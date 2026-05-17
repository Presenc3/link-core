'use strict';

/**
 * Integration tests: client/hub connection lifecycle, peer replacement, and hubFeatures reset.
 *
 * Uses a per-file dedicated hub on port 19100 so this file can run in
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

const PORT   = 19100;
const URL    = `ws://127.0.0.1:${PORT}`;
const SECRET = DEFAULT_SECRET;

const harness     = setupHub({ port: PORT });
const readyClient = makeReadyClient(harness);

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

  test('ready() times out on per-peer-keys mismatch (hub silently drops bad hello)', async () => {
    const PORT2 = 19101;
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

  test('getPeers() returns a deep copy - external mutation cannot poison internal state', async () => {
    const c = await readyClient({ kind: 'iso-peers' });
    await tick(50);
    const out = c.getPeers();
    out.push({ kind: 'INJECTED', hello: { kind: 'INJECTED' }, connectedAt: 0, connected: true });
    if (out[0]?.hello) out[0].hello.kind = 'MUTATED';
    const fresh = c.getPeers();
    assert.ok(!fresh.some((p) => p.kind === 'INJECTED'),
      'externally pushed peer must not appear in next getPeers() call');
    if (fresh[0]?.hello) {
      assert.notStrictEqual(fresh[0].hello.kind, 'MUTATED',
        'externally mutated hello field must not appear in next getPeers() call');
    }
    c.stop();
  });

  test('getPeerStatus() returns a deep copy - external mutation cannot poison internal state', async () => {
    const a = await readyClient({ kind: 'iso-status-a', makeStatus: () => ({ ok: true, n: 1 }) });
    const b = await readyClient({ kind: 'iso-status-b' });
    await tick(60);
    const got = b.getPeerStatus('iso-status-a');
    if (got) {
      got.status.n = 999;
      got.poisoned = true;
    }
    const again = b.getPeerStatus('iso-status-a');
    if (again) {
      assert.notStrictEqual(again.status.n, 999,
        'externally mutated nested status must not appear in next call');
      assert.strictEqual(again.poisoned, undefined,
        'externally added field must not appear in next call');
    }
    a.stop(); b.stop();
  });
});

describe('peer replacement (client-side)', () => {
  test('peer.replaced fires when a same-kind peer reconnects with a fresh socket', async () => {
    const obs = await readyClient({ kind: 'pr-obs' });
    const replacements = [];
    const connects     = [];
    const disconnects  = [];
    obs.on('peer.replaced',   (i) => replacements.push(i));
    obs.on('peer.connect',    (p) => connects.push(p));
    obs.on('peer.disconnect', (p) => disconnects.push(p));

    const w1 = await readyClient({ kind: 'pr-worker' });
    await tick(80);
    connects.length = 0;
    disconnects.length = 0;

    const w2 = await readyClient({ kind: 'pr-worker' });
    await tick(150);

    assert.strictEqual(replacements.length, 1, 'exactly one peer.replaced should fire');
    assert.strictEqual(replacements[0].kind,         'pr-worker');
    assert.strictEqual(replacements[0].peer.kind,    'pr-worker');
    assert.strictEqual(replacements[0].prevPeer.kind,'pr-worker');
    assert.notStrictEqual(
      replacements[0].peer.connectedAt,
      replacements[0].prevPeer.connectedAt,
      'connectedAt must differ between prev and new peer',
    );
    assert.strictEqual(connects.length,    0, 'no peer.connect on replacement');
    assert.strictEqual(disconnects.length, 0, 'no peer.disconnect on replacement');

    obs.stop(); w1.stop(); w2.stop();
  });

  test('peer.connect and peer.disconnect still fire correctly without replacement', async () => {
    const obs = await readyClient({ kind: 'pcd-obs' });
    const events = [];
    obs.on('peer.connect',    (p) => events.push(['connect',    p.kind]));
    obs.on('peer.disconnect', (p) => events.push(['disconnect', p.kind]));
    obs.on('peer.replaced',   (i) => events.push(['replaced',   i.kind]));

    const w = await readyClient({ kind: 'pcd-worker' });
    await tick(80);
    w.stop();
    await tick(80);

    assert.deepStrictEqual(
      events.filter((e) => e[1] === 'pcd-worker'),
      [['connect', 'pcd-worker'], ['disconnect', 'pcd-worker']],
    );
    obs.stop();
  });

  test('getPeers() inside peer.connect handler reflects post-update state', async () => {
    const obs = await readyClient({ kind: 'fresh-obs' });
    let seenKinds = null;
    obs.once('peer.connect', () => {
      seenKinds = obs.getPeers().map((p) => p.kind);
    });
    const w = await readyClient({ kind: 'fresh-worker' });
    await tick(80);
    assert.ok(seenKinds, 'peer.connect should have fired');
    assert.ok(seenKinds.includes('fresh-worker'),
      `getPeers() inside handler should include the joining peer; got ${JSON.stringify(seenKinds)}`);
    obs.stop(); w.stop();
  });
});

describe('hubFeatures reset on reconnect', () => {
  test('after disconnect, hubFeatures is null until next ready', async () => {
    const c = await readyClient({ kind: 'hf-a' });
    assert.ok(Array.isArray(c.hubFeatures));
    c.stop();
    assert.strictEqual(c.hubFeatures, null,
      'stop() clears hubFeatures so a later start() against a possibly-different hub starts fresh');
    const fresh = new LinkClient({ url: URL, secret: SECRET, kind: 'hf-b', logger: null });
    assert.strictEqual(fresh.hubFeatures, null, 'fresh client has null until ready');
    await fresh.ready({ timeoutMs: 2000 });
    assert.ok(Array.isArray(fresh.hubFeatures));
    fresh.stop();
  });
});

describe('ready() rejects fast when link is disabled', () => {
  test('ready() rejects with LinkNotReadyError when url is missing', async () => {
    const c = new LinkClient({ secret: 's', kind: 'k', logger: null });
    await assert.rejects(
      () => c.ready(),
      (err) => err instanceof LinkNotReadyError
            && err.op === 'ready'
            && /disabled/.test(err.message),
    );
  });

  test('ready() rejects with LinkNotReadyError when secret is missing', async () => {
    const c = new LinkClient({ url: URL, kind: 'k', logger: null });
    await assert.rejects(() => c.ready(), LinkNotReadyError);
  });

  test('ready() rejects with LinkNotReadyError when kind is missing', async () => {
    const c = new LinkClient({ url: URL, secret: 's', logger: null });
    await assert.rejects(() => c.ready(), LinkNotReadyError);
  });

  test('ready() rejection is synchronous-ish - within a few ms, not the default timeoutMs:0 forever', async () => {
    const c = new LinkClient({ logger: null });
    const t0 = Date.now();
    await assert.rejects(() => c.ready(), LinkNotReadyError);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 100, `ready() rejected in ${elapsed}ms (expected < 100)`);
  });
});