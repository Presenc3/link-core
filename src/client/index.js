'use strict';

const   WebSocket      = require('ws');
const { randomUUID   } = require('crypto');
const { EventEmitter } = require('events');

const { handleInboundMessage, handleClose } = require('./inbound.js');

const {
  TAG,
  DEFAULT_RECONNECT_GROWTH,
  DEFAULT_RECONNECT_INITIAL_MS,
  DEFAULT_RPC_TIMEOUT_MS,
  DEFAULT_HELLO_ACK_DIAGNOSTIC_MS,
  DEFAULT_MAX_RECENT_IDS,
  DEFAULT_RECONNECT_MAX_MS,
  DEFAULT_STATUS_INTERVAL_MS,
  DEFAULT_MAX_MESSAGE_BYTES,
  DEFAULT_REPLAY_WINDOW_MS,
  DEFAULT_MAX_BUFFERED_BYTES,
} = require('./constants.js');

const {
  makeMsg, assertValidTopic, DEFAULT_HASH_ALGO,
} = require('../protocol.js');

const {
  RpcAbortError,
  RpcTimeoutError,       RpcDisconnectError,
  BackpressureError,     HelloRejectedError,
  LinkNotReadyError,     FeatureUnsupportedError,
} = require('../util/errors.js');

const { RecentIds } = require('../util/recent.js');
const { noopLogger, consoleLogger } = require('../util/log.js');

class LinkClient extends EventEmitter {
  constructor({
    url, secret, kind, name,
    makeStatus,
    rpcHandlers = {},
    logger,
    perMessageDeflate     = false,
    reconnectOnRejection  = false,
    hashAlgo              = DEFAULT_HASH_ALGO,
    maxRecentIds          = DEFAULT_MAX_RECENT_IDS,
    defaultRpcTimeoutMs   = DEFAULT_RPC_TIMEOUT_MS,
    reconnectMaxMs        = DEFAULT_RECONNECT_MAX_MS,
    reconnectGrowth       = DEFAULT_RECONNECT_GROWTH,
    replayWindowMs        = DEFAULT_REPLAY_WINDOW_MS,
    maxMessageBytes       = DEFAULT_MAX_MESSAGE_BYTES,
    maxBufferedBytes      = DEFAULT_MAX_BUFFERED_BYTES,
    statusIntervalMs      = DEFAULT_STATUS_INTERVAL_MS,
    reconnectInitialMs    = DEFAULT_RECONNECT_INITIAL_MS,
    helloAckDiagnosticMs  = DEFAULT_HELLO_ACK_DIAGNOSTIC_MS
  } = {}) {
    super();

    this.url         = url;
    this.kind        = kind;
    this.secret      = secret;
    this.makeStatus  = makeStatus;
    this.name        = name || kind;
    this.rpcHandlers = Object.assign({}, rpcHandlers || {});
    this.log         = logger === null ? noopLogger : (logger || consoleLogger);
    this.hashAlgo             = hashAlgo;
    this.reconnectMaxMs       = reconnectMaxMs;
    this.replayWindowMs       = replayWindowMs;
    this.reconnectGrowth      = reconnectGrowth;
    this.maxMessageBytes      = maxMessageBytes;
    this.statusIntervalMs     = statusIntervalMs;
    this.maxBufferedBytes     = maxBufferedBytes;
    this.perMessageDeflate    = perMessageDeflate;
    this.reconnectInitialMs   = reconnectInitialMs;
    this.defaultRpcTimeoutMs  = defaultRpcTimeoutMs;
    this.helloAckDiagnosticMs = helloAckDiagnosticMs;
    this.reconnectOnRejection = reconnectOnRejection;

    this.recentIds = (replayWindowMs > 0) ? new RecentIds({
      maxCount: maxRecentIds,
      maxAgeMs: replayWindowMs
    }) : null;

    this._reconnectAttempt = 0;
    this.peers             = [];
    this.hubFeatures       = null;
    this.ws                = null;
    this.statusTimer       = null;
    this.reconnectTimer    = null;
    this.helloAckTimer     = null;
    this._lastVerifiedAt   = null;
    this._stopped          = false;
    this._verifiedAny      = false;
    this._ready            = false;
    this.pending           = new Map();
    this.lastStatusByPeer  = new Map();
    this._subscriptions    = new Map();
    this.reconnectMs       = reconnectInitialMs;
  }

  // === Lifecycle ========================================================

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

  stop() {
    // Capture state BEFORE clearing flags so we can emit a sensible
    // 'disconnect' if we were ready. This mirrors what handleClose() would
    // emit if the close handler had run naturally - but stop() detaches
    // listeners first, so the close handler never fires and we have to
    // reproduce the bookkeeping here.
    const wasReady = this._ready;

    this._stopped     = true;
    this._ready       = false;
    this._verifiedAny = false;

    if (this.ws) {
      this._detachWs(this.ws);
      try { this.ws.close(); } catch {};
    }

    if (this.statusTimer)    { clearInterval(this.statusTimer);    this.statusTimer    = null; }
    if (this.reconnectTimer) { clearTimeout( this.reconnectTimer); this.reconnectTimer = null; }
    if (this.helloAckTimer)  { clearTimeout( this.helloAckTimer);  this.helloAckTimer  = null; }

    for (const [, p] of this.pending) {
      clearTimeout(p.timeout);

      if (p.cleanupAbort) p.cleanupAbort();

      const err = new RpcDisconnectError('Link stopped before RPC completed', {
        to: p.to, rpcType: p.rpcType, id: p.id,
      });

      p.reject(err);
      this._emitRpcComplete(p, false, 'disconnect', err);
    }

    this.pending.clear();

    // Only emit 'disconnect' if we were actually ready - calling stop() on a
    // never-started or pre-ready client should be a quiet teardown.
    if (wasReady) {
      try {
        this.emit('disconnect', {
          reason:        'stopped',
          willReconnect: false,
          wasReady:      true,
        });
      } catch (e) {
        this.log.warn(TAG, "'disconnect' listener threw on stop():", e?.message || e);
      }
    }
  }

  _detachWs(ws) {
    if (!ws) return;

    try { ws.removeAllListeners('open');    } catch {}
    try { ws.removeAllListeners('close');   } catch {}
    try { ws.removeAllListeners('message'); } catch {}
    try { ws.removeAllListeners('error');   } catch {}
    try { ws.on('error', () => {});         } catch {}
  }

  // === Status / introspection ===========================================

  isConnected() { return !!this.ws && this.ws.readyState === WebSocket.OPEN; }
  isReady()     { return this._ready; }
  getPeers()    { return this.peers;  }
  getPeerStatus(kind) { return this.lastStatusByPeer.get(kind) || null; }

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
      bufferedAmount    : this.ws ? (this.ws.bufferedAmount || 0) : 0
    };
  }

  // === Fire-and-forget primitives =======================================

  send(to, type, data) {
    if (typeof to !== 'string' || !to
     ) throw new TypeError('send(to, type, data): "to" must be a non-empty string');

    if (typeof type !== 'string' || !type
     ) throw new TypeError('send(to, type, data): "type" must be a non-empty string');

    if (!this.isConnected() || !this._ready
     ) throw new LinkNotReadyError(
      'Cannot send: link not connected/ready',
      { op: 'send' },
    );

    if (Array.isArray(this.hubFeatures) && !this.hubFeatures.includes('direct')
     ) throw new FeatureUnsupportedError(
      'Cannot send: hub does not support directed fire-and-forget ' +
      '(upgrade hub to v0.4+)',
      { op: 'send', feature: 'direct' },
    );

    return this._send('direct', { directType: type, directData: data }, to) !== false;
  }

  publish(topic, payload) {
    assertValidTopic(topic);

    if (!this.isConnected() || !this._ready
     ) throw new LinkNotReadyError(
      'Cannot publish: link not connected/ready',
      { op: 'publish' },
    );

    if (Array.isArray(this.hubFeatures) && !this.hubFeatures.includes('topics')
     ) throw new FeatureUnsupportedError(
      'Cannot publish: hub does not support topics (upgrade hub to v0.4+)',
      { op: 'publish', feature: 'topics' },
    );

    return this._send('topic.message', { topic, payload }) !== false;
  }

  // === Subscriptions ====================================================

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

  // === RPC handler registry =============================================

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
    if (!this.rpcHandlers || !(rpcType in this.rpcHandlers)) return false;
    delete this.rpcHandlers[rpcType];
    return true;
  }

  // === Awaiters (waitFor / ready) =======================================

  waitFor(event, opts = {}) {
    const { timeoutMs = 0, signal } = opts;

    return new Promise((resolve, reject) => {
      let settled = false;
      let timer   = null;
      let onAbort = null;

      const cleanup = () => {
        settled = true;

        if (timer) clearTimeout(timer);
        try { this.off(event, onEvent); } catch {}

        if (onAbort && signal) {
          try { signal.removeEventListener('abort', onAbort); } catch {}
        }
      };

      const onEvent = (...args) => {
        if (settled) return;
        cleanup();
        resolve(args.length <= 1 ? args[0] : args);
      };

      this.on(event, onEvent);

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (settled) return;

          cleanup();
          reject(new Error(`waitFor('${event}') timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref?.();
      }

      if (signal) {
        if (signal.aborted) {
          cleanup();

          const err = new Error(`waitFor('${event}') aborted`);
          err.name = 'AbortError';

          reject(err);
          return;
        }

        onAbort = () => {
          if (settled) return;

          cleanup();

          const err = new Error(`waitFor('${event}') aborted`);
          err.name = 'AbortError';

          reject(err);
        };

        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  ready(opts = {}) {
    const { timeoutMs = 0, signal } = opts;

    if (this._ready
     ) return Promise.resolve({ kind: this.kind, features: this.hubFeatures });

    if (signal && signal.aborted) {
      const err = new Error(`ready() aborted`);
      err.name = 'AbortError';

      return Promise.reject(err);
    }

    // After stop(), ready() should reject fast rather than hang or quietly
    // resurrect the client. Callers who want to restart should call start()
    // explicitly.
    if (this._stopped) {
      return Promise.reject(new LinkNotReadyError(
        'ready(): link has been stopped - call start() to reconnect',
        { op: 'ready' },
      ));
    }

    if (!this.ws && !this._stopped) this.start();

    return new Promise((resolve, reject) => {
      let settled = false;
      let timer   = null;
      let onAbort = null;

      const cleanup = () => {
        settled = true;

        if (timer) clearTimeout(timer);

        this.off('ready',    onReady);
        this.off('rejected', onRejected);

        if (onAbort && signal) {
          try { signal.removeEventListener('abort', onAbort); } catch {}
        }
      };

      const onReady = (info) => {
        if (settled) return;

        cleanup();
        resolve(info);
      };

      const onRejected = (info) => {
        if (settled) return;

        cleanup();

        reject(new HelloRejectedError(
          info?.error || 'Hub rejected hello',
          { reason: info?.error || null },
        ));
      };

      this.on('ready',    onReady);
      this.on('rejected', onRejected);

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (settled) return;

          cleanup();
          reject(new Error(`ready() timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref?.();
      }

      if (signal) {
        onAbort = () => {
          if (settled) return;

          cleanup();

          const err = new Error('ready() aborted');
          err.name = 'AbortError';
          reject(err);
        };

        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  // === RPC ==============================================================

  rpc(to, rpcType, rpcData, optsOrTimeoutMs) {
    const opts = (typeof optsOrTimeoutMs === 'number')
      ? { timeoutMs: optsOrTimeoutMs }
      : (optsOrTimeoutMs || {});

    const timeoutMs = (typeof opts.timeoutMs === 'number')
      ? opts.timeoutMs
      : this.defaultRpcTimeoutMs;

    const signal    = opts.signal;
    const id        = randomUUID();
    const startedAt = Date.now();
    const tele      = { id, to, rpcType, startedAt };

    if (signal && signal.aborted) {
      const err = new RpcAbortError(
        `RPC aborted before send: ${to}:${rpcType}`,
        { to, rpcType, id },
      );

      this._emitRpcComplete(tele, false, 'abort', err);

      return Promise.reject(err);
    }

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

    if (this.ws.bufferedAmount > this.maxBufferedBytes) {
      this.emit('backpressure', {
        type: 'rpc.request',
        rpcType, to,
        bufferedAmount: this.ws.bufferedAmount,
      });

      const err = new BackpressureError(
        `RPC backpressure: hub send buffer full ` +
        `(${this.ws.bufferedAmount} > ${this.maxBufferedBytes} bytes): ${to}:${rpcType}`,
        {
          type: 'rpc.request', to, rpcType, id,
          bufferedAmount:   this.ws.bufferedAmount,
          maxBufferedBytes: this.maxBufferedBytes,
        },
      );

      this._emitRpcComplete(tele, false, 'backpressure', err);

      return Promise.reject(err);
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const p = this.pending.get(id);

        this.pending.delete(id);
        if (p?.cleanupAbort) p.cleanupAbort();

        this.emit('rpc.timeout', { id, to, rpcType, timeoutMs });

        const err = new RpcTimeoutError(
          `RPC timeout after ${timeoutMs}ms: ${to}:${rpcType}`,
          { to, rpcType, id, timeoutMs },
        );

        this._emitRpcComplete(tele, false, 'timeout', err);

        reject(err);
      }, timeoutMs);

      let cleanupAbort = null;

      if (signal) {
        const onAbort = () => {
          if (!this.pending.has(id)) return;

          clearTimeout(timeout);
          this.pending.delete(id);

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

      const msg = makeMsg(this.secret, {
        id, type: 'rpc.request', from: this.kind, to,
        data: { rpcType, rpcData },
      }, this.hashAlgo);

      try {
        this.ws.send(JSON.stringify(msg));
      } catch (e) {
        clearTimeout(timeout);
        this.pending.delete(id);
        if (cleanupAbort) cleanupAbort();
        this._emitRpcComplete(tele, false, 'send-error', e);
        reject(e);
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
        durationMs: p.startedAt ? (Date.now() - p.startedAt) : null,
        error:     ok ? null : (err?.message || String(err || '')),
      });
    } catch (e) {
      this.log.warn(TAG, 'rpc.complete listener threw:', e?.message || e);
    }
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

  // === Private send + connect ===========================================

  _send(type, data, to = null, id = randomUUID()) {
    if (!this.isConnected()) return false;

    if (this.ws.bufferedAmount > this.maxBufferedBytes) {
      this.log.warn(TAG, `dropped: backpressure (type=${type}, buffered=${this.ws.bufferedAmount} > ${this.maxBufferedBytes})`);
      this.emit('backpressure', { type, to, bufferedAmount: this.ws.bufferedAmount });
      return false;
    }

    const msg = makeMsg(this.secret, { id, type, from: this.kind, to, data }, this.hashAlgo);
    try { this.ws.send(JSON.stringify(msg)); return true; }
    catch (e) { this.log.warn(TAG, `_send(${type}) failed:`, e?.message || e); return false; }
  }

  _connect() {
    this.ws = new WebSocket(this.url, {
      maxPayload:        this.maxMessageBytes,
      perMessageDeflate: this.perMessageDeflate,
    });

    this.ws.on('open', () => {
      this._verifiedAny = false;
      this._ready       = false;
      this.hubFeatures  = null;

      this._send('hello', {
        kind: this.kind, name: this.name,
        pid: process.pid, startedAt: Date.now(),
      });

      if (this.helloAckDiagnosticMs > 0) {
        if (this.helloAckTimer) clearTimeout(this.helloAckTimer);
        this.helloAckTimer = setTimeout(() => {
          this.helloAckTimer = null;
          if (!this._verifiedAny && this.isConnected()) {
            this.log.warn(TAG, `no verified message within ${this.helloAckDiagnosticMs}ms of connect - likely secret mismatch with the hub`);
            this.emit('protocol-error', { reason: 'no-ack' });
          }
        }, this.helloAckDiagnosticMs);
        this.helloAckTimer.unref?.();
      }

      this.log.log(TAG, `connected (${this.kind}) -> ${this.url}`);
      this.emit('connect', { url: this.url, kind: this.kind });
    });

    this.ws.on('message', (raw) => handleInboundMessage(this, raw));

    this.ws.on('error', (e) => {
      this.log.warn(TAG, `ws error (${this.kind}):`, e?.message || e);
      this.emit('ws-error', e);
    });

    this.ws.on('close', (code, reason) => handleClose(this, code, reason));
  }
}

module.exports = { LinkClient };