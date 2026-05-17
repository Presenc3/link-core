'use strict';

/**
 * Integration tests: pub/sub, direct fire-and-forget, and typed errors on publish/send.
 *
 * Uses a per-file dedicated hub on port 19300 so this file can run in
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

const PORT   = 19300;
const URL    = `ws://127.0.0.1:${PORT}`;
const SECRET = DEFAULT_SECRET;

const harness     = setupHub({ port: PORT });
const readyClient = makeReadyClient(harness);

describe('pub/sub', () => {
  test('subscribe + publish delivers payload', async () => {
    const a = await readyClient({ kind: 'ps-a' });
    const b = await readyClient({ kind: 'ps-b' });
    let received = null;
    b.subscribe('greet', (p) => { received = p; });
    await tick();
    a.publish('greet', { hello: 'world' });
    await tick();
    assert.deepStrictEqual(received, { hello: 'world' });
    a.stop(); b.stop();
  });

  test('publisher does not receive its own message (no self-delivery)', async () => {
    const a = await readyClient({ kind: 'ps-self' });
    let receivedSelf = null;
    a.subscribe('beep', (p) => { receivedSelf = p; });
    await tick();
    a.publish('beep', { from: 'me' });
    await tick();
    assert.strictEqual(receivedSelf, null);
    a.stop();
  });

  test('subscriptions replay automatically across reconnect', async () => {
    const a = await readyClient({ kind: 'ps-rep-a' });
    const b = await readyClient({ kind: 'ps-rep-b' });
    let count = 0;
    b.subscribe('persist', () => { count++; });
    await tick();
    a.publish('persist', {});
    await tick();
    assert.strictEqual(count, 1);

    b.stop();
    await tick(100);
    const b2 = new LinkClient({ url: URL, secret: SECRET, kind: 'ps-rep-b', logger: null });
    b2.subscribe('persist', () => { count++; });
    await b2.ready({ timeoutMs: 2000 });
    await tick();
    a.publish('persist', {});
    await tick();
    assert.strictEqual(count, 2, 'second publish should reach the reconnected subscriber');
    a.stop(); b2.stop();
  });

  test('link.topic.list (all + filtered)', async () => {
    const a = await readyClient({ kind: 'tl-a' });
    const b = await readyClient({ kind: 'tl-b' });
    a.subscribe('alpha', () => {});
    b.subscribe('alpha', () => {});
    b.subscribe('beta',  () => {});
    await tick();

    const single = await a.rpc('server', 'link.topic.list', { topic: 'alpha' });
    assert.strictEqual(single.topic, 'alpha');
    assert.deepStrictEqual([...single.subscribers].sort(), ['tl-a', 'tl-b']);

    const all = await a.rpc('server', 'link.topic.list', {});
    const map = Object.fromEntries(all.topics.map((t) => [t.topic, t.subscribers.sort()]));
    assert.deepStrictEqual(map.alpha, ['tl-a', 'tl-b']);
    assert.deepStrictEqual(map.beta,  ['tl-b']);

    a.stop(); b.stop();
  });

  test('async topic handler that rejects does not surface as unhandledRejection', async () => {
    const a = await readyClient({ kind: 'ah-pub' });
    const b = await readyClient({ kind: 'ah-sub' });

    const captured = [];
    const onUnhandled = (reason) => { captured.push(reason); };
    process.on('unhandledRejection', onUnhandled);

    const recordingLogger = {
      logs: [],
      log:  () => {},
      warn: (tag, ...args) => { recordingLogger.logs.push({ tag, msg: args.join(' ') }); },
    };
    b.log = recordingLogger;

    let syncCalls  = 0;
    let asyncCalls = 0;
    b.subscribe('ah.events', (p) => { syncCalls++; throw new Error('sync boom'); });
    b.subscribe('ah.events', async (p) => { asyncCalls++; throw new Error('async boom'); });
    await tick();

    a.publish('ah.events', { x: 1 });
    await tick(80);

    process.off('unhandledRejection', onUnhandled);

    assert.strictEqual(syncCalls,  1);
    assert.strictEqual(asyncCalls, 1);
    assert.strictEqual(captured.length, 0,
      'async topic handler rejection must not surface as unhandledRejection');
    const warned = recordingLogger.logs.filter((e) => /topic handler/.test(e.msg));
    assert.ok(warned.length >= 2, 'both sync and async failures should be logged');

    a.stop(); b.stop();
  });

  test('hub topic.publish event always carries `delivered` (including 0)', async () => {
    const a = await readyClient({ kind: 'dp-pub' });
    const events = [];
    harness.hub.on('topic.publish', (i) => events.push(i));
    a.publish('dp.no-subs.here', { x: 1 });
    await tick(60);
    harness.hub.removeAllListeners('topic.publish');

    assert.ok(events.length >= 1);
    const ev = events.find((e) => e.topic === 'dp.no-subs.here');
    assert.ok(ev, 'event must fire even with zero subscribers');
    assert.strictEqual(ev.subscriberCount, 0);
    assert.strictEqual(ev.delivered, 0, '`delivered` must be present and equal 0');
    a.stop();
  });
});

describe('direct fire-and-forget', () => {
  test('send delivers to receiver with trusted from', async () => {
    const a = await readyClient({ kind: 'dr-a' });
    const b = await readyClient({ kind: 'dr-b' });
    let info = null;
    b.on('direct', (i) => { info = i; });
    const sent = a.send('dr-b', 'tap', { v: 7 });
    assert.strictEqual(sent, true);
    await tick();
    assert.ok(info);
    assert.strictEqual(info.from, 'dr-a');
    assert.strictEqual(info.type, 'tap');
    assert.deepStrictEqual(info.data, { v: 7 });
    a.stop(); b.stop();
  });

  test('send to offline target drops silently (returns true; no error)', async () => {
    const a = await readyClient({ kind: 'dr-off' });
    const sent = a.send('nobody', 't', {});
    assert.strictEqual(sent, true);
    a.stop();
  });
});

describe('typed errors on publish/send', () => {
  test('publish before ready throws LinkNotReadyError', () => {
    const c = new LinkClient({ url: URL, secret: SECRET, kind: 'ne-a', logger: null });
    assert.throws(
      () => c.publish('events', {}),
      (err) => err instanceof LinkNotReadyError
            && err.code === 'LINK_NOT_READY'
            && err.op   === 'publish',
    );
  });

  test('send before ready throws LinkNotReadyError', () => {
    const c = new LinkClient({ url: URL, secret: SECRET, kind: 'ne-b', logger: null });
    assert.throws(
      () => c.send('x', 't', {}),
      (err) => err instanceof LinkNotReadyError
            && err.code === 'LINK_NOT_READY'
            && err.op   === 'send',
    );
  });

  test('publish without "topics" feature throws FeatureUnsupportedError', async () => {
    const c = await readyClient({ kind: 'fu-pub' });
    c.hubFeatures = []; 
    assert.throws(
      () => c.publish('events', {}),
      (err) => err instanceof FeatureUnsupportedError
            && err.code    === 'FEATURE_UNSUPPORTED'
            && err.op      === 'publish'
            && err.feature === 'topics',
    );
    c.stop();
  });

  test('send without "direct" feature throws FeatureUnsupportedError', async () => {
    const c = await readyClient({ kind: 'fu-sd' });
    c.hubFeatures = [];
    assert.throws(
      () => c.send('x', 't', {}),
      (err) => err instanceof FeatureUnsupportedError
            && err.code    === 'FEATURE_UNSUPPORTED'
            && err.op      === 'send'
            && err.feature === 'direct',
    );
    c.stop();
  });
});