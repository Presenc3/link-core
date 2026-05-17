'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const {
  createSafePublisher,
  createSafeSend,
} = require('../../src/helpers/rpc.js');
const {
  LinkNotReadyError,
  FeatureUnsupportedError,
} = require('../../src/index.js');

function makeLogger() {
  const calls = { lD: [], lW: [] };
  return {
    lD: (ctx, msg, ...a) => calls.lD.push({ ctx, msg, a }),
    lW: (ctx, msg, ...a) => calls.lW.push({ ctx, msg, a }),
    calls,
  };
}

test('createSafePublisher returns true when link.publish resolves successfully', () => {
  const log = makeLogger();
  const link = { publish: () => true, hubFeatures: ['topics'] };
  const publish = createSafePublisher(link, { logger: log });
  assert.equal(publish('a.topic', { x: 1 }), true);
  assert.equal(log.calls.lD.length, 0);
  assert.equal(log.calls.lW.length, 0);
});

test('createSafePublisher returns false when link.publish returns false', () => {
  const log = makeLogger();
  const link = { publish: () => false, hubFeatures: ['topics'] };
  const publish = createSafePublisher(link, { logger: log });
  assert.equal(publish('a.topic', {}), false);
});

test('createSafePublisher swallows LinkNotReadyError quietly (debug only)', () => {
  const log = makeLogger();
  const link = { publish: () => { throw new LinkNotReadyError('not ready'); } };
  const publish = createSafePublisher(link, { logger: log });
  assert.equal(publish('a.topic', {}), false);
  assert.equal(log.calls.lD.length, 1);
  assert.match(log.calls.lD[0].msg, /link not ready/);
  assert.equal(log.calls.lW.length, 0);
});

test('createSafePublisher warns once on FeatureUnsupportedError, then drops to debug', () => {
  const log = makeLogger();
  const err = new FeatureUnsupportedError('hub does not advertise topics', { feature: 'topics' });
  const link = { publish: () => { throw err; } };
  const publish = createSafePublisher(link, { logger: log });

  publish('one', {});
  publish('two', {});
  publish('three', {});

  assert.equal(log.calls.lW.length, 1, 'warn fires only once');
  assert.match(log.calls.lW[0].msg, /publish disabled.*feature='topics'/);
  assert.equal(log.calls.lD.length, 2, 'subsequent skips at debug');
});

test('createSafePublisher with featureCheck:true short-circuits when hub lacks topics', () => {
  const log = makeLogger();
  let published = false;
  const link = {
    publish: () => { published = true; return true; },
    hubFeatures: ['direct'],
  };
  const publish = createSafePublisher(link, { logger: log, featureCheck: true });

  assert.equal(publish('a.topic', {}), false);
  assert.equal(published, false, 'never reached link.publish');
  assert.equal(log.calls.lW.length, 1, 'warn-once still applies');
  assert.match(log.calls.lW[0].msg, /publish disabled.*feature='topics'/);
});

test('createSafePublisher featureCheck:true allows when topics is present', () => {
  const log = makeLogger();
  const link = { publish: () => true, hubFeatures: ['topics', 'direct'] };
  const publish = createSafePublisher(link, { logger: log, featureCheck: true });
  assert.equal(publish('a.topic', {}), true);
  assert.equal(log.calls.lD.length, 0);
  assert.equal(log.calls.lW.length, 0);
});

test('createSafePublisher featureCheck:true falls through when hubFeatures is null (pre-ready)', () => {
  const log = makeLogger();
  const link = {
    publish: () => { throw new LinkNotReadyError('not ready'); },
    hubFeatures: null,
  };
  const publish = createSafePublisher(link, { logger: log, featureCheck: true });
  assert.equal(publish('a.topic', {}), false);
  assert.equal(log.calls.lD.length, 1, 'logged as link-not-ready, not feature-skip');
  assert.match(log.calls.lD[0].msg, /link not ready/);
});

test('createSafePublisher requires a logger with lD/lW', () => {
  assert.throws(() => createSafePublisher({}, {}),    /logger with .* is required/);
  assert.throws(() => createSafePublisher({}, { logger: {} }), /logger with .* is required/);
});

test('createSafeSend returns true on successful send', () => {
  const log = makeLogger();
  const link = { send: () => true, hubFeatures: ['direct'] };
  const send = createSafeSend(link, { logger: log });
  assert.equal(send('worker', 'job.run', { x: 1 }), true);
});

test('createSafeSend swallows LinkNotReadyError quietly', () => {
  const log = makeLogger();
  const link = { send: () => { throw new LinkNotReadyError('nope'); } };
  const send = createSafeSend(link, { logger: log });
  assert.equal(send('worker', 'job.run', {}), false);
  assert.equal(log.calls.lD.length, 1);
  assert.match(log.calls.lD[0].msg, /link not ready/);
});

test('createSafeSend warns once on FeatureUnsupportedError', () => {
  const log = makeLogger();
  const link = { send: () => { throw new FeatureUnsupportedError('no direct', { feature: 'direct' }); } };
  const send = createSafeSend(link, { logger: log });
  send('a', 't', {});
  send('b', 't', {});
  assert.equal(log.calls.lW.length, 1);
  assert.match(log.calls.lW[0].msg, /send disabled.*feature='direct'/);
  assert.equal(log.calls.lD.length, 1);
});

test('createSafeSend featureCheck:true short-circuits when hub lacks direct', () => {
  const log = makeLogger();
  let sent = false;
  const link = {
    send: () => { sent = true; return true; },
    hubFeatures: ['topics'],
  };
  const send = createSafeSend(link, { logger: log, featureCheck: true });
  assert.equal(send('worker', 'job.run', {}), false);
  assert.equal(sent, false);
  assert.equal(log.calls.lW.length, 1);
});

const { rpcWithRetry } = require('../../src/helpers/rpc.js');
const {
  RpcTimeoutError, RpcAbortError,
} = require('../../src/index.js');

test('rpcWithRetry: signal aborted during backoff sleep rejects with RpcAbortError fast', async () => {
  let calls = 0;
  const link = {
    rpc: async () => {
      calls++;
      throw new RpcTimeoutError('mock timeout', {});
    },
  };

  const ac = new AbortController();
  setTimeout(() => ac.abort(), 10);

  const start = Date.now();
  await assert.rejects(
    rpcWithRetry(link, 'peer', 'job', {}, {
      tries: 5,
      timeoutMs: 1000,
      baseDelayMs: 5000,
      signal: ac.signal,
    }),
    RpcAbortError,
  );
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 500,
    `expected fast abort during backoff, took ${elapsed}ms (calls=${calls})`);
});

const { waitForPeer } = require('../../src/helpers/rpc.js');

test('rpcWithRetry: rejects bad tries (0, -1, NaN, Infinity, non-integer)', async () => {
  const link = { rpc: async () => 'ok' };
  for (const bad of [0, -1, NaN, Infinity, 1.5, 'three']) {
    await assert.rejects(
      rpcWithRetry(link, 'p', 'j', {}, { tries: bad }),
      TypeError,
      `tries=${String(bad)} should reject`,
    );
  }
});

test('rpcWithRetry: rejects bad timeoutMs / baseDelayMs', async () => {
  const link = { rpc: async () => 'ok' };
  for (const bad of [-1, NaN, Infinity, '5000']) {
    await assert.rejects(
      rpcWithRetry(link, 'p', 'j', {}, { timeoutMs: bad }),
      TypeError,
      `timeoutMs=${String(bad)} should reject`,
    );
    await assert.rejects(
      rpcWithRetry(link, 'p', 'j', {}, { baseDelayMs: bad }),
      TypeError,
      `baseDelayMs=${String(bad)} should reject`,
    );
  }
});

test('waitForPeer: rejects bad timeoutMs (NaN, -1, Infinity, wrong type)', async () => {
  const link = { getPeers: () => [] };
  for (const bad of [NaN, -1, Infinity, '5000']) {
    await assert.rejects(
      waitForPeer(link, 'vault', { timeoutMs: bad }),
      TypeError,
      `timeoutMs=${String(bad)} should reject synchronously`,
    );
  }
});

test('waitForPeer: wakes on peer.replaced (not just peer.connect)', async () => {
  const { EventEmitter } = require('node:events');
  const link = Object.assign(new EventEmitter(), {
    _peers: [],
    getPeers() { return this._peers.slice(); },
    waitFor() { throw new Error('helper should not call link.waitFor directly'); },
  });

  setTimeout(() => {
    link._peers = [{ kind: 'vault', connected: true, connectedAt: Date.now() }];
    link.emit('peer.replaced', {
      kind: 'vault', prevPeer: null, peer: link._peers[0],
    });
  }, 20);

  const found = await waitForPeer(link, 'vault', { timeoutMs: 1000 });
  assert.strictEqual(found.kind, 'vault');
  assert.strictEqual(found.connected, true);
});

test('waitForPeer: already-aborted signal rejects synchronously with AbortError', async () => {
  const { EventEmitter } = require('node:events');
  const link = Object.assign(new EventEmitter(), { getPeers: () => [] });
  const ctl = new AbortController();
  ctl.abort();

  await assert.rejects(
    () => waitForPeer(link, 'vault', { timeoutMs: 30_000, signal: ctl.signal }),
    (err) => err.name === 'AbortError' && /waitForPeer/.test(err.message),
  );
});

test('waitForPeer: aborting during wait rejects with AbortError, not timeout', async () => {
  const { EventEmitter } = require('node:events');
  const link = Object.assign(new EventEmitter(), {
    getPeers() { return []; },
  });

  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 20);

  const t0 = Date.now();
  await assert.rejects(
    () => waitForPeer(link, 'never', { timeoutMs: 30_000, signal: ctl.signal }),
    (err) => err.name === 'AbortError',
  );
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 200,
    `aborted waitForPeer should reject promptly, took ${elapsed}ms`);
});

test('waitForPeer: rejects with TypeError if link wrapper omits on/off', async () => {
  const wrapper = {
    getPeers: () => [],
    waitFor:  () => Promise.resolve()
  };

  await assert.rejects(
    () => waitForPeer(wrapper, 'vault', { timeoutMs: 30_000 }),
    (err) => err instanceof TypeError && /must be a LinkClient/.test(err.message),
  );
});

test('loadSecrets: surfaces TypeError from waitForPeer, not a fake timeout', async () => {
  const { loadSecrets } = require('../../src/helpers/secrets.js');

  const wrapper = {
    getPeers: () => [],
    ready:    () => Promise.resolve({ kind: 'k', features: ['topics'] }),
  };

  await assert.rejects(
    () => loadSecrets(wrapper, { TOKEN: 'sec/foo/token' }, { timeoutMs: 5_000 }),
    (err) => err instanceof TypeError && /must be a LinkClient/.test(err.message),
  );
});