'use strict';

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert');

const {
  createHubServer, LinkClient,
  RpcRemoteError, RpcDisconnectError, RpcAbortError, RpcTimeoutError,
  BackpressureError, HelloRejectedError,
  LinkNotReadyError, FeatureUnsupportedError,
  makeMsg,
} = require('../src/index.js');

const PORT = 18800;
const URL  = `ws://127.0.0.1:${PORT}`;
const SECRET = 'integration-test';

let server;

before(async () => {
  server = createHubServer({
    secret: SECRET, port: PORT, logger: null, handleSignals: false,
  });
  await server.start();
});

after(async () => {
  if (server) await server.stop();
});

async function readyClient(opts = {}) {
  const c = new LinkClient({
    url: URL, secret: SECRET, logger: null,
    ...opts,
  });
  await c.ready({ timeoutMs: 3000 });
  return c;
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe('connection lifecycle', () => {
  test('client connects, becomes ready, and reports hubFeatures', async () => {
    const c = await readyClient({ kind: 'lc-1' });
    assert.ok(c.isConnected());
    assert.ok(c.isReady());
    assert.ok(Array.isArray(c.hubFeatures));
    assert.ok(c.hubFeatures.includes('topics'));
    assert.ok(c.hubFeatures.includes('direct'));
    c.stop();
  });

  test('health() snapshot reflects connected/ready state', async () => {
    const c = await readyClient({ kind: 'lc-2' });
    const h = c.health();
    assert.strictEqual(h.connected, true);
    assert.strictEqual(h.verified,  true);
    assert.strictEqual(h.ready,     true);
    assert.ok(typeof h.lastVerifiedAt === 'number');
    c.stop();
  });

  test('ready() rejects with HelloRejectedError on per-peer-keys mismatch', async () => {
    const PORT2 = 18801;
    const ppServer = createHubServer({
      port: PORT2, logger: null, handleSignals: false,
      secret: { 'known': 'k1' },
    });
    await ppServer.start();
    try {
      const c = new LinkClient({
        url: `ws://127.0.0.1:${PORT2}`,
        secret: 'wrong', kind: 'known',
        logger: null, helloAckDiagnosticMs: 0,
        reconnectInitialMs: 100, reconnectMaxMs: 100,
      });
      await assert.rejects(c.ready({ timeoutMs: 200 }), /timed out/);
      c.stop();
    } finally {
      await ppServer.stop();
    }
  });

  test('stop() clears ready state', async () => {
    const c = await readyClient({ kind: 'stop-clears-ready' });
    assert.strictEqual(c.isReady(), true);
    assert.strictEqual(c.health().ready, true);

    c.stop();

    assert.strictEqual(c.isReady(), false);
    assert.strictEqual(c.health().ready, false);
    assert.strictEqual(c.health().verified, false);
  });

  test('ready() does not resolve as ready after stop()', async () => {
    const c = await readyClient({ kind: 'stop-blocks-ready' });
    c.stop();
    await assert.rejects(
      c.ready({ timeoutMs: 50 }),
      /stopped|timed out/i,
    );
  });

  test('stop() emits "disconnect" if was ready', async () => {
    const c = await readyClient({ kind: 'stop-emits-disconnect' });
    const events = [];
    c.on('disconnect', (i) => events.push(i));
    c.stop();
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].reason, 'stopped');
    assert.strictEqual(events[0].willReconnect, false);
    assert.strictEqual(events[0].wasReady, true);
  });

  test('stop() does NOT emit "disconnect" if was never ready', async () => {
    const c = new LinkClient({ url: URL, secret: SECRET, kind: 'never-ready', logger: null });
    const events = [];
    c.on('disconnect', (i) => events.push(i));
    c.stop();
    assert.strictEqual(events.length, 0);
  });
});

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
    const a = await readyClient({ kind: 'cp-bp', maxBufferedBytes: 10 });   // tiny cap
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

describe('per-peer keys', () => {
  let ppServer;
  const PP_PORT = 18802;

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
});

describe('hub protocol-error + statuses eviction', () => {
  test('hub emits protocol-error on bad-signature', async () => {
    const c = await readyClient({ kind: 'pe-a' });
    let info = null;
    server.hub.on('protocol-error', (i) => { info = i; });
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

  test('hub statuses are evicted when a peer disconnects', async () => {
    const a = await readyClient({
      kind: 'st-a',
      makeStatus: () => ({ status: 'idle' }),
      statusIntervalMs: 5_000,
    });
    await tick(100);
    let snapshot = server.hub.getState();
    assert.ok(snapshot.lastStatus['st-a'], 'status was recorded while connected');

    a.stop();
    await tick(100);
    snapshot = server.hub.getState();
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

describe('hubFeatures reset on reconnect', () => {
  test('after disconnect, hubFeatures is null until next ready', async () => {
    const c = await readyClient({ kind: 'hf-a' });
    assert.ok(Array.isArray(c.hubFeatures));
    c.stop();
    assert.deepStrictEqual(c.hubFeatures, ['topics', 'direct'],
      'just after stop, hubFeatures still holds the last value (close handler does not clear it)');
    const fresh = new LinkClient({ url: URL, secret: SECRET, kind: 'hf-b', logger: null });
    assert.strictEqual(fresh.hubFeatures, null, 'fresh client has null until ready');
    await fresh.ready({ timeoutMs: 2000 });
    assert.ok(Array.isArray(fresh.hubFeatures));
    fresh.stop();
  });
});
