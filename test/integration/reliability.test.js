'use strict';

/**
 * Integration tests for the reliability pass:
 *   - non-serializable payloads are rejected at the call site (and never
 *     wedge the outbox);
 *   - `status.update` messages are conflated in the outbox;
 *   - inbound RPC handler concurrency is bounded by `maxConcurrentRpc`;
 *   - a non-serializable RPC handler result is rejected cleanly (the caller
 *     gets RPC_RESULT_NOT_SERIALIZABLE) without wedging the link.
 *
 * Dedicated hub on port 19700 so this file runs in parallel with the rest
 * of the integration suite.
 */

const { test, describe } = require('node:test');
const assert             = require('node:assert');

const { LinkClient, RpcRemoteError, RpcTimeoutError } = require('../../src/index.js');
const { setupHub, makeReadyClient, tick } = require('./_helpers.js');

const PORT = 19700;

const harness     = setupHub({ port: PORT });
const readyClient = makeReadyClient(harness);

/** Pin ws.bufferedAmount above the cap so the fast send path is bypassed. */
function congest(client, bytes = 10_000) {
  Object.defineProperty(client.ws, 'bufferedAmount', {
    get: () => bytes, configurable: true,
  });
}

describe('non-serializable payloads fail fast (no outbox wedge)', () => {
  test('send / publish / rpc throw a TypeError synchronously', async (t) => {
    const c = await readyClient({ kind: 'rel-noclone' });
    t.after(() => c.stop({ drain: false }));

    const poison = { ok: 1, bad: () => {} };

    assert.throws(() => c.send('rel-noclone', 'evt', poison), /structured-cloneable/);
    assert.throws(() => c.publish('rel.topic', poison),       /structured-cloneable/);
    assert.throws(() => c.rpc('rel-noclone', 'do', poison),   /structured-cloneable/);
    assert.strictEqual(c.publish('rel.topic', { fine: true }), true);
  });

  test('a cloneable payload is unaffected', async (t) => {
    const c = await readyClient({ kind: 'rel-okclone' });
    t.after(() => c.stop({ drain: false }));
    assert.strictEqual(c.publish('rel.topic', { nested: { a: [1, 2, 3] } }), true);
  });
});

describe('status.update conflation', () => {
  test('only the newest status survives in a congested outbox', async (t) => {
    const c = await readyClient({ kind: 'rel-status', maxBufferedBytes: 50 });
    t.after(() => c.stop({ drain: false }));
    congest(c);

    c._send('status.update', { n: 1 });
    c._send('status.update', { n: 2 });
    c._send('status.update', { n: 3 });

    const queued = c._outbox.filter((it) => it.type === 'status.update');
    assert.strictEqual(queued.length, 1, 'stale status updates should collapse to one');
    assert.deepStrictEqual(queued[0].data, { n: 3 }, 'the survivor is the newest');
  });
});

describe('inbound RPC concurrency cap (maxConcurrentRpc)', () => {
  test('handlers past the cap are rejected with RPC_OVERLOADED', async (t) => {
    let release;
    const gate = new Promise((r) => { release = r; });

    const worker = await readyClient({
      kind: 'rel-worker',
      maxConcurrentRpc: 1,
      rpcHandlers: { slow: async () => { await gate; return 'done'; } },
    });
    const caller = await readyClient({ kind: 'rel-caller' });
    t.after(() => { worker.stop({ drain: false }); caller.stop({ drain: false }); });

    const results = await Promise.allSettled([
      caller.rpc('rel-worker', 'slow', {}, { timeoutMs: 2000 }),
      caller.rpc('rel-worker', 'slow', {}, { timeoutMs: 2000 }),
      caller.rpc('rel-worker', 'slow', {}, { timeoutMs: 2000 }),
    ]);
    release();

    const overloaded = results.filter(
      (r) => r.status === 'rejected' && r.reason?.code === 'RPC_OVERLOADED');
    assert.ok(overloaded.length >= 1, 'at least one RPC should be shed past the cap');
  });
});

describe('non-serializable RPC handler result', () => {
  test('a non-cloneable handler result > caller gets RPC_RESULT_NOT_SERIALIZABLE (not a timeout), link survives', async (t) => {
    const worker = await readyClient({
      kind: 'rel-badresult',
      rpcHandlers: { bad: () => ({ fn: () => {} }) },
    });
    const caller = await readyClient({ kind: 'rel-caller2' });
    t.after(() => { worker.stop({ drain: false }); caller.stop({ drain: false }); });

    let caught;
    try { await caller.rpc('rel-badresult', 'bad', {}, { timeoutMs: 600 }); }
    catch (e) { caught = e; }

    assert.ok(caught instanceof RpcRemoteError, `expected RpcRemoteError, got ${caught}`);
    assert.ok(!(caught instanceof RpcTimeoutError), 'must not be a timeout');
    assert.strictEqual(caught.code, 'RPC_RESULT_NOT_SERIALIZABLE');

    await tick(50);
    assert.strictEqual(worker.publish('rel.topic', { alive: true }), true);
  });
});

describe('option validation', () => {
  test('maxConcurrentRpc and keepaliveIntervalMs reject invalid input', () => {
    assert.throws(() => new LinkClient({ logger: null, maxConcurrentRpc: -1 }),    /maxConcurrentRpc/);
    assert.throws(() => new LinkClient({ logger: null, maxConcurrentRpc: 1.5 }),   /maxConcurrentRpc/);
    assert.throws(() => new LinkClient({ logger: null, keepaliveIntervalMs: -1 }), /keepaliveIntervalMs/);
    assert.throws(() => new LinkClient({ logger: null, keepaliveIntervalMs: 'x' }),/keepaliveIntervalMs/);

    assert.doesNotThrow(() => new LinkClient({ logger: null, maxConcurrentRpc: 0 }));
    assert.doesNotThrow(() => new LinkClient({ logger: null, keepaliveIntervalMs: 0 }));
  });
});