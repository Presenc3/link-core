'use strict';

/**
 * Integration tests: the outbound queue (outbox), graceful stop() draining,
 * and the reconnect ceiling.
 *
 * Uses a per-file dedicated hub on port 19610 so this file can run in
 * parallel with the other integration files without colliding (forget.test.js
 * owns 19600-19609). Port 19699 is intentionally left with no listener - the
 * reconnect-ceiling test points at it to force connection failures.
 */

const { test, describe } = require('node:test');
const assert             = require('node:assert');
const { once }           = require('node:events');

const { LinkClient } = require('../../src/index.js');
const { setupHub, makeReadyClient, tick, DEFAULT_SECRET } = require('./_helpers.js');

const PORT   = 19610;
const URL    = `ws://127.0.0.1:${PORT}`;
const SECRET = DEFAULT_SECRET;

const harness     = setupHub({ port: PORT });
const readyClient = makeReadyClient(harness);

/** Pin ws.bufferedAmount above any cap so the fast send path is bypassed. */
function congest(client, bytes = 10_000) {
  Object.defineProperty(client.ws, 'bufferedAmount', {
    get: () => bytes, configurable: true,
  });
}
/** Drop the override so the socket's real (≈0 on loopback) value is read. */
function relieve(client) {
  delete client.ws.bufferedAmount;
}

describe('outbox: no-drop backpressure', () => {
  test('messages queue while the socket is congested, then drain automatically', async () => {
    const sub = await readyClient({ kind: 'ob-sub' });
    const got = [];
    sub.subscribe('ob.flow', (p) => { got.push(p); });
    await tick();

    const a = await readyClient({ kind: 'ob-pub', maxBufferedBytes: 50 });

    congest(a);
    for (let i = 0; i < 5; i++) a.publish('ob.flow', { i });

    assert.strictEqual(a.health().outboxSize, 5, 'all 5 wait in the outbox while congested');
    assert.strictEqual(got.length, 0, 'nothing delivered while congested');

    relieve(a);
    await tick(150);

    assert.strictEqual(a.health().outboxSize, 0, 'outbox drained once congestion cleared');
    assert.strictEqual(got.length, 5, 'every queued message delivered - none dropped');
    assert.deepStrictEqual(got.map((g) => g.i).sort(), [0, 1, 2, 3, 4]);

    a.stop(); sub.stop();
  });

  test('backpressure + outbox-drained events bracket a congestion episode', async () => {
    const a = await readyClient({ kind: 'ob-ev', maxBufferedBytes: 50 });
    const seen = [];
    a.on('backpressure',   () => seen.push('backpressure'));
    a.on('outbox-drained', () => seen.push('outbox-drained'));

    congest(a);
    a.publish('ob.ev', { x: 1 });
    a.publish('ob.ev', { x: 2 });
    relieve(a);
    await tick(150);

    assert.deepStrictEqual(seen, ['backpressure', 'outbox-drained'],
      'backpressure fires once on the way in, outbox-drained once on the way out');
    a.stop();
  });

  test('outbox-overflow fires (and publish returns false) when the byte cap is hit', async () => {
    const a = await readyClient({
      kind: 'ob-of', maxBufferedBytes: 50, maxOutboxBytes: 400,
    });
    const overflows = [];
    a.on('outbox-overflow', (i) => overflows.push(i));

    congest(a);
    const results = [];
    for (let i = 0; i < 12; i++) {
      results.push(a.publish('ob.of', { blob: 'x'.repeat(80) }));
    }

    assert.ok(results.includes(true),  'the first few publishes are accepted (queued)');
    assert.ok(results.includes(false), 'once the byte cap is hit, publish returns false');
    assert.ok(overflows.length >= 1,   'outbox-overflow event fired on refusal');
    assert.strictEqual(overflows[0].maxOutboxBytes, 400);
    assert.strictEqual(typeof overflows[0].outboxBytes, 'number');

    a.stop({ drain: false });
  });
});

describe('outbox: graceful stop()', () => {
  test('graceful stop() flushes queued messages before the socket closes', async () => {
    const sub = await readyClient({ kind: 'ob-gs-sub' });
    const got = [];
    sub.subscribe('ob.gs', (p) => { got.push(p); });
    await tick();

    const a = await readyClient({ kind: 'ob-gs-pub', maxBufferedBytes: 50 });

    congest(a);
    for (let i = 0; i < 4; i++) a.publish('ob.gs', { i });
    assert.strictEqual(a.health().outboxSize, 4, 'four messages queued');

    relieve(a);
    await a.stop();

    await tick(80);
    assert.strictEqual(got.length, 4, 'graceful stop drained every queued message');
    assert.deepStrictEqual(got.map((g) => g.i).sort(), [0, 1, 2, 3]);
    sub.stop();
  });

  test('stop({ drain: false }) closes immediately without draining the outbox', async () => {
    const sub = await readyClient({ kind: 'ob-hs-sub' });
    const got = [];
    sub.subscribe('ob.hs', (p) => { got.push(p); });
    await tick();

    const a = await readyClient({ kind: 'ob-hs-pub', maxBufferedBytes: 50 });
    congest(a);
    for (let i = 0; i < 4; i++) a.publish('ob.hs', { i });

    relieve(a);
    await a.stop({ drain: false });

    await tick(80);
    assert.strictEqual(got.length, 0, 'a hard stop does not flush the outbox');
    sub.stop();
  });
});

describe('outbox: hub-side queueing', () => {
  test('hub queues for a congested peer instead of dropping; health() reports it', async () => {
    const a   = await readyClient({ kind: 'hob-pub' });
    const sub = await readyClient({ kind: 'hob-sub' });

    const got = [];
    sub.subscribe('hob.flow', (p) => { got.push(p); });
    await tick();

    let subWs = null;
    for (const ws of harness.server.wss.clients) {
      if (ws.__kind === 'hob-sub') { subWs = ws; break; }
    }
    assert.ok(subWs, 'hub has a socket for hob-sub');
    Object.defineProperty(subWs, 'bufferedAmount', { get: () => 10_000_000, configurable: true });

    for (let i = 0; i < 5; i++) a.publish('hob.flow', { i });
    await tick(150);

    assert.strictEqual(got.length, 0, 'nothing delivered while the peer socket is congested');
    const h1 = harness.hub.health();
    assert.ok(h1.outboxBytes > 0,    'hub health() reports queued bytes');
    assert.ok(h1.queuedSockets >= 1, 'hub health() reports a queued socket');

    delete subWs.bufferedAmount;
    await tick(250);

    assert.strictEqual(got.length, 5, 'every queued message reached the peer once it caught up');
    const h2 = harness.hub.health();
    assert.strictEqual(h2.outboxBytes, 0, 'hub outbox fully drained');
    assert.strictEqual(h2.queuedSockets, 0);

    a.stop(); sub.stop();
  });
});

describe('outbox: reconnect ceiling', () => {
  test('emits reconnect-exhausted and gives up after maxReconnectAttempts', async () => {
    const c = new LinkClient({
      url: 'ws://127.0.0.1:19699', secret: SECRET, kind: 'ob-rc',
      maxReconnectAttempts: 2,
      reconnectInitialMs: 40, reconnectMaxMs: 40,
      helloAckDiagnosticMs: 0, logger: null,
    });

    const exhausted = once(c, 'reconnect-exhausted');
    c.start();

    const [info] = await Promise.race([
      exhausted,
      tick(5000).then(() => { throw new Error('reconnect-exhausted never fired'); }),
    ]);

    assert.strictEqual(info.attempts, 2, 'reports the two attempts that were made');
    assert.strictEqual(info.maxReconnectAttempts, 2);
    assert.strictEqual(c.health().stopped, true, 'client is stopped after exhaustion');
    assert.strictEqual(c.health().connected, false);

    c.stop();
  });

  test('default maxReconnectAttempts is Infinity (keeps retrying)', async () => {
    const c = new LinkClient({
      url: 'ws://127.0.0.1:19699', secret: SECRET, kind: 'ob-rc-inf',
      reconnectInitialMs: 30, reconnectMaxMs: 30,
      helloAckDiagnosticMs: 0, logger: null,
    });
    assert.strictEqual(c.maxReconnectAttempts, Infinity);

    let exhaustedFired = false;
    c.on('reconnect-exhausted', () => { exhaustedFired = true; });

    const reconnecting = [];
    c.on('reconnecting', (i) => reconnecting.push(i));
    c.start();

    await tick(250);
    c.stop();

    assert.ok(reconnecting.length >= 2, 'kept attempting to reconnect');
    assert.strictEqual(exhaustedFired, false, 'never gives up with the Infinity default');
  });
});