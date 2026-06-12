'use strict';

/**
 * Regression tests for the third v0.6.0 pre-release audit wave
 * (external review, all items reproduced before fixing), ports 20210-20229.
 *
 * Covers:
 *   1. One socket cannot authenticate as two kinds via concurrent hellos
 *      racing a slow async secret resolver (first hello wins; no ghost
 *      peer survives the close).
 *   2. The canonical signing serializer is JSON-faithful: boxed primitives
 *      and key-sensitive toJSON sign exactly what JSON.stringify ships
 *      (round-trip canonicalization invariant, fuzzed), and a boxed BigInt
 *      is rejected by the wire-safety check up front.
 *   3. RpcHandlerError.data is validated like a success result: lossy data
 *      is stripped loudly (error/code still arrive), and unserializable
 *      data no longer converts a deliberate remote error into a caller
 *      timeout. Both the hub-side and client-side handler paths.
 *   4. createHubServer start()/stop() are concurrency-safe: stop() during
 *      a pending start() leaves nothing listening, concurrent start()s
 *      share one flight, and no process signal handler leaks.
 *   5. makeStatus() output gets full wire-safety validation.
 *   6. Readiness is gated strictly on hello.ack: a verified non-ack frame
 *      neither flips ready nor causes queued feature-dependent messages
 *      to be purged against an assumed-empty feature list.
 *   7. /state responds 500 (and terminates the response) when extraState
 *      produces unserializable values, instead of hanging the request.
 *   8. Graceful stop() clears connection-activity timers before the drain
 *      window: no status pushes, keepalive activity, or hello-ack
 *      diagnostics fire after stop() begins.
 *   9. Outbox byte accounting covers id/type/to/from, and inbound ids are
 *      length-capped, so retained memory cannot blow past maxOutboxBytes.
 *  10. Construction-time hardening: kinds with surrounding whitespace and
 *      non-string names are rejected loudly.
 */

const http = require('http');
const { test, describe } = require('node:test');
const assert = require('node:assert');

const { WebSocket, WebSocketServer } = require('ws');

const {
  createHubServer, LinkClient, RpcHandlerError, RpcRemoteError,
  makeMsg, stableStringify, assertJsonSerializable,
} = require('../../src/index.js');

const { estimateSize } = require('../../src/internal/outbox.js');
const { parseEnvelope } = require('../../src/internal/inbound-validate.js');
const { assertValidKind } = require('../../src/hub/hello.js');

const SECRET = 'audit3-test';
const tick   = (ms = 40) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, { timeoutMs = 3000, intervalMs = 10, label } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let v;
    try { v = await predicate(); }
    catch { v = false; }
    if (v) return v;
    if (Date.now() >= deadline) {
      throw new Error(`waitFor: timed out after ${timeoutMs}ms${label ? ` waiting for ${label}` : ''}`);
    }
    await tick(intervalMs);
  }
}

/** Start a throwaway hub server on an ephemeral port; caller stops it. */
async function startServer(opts = {}) {
  const server = createHubServer({
    secret: SECRET, port: 0, host: '127.0.0.1',
    handleSignals: false, logger: null, ...opts,
  });
  await server.start();
  return { server, port: server.httpServer.address().port,
           url: `ws://127.0.0.1:${server.httpServer.address().port}` };
}

describe('1. concurrent hellos cannot register one socket as two kinds', () => {
  test('first hello wins; the loser is rejected; no ghost peer survives close', async () => {
    const { server } = await startServer({
      secret: async () => { await tick(80); return SECRET; },
    });
    try {
      const protoErrors = [];
      server.hub.on('protocol-error', (p) => protoErrors.push(p));

      const ws = new WebSocket(`ws://127.0.0.1:${server.httpServer.address().port}`);
      await new Promise((r) => ws.on('open', r));

      ws.send(JSON.stringify(makeMsg(SECRET, { id: 'h1', type: 'hello', data: { kind: 'beta'  } })));
      ws.send(JSON.stringify(makeMsg(SECRET, { id: 'h2', type: 'hello', data: { kind: 'alpha' } })));

      await waitFor(() => server.getState().peers.length >= 1, { label: 'first hello registered' });
      await tick(120);

      const kinds = server.getState().peers.map((p) => p.kind);
      assert.deepEqual(kinds, ['beta'], 'only the first hello registers');
      assert.ok(
        protoErrors.some((p) => p.reason === 'duplicate-hello' && p.detail === 'concurrent-hello'),
        'the racing hello is rejected as a concurrent duplicate');

      ws.close();
      await waitFor(() => server.getState().peers.length === 0,
        { label: 'peer fully removed on close' });
      assert.equal(server.hub.health().peerCount, 0, 'no ghost peer survives the close');
    } finally {
      await server.stop();
    }
  });
});

describe('2. canonical signing is JSON-faithful', () => {
  test('round-trip canonicalization invariant holds for adversarial values', () => {
    const cases = [
      { value: new Number(1) },
      { value: new String('x') },
      { value: new Boolean(true) },
      { value: { toJSON(key) { return `key:${key}`; } } },
      [new Number(2), { inner: new String('y') }],
      { nested: { deep: [new Boolean(false), 'plain', 3] } },
      { date: new Date(0) },
      { fnWithToJSON: Object.assign(() => {}, { toJSON: () => 42 }) },
    ];
    for (const v of cases) {
      const wire = JSON.stringify(v);
      assert.equal(
        stableStringify(v),
        stableStringify(JSON.parse(wire)),
        `canonical form must survive a JSON round-trip: ${wire}`);
    }
  });

  test('fuzz: 500 random JSON-ish values keep the invariant', () => {
    let seed = 0x5eed;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const leaf = () => {
      const r = rnd();
      if (r < 0.15) return new Number(Math.floor(rnd() * 1000));
      if (r < 0.30) return new String(String.fromCharCode(97 + Math.floor(rnd() * 26)).repeat(1 + Math.floor(rnd() * 4)));
      if (r < 0.40) return new Boolean(rnd() < 0.5);
      if (r < 0.55) return rnd() * 1000 - 500;
      if (r < 0.70) return `s${Math.floor(rnd() * 1e6)}`;
      if (r < 0.80) return rnd() < 0.5;
      if (r < 0.90) return null;
      return { toJSON(key) { return `j:${key}`; } };
    };
    const build = (depth) => {
      if (depth <= 0 || rnd() < 0.4) return leaf();
      if (rnd() < 0.5) return Array.from({ length: Math.floor(rnd() * 4) }, () => build(depth - 1));
      const o = {};
      for (let i = Math.floor(rnd() * 4); i > 0; i--) o[`k${Math.floor(rnd() * 100)}`] = build(depth - 1);
      return o;
    };
    for (let i = 0; i < 500; i++) {
      const v = build(3);
      const wire = JSON.stringify(v);
      assert.equal(stableStringify(v), stableStringify(JSON.parse(wire)),
        `fuzz case ${i} diverged: ${wire}`);
    }
  });

  test('boxed primitives pass validation as their unwrapped value; boxed BigInt and NaN-box are rejected', () => {
    assert.doesNotThrow(() => assertJsonSerializable({ v: new Number(1) }));
    assert.doesNotThrow(() => assertJsonSerializable({ v: new String('x') }));
    assert.throws(() => assertJsonSerializable({ v: Object(2n) }), /BigInt/);
    assert.throws(() => assertJsonSerializable({ v: new Number(NaN) }), /non-finite/);
  });

  test('end-to-end: an RPC payload with a boxed primitive arrives value-intact', async () => {
    const { server, url } = await startServer({
      rpcHandlers: { echo: (d) => ({ got: d }) },
    });
    const client = new LinkClient({ url, secret: SECRET, kind: 'fidelity', logger: null });
    try {
      client.start();
      await client.ready({ timeoutMs: 3000 });
      const r = await client.rpc('server', 'echo', { value: new Number(1) }, { timeoutMs: 2000 });
      assert.deepEqual(r, { got: { value: 1 } }, 'boxed Number ships as 1, signature verifies');
    } finally {
      await client.stop({ drain: false });
      await server.stop();
    }
  });
});

describe('3. RpcHandlerError.data is wire-validated on both handler paths', () => {
  test('hub-side: lossy data stripped (error/code intact); unserializable data no longer becomes a timeout', async () => {
    const { server, url } = await startServer({
      rpcHandlers: {
        mapErr:    () => { throw new RpcHandlerError('bad', { code: 'BAD', data: new Map([['a', 1]]) }); },
        bigintErr: () => { throw new RpcHandlerError('bad', { code: 'BAD', data: { value: 1n } }); },
        goodErr:   () => { throw new RpcHandlerError('bad', { code: 'BAD', data: { why: 'reasons' } }); },
      },
    });
    const client = new LinkClient({ url, secret: SECRET, kind: 'caller3a', logger: null });
    try {
      client.start();
      await client.ready({ timeoutMs: 3000 });

      await assert.rejects(
        client.rpc('server', 'mapErr', null, { timeoutMs: 1500 }),
        (e) => e instanceof RpcRemoteError && e.code === 'BAD' && e.data === undefined,
        'Map data is stripped, never silently shipped as {}');

      await assert.rejects(
        client.rpc('server', 'bigintErr', null, { timeoutMs: 1500 }),
        (e) => e instanceof RpcRemoteError && e.code === 'BAD' && e.message === 'bad',
        'the deliberate remote error arrives instead of an RpcTimeoutError');

      await assert.rejects(
        client.rpc('server', 'goodErr', null, { timeoutMs: 1500 }),
        (e) => e instanceof RpcRemoteError && e.code === 'BAD' && e.data?.why === 'reasons',
        'wire-safe data still arrives untouched');
    } finally {
      await client.stop({ drain: false });
      await server.stop();
    }
  });

  test('client-side handler path behaves identically', async () => {
    const { server, url } = await startServer();
    const peer = new LinkClient({
      url, secret: SECRET, kind: 'peer3b', logger: null,
      rpcHandlers: {
        bigintErr: () => { throw new RpcHandlerError('bad', { code: 'BAD', data: { value: 1n } }); },
      },
    });
    const caller = new LinkClient({ url, secret: SECRET, kind: 'caller3b', logger: null });
    try {
      peer.start();   await peer.ready({ timeoutMs: 3000 });
      caller.start(); await caller.ready({ timeoutMs: 3000 });

      await assert.rejects(
        caller.rpc('peer3b', 'bigintErr', null, { timeoutMs: 1500 }),
        (e) => e instanceof RpcRemoteError && e.code === 'BAD',
        'peer handler errors with bad data still arrive as the deliberate error');
    } finally {
      await caller.stop({ drain: false });
      await peer.stop({ drain: false });
      await server.stop();
    }
  });
});

describe('4. createHubServer start()/stop() concurrency', () => {
  test('stop() during a pending start() leaves nothing listening and a consistent lifecycle', async () => {
    const server = createHubServer({
      secret: SECRET, port: 0, host: '127.0.0.1', handleSignals: false, logger: null,
    });
    const starting = server.start();
    const stopping = server.stop();
    await Promise.allSettled([starting, stopping]);

    assert.equal(server.httpServer.listening, false, 'no reachable server may survive a stop()');
    assert.equal(server.isStopped, true);
    assert.equal(server.isStarted, false, 'isStarted reads false once stop() completes');
  });

  test('concurrent start() shares one flight; stop() removes every signal handler', async () => {
    const before = process.listenerCount('SIGTERM');
    const server = createHubServer({
      secret: SECRET, port: 0, host: '127.0.0.1', handleSignals: true, logger: null,
    });
    try {
      await Promise.all([server.start(), server.start()]);
      assert.equal(process.listenerCount('SIGTERM'), before + 1,
        'one start flight installs exactly one handler per signal');
    } finally {
      await server.stop();
    }
    assert.equal(process.listenerCount('SIGTERM'), before, 'stop() leaks no signal handler');
  });

  test('start() after stop() throws the single-shot error', async () => {
    const { server } = await startServer();
    await server.stop();
    await assert.rejects(() => server.start(), /single-shot/);
  });
});

describe('5. makeStatus() output is wire-validated', () => {
  test('a lossy status is warned about locally and never ships; a clean one ships', async () => {
    const { server, url } = await startServer();
    let status = new Map([['a', 1]]);
    const warned = [];
    const client = new LinkClient({
      url, secret: SECRET, kind: 'status5', statusIntervalMs: 60,
      makeStatus: () => status,
      logger: { debug() {}, info() {}, warn: (...a) => warned.push(a.join(' ')), error() {} },
    });
    try {
      client.start();
      await client.ready({ timeoutMs: 3000 });
      await tick(150);

      assert.equal(server.getState().lastStatus.status5, undefined,
        'the Map status must never reach the hub (not even as {})');
      assert.ok(warned.some((w) => /makeStatus/.test(w) && /wire-safe|not JSON-serializable/i.test(w)),
        'the client warns loudly about the rejected status');

      status = { ok: true, n: 7 };
      await waitFor(() => server.getState().lastStatus.status5?.status?.n === 7,
        { label: 'clean status delivered' });
    } finally {
      await client.stop({ drain: false });
      await server.stop();
    }
  });
});

describe('6. readiness is gated strictly on hello.ack', () => {
  test('a hub interleaving peers.update before a delayed ack cannot trigger early ready or message loss', async () => {
    const received = [];
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const m = JSON.parse(raw);
        received.push(m.type === 'direct' ? `direct:${m.data?.directType}` : m.type);
        if (m.type === 'hello') {
          ws.send(JSON.stringify(makeMsg(SECRET, {
            id: 'pu1', type: 'peers.update', to: m.data.kind,
            data: { peers: [{ kind: 'other', connectedAt: Date.now() }] },
          })));
          setTimeout(() => {
            ws.send(JSON.stringify(makeMsg(SECRET, {
              id: 'ack1', type: 'hello.ack', to: m.data.kind,
              data: { ok: true, serverTime: Date.now(), kind: m.data.kind, features: ['topics', 'direct'] },
            })));
          }, 150);
        }
      });
    });
    await new Promise((r) => wss.on('listening', r));

    const client = new LinkClient({
      url: `ws://127.0.0.1:${wss.address().port}`, secret: SECRET, kind: 'strict6', logger: null,
    });
    try {
      let readyAt = null, ackAt = null;
      client.on('ready', () => { readyAt = Date.now(); });
      client.on('message', ({ msg }) => { if (msg.type === 'hello.ack') ackAt = Date.now(); });

      client.start();
      await waitFor(() => client.isConnected(), { label: 'socket open' });
      assert.doesNotThrow(() => client.send('other', 'important.job', { n: 1 }),
        'unknown features must queue, not throw FeatureUnsupportedError');

      await waitFor(() => client.getPeers().some((p) => p.kind === 'other'),
        { label: 'interleaved peers.update processed' });
      assert.equal(client.isReady(), false, 'verified non-ack traffic does not flip ready');

      await client.ready({ timeoutMs: 3000 });
      assert.ok(readyAt !== null && ackAt !== null && readyAt >= ackAt,
        'ready fires at (not before) the hello.ack');
      assert.deepEqual(client.hubFeatures, ['topics', 'direct']);

      await waitFor(() => received.includes('direct:important.job'),
        { label: 'queued feature-dependent message delivered after the ack' });
    } finally {
      await client.stop({ drain: false });
      await new Promise((r) => wss.close(r));
    }
  });
});

describe('7. /state never hangs on unserializable extraState', () => {
  test('circular extraState responds HTTP 500 and the response ends', async () => {
    const circ = {}; circ.self = circ;
    const { server, port } = await startServer({
      enableStateRoute: true,
      extraState: () => ({ circ }),
    });
    try {
      const outcome = await new Promise((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/state`, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        });
        req.setTimeout(2000, () => { req.destroy(); reject(new Error('request hung')); });
        req.on('error', reject);
      });
      assert.equal(outcome, 500);
    } finally {
      await server.stop();
    }
  });
});

describe('8. graceful stop clears connection timers before the drain', () => {
  test('no status pushes or hello-ack diagnostics fire after stop() begins', async () => {
    const { server, url } = await startServer({
      rpcHandlers: { slow: async () => { await tick(350); return 'done'; } },
    });
    const lateStatusFrames = [];
    server.hub.on('message', ({ msg }) => {
      if (msg.type === 'status.update') lateStatusFrames.push(Date.now());
    });

    const client = new LinkClient({
      url, secret: SECRET, kind: 'drain8', logger: null,
      makeStatus: () => ({ ok: true }), statusIntervalMs: 50,
      helloAckDiagnosticMs: 200,
    });
    const lateProtoErrors = [];
    try {
      client.start();
      await client.ready({ timeoutMs: 3000 });

      const inflight = client.rpc('server', 'slow', null, { timeoutMs: 5000 });
      await tick(30);

      const stopBegan = Date.now();
      client.on('protocol-error', (p) => lateProtoErrors.push(p.reason));
      const stopP = client.stop({ timeoutMs: 2000 });

      assert.equal(client.statusTimer, null, 'status interval cleared at stop entry');
      assert.equal(client._keepaliveTimer, null, 'keepalive cleared at stop entry');
      assert.equal(client.helloAckTimer, null, 'ack diagnostic cleared at stop entry');

      await stopP;
      const result = await inflight;
      assert.equal(result, 'done', 'the graceful drain still let the in-flight RPC settle');

      await tick(80);
      assert.equal(lateStatusFrames.filter((t) => t > stopBegan + 5).length, 0,
        'no status.update may be enqueued after stop() begins');
      assert.deepEqual(lateProtoErrors, [], 'no protocol errors after stop() begins');
    } finally {
      await server.stop();
    }
  });
});

describe('9. outbox accounting and inbound id bounds', () => {
  test('estimateSize covers id/type/to/from', () => {
    const id = 'x'.repeat(200);
    const item = { id, type: 'rpc.response', to: 'a-peer-kind', from: 'me', data: { ok: true } };
    const est = estimateSize(item);
    const floor = id.length + 'rpc.response'.length + 'a-peer-kind'.length
                + Buffer.byteLength(JSON.stringify(item.data));
    assert.ok(est >= floor,
      `estimate (${est}) must cover the variable-length fields (>= ${floor})`);
  });

  test('inbound ids longer than 256 chars are rejected at parse', () => {
    const ok = parseEnvelope(JSON.stringify({ id: 'a'.repeat(256), type: 't' }), 1e6);
    assert.equal(ok.ok, true, 'a 256-char id is still accepted');

    const big = parseEnvelope(JSON.stringify({ id: 'a'.repeat(257), type: 't' }), 1e6);
    assert.equal(big.ok, false);
    assert.equal(big.reason, 'oversized-id');
  });
});

describe('10. construction-time hardening', () => {
  test('kinds with surrounding whitespace are rejected loudly', () => {
    assert.throws(() => assertValidKind(' worker '), /surrounding whitespace/);
    assert.throws(
      () => new LinkClient({ url: 'ws://x', secret: 's', kind: ' worker ', logger: null }),
      /surrounding whitespace/);
    assert.doesNotThrow(() => assertValidKind('worker'));
  });

  test('name must be a non-empty string when provided', () => {
    assert.throws(
      () => new LinkClient({ url: 'ws://x', secret: 's', kind: 'k', name: { o: 1 }, logger: null }),
      /"name" must be a non-empty string/);
    assert.doesNotThrow(
      () => new LinkClient({ url: 'ws://x', secret: 's', kind: 'k', name: 'pretty name', logger: null }));
  });
});
