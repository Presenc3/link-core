'use strict';

const { randomUUID } = require('crypto');
const { makeMsg, verify } = require('./protocol.js');

const TAG = 'link-core:hub';

const KEEPALIVE_INTERVAL_MS = 15_000;
const WS_OPEN = 1;

const noopLogger    = { log: () => {}, warn: () => {} };
const consoleLogger = {
  log:  (fn, ...args) => console.log(`[${fn}]`,  ...args),
  warn: (fn, ...args) => console.warn(`[${fn}]`, ...args),
};

function createHub({ secret, serverRpcHandlers = {}, logger } = {}) {
  if (!secret) throw new Error('createHub({ secret }) is required');
  const log = logger === null ? noopLogger : (logger || consoleLogger);

  const clients  = new Map();
  const statuses = new Map();

  function send(ws, { id = randomUUID(), type, from = 'server', to = null, data }) {
    const msg = makeMsg(secret, { id, type, from, to, data });
    try { ws.send(JSON.stringify(msg)); }
    catch (e) { log.warn(TAG, `send(${type}) failed:`, e?.message || e); }
    return id;
  }

  function broadcast(type, data) {
    for (const [kind, c] of clients.entries()) {
      if (!c.ws || c.ws.readyState !== WS_OPEN) continue;
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

  async function handleServerRpc(rpcType, rpcData, msg) {
    const type    = String(rpcType || '');
    const handler = serverRpcHandlers[type];
    if (!handler) throw new Error(`Unknown server rpcType: ${type}`);
    return handler(rpcData, msg);
  }

  function attach(ws, req) {
    const ip = req?.socket?.remoteAddress;
    log.log(TAG, `ws connection from ${ip}`);

    ws.__kind = null;
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (!verify(secret, msg)) {
        log.warn(TAG, `dropped message: bad signature (type=${msg?.type})`);
        return;
      }

      const type = msg.type;

      if (type === 'hello') {
        const kind = String(msg.data?.kind || '').trim();
        if (!kind) {
          send(ws, { type: 'hello.ack', data: { ok: false, error: 'missing kind' } });
          try { ws.close(); } catch {}
          return;
        }

        const existing = clients.get(kind);
        if (existing?.ws && existing.ws !== ws) {
          try { existing.ws.close(); } catch {}
        }

        ws.__kind = kind;
        clients.set(kind, { ws, hello: msg.data, connectedAt: Date.now() });
        log.log(TAG, `hello from ${kind}`);

        send(ws, {
          type: 'hello.ack',
          to:   kind,
          data: { ok: true, serverTime: Date.now(), kind },
        });

        publishPeers();

        const statusSnap = {};
        for (const [k, s] of statuses.entries()) statusSnap[k] = s;
        send(ws, { type: 'status.snapshot', to: kind, data: statusSnap });
        return;
      }

      const from = ws.__kind || null;
      if (!from) return;

      if (type === 'status.update') {
        const at = Date.now();
        statuses.set(from, { status: msg.data, at });
        broadcast('status.update', { from, status: msg.data, at });
        return;
      }

      if (type === 'rpc.request') {
        const to      = msg.to ? String(msg.to) : null;
        const rpcType = msg.data?.rpcType;
        const rpcData = msg.data?.rpcData;

        // hub-handled
        if (to === 'server') {
          try {
            const result = await handleServerRpc(rpcType, rpcData, msg);
            send(ws, {
              id:   msg.id,
              type: 'rpc.response',
              to:   from,
              data: { ok: true, result },
            });
          } catch (e) {
            log.warn(TAG, `server rpc '${rpcType}' failed:`, e?.message || e);
            send(ws, {
              id:   msg.id,
              type: 'rpc.response',
              to:   from,
              data: { ok: false, error: e?.message || String(e) },
            });
          }
          return;
        }

        // peer-routed
        if (!to) {
          send(ws, {
            id:   msg.id,
            type: 'rpc.response',
            to:   from,
            data: { ok: false, error: 'rpc.request missing "to"' },
          });
          return;
        }

        const target = clients.get(to);
        if (!target?.ws || target.ws.readyState !== WS_OPEN) {
          send(ws, {
            id:   msg.id,
            type: 'rpc.response',
            to:   from,
            data: { ok: false, error: `Target not connected: ${to}` },
          });
          return;
        }

        const fwd = makeMsg(secret, {
          id:   msg.id,
          type: 'rpc.request',
          from, to,
          data: { rpcType, rpcData },
        });
        try { target.ws.send(JSON.stringify(fwd)); }
        catch (e) { log.warn(TAG, 'rpc.request forward failed:', e?.message || e); }
        return;
      }

      if (type === 'rpc.response') {
        const to = msg.to ? String(msg.to) : null;
        if (!to) return;

        const target = clients.get(to);
        if (!target?.ws || target.ws.readyState !== WS_OPEN) return;

        const fwd = makeMsg(secret, {
          id:   msg.id,
          type: 'rpc.response',
          from, to,
          data: msg.data,
        });
        try { target.ws.send(JSON.stringify(fwd)); }
        catch (e) { log.warn(TAG, 'rpc.response forward failed:', e?.message || e); }
        return;
      }
    });

    ws.on('close', () => {
      const kind = ws.__kind;
      if (kind && clients.get(kind)?.ws === ws) {
        clients.delete(kind);
        log.log(TAG, `${kind} disconnected`);
        publishPeers();
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
        publishPeers();
        continue;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch {}
    }
  }, KEEPALIVE_INTERVAL_MS);
  keepalive.unref?.();

  function stop() {
    clearInterval(keepalive);
    for (const [, c] of clients.entries()) {
      try { c.ws?.close(); } catch {}
    }
    clients.clear();
    statuses.clear();
  }

  return { attach, getState, stop };
}

module.exports = { createHub };