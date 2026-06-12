'use strict';

/**
 * Integration tests: pub/sub, direct fire-and-forget, and typed errors on publish/send.
 *
 * Uses a per-file dedicated hub on port 19300 so this file can run in
 * parallel with the other integration files without colliding.
 *
 * Synchronization note: `subscribe()` is fire-and-forget - it sends a
 * `topic.subscribe` to the hub but returns no acknowledgment, so there is
 * NO ordering guarantee between one client's subscribe and another
 * client's concurrent publish. A test that does `b.subscribe(t); a.publish(t)`
 * back to back can race the subscribe against the publish. These tests
 * therefore wait on a *causal* signal - the hub actually reporting the
 * subscriber via the `link.topic.list` built-in RPC - before publishing,
 * instead of guessing with a fixed `tick()`.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  LinkClient,
  LinkNotReadyError,
  FeatureUnsupportedError,
} = require('../../src/index.js');

const { setupHub, makeReadyClient, tick, waitFor, DEFAULT_SECRET } = require('./_helpers.js');

const PORT   = 19300;
const URL    = `ws://127.0.0.1:${PORT}`;
const SECRET = DEFAULT_SECRET;

const harness     = setupHub({ port: PORT });
const readyClient = makeReadyClient(harness);

/** Register failure-safe teardown so a thrown assertion never leaks live clients. */
function autoStop(t, ...clients) {
  t.after(() => { for (const c of clients) { try { c.stop({ drain: false }); } catch {} } });
}

/**
 * Resolve once the hub reports `kind` as a subscriber of `topic`. Uses the
 * `link.topic.list` built-in RPC against the hub - a causal confirmation
 * that the subscription has been registered, replacing the old `tick()`
 * guess and closing the subscribe-vs-publish race.
 */
async function awaitSubscribed(viaClient, topic, kind) {
  await waitFor(async () => {
    const res = await viaClient.rpc('server', 'link.topic.list', { topic });
    return Array.isArray(res.subscribers) && res.subscribers.includes(kind);
  }, { label: `hub to register ${kind} on '${topic}'` });
}

describe('pub/sub', () => {
  test('subscribe + publish delivers payload', async (t) => {
    const a = await readyClient({ kind: 'ps-a' });
    const b = await readyClient({ kind: 'ps-b' });
    autoStop(t, a, b);

    let received = null;
    b.subscribe('greet', (p) => { received = p; });
    await awaitSubscribed(a, 'greet', 'ps-b');

    a.publish('greet', { hello: 'world' });
    await waitFor(() => received !== null, { label: 'payload delivered' });
    assert.deepStrictEqual(received, { hello: 'world' });
  });

  test('publisher does not receive its own message (no self-delivery)', async (t) => {
    const a = await readyClient({ kind: 'ps-self' });
    autoStop(t, a);

    let receivedSelf = null;
    a.subscribe('beep', (p) => { receivedSelf = p; });
    await awaitSubscribed(a, 'beep', 'ps-self');

    a.publish('beep', { from: 'me' });
    await tick(80);
    assert.strictEqual(receivedSelf, null);
  });

  test('subscriptions replay automatically across reconnect', async (t) => {
    const a = await readyClient({ kind: 'ps-rep-a' });
    const b = await readyClient({ kind: 'ps-rep-b' });
    autoStop(t, a);

    let count = 0;
    b.subscribe('persist', () => { count++; });
    await awaitSubscribed(a, 'persist', 'ps-rep-b');

    a.publish('persist', {});
    await waitFor(() => count === 1, { label: 'first publish delivered' });

    b.stop();
    await waitFor(async () => {
      const res = await a.rpc('server', 'link.topic.list', { topic: 'persist' });
      return !res.subscribers.includes('ps-rep-b');
    }, { label: 'hub to drop the stopped subscriber' });

    const b2 = new LinkClient({ url: URL, secret: SECRET, kind: 'ps-rep-b', logger: null });
    autoStop(t, b2);
    b2.subscribe('persist', () => { count++; });
    await b2.ready({ timeoutMs: 2000 });
    await awaitSubscribed(a, 'persist', 'ps-rep-b');

    a.publish('persist', {});
    await waitFor(() => count === 2, { label: 'second publish reaches reconnected subscriber' });
  });

  test('link.topic.list (all + filtered)', async (t) => {
    const a = await readyClient({ kind: 'tl-a' });
    const b = await readyClient({ kind: 'tl-b' });
    autoStop(t, a, b);

    a.subscribe('alpha', () => {});
    b.subscribe('alpha', () => {});
    b.subscribe('beta',  () => {});
    await awaitSubscribed(a, 'alpha', 'tl-a');
    await awaitSubscribed(a, 'alpha', 'tl-b');
    await awaitSubscribed(a, 'beta',  'tl-b');

    const single = await a.rpc('server', 'link.topic.list', { topic: 'alpha' });
    assert.strictEqual(single.topic, 'alpha');
    assert.deepStrictEqual([...single.subscribers].sort(), ['tl-a', 'tl-b']);

    const all = await a.rpc('server', 'link.topic.list', {});
    const map = Object.fromEntries(all.topics.map((tp) => [tp.topic, tp.subscribers.sort()]));
    assert.deepStrictEqual(map.alpha, ['tl-a', 'tl-b']);
    assert.deepStrictEqual(map.beta,  ['tl-b']);
  });

  test('async topic handler that rejects does not surface as unhandledRejection', async (t) => {
    const a = await readyClient({ kind: 'ah-pub' });
    const b = await readyClient({ kind: 'ah-sub' });
    autoStop(t, a, b);

    const captured = [];
    const onUnhandled = (reason) => { captured.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    t.after(() => process.off('unhandledRejection', onUnhandled));

    const recordingLogger = {
      logs: [],
      log:  () => {},
      warn: (tag, ...args) => { recordingLogger.logs.push({ tag, msg: args.join(' ') }); },
    };
    b.log = recordingLogger;

    let syncCalls  = 0;
    let asyncCalls = 0;
    b.subscribe('ah.events', () => { syncCalls++; throw new Error('sync boom'); });
    b.subscribe('ah.events', async () => { asyncCalls++; throw new Error('async boom'); });
    await awaitSubscribed(a, 'ah.events', 'ah-sub');

    a.publish('ah.events', { x: 1 });
    await waitFor(() => syncCalls === 1 && asyncCalls === 1, { label: 'both handlers invoked' });
    await tick(50);

    assert.strictEqual(captured.length, 0,
      'async topic handler rejection must not surface as unhandledRejection');
    const warned = recordingLogger.logs.filter((e) => /topic handler/.test(e.msg));
    assert.ok(warned.length >= 2, 'both sync and async failures should be logged');
  });

  test('hub topic.publish event always carries `delivered` (including 0)', async (t) => {
    const a = await readyClient({ kind: 'dp-pub' });
    autoStop(t, a);

    const events = [];
    const onPub = (i) => events.push(i);
    harness.hub.on('topic.publish', onPub);
    t.after(() => harness.hub.removeListener('topic.publish', onPub));

    a.publish('dp.no-subs.here', { x: 1 });
    const ev = await waitFor(() => events.find((e) => e.topic === 'dp.no-subs.here'),
      { label: 'topic.publish event with zero subscribers' });

    assert.strictEqual(ev.subscriberCount, 0);
    assert.strictEqual(ev.delivered, 0, '`delivered` must be present and equal 0');
  });
});

describe('direct fire-and-forget', () => {
  test('send delivers to receiver with trusted from', async (t) => {
    const a = await readyClient({ kind: 'dr-a' });
    const b = await readyClient({ kind: 'dr-b' });
    autoStop(t, a, b);

    let info = null;
    b.on('direct', (i) => { info = i; });
    const sent = a.send('dr-b', 'tap', { v: 7 });
    assert.strictEqual(sent, true);

    await waitFor(() => info !== null, { label: 'direct message delivered' });
    assert.strictEqual(info.from, 'dr-a');
    assert.strictEqual(info.type, 'tap');
    assert.deepStrictEqual(info.data, { v: 7 });
  });

  test('send to offline target drops silently (returns true; no error)', async (t) => {
    const a = await readyClient({ kind: 'dr-off' });
    autoStop(t, a);
    const sent = a.send('nobody', 't', {});
    assert.strictEqual(sent, true);
  });
});

describe('queue-before-ready + typed errors on publish/send', () => {
  test('publish before ready is queued, then delivered once ready', async (t) => {
    const sub = await readyClient({ kind: 'qbr-sub' });
    autoStop(t, sub);

    let got = null;
    sub.subscribe('qbr.topic', (p) => { got = p; });
    await awaitSubscribed(sub, 'qbr.topic', 'qbr-sub');

    const c = new LinkClient({ url: URL, secret: SECRET, kind: 'qbr-pub', logger: null });
    autoStop(t, c);
    const queued = c.publish('qbr.topic', { hello: 'queued' });
    assert.strictEqual(queued, true, 'publish before ready returns true (queued)');
    assert.strictEqual(c.health().outboxSize, 1, 'message is sitting in the outbox');

    await c.ready({ timeoutMs: 2000 });
    await waitFor(() => got !== null, { label: 'queued message delivers after ready' });
    assert.deepStrictEqual(got, { hello: 'queued' });
    await waitFor(() => c.health().outboxSize === 0, { label: 'outbox drained' });
  });

  test('send before ready is queued, then delivered once ready', async (t) => {
    const recv = await readyClient({ kind: 'qbr-recv' });
    autoStop(t, recv);

    let info = null;
    recv.on('direct', (i) => { info = i; });

    const c = new LinkClient({ url: URL, secret: SECRET, kind: 'qbr-snd', logger: null });
    autoStop(t, c);
    const queued = c.send('qbr-recv', 'ping', { n: 1 });
    assert.strictEqual(queued, true);
    assert.strictEqual(c.health().outboxSize, 1);

    await c.ready({ timeoutMs: 2000 });
    await waitFor(() => info !== null, { label: 'queued direct message delivers after ready' });
    assert.strictEqual(info.type, 'ping');
    assert.deepStrictEqual(info.data, { n: 1 });
  });

  test('publish/send on a stopped link throw LinkNotReadyError', async (t) => {
    const c = await readyClient({ kind: 'qbr-stopped' });
    autoStop(t, c);
    c.stop();
    assert.throws(
      () => c.publish('events', {}),
      (err) => err instanceof LinkNotReadyError
            && err.code === 'LINK_NOT_READY'
            && err.op   === 'publish',
    );
    assert.throws(
      () => c.send('x', 't', {}),
      (err) => err instanceof LinkNotReadyError && err.op === 'send',
    );
  });

  test('publish/send on a disabled link throw LinkNotReadyError', () => {
    const c = new LinkClient({ secret: SECRET, kind: 'qbr-disabled', logger: null });
    assert.throws(
      () => c.publish('events', {}),
      (err) => err instanceof LinkNotReadyError && err.op === 'publish',
    );
    assert.throws(
      () => c.send('x', 't', {}),
      (err) => err instanceof LinkNotReadyError && err.op === 'send',
    );
  });

  test('publish without "topics" feature throws FeatureUnsupportedError', async (t) => {
    const c = await readyClient({ kind: 'fu-pub' });
    autoStop(t, c);
    c.hubFeatures = [];
    assert.throws(
      () => c.publish('events', {}),
      (err) => err instanceof FeatureUnsupportedError
            && err.code    === 'FEATURE_UNSUPPORTED'
            && err.op      === 'publish'
            && err.feature === 'topics',
    );
  });

  test('send without "direct" feature throws FeatureUnsupportedError', async (t) => {
    const c = await readyClient({ kind: 'fu-sd' });
    autoStop(t, c);
    c.hubFeatures = [];
    assert.throws(
      () => c.send('x', 't', {}),
      (err) => err instanceof FeatureUnsupportedError
            && err.code    === 'FEATURE_UNSUPPORTED'
            && err.op      === 'send'
            && err.feature === 'direct',
    );
  });
});