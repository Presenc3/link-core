'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

const { EventEmitter } = require('events');
const { createEventRecorder, RECORDED_CLIENT_EVENTS, SNAPSHOT_TRIGGERS } =
  require('../../src/helpers/event-recorder.js');

function makeFakeClient(overrides = {}) {
  const c = new EventEmitter();
  c.kind        = overrides.kind        !== undefined ? overrides.kind        : 'web';
  c.name        = overrides.name        !== undefined ? overrides.name        : 'web-1';
  c.hubFeatures = overrides.hubFeatures !== undefined ? overrides.hubFeatures : ['topics', 'direct'];
  c._connected  = overrides.connected ?? true;
  c._ready      = overrides.ready     ?? true;
  c._peers      = overrides.peers     ?? [];
  c._statuses   = overrides.statuses  ?? {};
  c._health     = overrides.health    ?? {
    connected: true, verified: true, ready: true, lastVerifiedAt: Date.now(),
    peerCount: 0, pendingRpcCount: 0, subscriptionCount: 0, bufferedAmount: 0,
    reconnectAttempt: 0, stopped: false,
  };
  c.isConnected   = () => c._connected;
  c.isReady       = () => c._ready;
  c.getPeers      = () => c._peers;
  c.getPeerStatus = (k) => c._statuses[k] || null;
  c.health        = () => c._health;
  return c;
}

test('createEventRecorder throws on missing client', () => {
  assert.throws(() => createEventRecorder(),         /client.*required/i);
  assert.throws(() => createEventRecorder(null),     /client.*required/i);
  assert.throws(() => createEventRecorder('nope'),   /client.*required/i);
});

test('createEventRecorder throws on non-EventEmitter-shaped client', () => {
  assert.throws(() => createEventRecorder({}),       /EventEmitter/);
  assert.throws(() => createEventRecorder({ on: () => {} }), /EventEmitter/);
});

test('createEventRecorder exposes effective options as read-only metadata', () => {
  const c = makeFakeClient();
  const r = createEventRecorder(c, {
    ringSize: 7, heartbeatIntervalMs: 250, startedAt: 1234,
  });

  assert.equal(r.ringSize, 7);
  assert.equal(r.heartbeatIntervalMs, 250);
  assert.equal(r.startedAt, 1234);
  assert.throws(() => { r.ringSize = 99; });

  r.close();
});

test('createEventRecorder applies sensible defaults', () => {
  const c = makeFakeClient();
  const r = createEventRecorder(c);

  assert.equal(r.ringSize, 30);
  assert.equal(r.heartbeatIntervalMs, 1000);
  assert.ok(Number.isFinite(r.startedAt));

  r.close();
});

test('option clamping: bad values fall back to defaults', () => {
  const c = makeFakeClient();
  const r = createEventRecorder(c, {
    ringSize:            -5,
    heartbeatIntervalMs: -1,
    startedAt:           'not a number',
  });

  assert.equal(r.ringSize, 30);
  assert.equal(r.heartbeatIntervalMs, 1000);
  assert.ok(Number.isFinite(r.startedAt));

  r.close();
});

test('heartbeatIntervalMs: 0 disables the heartbeat', async () => {
  const c = makeFakeClient();
  const r = createEventRecorder(c, { heartbeatIntervalMs: 0 });

  let snaps = 0;
  r.on('snapshot', () => { snaps++; });

  await new Promise((res) => setTimeout(res, 50));
  assert.equal(snaps, 0);

  r.close();
});

test('RECORDED_CLIENT_EVENTS and SNAPSHOT_TRIGGERS are frozen', () => {
  assert.ok(Object.isFrozen(RECORDED_CLIENT_EVENTS));
  assert.ok(Object.isFrozen(SNAPSHOT_TRIGGERS));
  for (const t of SNAPSHOT_TRIGGERS) {
    assert.ok(RECORDED_CLIENT_EVENTS.includes(t), `${t} should be in RECORDED_CLIENT_EVENTS`);
  }
});

test('ready event records hub-up + emits snapshot', () => {
  const c = makeFakeClient();
  const r = createEventRecorder(c, { heartbeatIntervalMs: 0 });

  const snaps = [];
  r.on('snapshot', (s) => snaps.push(s));

  c.emit('ready', { kind: 'web', features: ['topics', 'direct'] });

  const recent = r.getRecent();
  assert.equal(recent.length, 1);
  assert.equal(recent[0].kind, 'hub-up');
  assert.equal(recent[0].from, 'link_server');
  assert.ok(Number.isFinite(recent[0].t));

  assert.equal(snaps.length, 1);
  assert.equal(snaps[0]._reason, 'ready');

  r.close();
});

test('rejected event records rejected + emits snapshot with reason+error', () => {
  const c = makeFakeClient();
  const r = createEventRecorder(c, { heartbeatIntervalMs: 0 });

  c.emit('rejected', { reason: 'bad-secret', error: 'boom' });

  const evts = r.getRecent();
  assert.equal(evts.length, 1);
  assert.deepEqual(
    { kind: evts[0].kind, from: evts[0].from, reason: evts[0].reason, error: evts[0].error },
    { kind: 'rejected', from: 'link_server', reason: 'bad-secret', error: 'boom' },
  );

  r.close();
});

test('disconnect event records hub-down + emits snapshot', () => {
  const c = makeFakeClient();
  const r = createEventRecorder(c, { heartbeatIntervalMs: 0 });

  c.emit('disconnect', { code: 1001, reason: 'hub stopped', wasReady: true, willReconnect: true });

  const evts = r.getRecent();
  assert.equal(evts[0].kind, 'hub-down');
  assert.equal(evts[0].code, 1001);
  assert.equal(evts[0].reason, 'hub stopped');

  r.close();
});

test('protocol-error event records but does NOT emit snapshot', () => {
  const c = makeFakeClient();
  const r = createEventRecorder(c, { heartbeatIntervalMs: 0 });

  let snaps = 0;
  r.on('snapshot', () => { snaps++; });

  c.emit('protocol-error', { reason: 'bad-signature', type: 'direct', detail: '...' });

  assert.equal(r.getRecent()[0].kind, 'protocol-error');
  assert.equal(snaps, 0, 'protocol-error should not be in SNAPSHOT_TRIGGERS');

  r.close();
});

test('peer.connect / peer.disconnect record join/leave + emit snapshots', () => {
  const c = makeFakeClient();
  const r = createEventRecorder(c, { heartbeatIntervalMs: 0 });

  const snapReasons = [];
  r.on('snapshot', (s) => snapReasons.push(s._reason));

  c.emit('peer.connect',    { kind: 'worker', hello: null, connectedAt: 1, connected: true });
  c.emit('peer.disconnect', { kind: 'worker', hello: null, connectedAt: 1, connected: false });

  const evts = r.getRecent();
  assert.equal(evts.length, 2);
  assert.deepEqual([evts[0].kind, evts[1].kind], ['join', 'leave']);
  assert.equal(evts[0].from, 'worker');
  assert.equal(evts[1].from, 'worker');

  assert.deepEqual(snapReasons, ['peer.connect', 'peer.disconnect']);

  r.close();
});

test('peer.status from self is suppressed (not recorded) but still emits snapshot', () => {
  const c = makeFakeClient({ kind: 'web' });
  const r = createEventRecorder(c, { heartbeatIntervalMs: 0 });

  const snapReasons = [];
  r.on('snapshot', (s) => snapReasons.push(s._reason));

  c.emit('peer.status', { from: 'web', status: { foo: 1 }, at: 100 });
  c.emit('peer.status', { from: 'worker', status: { foo: 2 }, at: 200 });

  const evts = r.getRecent();
  assert.equal(evts.length, 1);
  assert.equal(evts[0].kind, 'status');
  assert.equal(evts[0].from, 'worker');
  assert.deepEqual(snapReasons, ['peer.status', 'peer.status']);

  r.close();
});

test('rpc.complete records only on failure', () => {
  const c = makeFakeClient();
  const r = createEventRecorder(c, { heartbeatIntervalMs: 0 });

  c.emit('rpc.complete', { id: 'a', to: 'worker', rpcType: 'ping', ok: true,  reason: null,      durationMs: 5  });
  c.emit('rpc.complete', { id: 'b', to: 'worker', rpcType: 'ping', ok: false, reason: 'timeout', durationMs: 99 });

  const evts = r.getRecent();
  assert.equal(evts.length, 1);
  assert.deepEqual(
    { kind: evts[0].kind, to: evts[0].to, rpcType: evts[0].rpcType, reason: evts[0].reason },
    { kind: 'rpc-fail', to: 'worker', rpcType: 'ping', reason: 'timeout' },
  );

  r.close();
});

test('backpressure and direct are recorded but do NOT emit snapshots', () => {
  const c = makeFakeClient();
  const r = createEventRecorder(c, { heartbeatIntervalMs: 0 });

  let snaps = 0;
  r.on('snapshot', () => { snaps++; });

  c.emit('backpressure', { type: 'topic.publish', to: null, bufferedAmount: 5_000_000 });
  c.emit('direct',       { from: 'worker', to: 'web', type: 'job.done', data: {} });

  const kinds = r.getRecent().map((e) => e.kind);
  assert.deepEqual(kinds, ['backpressure', 'direct']);
  assert.equal(snaps, 0);

  r.close();
});

test('ring evicts oldest when over capacity (FIFO)', () => {
  const c = makeFakeClient();
  const r = createEventRecorder(c, { ringSize: 3, heartbeatIntervalMs: 0 });

  for (let i = 0; i < 5; i++) {
    c.emit('direct', { from: `peer-${i}`, type: 'x' });
  }

  const evts = r.getRecent();
  assert.equal(evts.length, 3);
  assert.deepEqual(evts.map((e) => e.from), ['peer-2', 'peer-3', 'peer-4']);

  r.close();
});

test('getRecent returns a copy - mutations do not affect the recorder', () => {
  const c = makeFakeClient();
  const r = createEventRecorder(c, { heartbeatIntervalMs: 0 });

  c.emit('direct', { from: 'a', type: 'x' });
  const snap1 = r.getRecent();
  snap1.push({ kind: 'fabricated' });
  snap1[0].t = -1;

  const snap2 = r.getRecent();
  assert.equal(snap2.length, 1);
  assert.notEqual(snap2[0].t, -1);

  r.close();
});

test('getSnapshot has the documented top-level keys', () => {
  const c = makeFakeClient();
  const r = createEventRecorder(c, { heartbeatIntervalMs: 0, startedAt: 42 });

  const s = r.getSnapshot();
  assert.deepEqual(
    Object.keys(s).sort(),
    ['at', 'connected', 'eventLog', 'health', 'peers', 'ready', 'self', 'startedAt', 'statuses'],
  );
  assert.equal(s.startedAt, 42);
  assert.deepEqual(s.self, { kind: 'web', name: 'web-1', features: ['topics', 'direct'] });

  r.close();
});

test('snapshot.features is a copy - mutations do not affect the recorder', () => {
  const c = makeFakeClient();
  const r = createEventRecorder(c, { heartbeatIntervalMs: 0 });

  const s1 = r.getSnapshot();
  s1.self.features.push('mutated');

  const s2 = r.getSnapshot();
  assert.deepEqual(s2.self.features, ['topics', 'direct']);

  r.close();
});

test('snapshot returns null self when client has no kind', () => {
  const c = makeFakeClient({ kind: null });
  const r = createEventRecorder(c, { heartbeatIntervalMs: 0 });

  assert.equal(r.getSnapshot().self, null);

  r.close();
});

test('snapshot populates statuses from getPeerStatus per peer', () => {
  const c = makeFakeClient({
    peers: [
      { kind: 'a', hello: null, connectedAt: 1, connected: true  },
      { kind: 'b', hello: null, connectedAt: 2, connected: true  },
      { kind: 'c', hello: null, connectedAt: 3, connected: false },
    ],
    statuses: {
      a: { status: 'ok',   at: 10 },
      b: { status: 'busy', at: 20 },
    },
  });
  const r = createEventRecorder(c, { heartbeatIntervalMs: 0 });

  const s = r.getSnapshot();
  assert.deepEqual(Object.keys(s.statuses).sort(), ['a', 'b']);
  assert.equal(s.statuses.a.status, 'ok');

  r.close();
});

test('snapshot tolerates throwing accessors (returns defaults)', () => {
  const c = new EventEmitter();
  c.kind          = 'web';
  c.name          = 'web-1';
  c.hubFeatures   = null;
  c.isConnected   = () => { throw new Error('nope'); };
  c.isReady       = () => { throw new Error('nope'); };
  c.getPeers      = () => { throw new Error('nope'); };
  c.getPeerStatus = () => { throw new Error('nope'); };
  c.health        = () => { throw new Error('nope'); };

  const r = createEventRecorder(c, { heartbeatIntervalMs: 0 });
  const s = r.getSnapshot();

  assert.equal(s.connected, false);
  assert.equal(s.ready,     false);
  assert.deepEqual(s.peers, []);
  assert.deepEqual(Object.keys(s.statuses), []);
  assert.equal(s.health, null);

  r.close();
});

test('onSnapshot delivers the current snapshot synchronously', () => {
  const c = makeFakeClient();
  const r = createEventRecorder(c, { heartbeatIntervalMs: 0 });

  let firstSnap = null;
  r.onSnapshot((s) => { if (firstSnap === null) firstSnap = s; });

  assert.ok(firstSnap, 'subscriber should have been called synchronously');
  assert.equal(firstSnap._reason, 'initial');

  r.close();
});

test('onSnapshot fires on subsequent emits and unsub stops them', () => {
  const c = makeFakeClient();
  const r = createEventRecorder(c, { heartbeatIntervalMs: 0 });

  const seen = [];
  const unsub = r.onSnapshot((s) => seen.push(s._reason));

  c.emit('peer.connect',    { kind: 'a', hello: null, connectedAt: 1, connected: true  });
  c.emit('peer.disconnect', { kind: 'a', hello: null, connectedAt: 1, connected: false });

  unsub();
  c.emit('peer.connect',    { kind: 'b', hello: null, connectedAt: 2, connected: true  });

  assert.deepEqual(seen, ['initial', 'peer.connect', 'peer.disconnect']);

  r.close();
});

test('onEvent fires on every recorded event but does NOT replay history', () => {
  const c = makeFakeClient();
  const r = createEventRecorder(c, { heartbeatIntervalMs: 0 });

  c.emit('direct', { from: 'a', type: 'x' });

  const seen = [];
  const unsub = r.onEvent((e) => seen.push(e.from));

  c.emit('direct', { from: 'b', type: 'x' });
  c.emit('direct', { from: 'c', type: 'x' });

  unsub();
  c.emit('direct', { from: 'd', type: 'x' });

  assert.deepEqual(seen, ['b', 'c']);

  r.close();
});

test('subscriber throws are caught and do not affect other subscribers', () => {
  const c = makeFakeClient();
  const r = createEventRecorder(c, { heartbeatIntervalMs: 0 });
  const origEmit = process.emitWarning;
  process.emitWarning = () => {};

  try {
    const fineSaw = [];
    r.onEvent(() => { throw new Error('subscriber went boom'); });
    r.onEvent((e) => fineSaw.push(e.kind));

    c.emit('direct', { from: 'a', type: 'x' });

    assert.deepEqual(fineSaw, ['direct']);
  } finally {
    process.emitWarning = origEmit;
    r.close();
  }
});

test('onSnapshot and onEvent reject non-functions', () => {
  const c = makeFakeClient();
  const r = createEventRecorder(c, { heartbeatIntervalMs: 0 });

  assert.throws(() => r.onSnapshot(),    /function/);
  assert.throws(() => r.onSnapshot(123), /function/);
  assert.throws(() => r.onEvent(),       /function/);
  assert.throws(() => r.onEvent('hi'),   /function/);

  r.close();
});

test('heartbeat emits tick snapshots at the configured cadence', async () => {
  const TARGET_TICKS    = 3;
  const INTERVAL_MS     = 20;
  const SAFETY_CEILING  = INTERVAL_MS * TARGET_TICKS * 6;
  const c = makeFakeClient();
  const r = createEventRecorder(c, { heartbeatIntervalMs: INTERVAL_MS });

  let ticks = 0;
  const seenReasons = new Set();
  const done = new Promise((resolve, reject) => {
    const safety = setTimeout(() => reject(new Error(
      `expected ${TARGET_TICKS} ticks within ${SAFETY_CEILING}ms, got ${ticks}`,
    )), SAFETY_CEILING);

    r.on('snapshot', (s) => {
      seenReasons.add(s._reason);
      if (s._reason === 'tick') {
        ticks++;
        if (ticks >= TARGET_TICKS) {
          clearTimeout(safety);
          resolve();
        }
      }
    });
  });

  await done;
  assert.ok(ticks >= TARGET_TICKS, `got ${ticks} ticks`);
  assert.ok(seenReasons.has('tick'),
    `snapshots from the heartbeat must carry _reason: 'tick' (saw: ${[...seenReasons].join(',')})`);
  r.close();
});

test('heartbeat does NOT fire when heartbeatIntervalMs is 0', async () => {
  const c = makeFakeClient();
  const r = createEventRecorder(c, { heartbeatIntervalMs: 0 });
  let ticks = 0;
  r.on('snapshot', (s) => { if (s._reason === 'tick') ticks++; });
  await new Promise((res) => setTimeout(res, 60));
  assert.strictEqual(ticks, 0, 'no ticks should fire with heartbeat disabled');
  r.close();
});

test('close() detaches client listeners', () => {
  const c = makeFakeClient();

  const before = RECORDED_CLIENT_EVENTS.map((ev) => c.listenerCount(ev));
  const r = createEventRecorder(c, { heartbeatIntervalMs: 0 });
  const during = RECORDED_CLIENT_EVENTS.map((ev) => c.listenerCount(ev));

  r.close();
  const after = RECORDED_CLIENT_EVENTS.map((ev) => c.listenerCount(ev));

  for (let i = 0; i < RECORDED_CLIENT_EVENTS.length; i++) {
    assert.equal(during[i] - before[i], 1, `${RECORDED_CLIENT_EVENTS[i]} should gain 1 listener`);
    assert.equal(after[i],  before[i],    `${RECORDED_CLIENT_EVENTS[i]} should be restored after close`);
  }
});

test('close() clears the heartbeat', async () => {
  const c = makeFakeClient();
  const r = createEventRecorder(c, { heartbeatIntervalMs: 20 });

  await new Promise((res) => setTimeout(res, 30));

  r.close();

  const seenAfterClose = [];
  r.on('snapshot', (s) => seenAfterClose.push(s._reason));

  await new Promise((res) => setTimeout(res, 60));
  assert.equal(seenAfterClose.length, 0, 'no snapshots should fire after close()');
});

test('close() is idempotent', () => {
  const c = makeFakeClient();
  const r = createEventRecorder(c, { heartbeatIntervalMs: 0 });
  r.close();
  r.close();
  r.close();
  assert.ok(true);
});

test('after close(), recorded client events become no-ops', () => {
  const c = makeFakeClient();
  const r = createEventRecorder(c, { heartbeatIntervalMs: 0 });

  c.emit('direct', { from: 'a', type: 'x' });
  assert.equal(r.getRecent().length, 1);

  r.close();
  c.emit('direct', { from: 'b', type: 'x' });
  assert.equal(r.getRecent().length, 1);
});

test('after close(), onSnapshot/onEvent are no-ops returning no-op unsubscribes', () => {
  const c = makeFakeClient();
  const r = createEventRecorder(c, { heartbeatIntervalMs: 0 });
  r.close();

  let snapshotCalled = 0;
  let eventCalled    = 0;
  const unsubSnap = r.onSnapshot(() => { snapshotCalled++; });
  const unsubEvt  = r.onEvent   (() => { eventCalled++;    });

  c.emit('direct', { from: 'a', type: 'x' });
  assert.equal(snapshotCalled, 0, 'no initial snapshot delivery after close');
  assert.equal(eventCalled,    0, 'no event delivery after close');
  assert.equal(typeof unsubSnap, 'function');
  assert.equal(typeof unsubEvt,  'function');
  unsubSnap(); unsubEvt();
});

test('after close(), getSnapshot()/getRecent() still work (read-only accessors)', () => {
  const c = makeFakeClient();
  c.kind = 'k';
  const r = createEventRecorder(c, { heartbeatIntervalMs: 0 });
  c.emit('direct', { from: 'p', type: 't' });
  r.close();

  const snap = r.getSnapshot();
  assert.ok(snap && typeof snap === 'object');
  assert.equal(typeof snap.at, 'number');
  assert.ok(Array.isArray(snap.eventLog));

  const recent = r.getRecent();
  assert.ok(Array.isArray(recent));
  assert.equal(recent.length, 1);
});