'use strict';

/**
 * Regression tests for the second v0.6.0 pre-release audit wave
 * (external review validation), ports 20110-20119.
 *
 * Covers:
 *   1. Hub 'message' listeners cannot mutate routing (snapshot emitted).
 *   2. Client 'message' listeners cannot mutate inbound rpc.response
 *      results (snapshot emitted).
 *   3. hub.getState() returns a deep snapshot, not live internals.
 *   4. Strict wire validation rejects lossy values (Map/Set/NaN/...).
 *   5. Server RPC results get the same clone+strict validation as peer
 *      RPC results (RPC_RESULT_NOT_SERIALIZABLE instead of silent drops).
 *   6. waitFor(Symbol) settles with a proper timeout error instead of
 *      crashing the process from inside the timer callback.
 *   7. Construction-time validation: port range, rpcHandlers values,
 *      hub-grade kind rules on the client.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  createHubServer, LinkClient, RpcRemoteError, assertJsonSerializable,
} = require('../../src/index.js');

const SECRET = 'audit2-test';
const tick   = (ms = 40) => new Promise((r) => setTimeout(r, ms));

describe('userland mutation isolation', () => {
  test("a hub 'message' listener cannot rewrite routing", async () => {
    const server = createHubServer({
      secret: SECRET, port: 20110, logger: null, handleSignals: false,
    });
    await server.start();
    const url = 'ws://127.0.0.1:20110';

    server.hub.on('message', ({ msg }) => {
      if (msg.type === 'direct' && msg.to === 'missing-peer') msg.to = 'bob';
    });

    const alice = new LinkClient({ url, secret: SECRET, kind: 'alice', logger: null });
    const bob   = new LinkClient({ url, secret: SECRET, kind: 'bob',   logger: null });
    let bobGot = null;
    bob.on('direct', (e) => { bobGot = e; });

    try {
      await Promise.all([alice.ready({ timeoutMs: 3000 }), bob.ready({ timeoutMs: 3000 })]);
      alice.send('missing-peer', 'evt', { x: 1 });
      await tick(150);
      assert.equal(bobGot, null, 'bob must not receive a hijacked direct');
    } finally {
      await alice.stop(); await bob.stop(); await server.stop();
    }
  });

  test("a client 'message' listener cannot mutate an inbound RPC result", async () => {
    const server = createHubServer({
      secret: SECRET, port: 20111, logger: null, handleSignals: false,
    });
    await server.start();
    const url = 'ws://127.0.0.1:20111';

    const target = new LinkClient({
      url, secret: SECRET, kind: 'target', logger: null,
      rpcHandlers: { echo: () => ({ ok: 1 }) },
    });
    const caller = new LinkClient({ url, secret: SECRET, kind: 'caller', logger: null });

    caller.on('message', ({ msg }) => {
      if (msg.type === 'rpc.response' && msg.data?.ok) msg.data.result = { mutated: true };
    });

    try {
      await Promise.all([target.ready({ timeoutMs: 3000 }), caller.ready({ timeoutMs: 3000 })]);
      const res = await caller.rpc('target', 'echo', {});
      assert.deepEqual(res, { ok: 1 });
    } finally {
      await caller.stop(); await target.stop(); await server.stop();
    }
  });

  test('getState() returns a deep snapshot', async () => {
    const server = createHubServer({
      secret: SECRET, port: 20112, logger: null, handleSignals: false,
    });
    await server.start();

    const link = new LinkClient({
      url: 'ws://127.0.0.1:20112', secret: SECRET, kind: 'peer.a',
      name: 'original-name', logger: null,
      makeStatus: () => ({ nested: { x: 1 } }), statusIntervalMs: 10_000,
    });

    try {
      await link.ready({ timeoutMs: 3000 });
      await tick(100);

      const st1 = server.hub.getState();
      assert.equal(st1.peers[0].hello.name, 'original-name');

      st1.peers[0].hello.name = 'MUTATED';
      if (st1.lastStatus['peer.a']) {
        st1.lastStatus['peer.a'].status.nested.x = 999;
        st1.lastStatus['peer.a'].at = 123;
      }

      const st2 = server.hub.getState();
      assert.equal(st2.peers[0].hello.name, 'original-name');
      if (st2.lastStatus['peer.a']) {
        assert.equal(st2.lastStatus['peer.a'].status.nested.x, 1);
        assert.notEqual(st2.lastStatus['peer.a'].at, 123);
      }
    } finally {
      await link.stop(); await server.stop();
    }
  });
});

describe('strict wire validation', () => {
  test('assertJsonSerializable rejects lossy values and accepts meaning-preserving ones', () => {
    assert.throws(() => assertJsonSerializable(new Map([['x', 1]])), /Map/);
    assert.throws(() => assertJsonSerializable({ s: new Set([1]) }), /Set.*at s/);
    assert.throws(() => assertJsonSerializable({ a: [NaN] }), /non-finite.*a\[0\]/);
    assert.throws(() => assertJsonSerializable(Infinity), /non-finite/);
    assert.throws(() => assertJsonSerializable({ r: /x/ }), /RegExp/);
    assert.throws(() => assertJsonSerializable({ e: new Error('x') }), /Error/);
    assert.throws(() => assertJsonSerializable({ b: new Uint8Array(2) }), /Uint8Array/);
    assert.throws(() => assertJsonSerializable({ n: 1n }), /BigInt/);
    const circ = {}; circ.self = circ;
    assert.throws(() => assertJsonSerializable(circ), /circular/);

    assert.doesNotThrow(() => assertJsonSerializable({ a: 1, b: 'x', c: null, d: [1, 2], e: { f: true } }));
    assert.doesNotThrow(() => assertJsonSerializable({ when: new Date() }));     // ISO string via toJSON
    assert.doesNotThrow(() => assertJsonSerializable({ opt: undefined }));        // omitted by JSON
    assert.doesNotThrow(() => assertJsonSerializable(undefined));
    
    const shared = { x: 1 };
    assert.doesNotThrow(() => assertJsonSerializable({ a: shared, b: shared }));
  });

  test('publish() rejects a Map at the call site instead of delivering {}', async () => {
    const server = createHubServer({
      secret: SECRET, port: 20113, logger: null, handleSignals: false,
    });
    await server.start();
    const link = new LinkClient({
      url: 'ws://127.0.0.1:20113', secret: SECRET, kind: 'pub.m', logger: null,
    });

    try {
      await link.ready({ timeoutMs: 3000 });
      assert.throws(() => link.publish('m.t', new Map([['x', 1]])), TypeError);
      assert.throws(() => link.send('someone', 'evt', { n: NaN }), TypeError);
    } finally {
      await link.stop(); await server.stop();
    }
  });

  test('server RPC result with a function property replies RPC_RESULT_NOT_SERIALIZABLE', async () => {
    const server = createHubServer({
      secret: SECRET, port: 20114, logger: null, handleSignals: false,
      rpcHandlers: { 'srv.fn': () => ({ ok: true, fn: () => 1 }) },
    });
    await server.start();
    const link = new LinkClient({
      url: 'ws://127.0.0.1:20114', secret: SECRET, kind: 'caller.f', logger: null,
    });

    try {
      await link.ready({ timeoutMs: 3000 });
      await assert.rejects(
        link.rpc('server', 'srv.fn', {}),
        (e) => e instanceof RpcRemoteError && e.code === 'RPC_RESULT_NOT_SERIALIZABLE',
      );
    } finally {
      await link.stop(); await server.stop();
    }
  });
});

describe('waitFor with a symbol event', () => {
  test('times out with a proper Error instead of crashing the timer callback', async () => {
    const link = new LinkClient({ logger: null });
    const sym = Symbol('never-fires');
    
    const keepAlive = setTimeout(() => {}, 5000);
    try {
      await assert.rejects(
        link.waitFor(sym, { timeoutMs: 30 }),
        (e) => e instanceof Error && !(e instanceof TypeError) && /timed out/.test(e.message),
      );
    } finally {
      clearTimeout(keepAlive);
    }
  });

  test('abort path also stringifies the symbol safely', async () => {
    const link = new LinkClient({ logger: null });
    const ac = new AbortController();
    const p = link.waitFor(Symbol('abort-me'), { timeoutMs: 0, signal: ac.signal });
    ac.abort();
    await assert.rejects(p, (e) => e.name === 'AbortError');
  });
});

describe('construction-time validation', () => {
  test('port must be an integer in [0, 65535]', () => {
    assert.throws(() => createHubServer({ secret: 's', port: 8080.5 }), /port/);
    assert.throws(() => createHubServer({ secret: 's', port: 999999 }), /65535/);
    assert.throws(() => createHubServer({ secret: 's', port: -1 }), /port/);
  });

  test('rpcHandlers values must be functions (client and hub)', () => {
    assert.throws(() => new LinkClient({ rpcHandlers: { 'job.run': 'runJob' } }), /must be a function/);
    assert.throws(() => createHubServer({ secret: 's', rpcHandlers: { x: 42 } }), /must be a function/);
    assert.doesNotThrow(() => new LinkClient({ rpcHandlers: { ok: () => 1 }, logger: null }));
  });

  test('client kind is held to the hub\'s rules at construction', () => {
    assert.throws(() => new LinkClient({ kind: 'has spaces' }), /a-zA-Z0-9/);
    assert.throws(() => new LinkClient({ kind: 'ctrl\nchar' }), /a-zA-Z0-9/);
    assert.throws(() => new LinkClient({ kind: 'server' }), /reserved/);
    assert.throws(() => new LinkClient({ kind: '__proto__' }), /reserved/);
    assert.throws(() => new LinkClient({ kind: 'x'.repeat(300) }), /256/);
    assert.doesNotThrow(() => new LinkClient({ kind: 'svc.radio-1', logger: null }));
  });
});