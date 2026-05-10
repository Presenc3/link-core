'use strict';

const { randomUUID }   = require('crypto');
const { EventEmitter } = require('events');

const { createMessageHandler } = require('./dispatch.js');
const { makeSecretResolver }   = require('./secret-resolver.js');

const { makeMsg, DEFAULT_HASH_ALGO } = require('../protocol.js');

const { noopLogger, consoleLogger } = require('../util/log.js');
const { RecentIds }                 = require('../util/recent.js');

const {
  TAG,
  WS_OPEN,
  DEFAULT_MAX_RECENT_IDS,
  DEFAULT_HELLO_TIMEOUT_MS,
  DEFAULT_REPLAY_WINDOW_MS,
  DEFAULT_MAX_MESSAGE_BYTES,
  DEFAULT_MAX_BUFFERED_BYTES,
  DEFAULT_KEEPALIVE_INTERVAL_MS,
} = require('./constants.js');

function createHub({
  secret,
  logger,
  rpcHandlers = {},
  hashAlgo            = DEFAULT_HASH_ALGO,
  maxRecentIds        = DEFAULT_MAX_RECENT_IDS,
  replayWindowMs      = DEFAULT_REPLAY_WINDOW_MS,
  helloTimeoutMs      = DEFAULT_HELLO_TIMEOUT_MS,
  maxMessageBytes     = DEFAULT_MAX_MESSAGE_BYTES,
  maxBufferedBytes    = DEFAULT_MAX_BUFFERED_BYTES,
  keepaliveIntervalMs = DEFAULT_KEEPALIVE_INTERVAL_MS,
} = {}) {
  if (secret == null) throw new Error('createHub({ secret }) is required');

  const resolveSecret = makeSecretResolver(secret);
  const log = logger === null ? noopLogger : (logger || consoleLogger);

  const hub = new EventEmitter();

  const clients        = new Map();
  const statuses       = new Map();
  const subscriptions  = new Map();
  const pendingSockets = new Map();

  const recentIds = (replayWindowMs > 0)
    ? new RecentIds({ maxAgeMs: replayWindowMs, maxCount: maxRecentIds })
    : null;

  function emitSafe(event, payload) {
    try { hub.emit(event, payload); }
    catch (e) { log.warn(TAG, `listener for '${event}' threw:`, e?.message || e); }
  }

  function send(ws, { id = randomUUID(), type, from = 'server', to = null, data }) {
    if (!ws || ws.readyState !== WS_OPEN) return false;

    const sk = ws.__secret;

    if (!sk) {
      log.warn(TAG, `cannot send: no signing key for type=${type} (kind=${ws.__kind || '<pending>'})`);
      return false;
    }

    if (ws.bufferedAmount > maxBufferedBytes) {
      const kind = ws.__kind || '<unknown>';

      log.warn(TAG, `dropped: backpressure (kind=${kind}, type=${type}, buffered=${ws.bufferedAmount} > ${maxBufferedBytes})`);

      emitSafe('backpressure', {
        kind, type, to,
        bufferedAmount:   ws.bufferedAmount,
        maxBufferedBytes,
      });

      return false;
    }

    const msg = makeMsg(sk, { id, type, from, to, data }, hashAlgo);

    try { ws.send(JSON.stringify(msg)); return id; }
    catch (e) { log.warn(TAG, `send(${type}) failed:`, e?.message || e); return false; }
  }

  function broadcast(type, data) {
    for (const [kind, c] of clients.entries()) {
      send(c.ws, { type, to: kind, data });
    }
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

  function getState() {
    const lastStatus = {};
    for (const [k, s] of statuses.entries()) lastStatus[k] = s;

    return { peers: snapshotPeers(), lastStatus };
  }

  function health() {
    let totalSubscribers = 0;
    for (const s of subscriptions.values()) totalSubscribers += s.size;

    return {
      totalSubscribers,
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

  const builtinRpcs = {
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
  };

  async function handleServerRpc(rpcType, rpcData, msg) {
    const type    = String(rpcType || '');

    const handler = rpcHandlers[type] || builtinRpcs[type];
    if (!handler) throw new Error(`Unknown server rpcType: ${type}`);

    return handler(rpcData, msg);
  }

  function trackPending(ws, ip) {
    if (helloTimeoutMs <= 0) return;

    const timer = setTimeout(() => {
      if (!pendingSockets.has(ws)) return;

      pendingSockets.delete(ws);
      log.warn(TAG, `pre-hello timeout (${helloTimeoutMs}ms) - closing socket from ${ip || '<unknown>'}`);
      emitSafe('peer.timeout', { remoteAddress: ip || null, helloTimeoutMs });

      try { ws.close(1008, 'hello timeout'); } catch {}
      setTimeout(() => { try { ws.terminate(); } catch {} }, 500).unref?.();
    }, helloTimeoutMs);

    timer.unref?.();
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
    log.log(TAG, `ws connection from ${ip}`);

    ws.__kind   = null;
    ws.__secret = null;
    ws.isAlive  = true;
    ws.on('pong', () => { ws.isAlive = true; });

    trackPending(ws, ip);

    const ctx = {
      log, hashAlgo, replayWindowMs, maxMessageBytes,
      clients, statuses, subscriptions, recentIds,
      resolveSecret, rpcHandlers, builtinRpcs,
      send, broadcast, publishPeers, dropSubscriptionsFor,
      untrackPending, emitSafe, handleServerRpc,
    };

    ws.on('message', createMessageHandler(ctx, ws));

    ws.on('close', (code, reason) => {
      untrackPending(ws);
      const kind = ws.__kind;
      if (kind && clients.get(kind)?.ws === ws) {
        const c = clients.get(kind);
        clients.delete(kind);
        statuses.delete(kind);
        dropSubscriptionsFor(kind);
        log.log(TAG, `${kind} disconnected`);
        publishPeers();
        emitSafe('peer.disconnect', {
          kind,
          hello:       c?.hello || null,
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
        publishPeers();
        emitSafe('peer.disconnect', {
          kind,
          hello:       c.hello || null,
          connectedAt: c.connectedAt || null,
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
      try { c.ws?.close(); } catch {}
    }
    clients.clear();
    statuses.clear();
    subscriptions.clear();
    if (recentIds) recentIds.clear();
    hub.removeAllListeners();
  }

  hub.attach   = attach;
  hub.getState = getState;
  hub.health   = health;
  hub.stop     = stop;
  return hub;
}

module.exports = { createHub };