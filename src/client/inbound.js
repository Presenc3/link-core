'use strict';

const { TAG } = require('./constants.js');
const { verify, PROTOCOL_VERSION } = require('../protocol.js');
const { RpcRemoteError, RpcDisconnectError } = require('../internal/errors.js');

function handleInboundMessage(client, raw) {
  if (raw.length > client.maxMessageBytes) {
    client.log.warn(TAG, `dropped: message too large (${raw.length} bytes > ${client.maxMessageBytes})`);
    client.emit('protocol-error', { reason: 'oversize', size: raw.length });
    return;
  }

  let msg;
  try { msg = JSON.parse(String(raw)); }
  catch (e) {
    client.log.warn(TAG, `dropped: parse error`);
    client.emit('protocol-error', { reason: 'parse-error', error: e });
    return;
  }

  if (typeof msg?.id !== 'string' || msg.id.length === 0) {
    client.log.warn(TAG, `dropped: missing or empty id (type=${msg?.type})`);
    client.emit('protocol-error', { reason: 'missing-id', type: msg?.type });
    return;
  }

  if (!verify(client.secret, msg, client.hashAlgo)) {
    if (!client._verifiedAny) {
      client.log.warn(TAG, `signature verification failed before any verified message - likely secret mismatch with the hub (type=${msg?.type})`);
    } else {
      client.log.warn(TAG, `dropped message: bad signature (type=${msg?.type})`);
    }
    client.emit('protocol-error', { reason: 'bad-signature', type: msg?.type, msg });
    return;
  }

  if (msg.v !== PROTOCOL_VERSION) {
    client.log.warn(TAG, `dropped message: unsupported protocol version v=${msg?.v} (expected ${PROTOCOL_VERSION}, type=${msg?.type})`);
    client.emit('protocol-error', { reason: 'bad-version', type: msg?.type, msg });
    return;
  }

  if (client.replayWindowMs > 0) {
    const skew = Math.abs(Date.now() - (typeof msg.ts === 'number' ? msg.ts : 0));

    if (skew > client.replayWindowMs) {
      client.log.warn(TAG, `dropped message: timestamp out of replay window (skew=${skew}ms, type=${msg?.type})`);
      client.emit('protocol-error', { reason: 'replay-window', type: msg?.type, msg, skew });
      return;
    }
  }

  if (client.recentIds && msg.type !== 'rpc.response') {
    const senderKind = msg.from || 'server';
    const cacheKey   = `${senderKind}|${msg.id}`;

    if (client.recentIds.has(cacheKey)) {
      client.log.warn(TAG, `dropped message: replay of id ${String(msg.id).slice(0, 8)} from ${senderKind} (type=${msg?.type})`);
      client.emit('protocol-error', { reason: 'replay-id', type: msg?.type, msg });
      return;
    }

    client.recentIds.add(cacheKey);
  }

  if (!client._verifiedAny) {
    client._verifiedAny = true;
    if (client.helloAckTimer) {
      clearTimeout(client.helloAckTimer);
      client.helloAckTimer = null;
    }
    client.emit('verified', { kind: client.kind });
  }

  client._lastVerifiedAt = Date.now();

  const isHelloAck  = msg.type === 'hello.ack';
  const helloOk     = msg.data?.ok;
  const rejectedNow = isHelloAck && helloOk === false;

  if (rejectedNow) {
    const reason = msg.data?.error || 'hello rejected';
    client.log.warn(TAG, `hub rejected hello: ${reason}`);
    client.emit('rejected', { reason, error: msg.data?.error || null });
    if (!client.reconnectOnRejection) client.stop();
    return;
  }

  if (!client._ready) {
    client._ready = true;
    client.reconnectMs = client.reconnectInitialMs;
    client._reconnectAttempt = 0;

    if (isHelloAck) {
      client.hubFeatures = Array.isArray(msg.data?.features) ? msg.data.features : [];
    } else if (client.hubFeatures === null) {
      client.hubFeatures = [];
    }

    for (const topic of client._subscriptions.keys()) {
      client._send('topic.subscribe', { topic });
    }

    if (client.makeStatus && !client.statusTimer) {
      const push = () => {
        try { client._send('status.update', client.makeStatus()); }
        catch (e) { client.log.warn(TAG, 'makeStatus() threw:', e?.message || e); }
      };
      push();
      client.statusTimer = setInterval(push, client.statusIntervalMs);
    }

    client.emit('ready', { kind: client.kind, features: client.hubFeatures });
  }

  client.emit('message', { msg, raw });

  switch (msg.type) {
    case 'peers.update': {
      const newPeers = msg.data?.peers || [];

      const oldByKind = new Map(client.peers.map((p) => [p.kind, p]));
      const newByKind = new Map(newPeers.map((p) => [p.kind, p]));

      const events = [];

      for (const np of newPeers) {
        const op = oldByKind.get(np.kind);
        if (!op) {
          events.push(['peer.connect', np]);
        } else if (op.connectedAt !== np.connectedAt) {
          events.push(['peer.replaced', { kind: np.kind, prevPeer: op, peer: np }]);
        }
      }
      for (const op of client.peers) {
        if (!newByKind.has(op.kind)) {
          events.push(['peer.disconnect', op]);
        }
      }

      client.peers = newPeers;

      for (const [evt, payload] of events) client.emit(evt, payload);
      return;
    }

    case 'status.snapshot': {
      const snap = msg.data || {};
      for (const k of Object.keys(snap)) client.lastStatusByPeer.set(k, snap[k]);
      return;
    }

    case 'status.update': {
      const { from, status, at } = msg.data || {};
      if (from) {
        client.lastStatusByPeer.set(from, { status, at });
        client.emit('peer.status', { from, status, at });
      }
      return;
    }

    case 'rpc.request':
      client.emit('rpc.request', {
        from:    msg.from,
        rpcType: msg.data?.rpcType,
        rpcData: msg.data?.rpcData,
        msg,
      });
      client._handleRpcRequest(msg).catch((e) =>
        client.log.warn(TAG, 'rpc.request handler crashed:', e?.message || e));
      return;

    case 'rpc.response': {
      const p = client.pending.get(msg.id);
      if (!p) {
        client.log.warn(TAG, `rpc.response ${String(msg.id).slice(0, 8)} no pending handler (timed out?)`);
        return;
      }
      clearTimeout(p.timeout);
      if (p.cleanupAbort) p.cleanupAbort();
      client.pending.delete(msg.id);

      if (msg.data?.ok) {
        p.resolve(msg.data.result);
        client._emitRpcComplete(p, true, null, null);
      } else {
        const err = new RpcRemoteError(msg.data?.error || 'RPC error', {
          to: p.to, rpcType: p.rpcType, id: p.id,
        });
        p.reject(err);
        client._emitRpcComplete(p, false, 'remote-error', err);
      }
      return;
    }

    case 'topic.message': {
      const { topic, payload } = msg.data || {};
      if (typeof topic !== 'string' || !topic) return;

      const handlers = client._subscriptions.get(topic);
      if (!handlers || handlers.size === 0) return;

      for (const h of handlers) {
        try {
          const r = h(payload, msg);
          if (r && typeof r.then === 'function') {
            r.catch((e) => client.log.warn(TAG, `topic handler for '${topic}' threw:`, e?.message || e));
          }
        } catch (e) {
          client.log.warn(TAG, `topic handler for '${topic}' threw:`, e?.message || e);
        }
      }
      return;
    }

    case 'direct': {
      const directType = msg.data?.directType;
      const directData = msg.data?.directData;
      if (typeof directType !== 'string' || !directType) return;

      client.emit('direct', { from: msg.from, type: directType, data: directData, msg });
      return;
    }
  }
}

function handleClose(client, code, reason) {
  if (client.statusTimer)   { clearInterval(client.statusTimer); client.statusTimer = null; }
  if (client.helloAckTimer) { clearTimeout(client.helloAckTimer); client.helloAckTimer = null; }

  const wasReady = client._ready;

  client._ready = false;
  client.hubFeatures = null;

  if (!client._stopped && client.pending.size > 0) {
    for (const [, p] of client.pending) {
      clearTimeout(p.timeout);
      if (p.cleanupAbort) p.cleanupAbort();

      const err = new RpcDisconnectError(
        'Link disconnected before RPC completed',
        { to: p.to, rpcType: p.rpcType, id: p.id },
      );

      p.reject(err);
      client.emit('rpc.disconnect', { id: p.id, to: p.to, rpcType: p.rpcType });
      client._emitRpcComplete(p, false, 'disconnect', err);
    }

    client.pending.clear();
  }

  client.emit('disconnect', {
    code:          typeof code === 'number' ? code : undefined,
    reason:        String(reason || ''),
    willReconnect: !client._stopped,
    wasReady,
  });

  if (client._stopped) return;

  client.log.log(TAG, `disconnected (${client.kind}), reconnecting in ${Math.round(client.reconnectMs)}ms…`);

  client._reconnectAttempt += 1;
  const j       = client.reconnectJitter;
  const baseMs  = client.reconnectMs;
  const delayMs = Math.max(0, baseMs * (1 - j / 2 + Math.random() * j));
  const attempt = client._reconnectAttempt;
  client.emit('reconnecting', { delayMs, attempt });

  client.reconnectTimer = setTimeout(() => {
    client.reconnectTimer = null;
    client.reconnectMs = Math.min(client.reconnectMs * client.reconnectGrowth, client.reconnectMaxMs);
    client._connect();
  }, delayMs);
}

module.exports = { handleInboundMessage, handleClose };