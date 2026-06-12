'use strict';

/**
 * Integration tests: RPC cancellation (`rpc.cancel` / `rpc.cancelled`).
 *
 * Covers the cancellation path:
 *   - an aborted RPC sends `rpc.cancel` to the hub
 *   - a timed-out RPC ("deadline") also sends `rpc.cancel`
 *   - the hub drops a still-queued request and reports `found: true`
 *   - an already-forwarded request reports `found: false`
 *   - `to: 'server'` cancels report `found: false` (never queued)
 *
 * Dedicated hub on port 19900 so this file runs in parallel with the
 * rest of the integration suite.
 *
 * Synchronization: these tests gate every assertion on a *causal* signal
 * (`waitFor`) rather than a fixed `tick()`. Whether a cancel reports
 * `found: true` (request still queued) or `found: false` (already on the
 * wire / delivered) hinges on whether the hub has forwarded the request
 * yet - a state transition a wall-clock `tick()` cannot pin down, which
 * is why the old `tick()`-gated version flaked under CPU load.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { setupHub, makeReadyClient, waitFor } = require('./_helpers.js');

const PORT = 19900;

const harness = setupHub({
  port: PORT,
  hubOpts: {
    maxBufferedBytes: 4096,
    rpcHandlers: { 'cx.hang': () => new Promise(() => {}) },
  },
});
const readyClient = makeReadyClient(harness);

/** Collect `rpc.cancelled` hub events into an array for assertions. */
function collectCancelled() {
  const seen = [];
  harness.hub.on('rpc.cancelled', (info) => seen.push(info));
  return seen;
}

/** Collect `rpc.forwarded` hub events (fires when the hub forwards a request). */
function collectForwarded() {
  const seen = [];
  harness.hub.on('rpc.forwarded', (info) => seen.push(info));
  return seen;
}

/** Register failure-safe teardown so a thrown assertion never leaks live clients. */
function autoStop(t, ...clients) {
  t.after(() => { for (const c of clients) { try { c.stop({ drain: false }); } catch {} } });
}

describe('rpc cancellation', () => {
  test('aborting an RPC sends rpc.cancel; hub emits rpc.cancelled', async (t) => {
    const cancelled = collectCancelled();
    const forwarded = collectForwarded();

    const target = await readyClient({
      kind: 'cx-target-1',
      rpcHandlers: { hang: () => new Promise(() => {}) },
    });
    const caller = await readyClient({ kind: 'cx-caller-1' });
    autoStop(t, caller, target);

    const ac = new AbortController();
    const p  = caller.rpc('cx-target-1', 'hang', {}, { signal: ac.signal });
    p.catch(() => {});

    await waitFor(() => forwarded.some((f) => f.from === 'cx-caller-1' && f.to === 'cx-target-1'),
      { label: 'request forwarded to target' });

    ac.abort();
    await assert.rejects(p, (e) => e.name === 'RpcAbortError');

    const mine = await waitFor(() => {
      const m = cancelled.filter((c) => c.from === 'cx-caller-1' && c.to === 'cx-target-1');
      return m.length === 1 ? m : false;
    }, { label: 'one rpc.cancelled from caller' });

    assert.strictEqual(mine[0].found, false, 'already forwarded -> not found queued');
  });

  test('an RPC that hits its deadline also sends rpc.cancel', async (t) => {
    const cancelled = collectCancelled();

    const target = await readyClient({
      kind: 'cx-target-2',
      rpcHandlers: { hang: () => new Promise(() => {}) },
    });
    const caller = await readyClient({ kind: 'cx-caller-2' });
    autoStop(t, caller, target);

    await assert.rejects(
      caller.rpc('cx-target-2', 'hang', {}, { timeoutMs: 80 }),
      (e) => e.name === 'RpcTimeoutError',
    );

    await waitFor(
      () => cancelled.filter((c) => c.from === 'cx-caller-2' && c.to === 'cx-target-2').length === 1,
      { label: 'a timeout should also emit a cancel' });
  });

  test('hub drops a still-queued request (found: true)', async (t) => {
    const cancelled = collectCancelled();
    const forwarded = collectForwarded();

    const target = await readyClient({
      kind: 'cx-target-3',
      rpcHandlers: { hang: () => new Promise(() => {}) },
    });
    const caller = await readyClient({ kind: 'cx-caller-3' });

    const burst = new AbortController();
    autoStop(t, caller, target);
    t.after(() => { try { burst.abort(); } catch {} try { target.ws._socket.resume(); } catch {} });

    target.ws._socket.pause();

    const big = 'x'.repeat(700_000);
    for (let i = 0; i < 12; i++) {
      const pi = caller.rpc('cx-target-3', 'hang', { big, i }, { signal: burst.signal });
      pi.catch(() => {});
    }

    await waitFor(() => harness.hub.health().queuedSockets >= 1,
      { timeoutMs: 5000, label: 'target outbox congested' });

    const ac = new AbortController();
    const p2 = caller.rpc('cx-target-3', 'hang-marker', { marker: true }, { signal: ac.signal });
    p2.catch(() => {});

    await waitFor(() => forwarded.some((f) => f.rpcType === 'hang-marker'),
      { timeoutMs: 5000, label: 'marker forwarded (queued)' });

    ac.abort();
    await assert.rejects(p2, (e) => e.name === 'RpcAbortError');

    await waitFor(
      () => cancelled.some((c) => c.from === 'cx-caller-3' && c.to === 'cx-target-3' && c.found === true),
      { timeoutMs: 5000, label: 'queued request found and dropped' });

    const found = cancelled.filter(
      (c) => c.from === 'cx-caller-3' && c.to === 'cx-target-3' && c.found === true);
    assert.strictEqual(found.length, 1, 'the queued request should have been found and dropped');
  });

  test('cancel for a to:"server" RPC reports found: false', async (t) => {
    const cancelled = collectCancelled();

    const caller = await readyClient({ kind: 'cx-caller-4' });
    autoStop(t, caller);

    const ac = new AbortController();
    const p = caller.rpc('server', 'cx.hang', {}, { signal: ac.signal });
    p.catch(() => {});

    await waitFor(() => harness.hub.health().serverRpcInFlight >= 1,
      { label: 'server RPC in flight' });
    ac.abort();
    await assert.rejects(p, (e) => e.name === 'RpcAbortError');

    const toServer = await waitFor(() => {
      const m = cancelled.filter((c) => c.to === 'server' && c.from === 'cx-caller-4');
      return m.length === 1 ? m : false;
    }, { label: 'one server-targeted cancel' });
    assert.strictEqual(toServer[0].found, false, 'server RPCs are never queued');
  });

  test('a peer can only cancel its own queued requests', async (t) => {
    const cancelled = collectCancelled();
    const forwarded = collectForwarded();

    const a = await readyClient({ kind: 'cx-a-5' });
    const b = await readyClient({ kind: 'cx-b-5' });
    const target = await readyClient({
      kind: 'cx-t-5',
      rpcHandlers: { hang: () => new Promise(() => {}) },
    });
    autoStop(t, a, b, target);

    const ac = new AbortController();
    const p = a.rpc('cx-t-5', 'hang', {}, { signal: ac.signal });
    p.catch(() => {});
    await waitFor(() => forwarded.some((f) => f.from === 'cx-a-5' && f.to === 'cx-t-5'),
      { label: 'request forwarded' });
    ac.abort();
    await assert.rejects(p, (e) => e.name === 'RpcAbortError');
    await waitFor(() => cancelled.some((c) => c.from === 'cx-a-5'),
      { label: "a's cancel observed" });
    assert.ok(cancelled.every((c) => c.from !== 'cx-b-5'), 'b never issued a cancel');
  });
});

describe('rpc cancellation - forwarded to in-flight handler', () => {
  test('hub forwards rpc.cancel; target handler signal fires (forwarded: true)', async (t) => {
    const cancelled = collectCancelled();
    const forwarded = collectForwarded();

    let sawSignal   = false;
    let handlerDone = false;

    const target = await readyClient({
      kind: 'cx-fwd-target-1',
      rpcHandlers: {
        slow: (_data, _msg, ctx) => new Promise((resolve) => {
          ctx.signal.addEventListener('abort', () => {
            sawSignal = true;
            resolve({ bailed: true });
          });
        }).finally(() => { handlerDone = true; }),
      },
    });
    const caller = await readyClient({ kind: 'cx-fwd-caller-1' });
    autoStop(t, caller, target);

    const ac = new AbortController();
    const p  = caller.rpc('cx-fwd-target-1', 'slow', {}, { signal: ac.signal });
    p.catch(() => {});

    await waitFor(() => forwarded.some((f) => f.from === 'cx-fwd-caller-1' && f.to === 'cx-fwd-target-1'),
      { label: 'request forwarded to handler' });
    ac.abort();

    await assert.rejects(p, (e) => e.name === 'RpcAbortError');

    const mine = await waitFor(() => {
      const m = cancelled.filter((c) => c.from === 'cx-fwd-caller-1' && c.to === 'cx-fwd-target-1');
      return m.length === 1 ? m : false;
    }, { label: 'one rpc.cancelled' });
    assert.strictEqual(mine[0].found, false, 'request was not queued');
    assert.strictEqual(mine[0].forwarded, true, 'cancel should be relayed to the target');

    await waitFor(() => sawSignal && handlerDone,
      { label: "handler's AbortSignal fired and handler settled" });
  });

  test('target client emits rpc.cancel event for an in-flight inbound RPC', async (t) => {
    const forwarded = collectForwarded();

    const target = await readyClient({
      kind: 'cx-fwd-target-2',
      rpcHandlers: { slow: (_d, _m, ctx) =>
        new Promise((resolve) => ctx.signal.addEventListener('abort', () => resolve('ok'))) },
    });
    const caller = await readyClient({ kind: 'cx-fwd-caller-2' });
    autoStop(t, caller, target);

    const events = [];
    target.on('rpc.cancel', (info) => events.push(info));

    const ac = new AbortController();
    const p  = caller.rpc('cx-fwd-target-2', 'slow', {}, { signal: ac.signal });
    p.catch(() => {});
    await waitFor(() => forwarded.some((f) => f.from === 'cx-fwd-caller-2' && f.to === 'cx-fwd-target-2'),
      { label: 'request forwarded' });
    ac.abort();
    await assert.rejects(p, (e) => e.name === 'RpcAbortError');

    await waitFor(() => events.length === 1, { label: 'target emits one rpc.cancel' });
    assert.strictEqual(events[0].from, 'cx-fwd-caller-2');
    assert.strictEqual(events[0].rpcType, 'slow');
    assert.strictEqual(typeof events[0].id, 'string');
  });

  test('a handler that ignores its signal still runs to completion', async (t) => {
    let handlerCompleted = false;
    const forwarded = collectForwarded();

    const target = await readyClient({
      kind: 'cx-fwd-target-3',
      rpcHandlers: { quick: async () => {
        await new Promise((r) => setTimeout(r, 120));
        handlerCompleted = true;
        return { ok: true };
      } },
    });
    const caller = await readyClient({ kind: 'cx-fwd-caller-3' });
    autoStop(t, caller, target);

    const ac = new AbortController();
    const p  = caller.rpc('cx-fwd-target-3', 'quick', {}, { signal: ac.signal });
    p.catch(() => {});
    await waitFor(() => forwarded.some((f) => f.from === 'cx-fwd-caller-3' && f.to === 'cx-fwd-target-3'),
      { label: 'request forwarded' });
    ac.abort();
    await assert.rejects(p, (e) => e.name === 'RpcAbortError');

    await waitFor(() => handlerCompleted, { label: 'ignoring handler runs to completion' });
  });
});