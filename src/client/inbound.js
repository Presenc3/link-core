'use strict';

const { TAG } = require('./constants.js');
const { RpcRemoteError } = require('../internal/errors.js');
const { WS_CLOSE_REPLACED } = require('../hub/constants.js');
const { parseEnvelope, verifyEnvelope, rejectInbound } = require('../internal/inbound-validate.js');

function handleInboundMessage(client, raw) {
  const parsed = parseEnvelope(raw, client.maxMessageBytes);

  if (!parsed.ok) {
    rejectInbound(parsed, {
      log: client.log, tag: TAG,
      firstContact: !client._verifiedAny,
      emit: (p) => client.emit('protocol-error', p),
    });

    return;
  }

  const msg = parsed.msg;

  const checked = verifyEnvelope(msg, client.secret, {
    hashAlgo:       client.hashAlgo,
    replayWindowMs: client.replayWindowMs,
    recentIds:      client.recentIds,
    senderKind:     () => msg.from || 'server',
  });

  if (!checked.ok) {
    rejectInbound({ ...checked, msg }, {
      log: client.log, tag: TAG,
      firstContact: !client._verifiedAny,
      onReplayWindow: (skew) => { client._skewDropsSinceVerified++; client._lastSkew = skew; },
      emit: (p) => client.emit('protocol-error', p),
    });

    return;
  }

  if (!client._verifiedAny) {
    client._verifiedAny = true;
    client._skewDropsSinceVerified = 0;

    client.emit('verified', { kind: client.kind });
  }

  client._lastVerifiedAt = Date.now();

  const isHelloAck  = msg.type === 'hello.ack';
  const helloOk     = msg.data?.ok;
  const rejectedNow = isHelloAck && helloOk === false;

  if (isHelloAck && client.helloAckTimer) {
    clearTimeout(client.helloAckTimer);
    client.helloAckTimer = null;
  }

  if (rejectedNow) {
    const reason = msg.data?.error || 'hello rejected';

    client.log.warn(TAG, `hub rejected hello: ${reason}`);
    client.emit('rejected', { reason, error: msg.data?.error || null });

    if (client.reconnectOnRejection) {
      try { client.ws.close(1000, 'hello rejected - will retry'); } catch {}
    } else {
      client.stop();
    }
    return;
  }

  if (isHelloAck && !rejectedNow) {
    const prev = client.hubFeatures;
    client.hubFeatures = Array.isArray(msg.data?.features) ? msg.data.features : [];

    if (client._ready
     && Array.isArray(prev) && !prev.includes('topics')
     && client.hubFeatures.includes('topics')) {
      for (const topic of client._subscriptions.keys()) {
        client._send('topic.subscribe', { topic });
      }
    }
  }

  if (isHelloAck && !rejectedNow && !client._ready && !client._stopped) {
    client._ready = true;
    client.reconnectMs = client.reconnectInitialMs;
    client._reconnectAttempt = 0;

    const feats     = client.hubFeatures;
    const hasTopics = !Array.isArray(feats) || feats.includes('topics');
    const hasDirect = !Array.isArray(feats) || feats.includes('direct');

    if (!hasTopics || !hasDirect) {
      const dropped = client._outbox.removeWhere((it) =>
        (!hasTopics && (it.type === 'topic.message'
                     || it.type === 'topic.subscribe'
                     || it.type === 'topic.unsubscribe'))
        || (!hasDirect && it.type === 'direct'));

      if (dropped > 0) {
        client.log.warn(TAG,
          `dropped ${dropped} queued message(s) requiring a feature the hub ` +
          `does not advertise (features=${feats.join(',') || 'none'})`);
      }
    }

    if (hasTopics) {
      for (const topic of client._subscriptions.keys()) {
        client._send('topic.subscribe', { topic });
      }
    }

    if (client.makeStatus && !client.statusTimer) {
      const push = () => {
        try {
          const owned = client._assertWireSafe(client.makeStatus(), 'makeStatus()');
          client._send('status.update', owned, null, undefined, true);
        } catch (e) {
          client.log.warn(TAG, 'makeStatus() threw or returned a non-wire-safe status:', e?.message || e);
        }
      };

      push();

      client.statusTimer = setInterval(push, client.statusIntervalMs);
      client.statusTimer.unref?.();
    }

    client._outbox.drain();
    client.emit('ready', { kind: client.kind, features: client.hubFeatures });
  }

  if (client.listenerCount('message') > 0) {
    client.emit('message', { msg: structuredClone(msg), raw });
  }

  switch (msg.type) {
    case 'peers.update': {
      const newPeers = msg.data?.peers || [];
      const newByKind = new Map(    newPeers.map((p) => [p.kind, p]));
      const oldByKind = new Map(client.peers.map((p) => [p.kind, p]));

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
          client.lastStatusByPeer.delete(op.kind);
          if (client.recentIds) client.recentIds.forget(op.kind);
          events.push(['peer.disconnect', op]);
        }
      }

      client.peers = newPeers;
      for (const [evt, payload] of events) client.emit(evt, structuredClone(payload));
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
        client.emit('peer.status', structuredClone({ from, status, at }));
      }
      
      return;
    }

    case 'rpc.request': {
      if (client.listenerCount('rpc.request') > 0) {
        const snap = structuredClone(msg);
        client.emit('rpc.request', {
          from:    snap.from,
          rpcType: snap.data?.rpcType,
          rpcData: snap.data?.rpcData,
          msg:     snap,
        });
      }

      client._handleRpcRequest(msg).catch((e) =>
        client.log.warn(TAG, 'rpc.request handler crashed:', e?.message || e));
      return;
    }

    case 'rpc.response': {
      const p = client.pending.get(msg.id);

      if (!p) {
        client.log.warn(TAG, `rpc.response ${String(msg.id).slice(0, 8)} no pending handler (timed out?)`);
        return;
      }

      if (msg.from != null && msg.from !== 'server'
       && p.to != null && msg.from !== p.to) {
        client.log.warn(TAG,
          `dropped rpc.response ${String(msg.id).slice(0, 8)}: from "${msg.from}" ` +
          `but RPC was sent to "${p.to}"`);
        client.emit('protocol-error', { reason: 'rpc-response-mismatch', type: msg?.type, msg });
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
          code: msg.data?.code,
          data: msg.data?.data,
        });

        p.reject(err);
        client._emitRpcComplete(p, false, 'remote-error', err);
      }
      return;
    }

    case 'rpc.cancel': {
      const cancelId = msg.data?.id;
      if (typeof cancelId !== 'string' || !cancelId) return;

      client._abortInboundRpc(cancelId, msg.from);
      return;
    }

    case 'topic.message': {
      const { topic, payload } = msg.data || {};
      if (typeof topic !== 'string' || !topic) return;

      const handlers = client._subscriptions.get(topic);
      if (!handlers || handlers.size === 0) return;

      const msgSnap = structuredClone(msg);

      for (const h of handlers) {
        let p;

        try { p = structuredClone(payload); }
        catch { p = payload; }

        try {
          const r = h(p, msgSnap);

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
      if (typeof directType !== 'string' || !directType) return;

      const snap = structuredClone(msg);

      client.emit('direct', {
        from: snap.from,
        type: directType,
        data: snap.data?.directData,
        msg:  snap,
      });
      return;
    }
  }
}

function handleClose(client, code, reason) {
  client._clearTimers();

  const wasReady = client._ready;

  client._ready = false;
  client.hubFeatures = null;

  if (!client._stopped) {
    client._failAllPending('Link disconnected before RPC completed');
  }

  client._outbox.removeWhere((it) => it.type === 'rpc.request' || it.type === 'rpc.cancel');
  client._abortInboundRpcs('Link disconnected before RPC completed');

  if (client._stopped) {
    return;
  }

  if (code === WS_CLOSE_REPLACED) {
    client._stopped = true;
    client._outbox.cancelDrain();
    client._outbox.clear();
    client.log.warn(TAG,
      `displaced: the hub replaced this socket because another connection ` +
      `authenticated as kind="${client.kind}". Two processes are likely ` +
      `sharing a kind; not reconnecting.`);
    client._emitDisconnect({
      code, reason: String(reason || 'replaced by new connection'),
      willReconnect: false, wasReady, displaced: true,
    });
    return;
  }

  const attempt   = client._reconnectAttempt + 1;
  const exhausted = client.maxReconnectAttempts !== Infinity
                 && attempt > client.maxReconnectAttempts;

  if (exhausted) {
    client._stopped = true;
    client._outbox.cancelDrain();
    client._outbox.clear();
  }

  client._emitDisconnect({
    code:          typeof code === 'number' ? code : undefined,
    reason:        String(reason || ''),
    willReconnect: !exhausted,
    wasReady,
  });

  if (exhausted) {
    client.log.warn(TAG,
      `giving up (${client.kind}): reconnect ceiling of ` +
      `${client.maxReconnectAttempts} attempt(s) reached`);
    try {
      client.emit('reconnect-exhausted', {
        attempts:             client._reconnectAttempt,
        maxReconnectAttempts: client.maxReconnectAttempts,
      });
    } catch (e) {
      client.log.warn(TAG, "'reconnect-exhausted' listener threw:", e?.message || e);
    }
    return;
  }

  client._reconnectAttempt = attempt;
  client.log.info(TAG, `disconnected (${client.kind}), reconnecting in ${Math.round(client.reconnectMs)}ms…`);

  const j       = client.reconnectJitter;
  const baseMs  = client.reconnectMs;
  const delayMs = Math.max(0, baseMs * (1 - j / 2 + Math.random() * j));
  client.emit('reconnecting', { delayMs, attempt });

  client.reconnectTimer = setTimeout(() => {
    client.reconnectTimer = null;
    client.reconnectMs = Math.min(client.reconnectMs * client.reconnectGrowth, client.reconnectMaxMs);
    client._connect();
  }, delayMs);
  client.reconnectTimer.unref?.();
}

module.exports = { handleInboundMessage, handleClose };