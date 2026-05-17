'use strict';

/**
 * Integration tests: peer-routed RPC, rpc.complete, and handle/unhandle.
 *
 * Uses a per-file dedicated hub on port 19200 so this file can run in
 * parallel with the other integration files without colliding.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  LinkClient,
  RpcRemoteError,          RpcDisconnectError,
  RpcAbortError,           RpcTimeoutError,
  BackpressureError,       LinkNotReadyError,
  FeatureUnsupportedError, createHubServer, makeMsg,
} = require('../../src/index.js');

const { setupHub, makeReadyClient, tick, DEFAULT_SECRET } = require('./_helpers.js');

const PORT   = 19200;
const URL    = `ws://127.0.0.1:${PORT}`;
const SECRET = DEFAULT_SECRET;

const harness     = setupHub({ port: PORT });
const readyClient = makeReadyClient(harness);

describe('rpc (peer-routed)', () => {
  test('happy path roundtrip', async () => {
    const a = await readyClient({ kind: 'rpc-a' });
    const b = await readyClient({ kind: 'rpc-b', rpcHandlers: {
      echo: async (data) => ({ pong: data }),
    } });
    const r = await a.rpc('rpc-b', 'echo', { hi: 1 });
    assert.deepStrictEqual(r, { pong: { hi: 1 } });
    a.stop(); b.stop();
  });

  test('remote handler throw → RpcRemoteError with full context', async () => {
    const a = await readyClient({ kind: 'rpc-a2' });
    const b = await readyClient({ kind: 'rpc-b2', rpcHandlers: {
      boom: async () => { throw new Error('kaboom'); },
    } });
    let caught;
    try { await a.rpc('rpc-b2', 'boom', {}); } catch (e) { caught = e; }
    assert.ok(caught instanceof RpcRemoteError);
    assert.strictEqual(caught.code,    'RPC_REMOTE');
    assert.strictEqual(caught.to,      'rpc-b2');
    assert.strictEqual(caught.rpcType, 'boom');
    assert.ok(typeof caught.id === 'string' && caught.id.length > 0);
    assert.match(caught.message, /kaboom/);
    a.stop(); b.stop();
  });

  test('missing peer → RpcRemoteError from hub ("Target not connected")', async () => {
    const a = await readyClient({ kind: 'rpc-a3' });
    let caught;
    try { await a.rpc('ghost', 'whatever', {}); } catch (e) { caught = e; }
    assert.ok(caught instanceof RpcRemoteError);
    assert.match(caught.message, /not connected/i);
    a.stop();
  });

  test('timeout → RpcTimeoutError', async () => {
    const a = await readyClient({ kind: 'rpc-a4' });
    const b = await readyClient({ kind: 'rpc-b4', rpcHandlers: {
      hang: () => new Promise(() => {}),
    } });
    let caught;
    try { await a.rpc('rpc-b4', 'hang', {}, 50); } catch (e) { caught = e; }
    assert.ok(caught instanceof RpcTimeoutError);
    assert.strictEqual(caught.code, 'RPC_TIMEOUT');
    assert.strictEqual(caught.timeoutMs, 50);
    a.stop(); b.stop();
  });

  test('AbortSignal in flight → RpcAbortError', async () => {
    const a = await readyClient({ kind: 'rpc-a5' });
    const b = await readyClient({ kind: 'rpc-b5', rpcHandlers: {
      slow: () => new Promise((r) => setTimeout(() => r('late'), 1000)),
    } });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    let caught;
    try {
      await a.rpc('rpc-b5', 'slow', {}, { timeoutMs: 5000, signal: ac.signal });
    } catch (e) { caught = e; }
    assert.ok(caught instanceof RpcAbortError);
    assert.strictEqual(caught.code, 'RPC_ABORT');
    a.stop(); b.stop();
  });

  test('pre-aborted signal → RpcAbortError before any wire send', async () => {
    const a = await readyClient({ kind: 'rpc-a6' });
    const ac = new AbortController(); ac.abort();
    let caught;
    try { await a.rpc('whatever', 'x', {}, { signal: ac.signal }); }
    catch (e) { caught = e; }
    assert.ok(caught instanceof RpcAbortError);
    assert.match(caught.message, /aborted before send/);
    a.stop();
  });

  test('disconnect mid-flight → RpcDisconnectError', async () => {
    const a = await readyClient({ kind: 'rpc-a7' });
    const b = await readyClient({ kind: 'rpc-b7', rpcHandlers: {
      hang: () => new Promise(() => {}),
    } });
    const p = a.rpc('rpc-b7', 'hang', {}, 5000);
    p.catch(() => {});
    await tick();
    a.stop();
    let caught;
    try { await p; } catch (e) { caught = e; }
    assert.ok(caught instanceof RpcDisconnectError);
    b.stop();
  });

  test('server-rpc: link.health works', async () => {
    const a = await readyClient({ kind: 'rpc-a8' });
    const h = await a.rpc('server', 'link.health', {});
    assert.ok(typeof h.peerCount === 'number');
    a.stop();
  });

  test('throws synchronously on invalid "to" (matches send/subscribe semantics)', async () => {
    const a = await readyClient({ kind: 'rpc-validate-to' });
    assert.throws(() => a.rpc('',      'echo', {}), TypeError, '"to" must be non-empty string');
    assert.throws(() => a.rpc(null,    'echo', {}), TypeError);
    assert.throws(() => a.rpc(123,     'echo', {}), TypeError);
    assert.throws(() => a.rpc(undefined,'echo',{}), TypeError);
    a.stop();
  });

  test('throws synchronously on invalid "rpcType"', async () => {
    const a = await readyClient({ kind: 'rpc-validate-type' });
    assert.throws(() => a.rpc('peer', '',        {}), TypeError, '"rpcType" must be non-empty string');
    assert.throws(() => a.rpc('peer', null,      {}), TypeError);
    assert.throws(() => a.rpc('peer', 123,       {}), TypeError);
    assert.throws(() => a.rpc('peer', undefined, {}), TypeError);
    a.stop();
  });

  test('pre-aborted signal emits rpc.abort (in addition to rpc.complete)', async () => {
    const a = await readyClient({ kind: 'pre-abort-emit' });
    const aborts = [];
    const completes = [];
    a.on('rpc.abort',    (i) => aborts.push(i));
    a.on('rpc.complete', (i) => completes.push(i));

    const ac = new AbortController();
    ac.abort();

    await assert.rejects(
      a.rpc('peer', 'whatever', {}, { signal: ac.signal }),
      RpcAbortError,
    );
    assert.strictEqual(aborts.length, 1, 'rpc.abort must fire even on pre-send abort');
    assert.strictEqual(completes.length, 1);
    assert.strictEqual(completes[0].reason, 'abort');
    a.stop();
  });

  test('stop() emits rpc.disconnect for orphaned pending RPCs', async () => {
    const a = await readyClient({ kind: 'stop-emit-a' });
    const b = await readyClient({
      kind: 'stop-emit-b',
      rpcHandlers: { hang: () => new Promise(() => {}) },
    });

    const disconnects = [];
    a.on('rpc.disconnect', (i) => disconnects.push(i));

    const p = a.rpc('stop-emit-b', 'hang', {}, 5000);
    p.catch(() => {});
    await tick(30);

    a.stop();
    await assert.rejects(p, RpcDisconnectError);
    assert.strictEqual(disconnects.length, 1, 'rpc.disconnect must fire when stop() orphans an RPC');
    assert.strictEqual(disconnects[0].rpcType, 'hang');
    b.stop();
  });
});

describe('rpc.complete', () => {
  test('always carries id and durationMs (number, not null) on success', async () => {
    const a = await readyClient({ kind: 'cp-a' });
    const b = await readyClient({ kind: 'cp-b', rpcHandlers: { echo: async (d) => d } });
    const events = [];
    a.on('rpc.complete', (i) => events.push(i));
    await a.rpc('cp-b', 'echo', { x: 1 });
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].ok, true);
    assert.strictEqual(events[0].reason, null);
    assert.ok(typeof events[0].id === 'string' && events[0].id.length > 0);
    assert.strictEqual(typeof events[0].durationMs, 'number');
    a.stop(); b.stop();
  });

  test('fires for pre-abort path with id and durationMs', async () => {
    const a = await readyClient({ kind: 'cp-pa' });
    const events = [];
    a.on('rpc.complete', (i) => events.push(i));
    const ac = new AbortController(); ac.abort();
    try { await a.rpc('xyz', 't', {}, { signal: ac.signal }); } catch {}
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].reason, 'abort');
    assert.ok(typeof events[0].id === 'string' && events[0].id.length > 0);
    assert.strictEqual(typeof events[0].durationMs, 'number');
    a.stop();
  });

  test('fires for not-connected path with reason="not-ready"', async () => {
    const a = new LinkClient({ url: URL, secret: SECRET, kind: 'cp-nc', logger: null });
    const events = [];
    a.on('rpc.complete', (i) => events.push(i));
    try { await a.rpc('x', 't', {}, 100); } catch {}
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].reason, 'not-ready');
    assert.ok(events[0].id);
  });

  test('fires for backpressure with reason="backpressure" (the new behavior)', async () => {
    const a = await readyClient({ kind: 'cp-bp', maxBufferedBytes: 10 });
    const events = [];
    a.on('rpc.complete', (i) => events.push(i));
    Object.defineProperty(a.ws, 'bufferedAmount', { get: () => 1_000_000, configurable: true });
    let caught;
    try { await a.rpc('x', 't', { p: 'x'.repeat(200) }, 100); }
    catch (e) { caught = e; }
    assert.ok(caught instanceof BackpressureError);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].reason, 'backpressure');
    assert.ok(events[0].id);
    a.stop();
  });

  test('fires for timeout path', async () => {
    const a = await readyClient({ kind: 'cp-to' });
    const b = await readyClient({ kind: 'cp-tob', rpcHandlers: {
      hang: () => new Promise(() => {}),
    } });
    const events = [];
    a.on('rpc.complete', (i) => events.push(i));
    try { await a.rpc('cp-tob', 'hang', {}, 50); } catch {}
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].reason, 'timeout');
    a.stop(); b.stop();
  });

  test('reason="remote-error" for handler-thrown errors (NOT send-error)', async () => {
    const a = await readyClient({ kind: 'cp-re' });
    const b = await readyClient({ kind: 'cp-reb', rpcHandlers: {
      boom: () => { throw new Error('boo'); },
    } });
    const events = [];
    a.on('rpc.complete', (i) => events.push(i));
    try { await a.rpc('cp-reb', 'boom', {}); } catch {}
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].reason, 'remote-error');
    a.stop(); b.stop();
  });
});

describe('handle / unhandle', () => {
  test('handle() registers, unhandle() removes, idempotent re-registration is safe', async () => {
    const b = await readyClient({ kind: 'h-b' });
    const fn = async ({ x }) => ({ y: x * 2 });
    assert.strictEqual(b.handle('mul', fn), undefined,
      'first registration returns no previous handler');
    assert.strictEqual(b.handle('mul', fn), fn,
      're-registration returns the previous handler');
    assert.strictEqual(b.unhandle('mul'), true,
      'unhandle returns true on a real handler');
    assert.strictEqual(b.unhandle('mul'), false,
      'unhandle returns false when nothing was registered');
    b.stop();
  });

  test('unhandle() ignores inherited keys (not "constructor"/"toString"/etc.)', async () => {
    const b = await readyClient({ kind: 'h-proto' });
    assert.strictEqual(b.unhandle('constructor'), false);
    assert.strictEqual(b.unhandle('toString'),    false);
    assert.strictEqual(b.unhandle('hasOwnProperty'), false);
    b.stop();
  });
});

describe('rpc/ready/waitFor per-call timeoutMs validation (since v0.5.0)', () => {
  function freshClient(kind) {
    return new LinkClient({
      url: URL, secret: SECRET, kind, logger: null,
    });
  }

  test('rpc() rejects NaN / Infinity / negative / wrong-type timeoutMs', async () => {
    const a = await readyClient({ kind: 'tov-a' });
    for (const bad of [NaN, Infinity, -1, '5000', {}, true]) {
      assert.throws(
        () => a.rpc('whatever', 'x', {}, { timeoutMs: bad }),
        TypeError,
        `rpc({ timeoutMs: ${String(bad)} }) should throw TypeError`,
      );
    }
    for (const bad of [NaN, Infinity, -1]) {
      assert.throws(
        () => a.rpc('whatever', 'x', {}, bad),
        TypeError,
        `rpc(..., ${String(bad)}) should throw TypeError`,
      );
    }
    a.stop();
  });

  test('rpc() treats timeoutMs: 0 as "no timeout" (matches ready/waitFor)', async () => {
    const a = await readyClient({ kind: 'tov-b' });
    let caught;
    try { await a.rpc('nobody', 'x', {}, { timeoutMs: 0 }); }
    catch (e) { caught = e; }
    assert.ok(caught instanceof RpcRemoteError,
      `expected RpcRemoteError, got ${caught?.constructor?.name}`);
    assert.ok(!(caught instanceof RpcTimeoutError),
      'must not fire a synthetic timeout for timeoutMs:0');
    a.stop();
  });

  test('ready() rejects NaN / Infinity / negative timeoutMs', () => {
    const c = freshClient('tov-c');
    for (const bad of [NaN, Infinity, -1, '0', {}]) {
      assert.throws(
        () => c.ready({ timeoutMs: bad }),
        TypeError,
        `ready({ timeoutMs: ${String(bad)} }) should throw TypeError`,
      );
    }
    c.stop();
  });

  test('waitFor() rejects NaN / Infinity / negative timeoutMs', () => {
    const c = freshClient('tov-d');
    for (const bad of [NaN, Infinity, -1, '0', {}]) {
      assert.throws(
        () => c.waitFor('ready', { timeoutMs: bad }),
        TypeError,
        `waitFor({ timeoutMs: ${String(bad)} }) should throw TypeError`,
      );
    }
    c.stop();
  });

  test('rpc() with no timeoutMs uses defaultRpcTimeoutMs', async () => {
    const a = await readyClient({ kind: 'tov-e', defaultRpcTimeoutMs: 50 });
    const b = await readyClient({ kind: 'tov-f', rpcHandlers: {
      hang: () => new Promise(() => {}),
    } });
    let caught;
    try { await a.rpc('tov-f', 'hang', {}); } catch (e) { caught = e; }
    assert.ok(caught instanceof RpcTimeoutError);
    assert.strictEqual(caught.timeoutMs, 50);
    a.stop(); b.stop();
  });
});