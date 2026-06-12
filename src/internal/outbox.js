'use strict';

/**
 * Shared outbound-queue ("outbox") machinery for the client and the hub.
 *
 * Both ends need the exact same congestion behaviour: send straight to the
 * wire on the fast path, otherwise hold the message in a bounded in-memory
 * queue and drain it as the socket catches up. Signing happens at *flush*
 * time so a message that waits through a reconnect gets a fresh timestamp
 * and is not rejected by the peer's replay window. The only time an
 * outbound message is refused is when the byte cap is hit - a loud
 * `outbox-overflow`, never a silent drop.
 *
 * Before v0.6.x this logic was duplicated, ~150 near-identical lines, in
 * `link-client.js` and `create-hub.js`. The two call sites differ only in
 * a handful of well-defined spots, all parameterised here:
 *
 *   - signing (`buildEnvelope`): the client signs with its own secret and
 *     stamps `from` as its kind; the hub signs with the socket's per-peer
 *     key and stamps `from` from the item.
 *   - readiness (`readyToWrite`): the client may only use the wire when
 *     connected *and* `ready`; the hub only needs the socket open.
 *   - status conflation (`conflationKey`): the client keeps one queued
 *     `status.update` total; the hub keeps one per originating peer.
 *   - the divergent event payload shapes (`onBackpressure`, `onOverflow`,
 *     `onSerializeError`, `onDrained`).
 *   - whether a closed socket's queue is abandoned (`discardOnClosedSocket`)
 *     - true for the hub's per-socket outbox, false for the client's
 *     outbox, which deliberately survives across reconnects.
 *
 * One `Outbox` instance backs one socket: the client holds a single one
 * for its lifetime; the hub creates one per peer socket in `attach()`.
 */

/** WebSocket `readyState` for an open connection (ws never re-exports this as a bare number). */
const WS_OPEN = 1;

/**
 * Rough byte cost of a queued item for outbox accounting (UTF-8 bytes).
 *
 * The fixed 200B covers the envelope scaffolding (key names, punctuation,
 * `v`, `ts`, and up to a 128-hex sig); every variable-length string field
 * is measured for real. The previous flat 96B ignored `id`/`type`/`to`/
 * `from` entirely - an `rpc.response` echoing a large inbound id (the id
 * is the *caller's*, bounded only by `MAX_ID_LENGTH` at parse time)
 * under-counted by that id's whole length, so retained memory could
 * exceed `maxOutboxBytes` by orders of magnitude.
 */
function estimateSize(item) {
  let n = 200;
  if (typeof item.id   === 'string') n += Buffer.byteLength(item.id);
  if (typeof item.type === 'string') n += Buffer.byteLength(item.type);
  if (typeof item.to   === 'string') n += Buffer.byteLength(item.to);
  if (typeof item.from === 'string') n += Buffer.byteLength(item.from);
  try { n += Buffer.byteLength(JSON.stringify(item.data ?? null)); }
  catch { n += 1024; }
  return n;
}

class Outbox {
  /**
   * @param {object}   opts
   * @param {number}   opts.maxOutboxBytes        hard cap on queued bytes
   * @param {number}   opts.maxBufferedBytes      `ws.bufferedAmount` pacing cap
   * @param {number}   opts.drainRetryMs          retry delay when paced/transiently failed
   * @param {object}   opts.log                   leveled logger
   * @param {string}   opts.tag                   log tag
   * @param {Function} opts.getSocket             `() => ws|null` - the live socket
   * @param {Function} opts.buildEnvelope         `(item) => msg` - sign; throws if non-serializable
   * @param {Function} opts.readyToWrite          `() => boolean` - fast-path + auto-drain gate
   * @param {Function} [opts.conflationKey]       `(item) => string|null` - items sharing a
   *                                              non-null key collapse to the newest
   * @param {boolean}  [opts.snapshotUnowned]     deep-clone `item.data` on enqueue unless `item.owned`
   * @param {boolean}  [opts.discardOnClosedSocket] drop the queue if the socket is not open
   * @param {Function} [opts.shouldSchedule]      `() => boolean` - extra guard on scheduling a drain
   * @param {Function} opts.onBackpressure        `(item, { bufferedAmount, outboxSize }) => void`
   * @param {Function} opts.onOverflow            `(item, { outboxBytes, maxOutboxBytes }) => void`
   * @param {Function} opts.onSerializeError      `(item, errorMessage) => void`
   * @param {Function} [opts.onDrained]           `() => void` - queue emptied after a congestion episode
   */
  constructor({
    maxOutboxBytes,
    maxBufferedBytes,
    drainRetryMs,
    log,
    tag,
    getSocket,
    buildEnvelope,
    readyToWrite,
    conflationKey       = null,
    snapshotUnowned     = false,
    discardOnClosedSocket = false,
    shouldSchedule      = null,
    onBackpressure,
    onOverflow,
    onSerializeError,
    onDrained           = null,
  }) {
    this.maxOutboxBytes        = maxOutboxBytes;
    this.maxBufferedBytes      = maxBufferedBytes;
    this.drainRetryMs          = drainRetryMs;
    this._log                  = log;
    this._tag                  = tag;
    this._getSocket            = getSocket;
    this._buildEnvelope        = buildEnvelope;
    this._readyToWrite         = readyToWrite;
    this._conflationKey        = conflationKey;
    this._snapshotUnowned      = snapshotUnowned;
    this._discardOnClosedSocket = discardOnClosedSocket;
    this._shouldSchedule       = shouldSchedule;
    this._onBackpressure       = onBackpressure;
    this._onOverflow           = onOverflow;
    this._onSerializeError     = onSerializeError;
    this._onDrained            = onDrained;

    this._items      = [];
    this._bytes      = 0;
    this._drainTimer = null;
  }

  /** Number of queued items. */
  get size()    { return this._items.length; }
  /** Estimated queued bytes. */
  get bytes()   { return this._bytes; }
  /** True when nothing is queued. */
  get isEmpty() { return this._items.length === 0; }

  /**
   * Send immediately on the fast path (ready, nothing already queued,
   * socket not congested), otherwise enqueue. Returns `true` if sent or
   * queued, `false` if the message was refused: outbox overflow
   * (`onOverflow` fired), or a fast-path payload that could not be
   * serialized (`onSerializeError` fired - permanent, so it is not queued).
   */
  enqueueOrSend(item) {
    if (this._items.length === 0 && this._readyToWrite()) {
      const ws = this._getSocket();
      if (ws && ws.bufferedAmount <= this.maxBufferedBytes) {
        const r = this.writeNow(item);
        if (r === 'sent')    return true;
        if (r === 'dropped') return false;
      }
    }
    return this.enqueue(item);
  }

  /**
   * Write `item` straight to the socket, signing it now (so a queued item
   * gets a fresh timestamp on flush).
   *
   * Returns one of:
   *   - `'sent'`    the message went out
   *   - `'failed'`  a *transient* failure (socket not open, `ws.send` threw)
   *                 - the caller should keep the item and retry later
   *   - `'dropped'` a *permanent* failure: the payload could not be
   *                 serialized, so retrying is pointless. An `outbox-error`
   *                 is reported and the item must be discarded, not retried
   *                 (otherwise it head-of-line-blocks the whole outbox).
   */
  writeNow(item) {
    const ws = this._getSocket();
    if (!ws || ws.readyState !== WS_OPEN) return 'failed';

    let msg;
    try {
      msg = this._buildEnvelope(item);
    } catch (e) {
      this._log.error(this._tag,
        `writeNow(${item.type}): payload could not be serialized, dropping:`,
        e?.message || e);
      try { this._onSerializeError(item, e?.message || String(e)); }
      catch (ee) { this._log.warn(this._tag, "'outbox-error' listener threw:", ee?.message || ee); }
      return 'dropped';
    }

    try {
      ws.send(JSON.stringify(msg), (err) => {
        if (err) this._log.warn(this._tag,
          `writeNow(${item.type}): async send failed (message may be lost):`,
          err?.message || err);
      });
      return 'sent';
    } catch (e) {
      this._log.warn(this._tag, `writeNow(${item.type}) failed:`, e?.message || e);
      return 'failed';
    }
  }

  /**
   * Append `item` to the queue. Refuses (returns `false`, reports
   * `outbox-overflow`) if the byte cap would be exceeded.
   *
   * Items whose `conflationKey` matches an already-queued item are
   * *conflated*: the queued copy is replaced in place rather than letting
   * a backlog of stale snapshots (e.g. `status.update`s) accumulate during
   * a congestion episode.
   */
  enqueue(item) {
    const size = estimateSize(item);

    if (this._snapshotUnowned && !item.owned && item.data !== undefined) {
      try { item.data = structuredClone(item.data); }
      catch { }
    }

    const ckey = this._conflationKey ? this._conflationKey(item) : null;
    if (ckey !== null) {
      const idx = this._items.findIndex(
        (it) => this._conflationKey(it) === ckey);
      if (idx !== -1) {
        const old       = this._items[idx];
        const projected = this._bytes - (old._size || 0) + size;

        if (projected > this.maxOutboxBytes) {
          this._log.warn(this._tag,
            `outbox full (${this._bytes}/${this.maxOutboxBytes} bytes) - ` +
            `refused conflated ${item.type}${item.to ? ` -> ${item.to}` : ''}`);
          try { this._onOverflow(item, { outboxBytes: this._bytes, maxOutboxBytes: this.maxOutboxBytes }); }
          catch (e) { this._log.warn(this._tag, "'outbox-overflow' listener threw:", e?.message || e); }
          return false;
        }

        item._size = size;
        this._items[idx] = item;
        this._bytes = projected;
        if (this._readyToWrite()) this.scheduleDrain();
        return true;
      }
    }

    if (this._bytes + size > this.maxOutboxBytes) {
      this._log.warn(this._tag,
        `outbox full (${this._bytes}/${this.maxOutboxBytes} bytes) - ` +
        `refused ${item.type}${item.to ? ` -> ${item.to}` : ''}`);
      try { this._onOverflow(item, { outboxBytes: this._bytes, maxOutboxBytes: this.maxOutboxBytes }); }
      catch (e) { this._log.warn(this._tag, "'outbox-overflow' listener threw:", e?.message || e); }
      return false;
    }

    const wasEmpty = this._items.length === 0;
    item._size = size;
    this._items.push(item);
    this._bytes += size;

    if (wasEmpty) {
      const ws = this._getSocket();
      const bufferedAmount = (ws && ws.readyState === WS_OPEN) ? (ws.bufferedAmount || 0) : 0;
      try { this._onBackpressure(item, { bufferedAmount, outboxSize: this._items.length }); }
      catch (e) { this._log.warn(this._tag, "'backpressure' listener threw:", e?.message || e); }
    }

    if (this._readyToWrite()) this.scheduleDrain();
    return true;
  }

  /**
   * Flush as much of the queue as the socket will take. Pauses (and
   * reschedules) when `ws.bufferedAmount` climbs past `maxBufferedBytes`,
   * so a slow socket paces the drain instead of being overrun. Gated on
   * the socket being open - not on `readyToWrite()` - so a graceful stop
   * (which clears `ready`) can still drain.
   */
  drain() {
    const ws = this._getSocket();
    if (!ws || ws.readyState !== WS_OPEN) {
      if (this._discardOnClosedSocket) this.clear();
      return;
    }

    let drainedAny = false;

    while (this._items.length > 0) {
      if (ws.bufferedAmount > this.maxBufferedBytes) {
        this.scheduleDrain(this.drainRetryMs);
        break;
      }

      const item = this._items[0];
      const r = this.writeNow(item);
      if (r === 'failed') {
        this.scheduleDrain(this.drainRetryMs);
        break;
      }

      this._items.shift();
      this._bytes -= item._size || 0;
      drainedAny = true;
    }

    if (this._items.length === 0) this._bytes = 0;

    if (drainedAny && this._items.length === 0 && this._onDrained) {
      try { this._onDrained(); }
      catch (e) { this._log.warn(this._tag, "'outbox-drained' listener threw:", e?.message || e); }
    }
  }

  /** Schedule a drain pass if one is not already pending. */
  scheduleDrain(delayMs = 0) {
    if (this._drainTimer) return;
    if (this._shouldSchedule && !this._shouldSchedule()) return;
    this._drainTimer = setTimeout(() => {
      this._drainTimer = null;
      this.drain();
    }, delayMs);
    this._drainTimer.unref?.();
  }

  /** Cancel any pending drain timer (does not touch queued items). */
  cancelDrain() {
    if (this._drainTimer) {
      clearTimeout(this._drainTimer);
      this._drainTimer = null;
    }
  }

  /** Remove a queued item by `id`. Returns `true` if one was found. */
  removeById(id) {
    return this.removeOne((it) => it.id === id);
  }

  /** Remove the first item matching `pred`. Returns `true` if one was found. */
  removeOne(pred) {
    const i = this._items.findIndex(pred);
    if (i === -1) return false;

    const [it] = this._items.splice(i, 1);
    this._bytes = this._items.length === 0
      ? 0
      : Math.max(0, this._bytes - (it._size || 0));
    return true;
  }

  /**
   * Remove every item matching `pred`, recomputing the byte total from the
   * survivors. Returns the number removed.
   */
  removeWhere(pred) {
    if (this._items.length === 0) return 0;

    const kept = [];
    let bytes = 0;
    let removed = 0;
    for (const it of this._items) {
      if (pred(it)) { removed += 1; continue; }
      kept.push(it);
      bytes += it._size || 0;
    }
    this._items = kept;
    this._bytes = bytes;
    return removed;
  }

  /** Return queued items matching `pred` (a shallow copy; items are live references). */
  filter(pred) {
    return this._items.filter(pred);
  }

  /** Drop every queued item. Does not cancel a pending drain timer (see `cancelDrain`). */
  clear() {
    this._items = [];
    this._bytes = 0;
  }
}

module.exports = { Outbox, estimateSize, WS_OPEN };