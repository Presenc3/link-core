'use strict';

const WebSocket = require('ws');
const { randomUUID } = require('crypto');
const { makeMsg, verify } = require('./protocol.js');

const TAG = 'link-core';

const DEFAULT_RPC_TIMEOUT_MS = 5_000;
const STATUS_INTERVAL_MS     = 10_000;
const RECONNECT_INITIAL_MS   = 1_000;
const RECONNECT_MAX_MS       = 10_000;
const RECONNECT_GROWTH       = 1.5;

const noopLogger    = { log: () => {}, warn: () => {} };
const consoleLogger = {
  log:  (fn, ...args) => console.log(`[${fn}]`,  ...args),
  warn: (fn, ...args) => console.warn(`[${fn}]`, ...args),
};

class LinkBusClient {
  constructor({ url, secret, kind, name, makeStatus, rpcHandlers = {}, logger }) {
    this.url         = url;
    this.secret      = secret;
    this.kind        = kind;
    this.name        = name || kind;
    this.makeStatus  = makeStatus;
    this.rpcHandlers = rpcHandlers;
    this.log         = logger === null ? noopLogger : (logger || consoleLogger);

    this.ws             = null;
    this.reconnectMs    = RECONNECT_INITIAL_MS;
    this._stopped       = false;
    this.statusTimer    = null;
    this.reconnectTimer = null;

    this.pending          = new Map();
    this.peers            = [];
    this.lastStatusByPeer = new Map();
  }

  start() {
    if (!this.url || !this.secret || !this.kind) {
      this.log.warn(TAG, 'start(): disabled (missing url/secret/kind)');
      return;
    }
    this._stopped = false;
    this._connect();
  }

  stop() {
    this._stopped = true;
    try { this.ws?.close(); } catch {}
    if (this.statusTimer)    { clearInterval(this.statusTimer);  this.statusTimer = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    for (const [, p] of this.pending) clearTimeout(p.timeout);
    this.pending.clear();
  }

  isConnected() { return !!this.ws && this.ws.readyState === WebSocket.OPEN; }
  getPeers()    { return this.peers; }
  getPeerStatus(kind) { return this.lastStatusByPeer.get(kind) || null; }

  rpc(to, rpcType, rpcData, timeoutMs = DEFAULT_RPC_TIMEOUT_MS) {
    if (!this.isConnected()) return Promise.reject(new Error('Link not connected'));

    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout after ${timeoutMs}ms: ${to}:${rpcType}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timeout });

      const msg = makeMsg(this.secret, {
        id, type: 'rpc.request', from: this.kind, to,
        data: { rpcType, rpcData },
      });

      try {
        this.ws.send(JSON.stringify(msg));
      } catch (e) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  _send(type, data, to = null, id = randomUUID()) {
    if (!this.isConnected()) return;
    const msg = makeMsg(this.secret, { id, type, from: this.kind, to, data });
    try { this.ws.send(JSON.stringify(msg)); }
    catch (e) { this.log.warn(TAG, `_send(${type}) failed:`, e?.message || e); }
  }

  _connect() {
    this.ws = new WebSocket(this.url);

    this.ws.on('open', () => {
      this.reconnectMs = RECONNECT_INITIAL_MS;

      this._send('hello', {
        kind: this.kind, name: this.name,
        pid: process.pid, startedAt: Date.now(),
      });

      if (this.makeStatus) {
        const push = () => {
          try { this._send('status.update', this.makeStatus()); }
          catch (e) { this.log.warn(TAG, 'makeStatus() threw:', e?.message || e); }
        };
        push();
        this.statusTimer = setInterval(push, STATUS_INTERVAL_MS);
      }

      this.log.log(TAG, `connected (${this.kind}) -> ${this.url}`);
    });

    this.ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (!verify(this.secret, msg)) {
        this.log.warn(TAG, `dropped message: bad signature (type=${msg?.type})`);
        return;
      }

      switch (msg.type) {
        case 'peers.update':
          this.peers = msg.data?.peers || [];
          return;

        case 'status.snapshot': {
          const snap = msg.data || {};
          for (const k of Object.keys(snap)) this.lastStatusByPeer.set(k, snap[k]);
          return;
        }

        case 'status.update': {
          const { from, status, at } = msg.data || {};
          if (from) this.lastStatusByPeer.set(from, { status, at });
          return;
        }

        case 'rpc.request':
          this._handleRpcRequest(msg).catch((e) =>
            this.log.warn(TAG, 'rpc.request handler crashed:', e?.message || e));
          return;

        case 'rpc.response': {
          const p = this.pending.get(msg.id);
          if (!p) {
            this.log.warn(TAG, `rpc.response ${String(msg.id).slice(0, 8)} no pending handler (timed out?)`);
            return;
          }
          clearTimeout(p.timeout);
          this.pending.delete(msg.id);

          if (msg.data?.ok) p.resolve(msg.data.result);
          else              p.reject(new Error(msg.data?.error || 'RPC error'));
          return;
        }
      }
    });

    this.ws.on('error', (e) => {
      this.log.warn(TAG, `ws error (${this.kind}):`, e?.message || e);
    });

    this.ws.on('close', () => {
      if (this.statusTimer) { clearInterval(this.statusTimer); this.statusTimer = null; }
      if (this._stopped) return;

      this.log.log(TAG, `disconnected (${this.kind}), reconnecting in ${Math.round(this.reconnectMs)}ms…`);

      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.reconnectMs = Math.min(this.reconnectMs * RECONNECT_GROWTH, RECONNECT_MAX_MS);
        this._connect();
      }, this.reconnectMs);
    });
  }

  async _handleRpcRequest(msg) {
    const { rpcType, rpcData } = msg.data || {};
    const type = String(rpcType || '');
    try {
      const handler = this.rpcHandlers[type];
      if (!handler) throw new Error(`Unknown rpcType: ${type}`);
      const result = await handler(rpcData, msg);
      this._send('rpc.response', { ok: true, result }, msg.from, msg.id);
    } catch (e) {
      this._send('rpc.response', { ok: false, error: e?.message || String(e) }, msg.from, msg.id);
    }
  }
}

module.exports = { LinkBusClient };