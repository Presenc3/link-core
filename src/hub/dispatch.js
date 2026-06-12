'use strict';

const { sanitizeHello, RESERVED_KINDS } = require('./hello.js');
const { TAG, WS_OPEN, HUB_FEATURES, HELLO_KIND_MAX, WS_CLOSE_REPLACED } = require('./constants.js');
const { PROTOCOL_VERSION, isValidTopic, assertJsonSerializable } = require('../protocol.js');
const { parseEnvelope, verifyEnvelope, rejectInbound } = require('../internal/inbound-validate.js');

const { rpcErrorResponse, ownRpcErrorData } = require('../internal/errors.js');

function createMessageHandler(ctx, ws) {
  const {
    log,            hashAlgo,     replayWindowMs, maxMessageBytes,
    clients,        statuses,     subscriptions,  recentIds,
    resolveSecret,  send,         publishPeers,   exposeRpcErrors,
    untrackPending, emitSafe,     handleServerRpc, cancelQueuedRpc,
    acl,            hubHasListeners,
  } = ctx;

  /**
   * Run an optional ACL check and report a denial uniformly. Returns
   * `true` to proceed, `false` if the caller should stop. A missing check
   * (`null`) is a pass with zero overhead. On denial it logs, emits
   * `acl-denied` with the curated `deniedPayload` (deliberately *not* the
   * raw `aclCtx`, which carries `rpcData`/`payload` we keep out of
   * telemetry), and runs `onDeny` for op-specific side effects (the RPC
   * branch uses it to send a failure response).
   */
  async function gate(check, aclCtx, op, deniedPayload, onDeny) {
    if (!check) return true;

    const verdict = await check(aclCtx);
    if (verdict.allowed) return true;

    log.warn(TAG, `acl: ${op} denied: ${verdict.error}`);
    emitSafe('acl-denied', { op, ...deniedPayload, code: verdict.code, error: verdict.error });
    if (onDeny) onDeny(verdict);
    return false;
  }

  /**
   * Run `fn` in this socket's FIFO lane.
   *
   * An ACL callback may be async, and `await`ing it inline lets a later
   * message from the same socket overtake an earlier one whose check is
   * still pending - two publishes to the same topic could fan out in
   * reverse order if the first check resolved slower. Ordering-sensitive
   * gated ops (publish / direct / subscribe) are therefore chained on a
   * per-socket promise: checks for one socket run strictly in arrival
   * order. Only sockets on a hub *with* the relevant ACL configured ever
   * enter the lane (the no-ACL path stays fully synchronous), and RPCs
   * stay concurrent by design - their responses correlate by id and a
   * slow handler must not head-of-line-block a peer's pub/sub traffic.
   *
   * The lane swallows-and-logs so one failed link can never wedge the
   * chain for the socket's remaining lifetime.
   */
  function runInOrder(fn) {
    const prev = ws.__gateLane || Promise.resolve();
    ws.__gateLane = prev
      .then(fn)
      .catch((e) => log.warn(TAG, `ordered dispatch failed (kind=${ws.__kind || '<pending>'}):`, e?.message || e));
  }

  return async (raw) => {
    const parsed = parseEnvelope(raw, maxMessageBytes);
    if (!parsed.ok) {
      rejectInbound(parsed, { log, tag: TAG, kind: ws.__kind || null,
        emit: (pl) => emitSafe('protocol-error', pl) });
      return;
    }

    const msg = parsed.msg;

    let verifyKey, helloData;

    if (ws.__secret) {
      verifyKey = ws.__secret;

    } else if (msg?.type === 'hello') {
      helloData = sanitizeHello(msg.data);
      const claimedKind = helloData.kind;

      if (!claimedKind) {
        const rawKind = String(msg.data?.kind ?? '');
        const trimmed = rawKind.trim();
        const detail =
          trimmed.length === 0           ? 'missing-kind'  :
          trimmed.length > HELLO_KIND_MAX ? 'oversized-kind':
          RESERVED_KINDS.has(trimmed)    ? 'reserved-kind' :
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

      if (ws.readyState !== WS_OPEN) {
        log.warn(TAG, `dropped hello: socket for kind=${claimedKind} closed during key resolution`);
        return;
      }

      if (ws.__secret) {
        log.warn(TAG,
          `dropped hello: concurrent hello already authenticated this socket ` +
          `as ${ws.__kind} (lost race claimed kind=${claimedKind})`);
        emitSafe('protocol-error', { reason: 'duplicate-hello', kind: ws.__kind, detail: 'concurrent-hello' });
        return;
      }
    } else {
      emitSafe('protocol-error', { reason: 'pre-hello-message', kind: null, type: msg?.type });
      return;
    }

    const checked = verifyEnvelope(msg, verifyKey, {
      hashAlgo,
      replayWindowMs,
      recentIds,
      senderKind: () => ws.__kind || helloData.kind,
    });
    if (!checked.ok) {
      rejectInbound({ ...checked, msg }, { log, tag: TAG, kind: ws.__kind || null,
        emit: (pl) => emitSafe('protocol-error', pl) });
      return;
    }

    const type = msg.type;

    if (hubHasListeners('message')) {
      emitSafe('message', { from: ws.__kind || null, msg: structuredClone(msg) });
    }

    if (type === 'hello') {
      if (!helloData) {
        log.warn(TAG, `dropped hello: socket already authenticated as ${ws.__kind}`);
        emitSafe('protocol-error', { reason: 'duplicate-hello', kind: ws.__kind });
        return;
      }

      const kind = helloData.kind;

      const existing = clients.get(kind);
      const replaced = !!(existing?.ws && existing.ws !== ws);
      if (replaced) {
        emitSafe('peer.replaced', {
          kind,
          prevHello: existing.hello ? structuredClone(existing.hello) : null,
          newHello:  structuredClone(helloData),
        });
        try { existing.ws.close(WS_CLOSE_REPLACED, 'replaced by new connection'); } catch {}
      }

      ws.__kind   = kind;
      ws.__secret = verifyKey;
      untrackPending(ws);

      clients.set(kind, { ws, hello: helloData, connectedAt: Date.now() });
      log.info(TAG, `hello from ${kind}${replaced ? ' (replaced)' : ''}`);

      send(ws, {
        type: 'hello.ack',
        to:   kind,
        data: { ok: true, serverTime: Date.now(), kind, features: HUB_FEATURES },
      });

      emitSafe('peer.connect', {
        kind,
        hello:       structuredClone(helloData),
        connectedAt: Date.now(),
        replaced,
      });

      publishPeers();

      const statusSnap = Object.create(null);
      for (const [k, s] of statuses.entries()) statusSnap[k] = s;
      send(ws, { type: 'status.snapshot', to: kind, data: statusSnap });
      return;
    }

    const from = ws.__kind || null;
    if (!from) return;

    if (clients.get(from)?.ws !== ws) {
      log.debug(TAG, `dropped ${type} from a stale ${from} socket (already replaced)`);
      return;
    }

    if (type === 'status.update') {
      const at = Date.now();
      statuses.set(from, { status: msg.data, at });
      for (const [kind, c] of clients.entries()) {
        if (kind === from) continue;
        send(c.ws, { type: 'status.update', to: kind, data: { from, status: msg.data, at } });
      }
      return;
    }

    if (type === 'rpc.request') {
      const to      = msg.to ? String(msg.to) : null;
      const rpcType = msg.data?.rpcType;
      const rpcData = msg.data?.rpcData;

      if (acl.checkRpc
       && !await gate(acl.checkRpc, { from, to, rpcType, rpcData }, 'rpc',
        { from, to, rpcType },
        (verdict) => send(ws, {
          id: msg.id, type: 'rpc.response', to: from,
          data: { ok: false, error: verdict.error, code: verdict.code },
        }))) return;

      if (to === 'server') {
        const trustedMsg = { ...msg, from };
        const startedAt = Date.now();
        try {
          const result = await handleServerRpc(rpcType, rpcData, trustedMsg);

          let ownedResult;
          try {
            if (result !== undefined) {
              ownedResult = structuredClone(result);
              assertJsonSerializable(ownedResult, `server RPC result for '${rpcType}'`);
            }
          } catch (serErr) {
            log.error(TAG,
              `server rpc '${rpcType}' returned a non-serializable result:`,
              serErr?.message || serErr);
            send(ws, {
              id:   msg.id,
              type: 'rpc.response',
              to:   from,
              data: {
                ok:    false,
                error: 'RPC handler returned a non-serializable result',
                code:  'RPC_RESULT_NOT_SERIALIZABLE',
              },
            });
            emitSafe('rpc.server', {
              id: msg.id, from, rpcType, ok: false,
              error: 'non-serializable result',
              durationMs: Date.now() - startedAt,
            });
            return;
          }

          send(ws, {
            id:   msg.id,
            type: 'rpc.response',
            to:   from,
            data: { ok: true, result: ownedResult },
          });
          emitSafe('rpc.server', {
            id: msg.id, from, rpcType, ok: true,
            durationMs: Date.now() - startedAt,
          });
        } catch (e) {
          const { exposed, body } = rpcErrorResponse(e, { exposeAll: exposeRpcErrors });

          ownRpcErrorData(body, (serErr) => log.error(TAG,
            `server rpc '${rpcType}' threw an error whose .data is not ` +
            `wire-safe - forwarding the error without data:`,
            serErr?.message || serErr));

          if (exposed) {
            log.warn(TAG, `server rpc '${rpcType}' failed: ${body.error}`);
          } else {
            log.warn(TAG, `server rpc '${rpcType}' threw:`, e?.message || e);
          }

          send(ws, {
            id:   msg.id,
            type: 'rpc.response',
            to:   from,
            data: { ok: false, ...body },
            owned: true,
          });
          emitSafe('rpc.server', {
            id: msg.id, from, rpcType, ok: false,
            error: body.error,
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
          data: { ok: false, error: 'rpc.request missing "to"', code: 'RPC_BAD_REQUEST' },
        });
        return;
      }

      const target = clients.get(to);
      if (!target?.ws || target.ws.readyState !== WS_OPEN) {
        send(ws, {
          id:   msg.id,
          type: 'rpc.response',
          to:   from,
          data: { ok: false, error: `Target not connected: ${to}`, code: 'RPC_NO_TARGET' },
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
          data: {
            ok: false,
            error: `Target backpressured or send failed: ${to}`,
            code: 'RPC_TARGET_UNAVAILABLE',
          },
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

    if (type === 'rpc.cancel') {
      const to       = msg.to ? String(msg.to) : null;
      const cancelId = msg.data?.id;

      if (typeof cancelId !== 'string' || !cancelId || !to) return;

      const found = (to === 'server')
        ? false
        : cancelQueuedRpc(to, cancelId, from);

      let forwarded = false;
      if (!found && to !== 'server') {
        const target = clients.get(to);
        if (target?.ws && target.ws.readyState === WS_OPEN) {
          forwarded = send(target.ws, {
            type: 'rpc.cancel',
            from, to,
            data: { id: cancelId },
          });
        }
      }

      emitSafe('rpc.cancelled', { id: cancelId, from, to, found, forwarded });
      return;
    }

    if (type === 'topic.subscribe') {
      const topic = msg.data?.topic;
      if (!isValidTopic(topic)) {
        log.warn(TAG, `dropped: invalid topic on subscribe (kind=${from})`);
        emitSafe('protocol-error', { reason: 'invalid-topic', kind: from, type });
        return;
      }

      const recordSubscription = () => {
        let subs = subscriptions.get(topic);
        if (!subs) { subs = new Set(); subscriptions.set(topic, subs); }
        const wasNew = !subs.has(from);
        subs.add(from);
        if (wasNew) emitSafe('topic.subscribe', { kind: from, topic });
      };

      if (!acl.checkSubscribe) { recordSubscription(); return; }

      runInOrder(async () => {
        if (clients.get(from)?.ws !== ws) return;
        if (!await gate(acl.checkSubscribe, { from, topic }, 'subscribe', { from, topic })) return;
        if (clients.get(from)?.ws !== ws) return;
        recordSubscription();
      });
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

      const fanout = () => {
        const subs = subscriptions.get(topic);

        if (!subs || subs.size === 0) {
          emitSafe('topic.publish', { from, topic, payload, subscriberCount: 0, delivered: 0 });
          return;
        }

        const eligible = subs.has(from) ? subs.size - 1 : subs.size;

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
          subscriberCount: eligible,
          delivered,
        });
      };

      if (!acl.checkPublish) { fanout(); return; }

      runInOrder(async () => {
        if (clients.get(from)?.ws !== ws) return;
        if (!await gate(acl.checkPublish, { from, topic, payload }, 'publish', { from, topic })) return;
        if (clients.get(from)?.ws !== ws) return;
        fanout();
      });
      return;
    }

    if (type === 'direct') {
      const to        = msg.to ? String(msg.to) : null;
      const directTy  = msg.data?.directType;
      if (!to || typeof directTy !== 'string' || !directTy) return;

      const forward = () => {
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
      };

      if (!acl.checkSend) { forward(); return; }

      runInOrder(async () => {
        if (clients.get(from)?.ws !== ws) return;
        if (!await gate(acl.checkSend, { from, to, type: directTy, data: msg.data?.directData },
          'send', { from, to, type: directTy })) return;
        if (clients.get(from)?.ws !== ws) return;
        forward();
      });
      return;
    }
  };
}

module.exports = { createMessageHandler };