'use strict';

/**
 * Integration tests: protocol-error handling, /state route safety, and hub-server lifecycle.
 *
 * Uses a per-file dedicated hub on port 19500 so this file can run in
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

const PORT   = 19500;
const URL    = `ws://127.0.0.1:${PORT}`;
const SECRET = DEFAULT_SECRET;

const harness     = setupHub({ port: PORT });
const readyClient = makeReadyClient(harness);

describe('hub protocol-error + statuses eviction', () => {
  test('hub emits protocol-error on bad-signature', async () => {
    const c = await readyClient({ kind: 'pe-a' });
    let info = null;
    harness.hub.on('protocol-error', (i) => { info = i; });
    const bad = makeMsg('totally-different-secret', {
      id: 'q', type: 'rpc.request', from: 'pe-a', to: 'whoever', data: {},
    });
    c.ws.send(JSON.stringify(bad));
    await tick();
    assert.ok(info);
    assert.strictEqual(info.reason, 'bad-signature');
    assert.strictEqual(info.kind,   'pe-a');
    c.stop();
  });

  test('replay-id cache is partitioned by kind: two peers reusing an id do not collide', async () => {
    const a = await readyClient({ kind: 'rid-a' });
    const b = await readyClient({ kind: 'rid-b' });
    const recv = await readyClient({ kind: 'rid-recv' });
    let received = 0;
    recv.subscribe('rid.test', () => { received += 1; });
    await tick();

    const sharedId = 'shared-id-not-a-uuid';
    const aMsg = makeMsg(SECRET, {
      id: sharedId, type: 'topic.message', from: 'rid-a',
      data: { topic: 'rid.test', payload: { who: 'a' } },
    });
    const bMsg = makeMsg(SECRET, {
      id: sharedId, type: 'topic.message', from: 'rid-b',
      data: { topic: 'rid.test', payload: { who: 'b' } },
    });
    a.ws.send(JSON.stringify(aMsg));
    b.ws.send(JSON.stringify(bMsg));
    await tick(100);
    assert.strictEqual(received, 2,
      'both publishers should reach the subscriber - cache key is kind|id, not id');
    a.stop(); b.stop(); recv.stop();
  });

  test('replay-id still detected within a single kind', async () => {
    const a = await readyClient({ kind: 'rid-self' });
    const recv = await readyClient({ kind: 'rid-self-recv' });
    let received = 0;
    recv.subscribe('rid.self', () => { received += 1; });
    await tick();

    const sharedId = 'self-replay-id';
    const m = makeMsg(SECRET, {
      id: sharedId, type: 'topic.message', from: 'rid-self',
      data: { topic: 'rid.self', payload: { x: 1 } },
    });
    a.ws.send(JSON.stringify(m));
    await tick(50);
    a.ws.send(JSON.stringify(m));
    await tick(100);
    assert.strictEqual(received, 1, 'second send from same kind with same id is a replay');
    a.stop(); recv.stop();
  });

  test('client replay-id cache is partitioned by sender for forwarded rpc.request', async () => {
    const a = await readyClient({ kind: 'crid-a' });
    const b = await readyClient({ kind: 'crid-b' });
    let invocations = 0;
    const c = await readyClient({
      kind: 'crid-c',
      rpcHandlers: {
        'shared': async () => { invocations += 1; return { ok: true }; },
      },
    });

    const sharedId = 'shared-rpc-id-not-uuid';
    const aMsg = makeMsg(SECRET, {
      id: sharedId, type: 'rpc.request', from: 'crid-a', to: 'crid-c',
      data: { rpcType: 'shared', rpcData: { who: 'a' } },
    });
    const bMsg = makeMsg(SECRET, {
      id: sharedId, type: 'rpc.request', from: 'crid-b', to: 'crid-c',
      data: { rpcType: 'shared', rpcData: { who: 'b' } },
    });
    a.ws.send(JSON.stringify(aMsg));
    b.ws.send(JSON.stringify(bMsg));
    await tick(150);
    assert.strictEqual(invocations, 2,
      "both forwarded RPCs should reach c's handler - cache key is from|id, not id");
    a.stop(); b.stop(); c.stop();
  });

  test('hub statuses are evicted when a peer disconnects', async () => {
    const a = await readyClient({
      kind: 'st-a',
      makeStatus: () => ({ status: 'idle' }),
      statusIntervalMs: 5_000,
    });
    await tick(100);
    let snapshot = harness.hub.getState();
    assert.ok(snapshot.lastStatus['st-a'], 'status was recorded while connected');

    a.stop();
    await tick(100);
    snapshot = harness.hub.getState();
    assert.strictEqual(snapshot.lastStatus['st-a'], undefined,
      'status should be evicted from hub state on disconnect');
  });

  test('after disconnect, fresh peers get a status.snapshot without dead peers', async () => {
    const a = await readyClient({
      kind: 'st-a2',
      makeStatus: () => ({ status: 'busy' }),
      statusIntervalMs: 5_000,
    });
    await tick(100);
    a.stop();
    await tick(100);

    const c = await readyClient({ kind: 'st-c' });
    await tick();
    assert.strictEqual(c.getPeerStatus('st-a2'), null);
    c.stop();
  });
});

describe('createHubServer: /state safe-by-default', () => {
  function makeRecordingLogger() {
    const logs = [];
    return {
      logs,
      log:  (tag, ...args) => logs.push({ level: 'log',  tag, msg: args.join(' ') }),
      warn: (tag, ...args) => logs.push({ level: 'warn', tag, msg: args.join(' ') }),
    };
  }

  test('default config does NOT enable /state and does NOT warn', async () => {
    const lg = makeRecordingLogger();
    const s = createHubServer({
      secret: SECRET, port: 19501, logger: lg, handleSignals: false,
    });
    await s.start();
    try {
      const fired = lg.logs.some((e) => e.level === 'warn' && /\/state/.test(e.msg));
      assert.ok(!fired, 'no /state warning expected under the safe default');

      const http = require('node:http');
      const code = await new Promise((resolve, reject) => {
        http.get('http://127.0.0.1:19501/state', (res) => {
          res.resume();
          resolve(res.statusCode);
        }).on('error', reject);
      });
      assert.strictEqual(code, 404, '/state must be unreachable when disabled');
    } finally {
      await s.stop();
    }
  });

  test('opt-in + 0.0.0.0 emits an informational warning', async () => {
    const lg = makeRecordingLogger();
    const s = createHubServer({
      secret: SECRET, port: 19502,
      enableStateRoute: true,
      logger: lg, handleSignals: false,
    });
    await s.start();
    try {
      const fired = lg.logs.some((e) => e.level === 'warn' && /\/state/.test(e.msg));
      assert.ok(fired, 'opt-in + 0.0.0.0 should still emit the exposure warning');
    } finally {
      await s.stop();
    }
  });

  test('opt-in + 127.0.0.1 does NOT warn (loopback is safe)', async () => {
    const lg = makeRecordingLogger();
    const s = createHubServer({
      secret: SECRET, port: 19503, host: '127.0.0.1',
      enableStateRoute: true,
      logger: lg, handleSignals: false,
    });
    await s.start();
    try {
      const fired = lg.logs.some((e) => e.level === 'warn' && /\/state/.test(e.msg));
      assert.ok(!fired, 'no warning on loopback');
    } finally {
      await s.stop();
    }
  });

  test('opt-in /state returns hub state', async () => {
    const lg = makeRecordingLogger();
    const s = createHubServer({
      secret: SECRET, port: 19504, host: '127.0.0.1',
      enableStateRoute: true,
      logger: lg, handleSignals: false,
    });
    await s.start();
    try {
      const http = require('node:http');
      const body = await new Promise((resolve, reject) => {
        http.get('http://127.0.0.1:19504/state', (res) => {
          let buf = '';
          res.on('data', (c) => { buf += c; });
          res.on('end',  ()   => resolve(buf));
        }).on('error', reject);
      });
      const parsed = JSON.parse(body);
      assert.ok(Array.isArray(parsed.peers), '/state should expose peers when enabled');
    } finally {
      await s.stop();
    }
  });
});

describe('createHubServer: lifecycle correctness', () => {
  test('is single-shot - start() after stop() throws', async () => {
    const s = createHubServer({
      secret: SECRET, port: 19510, logger: null, handleSignals: false,
    });
    await s.start();
    await s.stop();
    assert.strictEqual(s.isStopped, true);
    await assert.rejects(() => s.start(), /single-shot|stopped/i);
  });

  test('stop() before start() closes wss and is idempotent', async () => {
    const s = createHubServer({
      secret: SECRET, port: 19511, logger: null, handleSignals: false,
    });
    await s.stop();
    assert.strictEqual(s.isStopped, true);

    await s.stop();
    assert.strictEqual(s.isStopped, true);
    assert.strictEqual(s.wss.clients.size, 0);
  });

  test('stop() during in-progress stop() returns the same promise', async () => {
    const s = createHubServer({
      secret: SECRET, port: 19512, logger: null, handleSignals: false,
      drainDelayMs: 50,
    });
    await s.start();
    const p1 = s.stop();
    const p2 = s.stop();
    await Promise.all([p1, p2]);
    assert.strictEqual(s.isStopped, true);
  });
});