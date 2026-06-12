'use strict';

/**
 * Regression tests for the v0.6.0 pre-release adversarial audit
 * (ports 20100-20109).
 *
 * Covers:
 *   1. Per-listener emit isolation (client + hub): one throwing listener
 *      must not starve later-registered listeners - in particular the
 *      internal `ready()` / `waitFor()` waiters.
 *   2. Per-socket ordered dispatch under async ACL: two publishes from
 *      the same peer fan out in arrival order even when the first
 *      `canPublish` check resolves slower than the second.
 *   3. Connection-scoped queued items: a queued `rpc.cancel` must not
 *      survive a disconnect onto the next connection.
 *   4. A `hello.ack` that lands after another verified message already
 *      flipped `_ready` must still apply the hub's feature set (and
 *      re-assert subscriptions if `topics` only became known then).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { createHubServer, LinkClient, makeMsg } = require('../../src/index.js');
const { handleInboundMessage, handleClose } = require('../../src/client/inbound.js');

const SECRET = 'audit-test';
const tick   = (ms = 40) => new Promise((r) => setTimeout(r, ms));

describe('emit isolation', () => {
  test('a throwing userland listener does not break ready()', async () => {
    const server = createHubServer({
      secret: SECRET, port: 20100, logger: null, handleSignals: false,
    });
    await server.start();

    const link = new LinkClient({
      url: 'ws://127.0.0.1:20100', secret: SECRET, kind: 'svc.a', logger: null,
    });

    link.on('ready', () => { throw new Error('userland listener bug'); });

    try {
      await assert.doesNotReject(link.ready({ timeoutMs: 2000 }));
      assert.equal(link.isReady(), true);
    } finally {
      await link.stop();
      await server.stop();
    }
  });

  test('client: a throwing listener does not starve later listeners on the same event', () => {
    const link = new LinkClient({ logger: null });

    const seen = [];
    link.on('custom', () => { seen.push('a'); throw new Error('boom'); });
    link.on('custom', () => { seen.push('b'); });

    const hadListeners = link.emit('custom');

    assert.equal(hadListeners, true);
    assert.deepEqual(seen, ['a', 'b']);
  });

  test('client: once() listeners still self-remove under the isolated emit', () => {
    const link = new LinkClient({ logger: null });

    let calls = 0;
    link.once('custom', () => { calls += 1; });
    link.emit('custom');
    link.emit('custom');

    assert.equal(calls, 1);
    assert.equal(link.emit('custom'), false);
  });

  test("client: an unhandled 'error' emit keeps Node's throw-by-default contract", () => {
    const link = new LinkClient({ logger: null });
    const err = new Error('unhandled');

    assert.throws(() => link.emit('error', err), /unhandled/);

    let got = null;
    link.on('error', (e) => { got = e; });
    link.emit('error', err);
    assert.equal(got, err);
  });

  test('hub: a throwing listener does not starve later listeners', async () => {
    const server = createHubServer({
      secret: SECRET, port: 20101, logger: null, handleSignals: false,
    });
    await server.start();

    const seen = [];
    server.hub.on('peer.connect', () => { seen.push('a'); throw new Error('boom'); });
    server.hub.on('peer.connect', (info) => { seen.push(`b:${info.kind}`); });

    const link = new LinkClient({
      url: 'ws://127.0.0.1:20101', secret: SECRET, kind: 'svc.b', logger: null,
    });

    try {
      await link.ready({ timeoutMs: 3000 });
      await tick();
      assert.deepEqual(seen, ['a', 'b:svc.b']);
    } finally {
      await link.stop();
      await server.stop();
    }
  });
});

describe('ordered dispatch under async ACL', () => {
  test('same-peer publishes fan out in arrival order when canPublish is slow-then-fast', async () => {
    let checks = 0;
    const server = createHubServer({
      secret: SECRET, port: 20102, logger: null, handleSignals: false,
      canPublish: async () => {
        checks += 1;
        if (checks === 1) await tick(100);
        return true;
      },
    });
    await server.start();

    const url = 'ws://127.0.0.1:20102';
    const pub = new LinkClient({ url, secret: SECRET, kind: 'pub', logger: null });
    const sub = new LinkClient({ url, secret: SECRET, kind: 'sub', logger: null });

    const got = [];
    sub.subscribe('order.t', (p) => got.push(p.seq));

    try {
      await Promise.all([pub.ready({ timeoutMs: 3000 }), sub.ready({ timeoutMs: 3000 })]);
      await tick(120);

      pub.publish('order.t', { seq: 1 });
      pub.publish('order.t', { seq: 2 });
      pub.publish('order.t', { seq: 3 });

      await tick(400);
      assert.deepEqual(got, [1, 2, 3]);
    } finally {
      await pub.stop();
      await sub.stop();
      await server.stop();
    }
  });

  test('an async deny in the lane only drops the denied publish, later ones still flow', async () => {
    const server = createHubServer({
      secret: SECRET, port: 20103, logger: null, handleSignals: false,
      canPublish: async ({ payload }) => {
        await tick(20);
        return payload?.allow !== false;
      },
    });
    await server.start();

    const url = 'ws://127.0.0.1:20103';
    const pub = new LinkClient({ url, secret: SECRET, kind: 'pub', logger: null });
    const sub = new LinkClient({ url, secret: SECRET, kind: 'sub', logger: null });

    const got = [];
    sub.subscribe('order.d', (p) => got.push(p.seq));

    try {
      await Promise.all([pub.ready({ timeoutMs: 3000 }), sub.ready({ timeoutMs: 3000 })]);
      await tick(120);

      pub.publish('order.d', { seq: 1 });
      pub.publish('order.d', { seq: 2, allow: false });
      pub.publish('order.d', { seq: 3 });

      await tick(400);
      assert.deepEqual(got, [1, 3]);
    } finally {
      await pub.stop();
      await sub.stop();
      await server.stop();
    }
  });
});

describe('connection-scoped queued items', () => {
  test('a queued rpc.cancel does not survive a disconnect', () => {
    const link = new LinkClient({
      url: 'ws://127.0.0.1:1', secret: SECRET, kind: 'svc.c', logger: null,
    });

    link._outbox.enqueue({ id: 'a', type: 'rpc.request', to: 'x', data: {} });
    link._outbox.enqueue({ id: 'b', type: 'rpc.cancel',  to: 'x', data: { id: 'a' } });
    link._outbox.enqueue({ id: 'c', type: 'direct',      to: 'x', data: { directType: 't' } });

    assert.equal(link._outbox.size, 3);

    link._stopped = true;
    handleClose(link, 1006, '');

    const remaining = link._outbox.filter(() => true).map((it) => it.type);
    assert.deepEqual(remaining, ['direct']);
  });
});

describe('ready is gated strictly on hello.ack', () => {
  /** Deliver a signed envelope to the client as if it came off the wire. */
  function deliver(client, parts) {
    const msg = makeMsg(SECRET, parts);
    handleInboundMessage(client, Buffer.from(JSON.stringify(msg)));
  }

  test('a verified non-ack frame does not flip ready; the ack does, with real features', () => {
    const link = new LinkClient({
      url: 'ws://127.0.0.1:1', secret: SECRET, kind: 'svc.d', logger: null,
    });

    link.subscribe('late.topic', () => {});
    const sent = [];
    const origSend = link._send.bind(link);
    link._send = (type, data, ...rest) => { sent.push({ type, data }); return origSend(type, data, ...rest); };

    deliver(link, { id: 'm1', type: 'peers.update', from: null, data: { peers: [] } });
    assert.equal(link.isReady(), false, 'verified non-ack frame must not mark the client ready');
    assert.equal(link.hubFeatures, null, 'features are unknown (null), not assumed-empty');

    assert.doesNotThrow(() => link.send('peer.x', 'evt', { ok: 1 }));
    assert.doesNotThrow(() => link.publish('late.topic', { ok: 1 }));
    const queuedBeforeAck = link._outbox.filter(
      (it) => it.type === 'direct' || it.type === 'topic.message').length;
    assert.equal(queuedBeforeAck, 2, 'feature-dependent messages queue while features are unknown');

    let readyFeatures = null;
    link.once('ready', (p) => { readyFeatures = p.features; });
    deliver(link, {
      id: 'm2', type: 'hello.ack', from: null,
      data: { ok: true, serverTime: Date.now(), kind: 'svc.d', features: ['topics', 'direct'] },
    });

    assert.equal(link.isReady(), true);
    assert.deepEqual(link.hubFeatures, ['topics', 'direct']);
    assert.deepEqual(readyFeatures,   ['topics', 'direct'],
      "the 'ready' event carries the ack's feature list");

    const queuedAfterAck = link._outbox.filter(
      (it) => it.type === 'direct' || it.type === 'topic.message').length;
    assert.equal(queuedAfterAck, 2, 'nothing purged: the hub advertises both features');

    assert.ok(
      sent.some((s) => s.type === 'topic.subscribe' && s.data?.topic === 'late.topic'),
      'expected a topic.subscribe assert at ack-gated ready',
    );

    assert.doesNotThrow(() => link.publish('late.topic', { ok: 1 }));
    assert.doesNotThrow(() => link.send('peer.x', 'evt', { ok: 1 }));
  });
});