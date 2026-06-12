'use strict';

const   WebSocket      = require('ws');
const { randomUUID   } = require('crypto');
const { EventEmitter } = require('events');

const {
  TAG,
  DEFAULT_MAX_LISTENERS,
  DEFAULT_STOP_DRAIN_MS,
  DEFAULT_RPC_TIMEOUT_MS,
  DEFAULT_MAX_RECENT_IDS,
  DEFAULT_DRAIN_RETRY_MS,
  DEFAULT_RECONNECT_GROWTH,
  DEFAULT_RECONNECT_JITTER,
  DEFAULT_RECONNECT_MAX_MS,
  DEFAULT_REPLAY_WINDOW_MS,
  DEFAULT_MAX_OUTBOX_BYTES,
  DEFAULT_MAX_MESSAGE_BYTES,
  DEFAULT_STATUS_INTERVAL_MS,
  DEFAULT_MAX_BUFFERED_BYTES,
  DEFAULT_MAX_CONCURRENT_RPC,
  DEFAULT_RECONNECT_INITIAL_MS,
  DEFAULT_KEEPALIVE_INTERVAL_MS,
  DEFAULT_MAX_RECONNECT_ATTEMPTS,
  DEFAULT_HELLO_ACK_DIAGNOSTIC_MS,
} = require('./constants.js');

const { handleInboundMessage, handleClose } = require('./inbound.js');

const {
  makeMsg,                assertValidTopic,
  assertJsonSerializable, DEFAULT_HASH_ALGO,
} = require('../protocol.js');

const {
  RpcAbortError,
  RpcTimeoutError,       RpcDisconnectError,
  BackpressureError,     HelloRejectedError,
  LinkNotReadyError,     FeatureUnsupportedError,
  RpcHandlerError,       rpcErrorResponse, ownRpcErrorData,
} = require('../internal/errors.js');

const { Outbox          } = require('../internal/outbox.js');
const { PeerRecentIds   } = require('../internal/recent.js');
const { normalizeLogger } = require('../internal/logger.js');
const { settleOnEvents  } = require('../internal/await-event.js');

/** Build an `Error` whose `name` is `'AbortError'` (the cancellation convention). */
function namedAbortError(message) {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

const {
  positiveFinite, nonNegFinite, inRange, atLeast, applyOptions,
  positiveIntOrInfinity, nonNegInt, positiveInt, validHashAlgo,
  assertRpcHandlerMap,
} = require('../internal/options.js');

const { assertValidKind } = require('../hub/hello.js');

/**
 * Declarative spec for LinkClient's numeric/validated options - the
 * runtime mirror of the `LinkClientOptions` numeric fields declared in
 * the hand-written `.d.ts` (which stays the source of truth for the full
 * surface). `applyOptions` validates each and assigns it onto the
 * instance, so the validate step and the copy-to-`this` step can no
 * longer drift.
 */
const LINKCLIENT_OPTION_SPEC = [
  { name: 'hashAlgo',             validate: validHashAlgo,         def: DEFAULT_HASH_ALGO                            },
  { name: 'stopDrainMs',          validate: nonNegFinite,          def: DEFAULT_STOP_DRAIN_MS                        },
  { name: 'maxListeners',         validate: nonNegInt,             def: DEFAULT_MAX_LISTENERS                        },
  { name: 'maxRecentIds',         validate: positiveInt,           def: DEFAULT_MAX_RECENT_IDS                       },
  { name: 'reconnectMaxMs',       validate: positiveFinite,        def: DEFAULT_RECONNECT_MAX_MS                     },
  { name: 'replayWindowMs',       validate: nonNegFinite,          def: DEFAULT_REPLAY_WINDOW_MS                     },
  { name: 'maxOutboxBytes',       validate: positiveInt,           def: DEFAULT_MAX_OUTBOX_BYTES                     },
  { name: 'maxMessageBytes',      validate: positiveInt,           def: DEFAULT_MAX_MESSAGE_BYTES                    },
  { name: 'reconnectGrowth',      validate: atLeast,               def: DEFAULT_RECONNECT_GROWTH,       args: [1]    },
  { name: 'reconnectJitter',      validate: inRange,               def: DEFAULT_RECONNECT_JITTER,       args: [0, 1] },
  { name: 'statusIntervalMs',     validate: positiveFinite,        def: DEFAULT_STATUS_INTERVAL_MS                   },
  { name: 'maxBufferedBytes',     validate: positiveInt,           def: DEFAULT_MAX_BUFFERED_BYTES                   },
  { name: 'maxConcurrentRpc',     validate: nonNegInt,             def: DEFAULT_MAX_CONCURRENT_RPC                   },
  { name: 'reconnectInitialMs',   validate: positiveFinite,        def: DEFAULT_RECONNECT_INITIAL_MS                 },
  { name: 'keepaliveIntervalMs',  validate: nonNegFinite,          def: DEFAULT_KEEPALIVE_INTERVAL_MS                },
  { name: 'defaultRpcTimeoutMs',  validate: positiveFinite,        def: DEFAULT_RPC_TIMEOUT_MS                       },
  { name: 'helloAckDiagnosticMs', validate: nonNegFinite,          def: DEFAULT_HELLO_ACK_DIAGNOSTIC_MS              },
  { name: 'maxReconnectAttempts', validate: positiveIntOrInfinity, def: DEFAULT_MAX_RECONNECT_ATTEMPTS               }
];

/**
 * A WebSocket link client: connection + reconnection, HMAC-signed messages,
 * peer discovery, request/response RPC, pub/sub topics, and directed
 * fire-and-forget messaging.
 *
 * Outbound delivery model:
 *   `send()`, `publish()`, status pushes, and subscription syncs never drop
 *   on transient trouble. When the socket is congested or the link is
 *   mid-reconnect, messages wait in a bounded in-memory outbox and drain
 *   automatically once the link is healthy again. Queued messages are signed
 *   at flush time, so a message that waits through a reconnect still gets a
 *   fresh timestamp and is not rejected by the hub's replay window. The only
 *   time an outbound message is refused is when the outbox byte cap is hit -
 *   a loud `outbox-overflow` event, never a silent drop.
 *
 * Events (payload shapes omitted here - see the type declarations):
 *   connect, verified, ready, rejected, disconnect, reconnecting,
 *   reconnect-exhausted, message, peer.connect, peer.disconnect,
 *   peer.replaced, peer.status, direct, protocol-error, ws-error,
 *   rpc.request, rpc.timeout, rpc.abort, rpc.disconnect, rpc.complete,
 *   backpressure, outbox-overflow, outbox-drained
 */
class LinkClient extends EventEmitter {
  constructor(opts = {}) {
    super();

    const {
      url, name, kind, secret, logger, makeStatus,
      rpcHandlers           = {},
      perMessageDeflate     = false,
      reconnectOnRejection  = false,
      exposeRpcErrors       = false,
    } = opts;

    applyOptions(this, opts, LINKCLIENT_OPTION_SPEC);

    this.setMaxListeners(this.maxListeners);

    for (const [k, v] of [['url', url], ['secret', secret], ['kind', kind], ['name', name]]) {
      if (v != null && (typeof v !== 'string' || v.length === 0)) {
        throw new TypeError(`new LinkClient(): "${k}" must be a non-empty string when provided`);
      }
    }

    if (makeStatus != null && typeof makeStatus !== 'function') {
      throw new TypeError('new LinkClient(): "makeStatus" must be a function when provided');
    }

    assertRpcHandlerMap(rpcHandlers, 'new LinkClient(): "rpcHandlers"');

    if (kind != null) assertValidKind(kind, 'new LinkClient(): "kind"');

    this.url         = url;
    this.kind        = kind;
    this.secret      = secret;
    this.makeStatus  = makeStatus;
    this.name        = name || kind;
    this.log         = normalizeLogger(logger);
    this.rpcHandlers = Object.assign(Object.create(null), rpcHandlers || {});

    this.perMessageDeflate    = perMessageDeflate;
    this.reconnectOnRejection = reconnectOnRejection;
    this.exposeRpcErrors      = exposeRpcErrors === true;
    this.drainRetryMs         = DEFAULT_DRAIN_RETRY_MS;

    this.recentIds = (this.replayWindowMs > 0) ? new PeerRecentIds({
      maxCount: this.maxRecentIds,
      maxAgeMs: this.replayWindowMs
    }) : null;

    this._reconnectAttempt       = 0;
    this._inFlightRpc            = 0;
    this._skewDropsSinceVerified = 0;
    this._lastSkew               = 0;
    this.peers                   = [];
    this.hubFeatures             = null;
    this.ws                      = null;
    this.statusTimer             = null;
    this.reconnectTimer          = null;
    this.helloAckTimer           = null;
    this._keepaliveTimer         = null;
    this._lastVerifiedAt         = null;
    this._pongAlive              = true;
    this._stopped                = false;
    this._stopPromise            = null;
    this._verifiedAny            = false;
    this._ready                  = false;
    this._disconnectEmitted      = false;
    this.pending                 = new Map();
    this.lastStatusByPeer        = new Map();
    this._subscriptions          = new Map();
    this.reconnectMs             = this.reconnectInitialMs;

    /**
     * In-flight *inbound* RPCs (requests this client is currently handling),
     * keyed by request id. Each entry carries an `AbortController` whose
     * signal is handed to the handler, so a `rpc.cancel` relayed by the hub
     * (or a disconnect) can ask a cooperating handler to bail early.
     */
    this._inboundRpc = new Map();

    /**
     * The single outbound queue for this link. Holds messages while the
     * socket is congested or mid-reconnect and drains them automatically;
     * deliberately survives reconnects (`discardOnClosedSocket: false`).
     */
    this._outbox = new Outbox({
      maxOutboxBytes:   this.maxOutboxBytes,
      maxBufferedBytes: this.maxBufferedBytes,
      drainRetryMs:     this.drainRetryMs,
      log:              this.log,
      tag:              TAG,
      getSocket:        () => this.ws,
      readyToWrite:     () => this.isConnected() && this._ready,
      shouldSchedule:   () => !this._stopped,
      snapshotUnowned:  true,
      conflationKey:    (item) => (item.type === 'status.update' ? 'status.update' : null),
      buildEnvelope:    (item) => makeMsg(this.secret, {
        id:    item.id,
        type:  item.type,
        from:  this.kind,
        to:    item.to ?? null,
        data:  item.data,
        clone: !item.owned,
      }, this.hashAlgo),
      onBackpressure:   (item, info) => this.emit('backpressure', {
        type:           item.type,
        to:             item.to ?? null,
        queued:         true,
        bufferedAmount: info.bufferedAmount,
        outboxSize:     info.outboxSize,
      }),
      onOverflow:       (item, info) => this.emit('outbox-overflow', {
        type:           item.type,
        to:             item.to ?? null,
        outboxBytes:    info.outboxBytes,
        maxOutboxBytes: info.maxOutboxBytes,
      }),
      onSerializeError: (item, error) => this.emit('outbox-error', {
        type:  item.type,
        to:    item.to ?? null,
        id:    item.id,
        error,
      }),
      onDrained:        () => this.emit('outbox-drained', {}),
    });
  }

  start() {
    if (!this.url || !this.secret || !this.kind
     ) return this.log.warn(TAG, 'start(): disabled (missing url/secret/kind)');

    if (this.ws) {
      const state = this.ws.readyState;

      if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) {
        this._stopped = false;
        return;
      }

      this._detachWs(this.ws);
      this.ws = null;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this._stopped = false;
    this._connect();
  }

  /**
   * Stop the link. By default this is a *graceful* stop: it flushes the
   * outbound queue, lets in-flight RPCs settle, and waits for the socket's
   * send buffer to empty - all bounded by `opts.timeoutMs` - before closing.
   *
   * Always returns a Promise that resolves (never rejects); a drain
   * timeout or error is swallowed and the socket is force-closed anyway.
   *
   * @param {object}  [opts]
   * @param {boolean} [opts.drain=true] false = close immediately, rejecting pending RPCs
   * @param {number}  [opts.timeoutMs]  drain budget in ms (default: the `stopDrainMs` ctor option)
   * @returns {Promise<void>}
   */
  stop(opts = {}) {
    if (this._stopPromise) return this._stopPromise;

    const drain         = opts?.drain !== false;
    const drainTimeoutMs = nonNegFinite(opts?.timeoutMs, this.stopDrainMs, 'stop(): opts.timeoutMs');

    this._stopped = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    this._outbox.cancelDrain();

    this._clearTimers();

    const wasReady = this._ready;
    this._ready       = false;
    this._verifiedAny = false;
    this.hubFeatures  = null;

    if (!drain || !this.isConnected()) {
      this._hardStop(wasReady);
      return Promise.resolve();
    }

    if (this._outbox.isEmpty
     && this.pending.size === 0
     && (this.ws.bufferedAmount || 0) === 0) {
      this._hardStop(wasReady);
      return Promise.resolve();
    }

    const p = (async () => {
      try { await this._drainForShutdown(drainTimeoutMs); }
      catch (e) { this.log.warn(TAG, 'stop(): drain error:', e?.message || e); }

      this._hardStop(wasReady);
      if (!this._stopped) this.start();
    })();

    this._stopPromise = p;
    p.finally(() => { if (this._stopPromise === p) this._stopPromise = null; });

    return p;
  }

  /**
   * Clear every connection-scoped timer. Centralized so no teardown path
   * can forget one. Safe to call repeatedly.
   */
  _clearTimers() {
    if (this.statusTimer)     { clearInterval(this.statusTimer);     this.statusTimer     = null; }
    if (this.reconnectTimer)  { clearTimeout( this.reconnectTimer);  this.reconnectTimer  = null; }
    if (this.helloAckTimer)   { clearTimeout( this.helloAckTimer);   this.helloAckTimer   = null; }
    if (this._keepaliveTimer) { clearInterval(this._keepaliveTimer); this._keepaliveTimer = null; }
  }

  /**
   * Reject + telemeter every pending *outbound* RPC with an
   * `RpcDisconnectError`, then clear the map. Shared by the explicit
   * teardown (`_hardStop`) and the disconnect path (`handleClose`); they
   * differ only in the human-readable reason string.
   *
   * @param {string} reason message for the rejection error
   */
  _failAllPending(reason) {
    if (this.pending.size === 0) return;

    for (const [, p] of this.pending) {
      clearTimeout(p.timeout);
      if (p.cleanupAbort) p.cleanupAbort();

      const err = new RpcDisconnectError(reason, { to: p.to, rpcType: p.rpcType, id: p.id });

      p.reject(err);
      this.emit('rpc.disconnect', { id: p.id, to: p.to, rpcType: p.rpcType });
      this._emitRpcComplete(p, false, 'disconnect', err);
    }

    this.pending.clear();
  }

  /**
   * Tear down everything immediately: detach + close the socket, clear all
   * timers, discard the entire outbound queue, reject still-pending RPCs,
   * emit the final `disconnect`. Called by `stop()` after any graceful
   * drain - i.e. on an *explicit* teardown, not an automatic reconnect, so
   * the outbox is dropped wholesale (automatic reconnects, by contrast,
   * deliberately keep non-RPC queued messages across the blip).
   *
   * @param {boolean} wasReady whether the link was ready when stop() began
   */
  _hardStop(wasReady) {
    if (this.ws) {
      this._detachWs(this.ws);
      try { this.ws.close(); } catch {}
    }

    this._ready = false;
    this._clearTimers();
    this._outbox.cancelDrain();
    this._outbox.clear();
    this._abortInboundRpcs('Link stopped before RPC completed');

    this._failAllPending('Link stopped before RPC completed');

    if (wasReady) {
      this._emitDisconnect({ reason: 'stopped', willReconnect: false, wasReady: true });
    }
  }

  /**
   * Resolve once the outbox is empty, all pending RPCs have settled, and the
   * socket's send buffer has flushed - or once `timeoutMs` elapses, or the
   * socket closes underneath us. Never rejects. Pumps the outbox while it
   * waits so a graceful stop actively pushes queued messages out.
   *
   * @param {number} timeoutMs 0 = wait indefinitely
   * @returns {Promise<void>}
   */
  _drainForShutdown(timeoutMs) {
    return new Promise((resolve) => {
      const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : null;

      const settled = () =>
        !this.isConnected()
        || (this._outbox.isEmpty
            && this.pending.size === 0
            && (this.ws.bufferedAmount || 0) === 0);

      const tick = () => {
        if (settled()) return resolve();

        if (deadline !== null && Date.now() >= deadline) {
          this.log.warn(TAG,
            `stop(): drain budget of ${timeoutMs}ms exhausted ` +
            `(outbox=${this._outbox.size}, pendingRpc=${this.pending.size}) - forcing close`);
          return resolve();
        }

        if (!this._outbox.isEmpty) this._outbox.drain();

        const t = setTimeout(tick, this.drainRetryMs);
        t.unref?.();
      };

      tick();
    });
  }

  _detachWs(ws) {
    if (!ws) return;

    try { ws.removeAllListeners('open');    } catch {}
    try { ws.removeAllListeners('close');   } catch {}
    try { ws.removeAllListeners('message'); } catch {}
    try { ws.removeAllListeners('pong');    } catch {}
    try { ws.removeAllListeners('error');   } catch {}
    try { ws.on('error', () => {});         } catch {}
  }

  /**
   * Every event this client emits is observational. A throwing listener must
   * never break internal protocol handling - e.g. a listener that throws on
   * `message` or `ready` would otherwise abort the very dispatch loop that
   * processes the rpc.response a caller is awaiting, turning a userland bug
   * into a silent RPC timeout.
   *
   * Isolation is per-listener, not per-emit: a plain try/catch around
   * `super.emit` protects the *caller*, but Node's emit loop still aborts
   * at the first throwing listener, silently starving every listener
   * registered after it - including this library's own internal waiters
   * (`ready()` / `waitFor()` attach listeners via `settleOnEvents`, so a
   * throwing userland `'ready'` listener would make `ready()` hang until
   * its timeout even though the link came up). So each listener runs in
   * its own try/catch: one bad listener is logged and skipped, the rest
   * still fire. The one exception is the EventEmitter "unhandled 'error'"
   * signal, which keeps Node's throw-by-default contract so a real
   * misconfiguration still surfaces. (Note: the library itself never emits
   * 'error'; it uses 'ws-error'.)
   */
  emit(event, ...args) {
    if (event === 'error' && this.listenerCount('error') === 0) {
      return super.emit(event, ...args);
    }

    if (this.listenerCount(event) === 0) return false;

    const listeners = this.rawListeners(event);

    for (const fn of listeners) {
      try { fn.apply(this, args); }
      catch (err) {
        this.log?.warn?.(TAG, `'${String(event)}' listener threw:`, err?.message || err);
      }
    }

    return listeners.length > 0;
  }

  /** Emit `disconnect` at most once per socket lifetime (reset on _connect). */
  _emitDisconnect(payload) {
    if (this._disconnectEmitted) return;
    this._disconnectEmitted = true;
    this.emit('disconnect', payload);
  }

  isConnected() { return !!this.ws && this.ws.readyState === WebSocket.OPEN; }
  isReady()     { return this._ready; }

  /**
   * Returns a deep copy of the latest peer list. The returned array (and
   * every object inside) is safe to mutate; callers cannot use it to
   * pollute the LinkClient's internal state. Peer payloads always come
   * over the wire (JSON-roundtripped) so `structuredClone` never throws
   * here.
   *
   * Includes the calling client itself - the hub broadcasts the full
   * membership snapshot. Filter on `p.kind !== this.kind` if you only
   * want "everyone else".
   */
  getPeers() { return structuredClone(this.peers); }

  /**
   * Returns a deep copy of the last-known status for a peer of that
   * kind, or `null`. Safe to mutate.
   */
  getPeerStatus(kind) {
    const s = this.lastStatusByPeer.get(kind);
    return s ? structuredClone(s) : null;
  }

  health() {
    return {
      ready             : this._ready,
      stopped           : this._stopped,
      verified          : this._verifiedAny,
      peerCount         : this.peers.length,
      pendingRpcCount   : this.pending.size,
      connected         : this.isConnected(),
      lastVerifiedAt    : this._lastVerifiedAt,
      reconnectAttempt  : this._reconnectAttempt,
      subscriptionCount : this._subscriptions.size,
      bufferedAmount    : this.ws ? (this.ws.bufferedAmount || 0) : 0,
      outboxSize        : this._outbox.size,
      outboxBytes       : this._outbox.bytes,
      inFlightRpc       : this._inFlightRpc,
    };
  }

  /**
   * Validate that `data` can both be carried through the outbox *and*
   * placed on the JSON wire, and return a single owned snapshot of it.
   *
   * Two distinct failure modes are checked, because they do not overlap:
   *
   *   - `structuredClone` rejects functions, class instances, live
   *     sockets, and the like. `makeMsg` clones the payload into the
   *     envelope, so a non-cloneable value would otherwise fail only at
   *     flush time - and the drain loop, unable to tell a permanent
   *     serialization failure from a transient socket hiccup, would retry
   *     it forever and head-of-line-block the whole outbox.
   *
   *   - `JSON.stringify` rejects values that clone happily but cannot be
   *     serialized: `BigInt` is the common one, circular structures the
   *     other. These survive `structuredClone` untouched and would fail
   *     only at `JSON.stringify(msg)` send time, surfacing as a confusing
   *     `outbox-error` (or, for `rpc()`, a `BackpressureError`/timeout)
   *     instead of a clear error at the call site.
   *
   * The returned value is a fresh `structuredClone`, so the caller cannot
   * mutate the queued message after the call returns. This is the *only*
   * clone on the `send`/`publish`/`rpc` path: the snapshot is marked
   * `owned` downstream and `makeMsg` is told to skip its own clone.
   *
   * @param {*} data
   * @param {string} op call-site label for thrown messages
   * @returns {*} an owned snapshot of `data` (or `undefined` if `data` was)
   */
  _assertWireSafe(data, op) {
    if (data === undefined) return undefined;

    let snapshot;
    try {
      snapshot = structuredClone(data);
    } catch (e) {
      throw new TypeError(
        `${op}: payload is not structured-cloneable - ${e?.message || e}`);
    }

    try {
      assertJsonSerializable(snapshot, `${op}: payload`);
    } catch (e) {
      if (e instanceof TypeError) throw e;
      throw new TypeError(e?.message || String(e), { cause: e });
    }

    return snapshot;
  }

  /**
   * Directed fire-and-forget send. Returns `true` if the message was sent or
   * queued, `false` only if the outbox is full (an `outbox-overflow` event
   * also fires). Throws synchronously for programmer errors (bad arguments,
   * a non-serializable payload), for a disabled or stopped link, or when the
   * hub does not advertise the `direct` feature.
   */
  send(to, type, data) {
    if (typeof to !== 'string' || !to
     ) throw new TypeError('send(to, type, data): "to" must be a non-empty string');

    if (typeof type !== 'string' || !type
     ) throw new TypeError('send(to, type, data): "type" must be a non-empty string');

    this._assertSendable('send');

    const owned = this._assertWireSafe(data, 'send(to, type, data)');

    if (Array.isArray(this.hubFeatures) && !this.hubFeatures.includes('direct')
     ) throw new FeatureUnsupportedError(
      'Cannot send: hub does not support directed fire-and-forget ' +
      '(upgrade hub to v0.4+)',
      { op: 'send', feature: 'direct' },
    );

    return this._send('direct', { directType: type, directData: owned }, to, undefined, true) !== false;
  }

  /**
   * Publish a payload to a topic. Returns `true` if sent or queued, `false`
   * only on outbox overflow. Throws synchronously for an invalid topic, a
   * disabled or stopped link, or a hub without the `topics` feature.
   */
  publish(topic, payload) {
    assertValidTopic(topic);

    this._assertSendable('publish');

    const owned = this._assertWireSafe(payload, 'publish(topic, payload)');

    if (Array.isArray(this.hubFeatures) && !this.hubFeatures.includes('topics')
     ) throw new FeatureUnsupportedError(
      'Cannot publish: hub does not support topics (upgrade hub to v0.4+)',
      { op: 'publish', feature: 'topics' },
    );

    return this._send('topic.message', { topic, payload: owned }, null, undefined, true) !== false;
  }

  /**
   * Throw if the link can never deliver a fire-and-forget message - i.e. it
   * is disabled (missing url/secret/kind) or has been stopped. A merely
   * not-yet-connected or reconnecting link is *not* an error here: the
   * message is queued and drains when the link comes up.
   */
  _assertSendable(op) {
    if (!this.url || !this.secret || !this.kind) {
      throw new LinkNotReadyError(
        `Cannot ${op}: link is disabled (missing url, secret, or kind)`,
        { op },
      );
    }
    if (this._stopped) {
      throw new LinkNotReadyError(
        `Cannot ${op}: link has been stopped - call start() to reconnect`,
        { op },
      );
    }
  }

  subscribe(topic, handler) {
    assertValidTopic(topic);

    if (typeof handler !== 'function'
     ) throw new TypeError('subscribe(topic, handler): handler must be a function');

    let handlers = this._subscriptions.get(topic);
    const isFirst = !handlers;

    if (isFirst) {
      handlers = new Set();
      this._subscriptions.set(topic, handlers);
    }

    handlers.add(handler);

    if (isFirst && this.isConnected() && this._ready
     ) this._send('topic.subscribe', { topic });
  }

  unsubscribe(topic, handler) {
    assertValidTopic(topic);

    const handlers = this._subscriptions.get(topic);
    if (!handlers) return false;

    if (handler) {
      const removed = handlers.delete(handler);
      if (handlers.size > 0) return removed;
    }

    this._subscriptions.delete(topic);

    if (this.isConnected() && this._ready
     ) this._send('topic.unsubscribe', { topic });

    return true;
  }

  handle(rpcType, fn) {
    if (typeof rpcType !== 'string' || !rpcType
     ) throw new TypeError('handle(rpcType, fn): "rpcType" must be a non-empty string');

    if (typeof fn !== 'function'
     ) throw new TypeError('handle(rpcType, fn): "fn" must be a function');

    const prev = this.rpcHandlers[rpcType];
    this.rpcHandlers[rpcType] = fn;

    return prev;
  }

  unhandle(rpcType) {
    if (!this.rpcHandlers || !Object.hasOwn(this.rpcHandlers, rpcType)) return false;
    delete this.rpcHandlers[rpcType];
    return true;
  }

  waitFor(event, opts = {}) {
    const { signal } = opts;
    const timeoutMs = nonNegFinite(opts.timeoutMs, 0, 'waitFor(): opts.timeoutMs');

    const name = String(event);

    return settleOnEvents(this, {
      resolveEvents: [event],
      timeoutMs,
      signal,
      timeoutError: () => new Error(`waitFor('${name}') timed out after ${timeoutMs}ms`),
      abortError:   () => namedAbortError(`waitFor('${name}') aborted`),
    });
  }

  ready(opts = {}) {
    const { signal } = opts;
    const timeoutMs = nonNegFinite(opts.timeoutMs, 0, 'ready(): opts.timeoutMs');

    if (this._ready
     ) return Promise.resolve({ kind: this.kind, features: this.hubFeatures });

    if (!this.url || !this.secret || !this.kind) {
      return Promise.reject(new LinkNotReadyError(
        'ready(): link is disabled (missing url, secret, or kind) - ' +
        'configure all three or skip ready() in disabled-mode code paths',
        { op: 'ready' },
      ));
    }

    if (signal && signal.aborted) {
      return Promise.reject(namedAbortError('ready() aborted'));
    }

    if (this._stopped) {
      return Promise.reject(new LinkNotReadyError(
        'ready(): link has been stopped - call start() to reconnect',
        { op: 'ready' },
      ));
    }

    if (!this.ws) this.start();

    return settleOnEvents(this, {
      resolveEvents: ['ready'],
      rejectEvents: [{
        event: 'rejected',
        toError: (info) => new HelloRejectedError(
          info?.error || 'Hub rejected hello',
          { reason: info?.error || null },
        ),
      }],
      timeoutMs,
      signal,
      timeoutError: () => new Error(`ready() timed out after ${timeoutMs}ms`),
      abortError:   () => namedAbortError('ready() aborted'),
    });
  }

  rpc(to, rpcType, rpcData, optsOrTimeoutMs) {
    if (typeof to !== 'string' || !to
     ) throw new TypeError('rpc(to, rpcType, rpcData, opts?): "to" must be a non-empty string');

    if (typeof rpcType !== 'string' || !rpcType
     ) throw new TypeError('rpc(to, rpcType, rpcData, opts?): "rpcType" must be a non-empty string');

    const opts = (typeof optsOrTimeoutMs === 'number')
      ? { timeoutMs: optsOrTimeoutMs }
      : (optsOrTimeoutMs || {});

    const timeoutMs = nonNegFinite(
      opts.timeoutMs, this.defaultRpcTimeoutMs, 'rpc(): opts.timeoutMs',
    );

    const signal    = opts.signal;
    const id        = randomUUID();
    const startedAt = Date.now();
    const tele      = { id, to, rpcType, startedAt };

    if (signal && signal.aborted) {
      const err = new RpcAbortError(
        `RPC aborted before send: ${to}:${rpcType}`,
        { to, rpcType, id },
      );

      this.emit('rpc.abort', { id, to, rpcType });
      this._emitRpcComplete(tele, false, 'abort', err);

      return Promise.reject(err);
    }

    const ownedRpcData = this._assertWireSafe(rpcData, 'rpc(to, rpcType, rpcData)');

    if (!this.isConnected() || !this._ready) {
      const err = new LinkNotReadyError(
        'Cannot rpc: link not connected/ready',
        { op: 'rpc' },
      );

      err.to      = to;
      err.rpcType = rpcType;
      err.id      = id;

      this._emitRpcComplete(tele, false, 'not-ready', err);

      return Promise.reject(err);
    }

    return new Promise((resolve, reject) => {
      const timeout = timeoutMs > 0 ? setTimeout(() => {
        const p = this.pending.get(id);

        this.pending.delete(id);
        this._outbox.removeById(id);
        if (p?.cleanupAbort) p.cleanupAbort();

        this._sendRpcCancel(id, to);

        this.emit('rpc.timeout', { id, to, rpcType, timeoutMs });

        const err = new RpcTimeoutError(
          `RPC timeout after ${timeoutMs}ms: ${to}:${rpcType}`,
          { to, rpcType, id, timeoutMs },
        );

        this._emitRpcComplete(tele, false, 'timeout', err);

        reject(err);
      }, timeoutMs) : null;

      timeout?.unref?.();

      let cleanupAbort = null;

      if (signal) {
        const onAbort = () => {
          if (!this.pending.has(id)) return;

          clearTimeout(timeout);
          this.pending.delete(id);
          this._outbox.removeById(id);
          this._sendRpcCancel(id, to);

          const err = new RpcAbortError(
            `RPC aborted: ${to}:${rpcType}`,
            { to, rpcType, id },
          );

          this.emit('rpc.abort', { id, to, rpcType });
          this._emitRpcComplete(tele, false, 'abort', err);

          reject(err);
        };

        signal.addEventListener('abort', onAbort, { once: true });

        cleanupAbort = () => {
          try { signal.removeEventListener('abort', onAbort); } catch {}
        };
      }

      this.pending.set(id, { resolve, reject, timeout, to, rpcType, id, startedAt, cleanupAbort });

      const accepted = this._outbox.enqueueOrSend({
        id, type: 'rpc.request', to, data: { rpcType, rpcData: ownedRpcData }, owned: true,
      });

      if (!accepted) {
        clearTimeout(timeout);
        this.pending.delete(id);
        if (cleanupAbort) cleanupAbort();

        const err = new BackpressureError(
          `RPC dropped: outbound queue full (> ${this.maxOutboxBytes} bytes): ${to}:${rpcType}`,
          {
            type: 'rpc.request', to, rpcType, id,
            maxBufferedBytes: this.maxBufferedBytes,
          },
        );

        this._emitRpcComplete(tele, false, 'backpressure', err);
        reject(err);
      }
    });
  }

  _emitRpcComplete(p, ok, reason, err) {
    try {
      this.emit('rpc.complete', {
        id:        p.id,
        to:        p.to,
        rpcType:   p.rpcType,
        ok,
        reason,
        durationMs: Date.now() - p.startedAt,
        error:     ok ? null : (err?.message || String(err || '')),
      });
    } catch (e) {
      this.log.warn(TAG, 'rpc.complete listener threw:', e?.message || e);
    }
  }

  /**
   * Best-effort: ask the hub to drop a still-queued `rpc.request` so a
   * congested target never even receives it. Sent when a pending RPC is
   * abandoned locally - either aborted via its `AbortSignal` or expired
   * by its deadline (`timeoutMs`).
   *
   * This is a *fire-and-forget* cleanup hint, not a guarantee: it only
   * helps in the window where the request is still sitting in the target
   * peer's hub-side outbox. If the request was already forwarded, the
   * remote handler runs to completion as before (its response is then
   * logged-and-dropped, since the pending entry is gone). The cancel is
   * skipped entirely when the link is not ready, since a cancel is only
   * meaningful on the same connection that carried the original request.
   *
   * @param {string} rpcId the `id` of the `rpc.request` being cancelled
   * @param {string} to    the original RPC target
   */
  _sendRpcCancel(rpcId, to) {
    if (!this.isConnected() || !this._ready) return;
    try {
      this._send('rpc.cancel', { id: rpcId }, to, undefined, true);
    } catch (e) {
      this.log.debug(TAG,
        `rpc.cancel for ${String(rpcId).slice(0, 8)} not sent:`, e?.message || e);
    }
  }

  /**
   * Abort one in-flight *inbound* RPC in response to a `rpc.cancel` the hub
   * relayed from the original caller. The cancel only reaches a handler
   * that opted in by reading the `AbortSignal` it was handed; a handler
   * that ignores the signal runs to completion as before (its response is
   * then skipped, since the caller has already given up).
   *
   * The `from` guard re-checks, on the target side, that the cancel came
   * from the same peer that issued the original `rpc.request`: the hub
   * stamps `from` from the authenticated socket, so a peer cannot cancel
   * an RPC it did not originate.
   *
   * @param {string} rpcId the id of the `rpc.request` being cancelled
   * @param {string|null} from the authenticated kind of the canceller
   * @returns {boolean} true if a matching in-flight RPC was aborted
   */
  _abortInboundRpc(rpcId, from) {
    const entry = this._inboundRpc.get(rpcId);
    if (!entry) return false;

    if (entry.from != null && from != null && entry.from !== from) {
      this.log.warn(TAG,
        `ignoring rpc.cancel for ${String(rpcId).slice(0, 8)}: from "${from}" ` +
        `but the request was issued by "${entry.from}"`);
      return false;
    }

    if (!entry.ac.signal.aborted) {
      entry.ac.abort(new RpcAbortError('RPC cancelled by caller', {
        id: rpcId, rpcType: entry.rpcType,
      }));
    }

    try {
      this.emit('rpc.cancel', { id: rpcId, from: entry.from, rpcType: entry.rpcType });
    } catch (e) {
      this.log.warn(TAG, "'rpc.cancel' listener threw:", e?.message || e);
    }

    return true;
  }

  /**
   * Abort every in-flight inbound RPC - used when the link is torn down so
   * a handler honouring its `AbortSignal` stops work it can no longer
   * deliver a response for. The pending map is left for the caller to
   * clear (the `finally` in `_handleRpcRequest` also removes each entry).
   *
   * @param {string} reason human-readable abort reason for the signal
   */
  _abortInboundRpcs(reason) {
    if (this._inboundRpc.size === 0) return;
    for (const [id, entry] of this._inboundRpc) {
      if (!entry.ac.signal.aborted) {
        entry.ac.abort(new RpcAbortError(reason, { id, rpcType: entry.rpcType }));
      }
    }
  }

  /**
   * Run a local RPC handler for an inbound `rpc.request` and reply.
   *
   * The handler is given a third argument `{ signal }` carrying an
   * `AbortSignal`. The signal fires if the original caller cancels the
   * RPC (the hub relays a best-effort `rpc.cancel`) or if this link is
   * torn down. A handler may ignore it - in which case behaviour is
   * unchanged - or honour it to bail out of long-running work early.
   *
   * Errors are sanitized by default: an `RpcHandlerError` (or any error with
   * `expose === true`) is forwarded to the caller with its message, code,
   * and data intact; anything else reaches the caller only as a generic
   * "Internal handler error", while the real error is logged and emitted on
   * the `'rpc.handler-error'` event. Set the `exposeRpcErrors` option to
   * forward every handler error verbatim instead.
   */
  async _handleRpcRequest(msg) {
    const { rpcType, rpcData } = msg.data || {};
    const type = String(rpcType || '');

    if (this.maxConcurrentRpc > 0 && this._inFlightRpc >= this.maxConcurrentRpc) {
      this.log.warn(TAG,
        `rpc '${type}' rejected: ${this._inFlightRpc} handler(s) already in ` +
        `flight (maxConcurrentRpc=${this.maxConcurrentRpc})`);
      this._send('rpc.response', {
        ok: false,
        error: 'Handler overloaded - too many concurrent RPCs',
        code: 'RPC_OVERLOADED',
      }, msg.from, msg.id);
      return;
    }

    const ac = new AbortController();
    this._inboundRpc.set(msg.id, { ac, from: msg.from, rpcType: type });

    /**
     * Send the RPC response, unless the caller already cancelled - in
     * which case the pending entry on their side is gone and the response
     * would only be logged-and-dropped, so skip the wire traffic.
     *
     * `owned` marks `data` as an exclusively-held snapshot the outbox may
     * carry without its own defensive clone (see `_send`). Error replies
     * qualify too since v0.6.0: `ownRpcErrorData` replaces an exposed
     * error's `data` with a validated clone, so the throwing handler no
     * longer holds a reference into the reply.
     */
    const reply = (data, owned = false) => {
      if (ac.signal.aborted) return;
      this._send('rpc.response', data, msg.from, msg.id, owned);
    };

    this._inFlightRpc++;
    try {
      let result;
      try {
        const handler = this.rpcHandlers[type];
        if (!handler) {
          throw new RpcHandlerError(`Unknown rpcType: ${type}`, { code: 'RPC_UNKNOWN_TYPE' });
        }
        result = await handler(rpcData, msg, { signal: ac.signal });
      } catch (e) {
        const { exposed, body } = rpcErrorResponse(e, { exposeAll: this.exposeRpcErrors });

        ownRpcErrorData(body, (serErr) => this.log.error(TAG,
          `rpc handler '${type}' threw an error whose .data is not ` +
          `wire-safe - forwarding the error without data:`,
          serErr?.message || serErr));

        if (!exposed) {
          this.log.warn(TAG, `rpc handler '${type}' threw:`, e?.message || e);
          try {
            this.emit('rpc.handler-error', {
              rpcType: type, from: msg.from, id: msg.id, error: e,
            });
          } catch (ee) {
            this.log.warn(TAG, "'rpc.handler-error' listener threw:", ee?.message || ee);
          }
        }

        reply({ ok: false, ...body }, true);
        return;
      }

      let ownedResult;
      try {
        if (result !== undefined) {
          ownedResult = structuredClone(result);
          assertJsonSerializable(ownedResult, `rpc handler result for '${type}'`);
        }
      } catch (e) {
        this.log.error(TAG,
          `rpc handler '${type}' returned a non-serializable result:`,
          e?.message || e);
        reply({
          ok:    false,
          error: 'RPC handler returned a non-serializable result',
          code:  'RPC_RESULT_NOT_SERIALIZABLE',
        });
        return;
      }

      reply({ ok: true, result: ownedResult }, true);
    } finally {
      this._inFlightRpc--;
      this._inboundRpc.delete(msg.id);
    }
  }

  /**
   * Public entry for every internally-generated outbound message
   * (subscriptions, status pushes, RPC responses, etc.). Returns `true` if
   * sent or queued, `false` on outbox overflow.
   *
   * `owned` declares that `data` is already an exclusively-owned snapshot
   * that no other code holds a reference to - the outbox can store it and
   * `makeMsg` can sign it without taking a defensive `structuredClone`.
   * Since v0.6.0 every path that forwards app-supplied values snapshots
   * once up front and sends owned: `send`/`publish`/`rpc` (via
   * `_assertWireSafe`), the `makeStatus()` status push (same), and RPC
   * responses (handler results and exposed error `data` are probe-cloned
   * during validation). Remaining unowned callers carry only
   * internally-built plain objects.
   */
  _send(type, data, to = null, id = randomUUID(), owned = false) {
    return this._outbox.enqueueOrSend({ id, type, data, to, owned });
  }

  /**
   * Start the application-level liveness watchdog. Every
   * `keepaliveIntervalMs` it pings the hub; if the previous ping went
   * unanswered (no `pong` frame) the connection is treated as dead and
   * the socket is terminated - which triggers the normal close/reconnect
   * path.
   *
   * `keepaliveIntervalMs: 0` disables the watchdog.
   */
  _startKeepalive() {
    if (this._keepaliveTimer) {
      clearInterval(this._keepaliveTimer);
      this._keepaliveTimer = null;
    }

    if (this.keepaliveIntervalMs <= 0) return;

    this._pongAlive = true;
    this._keepaliveTimer = setInterval(() => {
      if (!this.isConnected()) return;

      if (this._pongAlive === false) {
        this.log.warn(TAG,
          `keepalive: hub did not answer a ping within ${this.keepaliveIntervalMs}ms - ` +
          `connection appears dead, terminating to force a reconnect`);
        try { this.emit('protocol-error', { reason: 'keepalive-timeout' }); }
        catch (e) { this.log.warn(TAG, "'protocol-error' listener threw:", e?.message || e); }
        try { this.ws.terminate(); } catch {}
        return;
      }

      this._pongAlive = false;
      try { this.ws.ping(); } catch {}
    }, this.keepaliveIntervalMs);
    this._keepaliveTimer.unref?.();
  }

  _connect() {
    this._disconnectEmitted = false;

    this.ws = new WebSocket(this.url, {
      maxPayload:        this.maxMessageBytes,
      perMessageDeflate: this.perMessageDeflate,
    });

    this.ws.on('open', () => {
      this._verifiedAny = false;
      this._ready       = false;
      this.hubFeatures  = null;
      this._pongAlive   = true;
      this._skewDropsSinceVerified = 0;
      this._lastSkew    = 0;

      this._outbox.writeNow({
        id:   randomUUID(),
        type: 'hello',
        to:   null,
        data: { kind: this.kind, name: this.name, pid: process.pid, startedAt: Date.now() },
      });

      if (this.helloAckDiagnosticMs > 0) {
        if (this.helloAckTimer) clearTimeout(this.helloAckTimer);
        this.helloAckTimer = setTimeout(() => {
          this.helloAckTimer = null;
          if (!this._ready && this.isConnected()) {
            if (this._verifiedAny) {
              this.log.warn(TAG,
                `hub verified our traffic but sent no hello.ack within ` +
                `${this.helloAckDiagnosticMs}ms of connect - the client only becomes ` +
                `ready on hello.ack, so this link will never become ready. The hub ` +
                `likely predates v0.4 (no hello.ack) or is non-conforming.`);
              this.emit('protocol-error', { reason: 'no-ack', verified: true });
            } else if (this._skewDropsSinceVerified > 0) {
              this.log.warn(TAG,
                `no verified message within ${this.helloAckDiagnosticMs}ms of connect - ` +
                `${this._skewDropsSinceVerified} signature-valid message(s) were dropped ` +
                `for being outside the replay window (last skew ${this._lastSkew}ms vs ` +
                `replayWindowMs ${this.replayWindowMs}ms). This is almost certainly clock ` +
                `skew - sync clocks (NTP) or raise replayWindowMs.`);
              this.emit('protocol-error', { reason: 'clock-skew', skew: this._lastSkew });
            } else {
              this.log.warn(TAG, `no verified message within ${this.helloAckDiagnosticMs}ms of connect - likely a shared-secret or hashAlgo mismatch with the hub (both produce identical "nothing verifies" symptoms)`);
              this.emit('protocol-error', { reason: 'no-ack' });
            }
          }
        }, this.helloAckDiagnosticMs);
        this.helloAckTimer.unref?.();
      }

      this._startKeepalive();

      this.log.info(TAG, `connected (${this.kind}) -> ${this.url}`);
      this.emit('connect', { url: this.url, kind: this.kind });
    });

    this.ws.on('pong', () => { this._pongAlive = true; });

    this.ws.on('message', (raw) => handleInboundMessage(this, raw));

    this.ws.on('error', (e) => {
      this.log.warn(TAG, `ws error (${this.kind}):`, e?.message || e);
      this.emit('ws-error', e);
    });

    this.ws.on('close', (code, reason) => handleClose(this, code, reason));
  }
}

module.exports = { LinkClient };