'use strict';

const { verify, PROTOCOL_VERSION } = require('../protocol.js');

const {
  RpcRemoteError, RpcDisconnectError,
} = require('../util/errors.js');

const { TAG } = require('./constants.js');

/**
 * Handle a single raw frame from the hub. Runs the six-step verification
 * chain (size, parse, signature, version, replay window, replay id), then
 * does first-verified-message bookkeeping (clearing the hello-ack diagnostic
 * timer, transitioning to ready, replaying subscriptions, starting the
 * status push timer), then dispatches by `msg.type`.
 *
 * Pulled out of `LinkClient._connect()`'s `ws.on('message', ...)` so the
 * class file isn't dominated by ~200 lines of inline message handling.
 * Mutates the client via documented internal fields - this is "the same
 * code, just in a different file".
 */
function handleInboundMessage(client, raw) {
  // 1. Defensive size check
  if (raw.length > client.maxMessageBytes) {
    client.log.warn(TAG, `dropped: message too large (${raw.length} bytes > ${client.maxMessageBytes})`);
    client.emit('protocol-error', { reason: 'oversize', size: raw.length });
    return;
  }

  // 2. Parse
  let msg;
  try { msg = JSON.parse(String(raw)); }
  catch (e) {
    client.log.warn(TAG, `dropped: parse error`);
    client.emit('protocol-error', { reason: 'parse-error', error: e });
    return;
  }

  // 3. Signature
  if (!verify(client.secret, msg, client.hashAlgo)) {
    if (!client._verifiedAny) {
      client.log.warn(TAG, `signature verification failed before any verified message - likely secret mismatch with the hub (type=${msg?.type})`);
    } else {
      client.log.warn(TAG, `dropped message: bad signature (type=${msg?.type})`);
    }
    client.emit('protocol-error', { reason: 'bad-signature', type: msg?.type, msg });
    return;
  }

  // 4. Protocol version
  if (msg.v !== PROTOCOL_VERSION) {
    client.log.warn(TAG, `dropped message: unsupported protocol version v=${msg?.v} (expected ${PROTOCOL_VERSION}, type=${msg?.type})`);
    client.emit('protocol-error', { reason: 'bad-version', type: msg?.type, msg });
    return;
  }

  // 5. Replay: timestamp window
  if (client.replayWindowMs > 0) {
    const skew = Math.abs(Date.now() - (typeof msg.ts === 'number' ? msg.ts : 0));

    if (skew > client.replayWindowMs) {
      client.log.warn(TAG, `dropped message: timestamp out of replay window (skew=${skew}ms, type=${msg?.type})`);
      client.emit('protocol-error', { reason: 'replay-window', type: msg?.type, msg, skew });
      return;
    }
  }

  // 6. Replay: id duplicate (responses exempt)
  if (client.recentIds && msg.id && msg.type !== 'rpc.response') {
    if (client.recentIds.has(msg.id)) {
      client.log.warn(TAG, `dropped message: replay of id ${String(msg.id).slice(0, 8)} (type=${msg?.type})`);
      client.emit('protocol-error', { reason: 'replay-id', type: msg?.type, msg });
      return;
    }

    client.recentIds.add(msg.id);
  }

  // First-verified-message bookkeeping
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
      const oldKinds = new Set(client.peers.map(p => p.kind));
      const newKinds = new Set(newPeers.map(p => p.kind));
      for (const p of newPeers) {
        if (!oldKinds.has(p.kind)) client.emit('peer.connect', p);
      }
      for (const p of client.peers) {
        if (!newKinds.has(p.kind)) client.emit('peer.disconnect', p);
      }
      client.peers = newPeers;
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
          h(payload, msg);
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

/**
 * Handle the `ws.on('close')` event. Clears timers, fails any in-flight
 * RPCs with `RpcDisconnectError`, fires `'disconnect'`, and schedules a
 * reconnect if the client wasn't explicitly stopped.
 *
 * Also extracted from `_connect()` to keep the class file readable.
 */
function handleClose(client, code, reason) {
  if (client.statusTimer)   { clearInterval(client.statusTimer); client.statusTimer = null; }
  if (client.helloAckTimer) { clearTimeout(client.helloAckTimer); client.helloAckTimer = null; }

  const wasReady = client._ready;
  client._ready = false;

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
  const delayMs = client.reconnectMs;
  const attempt = client._reconnectAttempt;
  client.emit('reconnecting', { delayMs, attempt });

  client.reconnectTimer = setTimeout(() => {
    client.reconnectTimer = null;
    client.reconnectMs = Math.min(client.reconnectMs * client.reconnectGrowth, client.reconnectMaxMs);
    client._connect();
  }, client.reconnectMs);
}

module.exports = { handleInboundMessage, handleClose };