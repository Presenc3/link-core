'use strict';

/**
 * Dashboard-friendly snapshot + event ring buffer over a LinkClient.
 *
 *   const recorder = createEventRecorder(link, {
 *     ringSize:            30,
 *     heartbeatIntervalMs: 1000,
 *   });
 *
 *   // SSE consumer
 *   const unsub = recorder.onSnapshot((snap) => {
 *     res.write(`data: ${JSON.stringify(snap)}\n\n`);
 *   });
 *
 *   // ... later
 *   unsub();
 *   recorder.close();
 *
 * Listens to the LinkClient events that a "what's happening on the bus
 * right now" dashboard cares about - lifecycle (`ready`, `rejected`,
 * `disconnect`), membership (`peer.connect`, `peer.disconnect`,
 * `peer.status`), drops (`protocol-error`, `backpressure`), failed RPCs
 * (`rpc.complete` with `ok: false`), and inbound `direct` messages -
 * and pushes each into a bounded ring buffer with a normalized
 * `{ kind, from, ..., t }` shape.
 *
 * Membership-and-lifecycle events also trigger a snapshot emit, so a
 * subscriber that registers via `recorder.onSnapshot(fn)` sees a frame
 * the moment a peer joins or leaves, not on the next heartbeat tick.
 * The heartbeat (default 1 Hz; set `heartbeatIntervalMs: 0` to disable)
 * is the floor - it guarantees a frame even on a fully idle network
 * so dashboards can keep their "last beat N ms ago" labels honest.
 *
 * The snapshot is a fresh object on every read - safe to JSON.stringify
 * and ship over the wire without further copying. The `eventLog` entries
 * are shallow-cloned from the ring buffer; nested objects (`peer`,
 * `prevPeer`, `status`) are shared references and should be treated as
 * read-only by consumers (mutating them would corrupt subsequent
 * snapshots). For mutable downstream processing, JSON-roundtrip the
 * snapshot first.
 *
 * The recorder is intentionally observation-only: it does not call
 * `link.publish()` / `link.send()` / `link.rpc()`, does not consume
 * topics, and does not depend on hub features. It works against a
 * v0.4+ LinkClient. (It uses `link.health()`, added in v0.4.0; older
 * clients are not supported.)
 */

const { EventEmitter } = require('events');

const DEFAULT_RING_SIZE       = 30;
const DEFAULT_HEARTBEAT_MS    = 1000;

const RECORDED_CLIENT_EVENTS = Object.freeze([
  'ready',
  'rejected',
  'disconnect',
  'protocol-error',
  'backpressure',
  'peer.connect',
  'peer.disconnect',
  'peer.replaced',
  'peer.status',
  'rpc.complete',
  'direct',
]);

const SNAPSHOT_TRIGGERS = Object.freeze([
  'ready',
  'rejected',
  'disconnect',
  'peer.connect',
  'peer.disconnect',
  'peer.replaced',
  'peer.status',
]);

/**
 * Build an EventRecorder bound to a LinkClient.
 *
 *   const recorder = createEventRecorder(link, { ringSize: 100 });
 *
 * Options:
 *   ringSize             integer ≥ 1.  Max recorded events; oldest evicted on overflow. Default 30.
 *   heartbeatIntervalMs  integer ≥ 0.  Periodic snapshot emit cadence. 0 disables. Default 1000.
 *   startedAt            number.       Stamp included in `snapshot.startedAt`. Default `Date.now()`
 *                                      at construction time.
 *
 * Returns an EventEmitter with:
 *   getSnapshot()         current full snapshot (peers, statuses, eventLog, ...).
 *   getRecent()           copy of the ring buffer.
 *   onSnapshot(fn)        subscribe; `fn` is called synchronously with the current
 *                         snapshot first, then on every subsequent emit. Returns an
 *                         unsubscribe function.
 *   onEvent(fn)           subscribe; `fn` is called on each newly-recorded event.
 *                         Does NOT replay the ring buffer. Returns an unsubscribe
 *                         function. Use `getRecent()` first if history is wanted.
 *   close()               detach all client listeners + clear heartbeat. Idempotent.
 *
 * Events emitted:
 *   'event'    (evt)       - every recorded event, same payload onEvent() receives
 *   'snapshot' (snap)      - each snapshot emit, same payload onSnapshot() receives
 */
function createEventRecorder(client, opts = {}) {
  if (!client || typeof client !== 'object') {
    throw new TypeError('createEventRecorder: client (a LinkClient) is required');
  }
  if (typeof client.on !== 'function' || typeof client.off !== 'function') {
    throw new TypeError('createEventRecorder: client must be an EventEmitter (got something without on/off)');
  }

  const ringSize = Number.isFinite(opts.ringSize) && opts.ringSize >= 1
    ? Math.floor(opts.ringSize)
    : DEFAULT_RING_SIZE;
  const heartbeatIntervalMs = Number.isFinite(opts.heartbeatIntervalMs) && opts.heartbeatIntervalMs >= 0
    ? Math.floor(opts.heartbeatIntervalMs)
    : DEFAULT_HEARTBEAT_MS;
  const startedAt = Number.isFinite(opts.startedAt) ? opts.startedAt : Date.now();

  const recorder = new EventEmitter();

  recorder.setMaxListeners(0);

  const ring          = [];
  const snapshotSubs  = new Set();
  const eventSubs     = new Set();
  const boundHandlers = new Map();
  let   heartbeat     = null;
  let   closed        = false;

  function pushEvent(evt) {
    if (closed) return;
    const stamped = { ...evt, t: (Number.isFinite(evt && evt.t) ? evt.t : Date.now()) };
    ring.push(stamped);
    if (ring.length > ringSize) ring.splice(0, ring.length - ringSize);

    for (const fn of eventSubs) {
      try { fn(stamped); }
      catch (e) {
        if (typeof process !== 'undefined' && process.emitWarning) {
          process.emitWarning(
            `event-recorder: event subscriber threw: ${e && e.message ? e.message : e}`,
            'LinkCoreEventRecorder',
          );
        }
      }
    }

    try { recorder.emit('event', stamped); }
    catch { /* recorder.emit only throws on 'error' without listeners; we don't emit that */ }
  }

  function buildSnapshot(reason) {
    let connected = false;
    let ready     = false;
    let self      = null;
    let peers     = [];
    let statuses  = Object.create(null);
    let health    = null;

    try {
      connected = !!(typeof client.isConnected === 'function' && client.isConnected());
    } catch { }
    try {
      ready = !!(typeof client.isReady === 'function' && client.isReady());
    } catch { }

    if (client.kind != null) {
      self = {
        kind:     client.kind,
        name:     client.name != null ? client.name : null,
        features: Array.isArray(client.hubFeatures) ? client.hubFeatures.slice() : null,
      };
    }

    try {
      if (typeof client.getPeers === 'function') {
        const p = client.getPeers();
        if (Array.isArray(p)) peers = p;
      }
    } catch { }

    try {
      if (typeof client.getPeerStatus === 'function') {
        for (const p of peers) {
          const s = client.getPeerStatus(p && p.kind);
          if (s) statuses[p.kind] = s;
        }
      }
    } catch { }

    try {
      if (typeof client.health === 'function') {
        const h = client.health();
        if (h != null) health = h;
      }
    } catch { }

    const snap = {
      connected,
      ready,
      self,
      peers,
      statuses,
      startedAt,
      health,
      eventLog: ring.map((e) => ({ ...e })),
      at:       Date.now(),
    };
    if (reason) snap._reason = reason;
    return snap;
  }

  function emitSnapshot(reason) {
    if (closed) return;
    const snap = buildSnapshot(reason);

    for (const fn of snapshotSubs) {
      try { fn(snap); }
      catch (e) {
        if (typeof process !== 'undefined' && process.emitWarning) {
          process.emitWarning(
            `event-recorder: snapshot subscriber threw: ${e && e.message ? e.message : e}`,
            'LinkCoreEventRecorder',
          );
        }
      }
    }

    try { recorder.emit('snapshot', snap); } catch { }
  }

  function onReady(payload) {
    pushEvent({ kind: 'hub-up', from: 'link_server' });
    emitSnapshot('ready');
  }

  function onRejected(payload) {
    const reason = payload && payload.reason;
    const error  = payload && payload.error;
    pushEvent({ kind: 'rejected', from: 'link_server', reason, error });
    emitSnapshot('rejected');
  }

  function onDisconnect(payload) {
    const code   = payload && payload.code;
    const reason = payload && payload.reason;
    pushEvent({ kind: 'hub-down', from: 'link_server', code, reason });
    emitSnapshot('disconnect');
  }

  function onProtocolError(info) {
    pushEvent({
      kind:   'protocol-error',
      from:   'self',
      reason: info && info.reason,
      type:   info && info.type,
    });
  }

  function onBackpressure(info) {
    pushEvent({
      kind:           'backpressure',
      from:           'self',
      type:           info && info.type,
      to:             info && info.to,
      bufferedAmount: info && info.bufferedAmount,
    });
  }

  function onPeerConnect(peer) {
    pushEvent({ kind: 'join',  from: peer && peer.kind, peer });
    emitSnapshot('peer.connect');
  }

  function onPeerDisconnect(peer) {
    pushEvent({ kind: 'leave', from: peer && peer.kind, peer });
    emitSnapshot('peer.disconnect');
  }

  function onPeerReplaced(info) {
    pushEvent({
      kind:     'replace',
      from:     info && info.kind,
      prevPeer: info && info.prevPeer,
      peer:     info && info.peer,
    });
    emitSnapshot('peer.replaced');
  }

  function onPeerStatus(info) {
    if (info && info.from && info.from !== client.kind) {
      pushEvent({
        kind:   'status',
        from:   info.from,
        status: info.status,
        at:     info.at,
      });
    }
    emitSnapshot('peer.status');
  }

  function onRpcComplete(info) {
    if (info && info.ok === false) {
      pushEvent({
        kind:       'rpc-fail',
        from:       'self',
        to:         info.to,
        rpcType:    info.rpcType,
        reason:     info.reason,
        durationMs: info.durationMs,
      });
    }
  }

  function onDirect(info) {
    pushEvent({
      kind: 'direct',
      from: info && info.from,
      type: info && info.type,
    });
  }

  const handlers = {
    'ready':           onReady,
    'rejected':        onRejected,
    'disconnect':      onDisconnect,
    'protocol-error':  onProtocolError,
    'backpressure':    onBackpressure,
    'peer.connect':    onPeerConnect,
    'peer.disconnect': onPeerDisconnect,
    'peer.replaced':   onPeerReplaced,
    'peer.status':     onPeerStatus,
    'rpc.complete':    onRpcComplete,
    'direct':          onDirect,
  };
  for (const [eventName, fn] of Object.entries(handlers)) {
    client.on(eventName, fn);
    boundHandlers.set(eventName, fn);
  }

  if (heartbeatIntervalMs > 0) {
    heartbeat = setInterval(() => emitSnapshot('tick'), heartbeatIntervalMs);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();
  }

  recorder.getSnapshot = function getSnapshot() {
    return buildSnapshot();
  };

  recorder.getRecent = function getRecent() {
    return ring.map((e) => ({ ...e }));
  };

  recorder.onSnapshot = function onSnapshot(fn) {
    if (typeof fn !== 'function') {
      throw new TypeError('onSnapshot: fn must be a function');
    }

    if (closed) return () => {};
    snapshotSubs.add(fn);
    try { fn(buildSnapshot('initial')); }
    catch (e) {
      if (typeof process !== 'undefined' && process.emitWarning) {
        process.emitWarning(
          `event-recorder: snapshot subscriber threw on initial delivery: ${e && e.message ? e.message : e}`,
          'LinkCoreEventRecorder',
        );
      }
    }
    return () => { snapshotSubs.delete(fn); };
  };

  recorder.onEvent = function onEvent(fn) {
    if (typeof fn !== 'function') {
      throw new TypeError('onEvent: fn must be a function');
    }
    if (closed) return () => {};
    eventSubs.add(fn);
    return () => { eventSubs.delete(fn); };
  };

  recorder.close = function close() {
    if (closed) return;
    closed = true;
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    for (const [eventName, fn] of boundHandlers) {
      try { client.off(eventName, fn); } catch { }
    }
    boundHandlers.clear();
    snapshotSubs.clear();
    eventSubs.clear();
    recorder.removeAllListeners();
  };

  Object.defineProperty(recorder, 'ringSize',            { value: ringSize,            enumerable: true });
  Object.defineProperty(recorder, 'heartbeatIntervalMs', { value: heartbeatIntervalMs, enumerable: true });
  Object.defineProperty(recorder, 'startedAt',           { value: startedAt,           enumerable: true });

  return recorder;
}

module.exports = {
  createEventRecorder,
  RECORDED_CLIENT_EVENTS,
  SNAPSHOT_TRIGGERS,
};