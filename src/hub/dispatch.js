'use strict';

const { sanitizeHello }    = require('./hello.js');
const { TAG, WS_OPEN, HUB_FEATURES } = require('./constants.js');
const { verify, PROTOCOL_VERSION, isValidTopic } = require('../protocol.js');

function createMessageHandler(ctx, ws) {
  const {
    log,            hashAlgo,     replayWindowMs, maxMessageBytes,
    clients,        statuses,     subscriptions,  recentIds,
    resolveSecret,  send,         broadcast,      publishPeers,
    untrackPending, emitSafe,     handleServerRpc,
  } = ctx;

  return async (raw) => {
    if (raw.length > maxMessageBytes) {
      log.warn(TAG, `dropped: message too large (${raw.length} bytes > ${maxMessageBytes})`);

      emitSafe('protocol-error', {
        reason: 'oversize',
        kind:   ws.__kind || null,
        size:   raw.length,
      });

      return;
    }

    let msg;
    try { msg = JSON.parse(String(raw)); }
    catch {
      emitSafe('protocol-error', { reason: 'parse-error', kind: ws.__kind || null });
      return;
    }

    if (typeof msg?.id !== 'string' || msg.id.length === 0) {
      log.warn(TAG, `dropped: missing or empty id (type=${msg?.type})`);

      emitSafe('protocol-error', {
        reason: 'missing-id',
        kind:   ws.__kind || null,
        type:   msg?.type,
      });

      return;
    }

    let verifyKey, helloData;

    if (ws.__secret) {
      verifyKey = ws.__secret;

    } else if (msg?.type === 'hello') {
      helloData = sanitizeHello(msg.data);
      const claimedKind = helloData.kind;

      if (!claimedKind) {
        const rawKind = String(msg.data?.kind ?? '');
        const detail =
          rawKind.length === 0       ? 'missing-kind' :
          rawKind.length > 256       ? 'oversized-kind' :
                                       'invalid-kind';

        log.warn(TAG, `dropped hello: ${detail} (raw=${JSON.stringify(rawKind.slice(0, 64))})`);
        emitSafe('protocol-error', { reason: 'bad-hello', kind: null, detail });
        try { ws.close(1008, detail); } catch {}
        return;
      }

      verifyKey = await resolveSecret(claimedKind);

      if (!verifyKey) {
        log.warn(TAG, `dropped hello: no key for kind=${claimedKind}`);
        emitSafe('protocol-error', { reason: 'unknown-kind', kind: claimedKind });
        return;
      }

      if (ws.__secret) {
        log.warn(TAG, `dropped hello: socket already authenticated as ${ws.__kind}`);
        emitSafe('protocol-error', { reason: 'duplicate-hello', kind: ws.__kind });
        return;
      }
    } else {
      emitSafe('protocol-error', { reason: 'pre-hello-message', kind: null, type: msg?.type });
      return;
    }

    if (!verify(verifyKey, msg, hashAlgo)) {
      log.warn(TAG, `dropped: bad signature (type=${msg?.type}, kind=${ws.__kind || '<pending>'})`);

      emitSafe('protocol-error', {
        reason: 'bad-signature',
        kind:   ws.__kind || null,
        type:   msg?.type,
      });

      return;
    }

    if (msg.v !== PROTOCOL_VERSION) {
      log.warn(TAG, `dropped: unsupported protocol version v=${msg?.v} (expected ${PROTOCOL_VERSION}, type=${msg?.type})`);

      emitSafe('protocol-error', {
        reason: 'bad-version',
        kind:   ws.__kind || null,
        type:   msg?.type,
      });

      return;
    }

    if (replayWindowMs > 0) {
      const skew = Math.abs(Date.now() - (typeof msg.ts === 'number' ? msg.ts : 0));

      if (skew > replayWindowMs) {
        log.warn(TAG, `dropped: timestamp out of replay window (skew=${skew}ms, type=${msg?.type})`);
        emitSafe('protocol-error', {
          reason: 'replay-window',
          kind:   ws.__kind || null,
          type:   msg?.type,
          skew,
        });

        return;
      }
    }

    if (recentIds && msg.type !== 'rpc.response') {
      const senderKind = ws.__kind || (msg.type === 'hello' ? helloData?.kind : null);
      const cacheKey = senderKind ? `${senderKind}|${msg.id}` : msg.id;

      if (recentIds.has(cacheKey)) {
        log.warn(TAG, `dropped: replay of id ${String(msg.id).slice(0, 8)} (type=${msg?.type})`);

        emitSafe('protocol-error', {
          reason: 'replay-id',
          kind:   ws.__kind || null,
          type:   msg?.type,
        });

        return;
      }

      recentIds.add(cacheKey);
    }

    emitSafe('message', { from: ws.__kind || null, msg });

    const type = msg.type;

    if (type === 'hello') {
      const kind = helloData.kind;

      const existing = clients.get(kind);
      const replaced = !!(existing?.ws && existing.ws !== ws);
      if (replaced) {
        emitSafe('peer.replaced', {
          kind,
          prevHello: existing.hello || null,
          newHello:  helloData,
        });
        try { existing.ws.close(1000, 'replaced by new connection'); } catch {}
      }

      ws.__kind   = kind;
      ws.__secret = verifyKey;
      untrackPending(ws);

      clients.set(kind, { ws, hello: helloData, connectedAt: Date.now() });
      log.log(TAG, `hello from ${kind}${replaced ? ' (replaced)' : ''}`);

      send(ws, {
        type: 'hello.ack',
        to:   kind,
        data: { ok: true, serverTime: Date.now(), kind, features: HUB_FEATURES },
      });

      emitSafe('peer.connect', {
        kind,
        hello:       helloData,
        connectedAt: Date.now(),
        replaced,
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

      if (to === 'server') {
        const trustedMsg = { ...msg, from };
        const startedAt = Date.now();
        try {
          const result = await handleServerRpc(rpcType, rpcData, trustedMsg);
          send(ws, {
            id:   msg.id,
            type: 'rpc.response',
            to:   from,
            data: { ok: true, result },
          });
          emitSafe('rpc.server', {
            id: msg.id, from, rpcType, ok: true,
            durationMs: Date.now() - startedAt,
          });
        } catch (e) {
          log.warn(TAG, `server rpc '${rpcType}' failed:`, e?.message || e);
          send(ws, {
            id:   msg.id,
            type: 'rpc.response',
            to:   from,
            data: { ok: false, error: e?.message || String(e) },
          });
          emitSafe('rpc.server', {
            id: msg.id, from, rpcType, ok: false,
            error: e?.message || String(e),
            durationMs: Date.now() - startedAt,
          });
        }
        return;
      }

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

      const forwarded = send(target.ws, {
        id:   msg.id,
        type: 'rpc.request',
        from, to,
        data: { rpcType, rpcData },
      });
      if (!forwarded) {
        send(ws, {
          id:   msg.id,
          type: 'rpc.response',
          to:   from,
          data: { ok: false, error: `Target backpressured or send failed: ${to}` },
        });
        return;
      }
      emitSafe('rpc.forwarded', { id: msg.id, from, to, rpcType });
      return;
    }

    if (type === 'rpc.response') {
      const to = msg.to ? String(msg.to) : null;
      if (!to) return;

      const target = clients.get(to);
      if (!target?.ws || target.ws.readyState !== WS_OPEN) return;

      send(target.ws, {
        id:   msg.id,
        type: 'rpc.response',
        from, to,
        data: msg.data,
      });
      emitSafe('rpc.response.forwarded', {
        id: msg.id, from, to,
        ok: !!msg.data?.ok,
      });
      return;
    }

    if (type === 'topic.subscribe') {
      const topic = msg.data?.topic;
      if (!isValidTopic(topic)) {
        log.warn(TAG, `dropped: invalid topic on subscribe (kind=${from})`);
        emitSafe('protocol-error', { reason: 'invalid-topic', kind: from, type });
        return;
      }
      let subs = subscriptions.get(topic);
      if (!subs) { subs = new Set(); subscriptions.set(topic, subs); }
      const wasNew = !subs.has(from);
      subs.add(from);
      if (wasNew) emitSafe('topic.subscribe', { kind: from, topic });
      return;
    }

    if (type === 'topic.unsubscribe') {
      const topic = msg.data?.topic;
      if (!topic) {
        for (const [t, s] of subscriptions) {
          if (s.delete(from)) emitSafe('topic.unsubscribe', { kind: from, topic: t });
          if (s.size === 0) subscriptions.delete(t);
        }
        return;
      }
      if (!isValidTopic(topic)) {
        log.warn(TAG, `dropped: invalid topic on unsubscribe (kind=${from})`);
        emitSafe('protocol-error', { reason: 'invalid-topic', kind: from, type });
        return;
      }
      const subs = subscriptions.get(topic);
      if (subs) {
        const removed = subs.delete(from);
        if (subs.size === 0) subscriptions.delete(topic);
        if (removed) emitSafe('topic.unsubscribe', { kind: from, topic });
      }
      return;
    }

    if (type === 'topic.message') {
      const topic   = msg.data?.topic;
      const payload = msg.data?.payload;
      if (!isValidTopic(topic)) {
        log.warn(TAG, `dropped: invalid topic on publish (kind=${from})`);
        emitSafe('protocol-error', { reason: 'invalid-topic', kind: from, type });
        return;
      }
      const subs = subscriptions.get(topic);
      if (!subs || subs.size === 0) {
        emitSafe('topic.publish', { from, topic, payload, subscriberCount: 0 });
        return;
      }
      let delivered = 0;
      for (const sub of subs) {
        if (sub === from) continue;
        const target = clients.get(sub);
        if (!target?.ws || target.ws.readyState !== WS_OPEN) continue;

        const ok = send(target.ws, {
          type: 'topic.message',
          from, to: sub,
          data: { topic, payload },
        });
        if (ok) delivered += 1;
      }
      emitSafe('topic.publish', {
        from, topic, payload,
        subscriberCount: subs.size,
        delivered,
      });
      return;
    }

    if (type === 'direct') {
      const to        = msg.to ? String(msg.to) : null;
      const directTy  = msg.data?.directType;
      if (!to || typeof directTy !== 'string' || !directTy) return;
      const target = clients.get(to);
      if (!target?.ws || target.ws.readyState !== WS_OPEN) return;
      const ok = send(target.ws, {
        type: 'direct',
        from, to,
        data: {
          directType: directTy,
          directData: msg.data?.directData,
        },
      });
      if (ok) emitSafe('direct', { from, to, type: directTy, data: msg.data?.directData });
      return;
    }
  };
}

module.exports = { createMessageHandler };