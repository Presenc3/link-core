'use strict';

/**
 * Integration tests: per-peer keys, hello sanitization, pre-hello connection cap.
 *
 * Uses a per-file dedicated hub on port 19400 so this file can run in
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

const PORT   = 19400;
const URL    = `ws://127.0.0.1:${PORT}`;
const SECRET = DEFAULT_SECRET;

const harness     = setupHub({ port: PORT });
const readyClient = makeReadyClient(harness);

describe('per-peer keys', () => {
  let ppServer;
  const PP_PORT = 19401;

  before(async () => {
    ppServer = createHubServer({
      port: PP_PORT, logger: null, handleSignals: false,
      secret: { 'known': 'k1', 'other': 'k2' },
    });
    await ppServer.start();
  });

  after(async () => {
    if (ppServer) await ppServer.stop();
  });

  test('known kind with right key connects', async () => {
    const c = new LinkClient({
      url: `ws://127.0.0.1:${PP_PORT}`, secret: 'k1', kind: 'known', logger: null,
    });
    await c.ready({ timeoutMs: 2000 });
    assert.ok(c.isReady());
    c.stop();
  });

  test('unknown kind: hub silently drops, no rejected event', async () => {
    const c = new LinkClient({
      url: `ws://127.0.0.1:${PP_PORT}`, secret: 'k1', kind: 'mystery', logger: null,
      helloAckDiagnosticMs: 50,
      reconnectInitialMs: 50, reconnectMaxMs: 50,
    });
    let rejectedFired = false;
    let noAckFired    = false;
    c.on('rejected',       () => { rejectedFired = true; });
    c.on('protocol-error', (i) => { if (i.reason === 'no-ack') noAckFired = true; });
    c.start();
    await tick(200);
    assert.strictEqual(rejectedFired, false, 'hub does NOT confirm kind existence');
    assert.ok(noAckFired,                    'client emits no-ack diagnostic');
    c.stop();
  });

  test('static secret-map ignores prototype-polluted properties', async () => {
    Object.prototype.evilKind = 'attacker-controlled-key';
    try {
      const c = new LinkClient({
        url: `ws://127.0.0.1:${PP_PORT}`,
        secret: 'attacker-controlled-key', kind: 'evilKind',
        logger: null, helloAckDiagnosticMs: 0,
        reconnectInitialMs: 100, reconnectMaxMs: 100,
      });
      await assert.rejects(c.ready({ timeoutMs: 200 }), /timed out/);
      c.stop();
    } finally {
      delete Object.prototype.evilKind;
    }
  });
});

describe('hello sanitization', () => {
  test('hub rejects hello with spaces in kind (KIND_PATTERN)', async () => {
    const c = new LinkClient({
      url: URL, secret: SECRET, kind: 'kind with spaces',
      logger: null, helloAckDiagnosticMs: 0,
      reconnectInitialMs: 50, reconnectMaxMs: 50,
    });
    const events = [];
    harness.hub.on('protocol-error', (i) => events.push(i));
    c.start();
    await tick(150);
    const badHello = events.find((e) => e.reason === 'bad-hello');
    assert.ok(badHello, 'expected bad-hello protocol-error');
    assert.strictEqual(badHello.detail, 'invalid-kind');
    c.stop();
  });

  test('hub rejects hello with control chars in kind', async () => {
    const c = new LinkClient({
      url: URL, secret: SECRET, kind: 'worker\nINJECTED',
      logger: null, helloAckDiagnosticMs: 0,
      reconnectInitialMs: 50, reconnectMaxMs: 50,
    });
    const events = [];
    harness.hub.on('protocol-error', (i) => events.push(i));
    c.start();
    await tick(150);
    assert.ok(events.find((e) => e.reason === 'bad-hello' && e.detail === 'invalid-kind'));
    c.stop();
  });

  test('hub rejects hello with empty kind (missing-kind detail)', async () => {
    const c = await readyClient({ kind: 'kind-empty-probe' });
    const events = [];
    harness.hub.on('protocol-error', (i) => events.push(i));
    const helloMsg = makeMsg(SECRET, {
      id: 'forged-empty-hello', type: 'hello',
      from: null, to: null, data: { kind: '', name: 'x' },
    });
    const ws = new (require('ws'))(URL);
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify(helloMsg));
    await tick(100);
    assert.ok(events.find((e) => e.reason === 'bad-hello' && e.detail === 'missing-kind'));
    try { ws.close(); } catch {}
    c.stop();
  });

  test('valid kinds (alphanumeric, dot, underscore, hyphen) still connect', async () => {
    for (const kind of ['worker', 'svc.api', 'sub_one', 'tier-1', 'a.b_c-d.0']) {
      const c = await readyClient({ kind });
      assert.ok(c.isReady(), `${kind} should connect`);
      c.stop();
    }
  });

  test('hub rejects reserved kinds (__proto__, constructor, prototype, server) with reserved-kind detail', async () => {
    for (const kind of ['__proto__', 'constructor', 'prototype', 'server']) {
      const events = [];
      const onErr = (i) => events.push(i);
      harness.hub.on('protocol-error', onErr);

      const ws = new (require('ws'))(URL);
      await new Promise((r) => ws.on('open', r));
      const hello = makeMsg(SECRET, {
        id: `forged-reserved-hello-${kind}`,
        type: 'hello',
        data: { kind, name: 'reserved-probe' },
      });
      ws.send(JSON.stringify(hello));
      await tick(150);

      assert.ok(
        events.find((e) => e.reason === 'bad-hello' && e.detail === 'reserved-kind'),
        `expected bad-hello/reserved-kind for kind=${kind}; got ${JSON.stringify(events)}`,
      );

      harness.hub.off('protocol-error', onErr);
      try { ws.close(); } catch {}
    }
  });

  test('re-hello on an already-authenticated socket is dropped as duplicate-hello (and does not crash the dispatcher)', async () => {
    const events = [];
    harness.hub.on('protocol-error', (i) => events.push(i));

    let unhandled = null;
    const onRej = (e) => { unhandled = e; };
    process.on('unhandledRejection', onRej);

    const ws = new (require('ws'))(URL);
    await new Promise((r) => ws.on('open', r));

    const hello1 = makeMsg(SECRET, {
      id: 'rehello-1', type: 'hello',
      data: { kind: 'rehello-probe', name: 'probe' },
    });
    ws.send(JSON.stringify(hello1));
    await new Promise((r) => ws.once('message', () => r()));

    const hello2 = makeMsg(SECRET, {
      id: 'rehello-2', type: 'hello',
      data: { kind: 'rehello-probe', name: 'probe-again' },
    });
    ws.send(JSON.stringify(hello2));
    await tick(150);

    process.off('unhandledRejection', onRej);

    assert.strictEqual(unhandled, null,
      `re-hello must not cause an unhandledRejection; got ${unhandled?.message || unhandled}`);
    assert.ok(
      events.find((e) => e.reason === 'duplicate-hello' && e.kind === 'rehello-probe'),
      `expected a duplicate-hello protocol-error for kind=rehello-probe; got ${JSON.stringify(events)}`,
    );
    try { ws.close(); } catch {}
  });
});

describe('hub: pre-hello connection cap (maxPendingSockets)', () => {
  test('evicts oldest pending socket when cap is exceeded', async () => {
    const PORT_C = 19402;
    const s = createHubServer({
      secret: SECRET, port: PORT_C, logger: null, handleSignals: false,
      maxPendingSockets: 2,     
      helloTimeoutMs:    60_000,
    });
    await s.start();

    const evictions = [];
    s.hub.on('peer.timeout', (i) => evictions.push(i));

    const WS = require('ws');
    const sockets = [];
    function openSilent() {
      return new Promise((resolve) => {
        const ws = new WS(`ws://127.0.0.1:${PORT_C}`);
        ws.on('open', () => resolve(ws));
        ws.on('error', () => {});
      });
    }
    try {
      sockets.push(await openSilent());
      sockets.push(await openSilent());
      sockets.push(await openSilent());
      sockets.push(await openSilent());

      await new Promise((r) => setTimeout(r, 100));

      assert.ok(evictions.length >= 2,
        `expected at least 2 pending-cap evictions, got ${evictions.length}`);
      for (const e of evictions) {
        assert.strictEqual(e.reason, 'pending-cap');
      }
    } finally {
      for (const ws of sockets) {
        try { ws.terminate(); } catch {}
      }
      await s.stop();
    }
  });
});