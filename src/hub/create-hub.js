'use strict';

const { randomUUID }   = require('crypto');
const { EventEmitter } = require('events');

const { createMessageHandler } = require('./dispatch.js');
const { makeSecretResolver }   = require('./secret-resolver.js');
const { makeAclGate, assertAclOption } = require('./acl.js');

const { makeMsg, DEFAULT_HASH_ALGO } = require('../protocol.js');

const { PeerRecentIds    } = require('../internal/recent.js');
const { RpcHandlerError  } = require('../internal/errors.js');
const { normalizeLogger  } = require('../internal/logger.js');
const { Outbox           } = require('../internal/outbox.js');
const { positiveFinite, nonNegFinite, nonNegInt, positiveInt, validHashAlgo, applyOptions, assertRpcHandlerMap } = require('../internal/options.js');

const {
  TAG,
  WS_OPEN,
  DEFAULT_MAX_RECENT_IDS,
  DEFAULT_DRAIN_RETRY_MS,
  DEFAULT_HELLO_TIMEOUT_MS,
  DEFAULT_REPLAY_WINDOW_MS,
  DEFAULT_MAX_OUTBOX_BYTES,
  DEFAULT_MAX_MESSAGE_BYTES,
  DEFAULT_MAX_BUFFERED_BYTES,
  DEFAULT_MAX_PENDING_SOCKETS,
  DEFAULT_MAX_CONCURRENT_RPC,
  DEFAULT_KEEPALIVE_INTERVAL_MS,
} = require('./constants.js');

const HUB_OPTION_SPEC = [
  { name: 'hashAlgo',            validate: validHashAlgo,  def: DEFAULT_HASH_ALGO              },
  { name: 'maxRecentIds',        validate: positiveInt,    def: DEFAULT_MAX_RECENT_IDS         },
  { name: 'maxOutboxBytes',      validate: positiveInt,    def: DEFAULT_MAX_OUTBOX_BYTES       },
  { name: 'maxMessageBytes',     validate: positiveInt,    def: DEFAULT_MAX_MESSAGE_BYTES      },
  { name: 'maxBufferedBytes',    validate: positiveInt,    def: DEFAULT_MAX_BUFFERED_BYTES     },
  { name: 'maxPendingSockets',   validate: positiveInt,    def: DEFAULT_MAX_PENDING_SOCKETS    },
  { name: 'maxConcurrentRpc',    validate: nonNegInt,      def: DEFAULT_MAX_CONCURRENT_RPC     },
  { name: 'keepaliveIntervalMs', validate: positiveFinite, def: DEFAULT_KEEPALIVE_INTERVAL_MS  },
  // 0 means "disabled" for these two
  { name: 'replayWindowMs',      validate: nonNegFinite,   def: DEFAULT_REPLAY_WINDOW_MS       },
  { name: 'helloTimeoutMs',      validate: nonNegFinite,   def: DEFAULT_HELLO_TIMEOUT_MS       },
];

function createHub(opts = {}) {
  const {
    secret,
    logger,
    rpcHandlers = {},
    exposeRpcErrors = false,
    canRpc,
    canSend,
    canPublish,
    canSubscribe,
  } = opts;

  if (secret == null) throw new Error('createHub({ secret }) is required');

  assertRpcHandlerMap(rpcHandlers, 'createHub({ rpcHandlers })');

  assertAclOption(canRpc,       'canRpc');
  assertAclOption(canSend,      'canSend');
  assertAclOption(canPublish,   'canPublish');
  assertAclOption(canSubscribe, 'canSubscribe');

  const o = {};
  applyOptions(o, opts, HUB_OPTION_SPEC);

  const {
    hashAlgo, maxRecentIds, maxOutboxBytes, maxMessageBytes, maxBufferedBytes,
    maxPendingSockets, maxConcurrentRpc, keepaliveIntervalMs, replayWindowMs, helloTimeoutMs,
  } = o;

  const resolveSecret = makeSecretResolver(secret);
  const log = normalizeLogger(logger);

  const acl = makeAclGate({ canRpc, canPublish, canSubscribe, canSend }, log);

  const hub = new EventEmitter();

  const clients        = new Map();
  const statuses       = new Map();
  const subscriptions  = new Map();
  const pendingSockets = new Map();

  const recentIds = (replayWindowMs > 0)
    ? new PeerRecentIds({ maxAgeMs: replayWindowMs, maxCount: maxRecentIds })
    : null;

  /**
   * Emit a hub event with per-listener isolation. A plain try/catch around
   * `hub.emit` would protect the dispatch path but still let Node's emit
   * loop abort at the first throwing listener, silently starving every
   * listener registered after it. Here each listener runs in its own
   * try/catch: a bad one is logged and skipped, the rest still fire.
   */
  function emitSafe(event, payload) {
    if (hub.listenerCount(event) === 0) return;

    for (const fn of hub.rawListeners(event)) {
      try { fn.call(hub, payload); }
      catch (e) { log.warn(TAG, `listener for '${event}' threw:`, e?.message || e); }
    }
  }

  const drainRetryMs = DEFAULT_DRAIN_RETRY_MS;
  let serverRpcInFlight = 0;

  /**
   * Build the per-socket outbox. Each connected socket owns one `Outbox`
   * instance (stored as `ws.__outbox`) so a congested consumer queues
   * rather than dropping, and a slow peer cannot block fan-out to others.
   *
   * The hub's outbox differs from the client's in a few ways, all
   * expressed through this config: it signs with the socket's per-peer
   * key (`ws.__secret`), preserves each item's originating `from`, snapshots
   * payloads at enqueue (queued leaves are otherwise shared references),
   * conflates `status.update` per originating peer, and abandons its queue
   * when the
   * socket closes (a disconnected peer's per-socket queue is meaningless).
   */
  function makeSocketOutbox(ws) {
    return new Outbox({
      maxOutboxBytes,
      maxBufferedBytes,
      drainRetryMs,
      log,
      tag: TAG,
      getSocket:  () => ws,
      readyToWrite: () => ws.readyState === WS_OPEN,
      discardOnClosedSocket: true,
      snapshotUnowned: true,
      conflationKey: (item) =>
        (item.type === 'status.update' ? `status.update:${item.data?.from}` : null),
      buildEnvelope: (item) => makeMsg(ws.__secret, {
        id: item.id, type: item.type, from: item.from, to: item.to, data: item.data,
        clone: false,
      }, hashAlgo),
      onBackpressure: (item, info) => emitSafe('backpressure', {
        kind:           ws.__kind || null,
        type:           item.type,
        to:             item.to,
        bufferedAmount: ws.bufferedAmount,
        maxBufferedBytes,
        queued:         true,
        outboxSize:     info.outboxSize,
      }),
      onOverflow: (item, info) => {
        log.warn(TAG,
          `outbox full for ${ws.__kind || '<pending>'} ` +
          `(${info.outboxBytes}/${maxOutboxBytes} bytes) - dropped ${item.type}`);
        emitSafe('outbox-overflow', {
          kind:        ws.__kind || null,
          type:        item.type,
          to:          item.to,
          outboxBytes: info.outboxBytes,
          maxOutboxBytes,
        });
      },
      onSerializeError: (item, errMsg) => {
        log.error(TAG,
          `send(${item.type}): payload could not be serialized, dropping ` +
          `(kind=${ws.__kind || '<pending>'}):`, errMsg);
        emitSafe('outbox-error', {
          kind:  ws.__kind || null,
          type:  item.type,
          to:    item.to,
          id:    item.id,
          error: errMsg,
        });
      },
    });
  }

  /**
   * Send an envelope to a peer's socket. Returns `true` when the message
   * was written or queued in that socket's outbox, `false` only on a hard
   * failure (closed socket, missing signing key, or the per-socket outbox
   * cap being hit). A congested socket queues rather than dropping, so a
   * single slow consumer no longer loses messages or blocks fan-out to
   * other peers.
   *
   * Callers that need the generated message id can pass `id` themselves
   * (RPC responses do, for correlation).
   */
  function send(ws, { id = randomUUID(), type, from = 'server', to = null, data, owned = false }) {
    if (!ws || ws.readyState !== WS_OPEN) return false;

    if (!ws.__secret) {
      log.warn(TAG, `cannot send: no signing key for type=${type} (kind=${ws.__kind || '<pending>'})`);
      return false;
    }

    return ws.__outbox.enqueueOrSend({ id, type, from, to, data, owned });
  }

  function broadcast(type, data) {
    for (const [kind, c] of clients.entries()) {
      send(c.ws, { type, to: kind, data });
    }
  }

  /**
   * Remove a still-queued `rpc.request` from a target peer's outbox in
   * response to an `rpc.cancel` from the original caller.
   *
   * Only ever removes a *queued* item - one that landed in the target's
   * outbox because that socket was congested when the request was
   * forwarded. The far more common case (target not congested, request
   * written straight to the wire) leaves nothing to find, and a request
   * that was already drained is likewise gone; both return `false`.
   *
   * The `fromKind` guard means a peer can only cancel requests it itself
   * originated - a peer cannot yank another peer's in-flight RPC.
   *
   * @param {string} targetKind the RPC's destination peer
   * @param {string} cancelId   the `id` of the `rpc.request` to drop
   * @param {string} fromKind   the authenticated kind of the canceller
   * @returns {boolean} true if a queued request was found and removed
   */
  function cancelQueuedRpc(targetKind, cancelId, fromKind) {
    const outbox = clients.get(targetKind)?.ws?.__outbox;
    if (!outbox) return false;

    return outbox.removeOne(
      (it) => it.type === 'rpc.request'
           && it.id   === cancelId
           && it.from === fromKind);
  }

  function snapshotPeers() {
    return [...clients.entries()].map(([kind, c]) => ({
      kind,
      hello:       c.hello || null,
      connectedAt: c.connectedAt || null,
      connected:   !!c.ws && c.ws.readyState === WS_OPEN,
    }));
  }

  function publishPeers() {
    broadcast('peers.update', { peers: snapshotPeers() });
  }

  /**
   * A read-only inspection snapshot for userland (and the `/state` route).
   * Deep-cloned: the peer entries' `hello` objects and the status values
   * are otherwise live references into hub state, so a caller mutating the
   * "snapshot" would corrupt what every later peers.update broadcast,
   * status relay, and getState() reads. Everything here is wire-derived
   * JSON data, so the clone cannot throw.
   */
  function getState() {
    const lastStatus = Object.create(null);
    for (const [k, s] of statuses.entries()) lastStatus[k] = s;

    return structuredClone({ peers: snapshotPeers(), lastStatus });
  }

  function health() {
    let totalSubscribers = 0;
    for (const s of subscriptions.values()) totalSubscribers += s.size;

    let outboxBytes = 0;
    let queuedSockets = 0;

    for (const c of clients.values()) {
      const b = c.ws?.__outbox?.bytes || 0;
      if (b > 0) { outboxBytes += b; queuedSockets += 1; }
    }

    return {
      outboxBytes,
      queuedSockets,
      totalSubscribers,
      serverRpcInFlight,
      peerCount:          clients.size,
      statusCount:        statuses.size,
      topicCount:         subscriptions.size,
      pendingSocketCount: pendingSockets.size,
      recentIdsSize:      recentIds ? recentIds.size() : 0,
    };
  }

  function dropSubscriptionsFor(kind) {
    for (const [t, s] of subscriptions) {
      if (s.delete(kind) && s.size === 0) subscriptions.delete(t);
    }
  }

  const builtinRpcs = Object.freeze(Object.assign(Object.create(null), {
    'link.topic.list': ({ topic } = {}) => {
      if (typeof topic === 'string' && topic.length > 0) {
        const subs = subscriptions.get(topic);
        return { topic, subscribers: subs ? [...subs] : [] };
      }
      const all = [];
      for (const [t, s] of subscriptions) all.push({ topic: t, subscribers: [...s] });
      return { topics: all };
    },
    'link.health': () => health(),
  }));

  const serverRpcs = Object.assign(Object.create(null), rpcHandlers || {});

  async function handleServerRpc(rpcType, rpcData, msg) {
    const type    = String(rpcType || '');

    const handler = serverRpcs[type] || builtinRpcs[type];

    if (!handler) {
      throw new RpcHandlerError(`Unknown server rpcType: ${type}`, { code: 'RPC_UNKNOWN_TYPE' });
    }

    if (maxConcurrentRpc > 0 && serverRpcInFlight >= maxConcurrentRpc) {
      throw new RpcHandlerError(
        'Server overloaded - too many concurrent RPCs',
        { code: 'RPC_OVERLOADED' });
    }

    serverRpcInFlight++;
    try {
      return await handler(rpcData, msg);
    } finally {
      serverRpcInFlight--;
    }
  }

  function trackPending(ws, ip) {
    while (pendingSockets.size >= maxPendingSockets) {
      const oldest = pendingSockets.keys().next().value;
      if (!oldest) break;

      const entry = pendingSockets.get(oldest);
      pendingSockets.delete(oldest);
      if (entry) clearTimeout(entry.timer);

      log.warn(TAG,
        `pre-hello cap reached (${maxPendingSockets}) - evicting oldest pending socket ` +
        `from ${entry?.ip || '<unknown>'}`);
      emitSafe('peer.timeout', {
        remoteAddress: entry?.ip || null,
        helloTimeoutMs,
        reason: 'pending-cap',
      });

      try { oldest.close(1008, 'pending cap'); } catch {}
      setTimeout(() => { try { oldest.terminate(); } catch {} }, 500).unref?.();
    }

    let timer = null;
    if (helloTimeoutMs > 0) {
      timer = setTimeout(() => {
        if (!pendingSockets.has(ws)) return;

        pendingSockets.delete(ws);
        log.warn(TAG, `pre-hello timeout (${helloTimeoutMs}ms) - closing socket from ${ip || '<unknown>'}`);
        emitSafe('peer.timeout', { remoteAddress: ip || null, helloTimeoutMs, reason: 'hello-timeout' });

        try { ws.close(1008, 'hello timeout'); } catch {}
        setTimeout(() => { try { ws.terminate(); } catch {} }, 500).unref?.();
      }, helloTimeoutMs);

      timer.unref?.();
    }

    pendingSockets.set(ws, { timer, addedAt: Date.now(), ip });
  }

  function untrackPending(ws) {
    const entry = pendingSockets.get(ws);
    if (!entry) return;

    clearTimeout(entry.timer);
    pendingSockets.delete(ws);
  }

  function attach(ws, req) {
    const ip = req?.socket?.remoteAddress;
    log.info(TAG, `ws connection from ${ip}`);

    ws.__kind        = null;
    ws.__secret      = null;
    ws.__outbox      = makeSocketOutbox(ws);
    ws.isAlive       = true;
    ws.on('pong', () => { ws.isAlive = true; });

    trackPending(ws, ip);

    const ctx = {
      log, hashAlgo, replayWindowMs, maxMessageBytes,
      clients, statuses, subscriptions, recentIds,
      resolveSecret, exposeRpcErrors,
      send, publishPeers, cancelQueuedRpc,
      untrackPending, emitSafe, handleServerRpc, acl,
      hubHasListeners: (event) => hub.listenerCount(event) > 0,
    };

    ws.on('message', createMessageHandler(ctx, ws));

    ws.on('close', (code, reason) => {
      untrackPending(ws);

      if (ws.__outbox) { ws.__outbox.cancelDrain(); ws.__outbox.clear(); }

      const kind = ws.__kind;

      if (kind && clients.get(kind)?.ws === ws) {
        const c = clients.get(kind);
        clients.delete(kind);
        statuses.delete(kind);
        dropSubscriptionsFor(kind);
        if (recentIds) recentIds.forget(kind);

        log.info(TAG, `${kind} disconnected`);
        publishPeers();

        emitSafe('peer.disconnect', {
          kind,
          hello:       c?.hello ? structuredClone(c.hello) : null,
          connectedAt: c?.connectedAt || null,
          code:        typeof code === 'number' ? code : undefined,
          reason:      String(reason || ''),
        });
      }
    });

    ws.on('error', (e) => {
      log.warn(TAG, `ws error${ws.__kind ? ` (${ws.__kind})` : ''}:`, e?.message || e);
      try { ws.close(); } catch {}
    });
  }

  const keepalive = setInterval(() => {
    for (const [kind, c] of clients.entries()) {
      const ws = c.ws;
      if (!ws) continue;

      if (ws.isAlive === false) {
        try { ws.terminate(); } catch {}
        clients.delete(kind);
        statuses.delete(kind);
        dropSubscriptionsFor(kind);
        if (recentIds) recentIds.forget(kind);
        publishPeers();
        emitSafe('peer.disconnect', {
          kind,
          hello:       c.hello ? structuredClone(c.hello) : null,
          connectedAt: c.connectedAt || null,
          code:        1006,
          reason:      'keepalive timeout',
        });
        continue;
      }

      ws.isAlive = false;
      try { ws.ping(); } catch {}
    }
  }, keepaliveIntervalMs);
  keepalive.unref?.();

  function stop() {
    clearInterval(keepalive);

    for (const [ws, entry] of pendingSockets.entries()) {
      clearTimeout(entry.timer);
      try { ws.close(1001, 'hub stopped'); } catch {}
    }

    pendingSockets.clear();

    for (const [, c] of clients.entries()) {
      const ws = c.ws;
      if (ws && ws.__outbox) ws.__outbox.cancelDrain();
      try { ws?.close(); } catch {}
    }

    clients.clear();
    statuses.clear();
    subscriptions.clear();

    if (recentIds) recentIds.clear();

    hub.removeAllListeners();
  }

  hub.stop     = stop;
  hub.attach   = attach;
  hub.health   = health;
  hub.getState = getState;
  
  return hub;
}

module.exports = { createHub };