'use strict';

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert');

const {
  createHubServer, LinkClient, loadSecrets, LOADED_SECRETS_UNWATCH,
} = require('../../src/index.js');

const PORT   = 18950;
const URL    = `ws://127.0.0.1:${PORT}`;
const SECRET = 'secrets-helper-test';
const VAULT  = 'link_secs';

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

async function makeVault(t, { store = {}, slowMs = 0 } = {}) {
  const vault = new LinkClient({
    url: URL, secret: SECRET, kind: VAULT, logger: null,
    rpcHandlers: {
      'secs.get': async ({ path }) => {
        if (slowMs > 0) await new Promise((r) => setTimeout(r, slowMs));
        return store[path] != null ? { value: store[path] } : { value: null };
      },
    },
  });
  if (t && typeof t.after === 'function') t.after(() => { try { vault.stop(); } catch {} });
  await vault.ready({ timeoutMs: 3000 });
  return vault;
}

async function makeConsumer(t, opts = {}) {
  const c = new LinkClient({
    url: URL, secret: SECRET, kind: opts.kind || 'consumer', logger: null,
    defaultRpcTimeoutMs: 60_000,
    ...opts,
  });
  if (t && typeof t.after === 'function') t.after(() => { try { c.stop(); } catch {} });
  return c;
}

describe('loadSecrets - happy path', () => {
  test('fetches every mapped secret and returns the value map', async (t) => {
    const vault = await makeVault(t, {
      store: {
        'sec/shared/openai':       'sk-openai-123',
        'sec/datastore/sentry':    'https://sentry/abc',
      },
    });

    const consumer = await makeConsumer(t, { kind: 'consumer-happy' });
    await consumer.ready({ timeoutMs: 3000 });

    const cfg = await loadSecrets(consumer, {
      OPENAI_API_KEY: 'sec/shared/openai',
      SENTRY_DSN:     'sec/datastore/sentry',
    }, { timeoutMs: 5_000 });

    assert.strictEqual(cfg.OPENAI_API_KEY, 'sk-openai-123');
    assert.strictEqual(cfg.SENTRY_DSN,     'https://sentry/abc');

  });
});

describe('loadSecrets - budget enforcement (the bug this guards)', () => {
  test('per-get RPCs are bounded by the shared budget, not defaultRpcTimeoutMs', async (t) => {
    const vault = await makeVault(t, {
      store: { 'sec/slow/answer': '42' },
      slowMs: 1_500,
    });

    const consumer = await makeConsumer(t, { kind: 'consumer-budget' });
    await consumer.ready({ timeoutMs: 3000 });

    const start = Date.now();
    await assert.rejects(
      loadSecrets(consumer, { ANS: 'sec/slow/answer' }, { timeoutMs: 300 }),
      /vault did not respond|budget.+exhausted|timed out/i,
    );
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 2_000,
      `expected fast failure within budget, took ${elapsed}ms`);

  });

  test('throws fast if the vault peer never appears', async (t) => {
    const consumer = await makeConsumer(t, { kind: 'consumer-no-vault' });
    await consumer.ready({ timeoutMs: 3000 });

    const start = Date.now();
    await assert.rejects(
      loadSecrets(consumer, { X: 'sec/x/y' }, { timeoutMs: 250 }),
      /waiting for kind=link_secs|budget.+exhausted/i,
    );
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 1_500,
      `expected fast failure waiting for vault, took ${elapsed}ms`);

  });

  test('rejects synchronously on invalid timeoutMs (NaN, 0, negative)', async (t) => {
    const consumer = await makeConsumer(t, { kind: 'consumer-bad-budget' });
    await consumer.ready({ timeoutMs: 3000 });

    await assert.rejects(
      loadSecrets(consumer, { X: 'sec/x/y' }, { timeoutMs: NaN }),
      /positive finite/,
    );
    await assert.rejects(
      loadSecrets(consumer, { X: 'sec/x/y' }, { timeoutMs: 0 }),
      /positive finite/,
    );
    await assert.rejects(
      loadSecrets(consumer, { X: 'sec/x/y' }, { timeoutMs: -1 }),
      /positive finite/,
    );

  });
});

describe('loadSecrets - missing secrets fail fast', () => {
  test('throws if any secret resolves to null (vault returned no value)', async (t) => {
    const vault = await makeVault(t, {
      store: { 'sec/shared/openai': 'sk-real' },
    });

    const consumer = await makeConsumer(t, { kind: 'consumer-missing' });
    await consumer.ready({ timeoutMs: 3000 });

    await assert.rejects(
      loadSecrets(consumer, {
        OPENAI_API_KEY: 'sec/shared/openai',
        ABSENT_KEY:     'sec/shared/missing',
      }, { timeoutMs: 3_000 }),
      /missing secret.+sec\/shared\/missing/,
    );

  });
});

describe('loadSecrets - watch mode + unwatch handle', () => {
  test('LOADED_SECRETS_UNWATCH is exported, absent on non-watch, present on watch', async (t) => {
    assert.strictEqual(typeof LOADED_SECRETS_UNWATCH, 'symbol');

    const vault = await makeVault(t, { store: { 'sec/shared/k': 'v1' } });
    const consumer = await makeConsumer(t, { kind: 'consumer-unwatch-shape' });
    await consumer.ready({ timeoutMs: 3000 });

    const noWatch = await loadSecrets(consumer, { K: 'sec/shared/k' }, { timeoutMs: 3000 });
    assert.strictEqual(noWatch[LOADED_SECRETS_UNWATCH], undefined,
      'no unwatch handle on non-watch loads');

    const withWatch = await loadSecrets(consumer, { K: 'sec/shared/k' }, {
      timeoutMs: 3000, watch: true,
    });
    assert.strictEqual(typeof withWatch[LOADED_SECRETS_UNWATCH], 'function',
      'unwatch handle attached on watch loads');

    const serialized = JSON.parse(JSON.stringify(withWatch));
    assert.deepStrictEqual(Object.keys(serialized), ['K']);

    withWatch[LOADED_SECRETS_UNWATCH]();
  });

  test('watch mutates in place on rotation; unwatch stops further updates', async (t) => {
    const store = { 'sec/shared/api': 'v1' };
    const vault = new LinkClient({
      url: URL, secret: SECRET, kind: VAULT, logger: null,
      rpcHandlers: {
        'secs.get': async ({ path }) => ({ value: store[path] ?? null }),
      },
    });
    t.after(() => { try { vault.stop(); } catch {} });
    await vault.ready({ timeoutMs: 3000 });

    const consumer = await makeConsumer(t, { kind: 'consumer-watch-rotate' });
    await consumer.ready({ timeoutMs: 3000 });

    const cfg = await loadSecrets(consumer, { API: 'sec/shared/api' }, {
      timeoutMs: 3000, watch: true,
    });
    assert.strictEqual(cfg.API, 'v1');

    store['sec/shared/api'] = 'v2';
    vault.publish('secs.changed.shared', { path: 'sec/shared/api', action: 'set' });
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(cfg.API, 'v2', 'cfg must be mutated in place on rotation');

    cfg[LOADED_SECRETS_UNWATCH]();
    store['sec/shared/api'] = 'v3';
    vault.publish('secs.changed.shared', { path: 'sec/shared/api', action: 'set' });
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(cfg.API, 'v2', 'unwatch must stop further mutations');

  });

  test('unwatch is idempotent and only removes the helper\'s own subscriptions', async (t) => {
    const vault = await makeVault(t, { store: { 'sec/shared/k': 'v1' } });
    const consumer = await makeConsumer(t, { kind: 'consumer-unwatch-idem' });
    await consumer.ready({ timeoutMs: 3000 });
    let userHandlerCalls = 0;
    const userHandler = () => { userHandlerCalls++; };
    consumer.subscribe('secs.changed.shared', userHandler);

    const cfg = await loadSecrets(consumer, { K: 'sec/shared/k' }, {
      timeoutMs: 3000, watch: true,
    });

    cfg[LOADED_SECRETS_UNWATCH]();
    cfg[LOADED_SECRETS_UNWATCH]();
    cfg[LOADED_SECRETS_UNWATCH]();

    vault.publish('secs.changed.shared', { path: 'sec/shared/k', action: 'set' });
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(userHandlerCalls, 1,
      'caller-installed handler on the same topic must survive unwatch()');

    consumer.unsubscribe('secs.changed.shared', userHandler);
  });
});

describe('loadSecrets - watch mode sender + value validation', () => {
  test('rotation events from a peer other than secretsKind are ignored', async (t) => {
    const vault = await makeVault(t, { store: { 'sec/shared/k': 'real-value' } });

    const consumer = await makeConsumer(t, { kind: 'consumer-sender-validation' });
    await consumer.ready({ timeoutMs: 3000 });

    const cfg = await loadSecrets(consumer, { K: 'sec/shared/k' }, {
      timeoutMs: 3000, watch: true,
    });
    assert.strictEqual(cfg.K, 'real-value');

    const impostor = new LinkClient({
      url: URL, secret: SECRET, kind: 'impostor', logger: null,
    });
    t.after(() => { try { impostor.stop(); } catch {} });
    await impostor.ready({ timeoutMs: 3000 });

    impostor.publish('secs.changed.shared', {
      path: 'sec/shared/k', action: 'del',
    });
    await new Promise((r) => setTimeout(r, 200));

    assert.strictEqual(cfg.K, 'real-value',
      'forged rotation event from a non-vault peer must NOT mutate cfg');

    cfg[LOADED_SECRETS_UNWATCH]();
  });

  test('watch rotation drops non-string vault responses instead of poisoning cfg', async (t) => {
    const store = { 'sec/shared/api': 'v1' };
    const vault = new LinkClient({
      url: URL, secret: SECRET, kind: VAULT, logger: null,
      rpcHandlers: {
        'secs.get': async ({ path }) => ({ value: store[path] }),
      },
    });
    t.after(() => { try { vault.stop(); } catch {} });
    await vault.ready({ timeoutMs: 3000 });

    const consumer = await makeConsumer(t, { kind: 'consumer-type-validation' });
    await consumer.ready({ timeoutMs: 3000 });

    const cfg = await loadSecrets(consumer, { API: 'sec/shared/api' }, {
      timeoutMs: 3000, watch: true,
    });
    assert.strictEqual(cfg.API, 'v1');

    store['sec/shared/api'] = { evil: true };
    vault.publish('secs.changed.shared', { path: 'sec/shared/api', action: 'set' });
    await new Promise((r) => setTimeout(r, 200));

    assert.strictEqual(cfg.API, 'v1',
      'non-string rotated value must be dropped, leaving cfg untouched');
    assert.strictEqual(typeof cfg.API, 'string', 'cfg.API must remain a string');

    cfg[LOADED_SECRETS_UNWATCH]();
  });

  test('mapping with a non-secret-path entry rejects up front (no socket churn)', async (t) => {
    const consumer = await makeConsumer(t, { kind: 'consumer-bad-mapping' });
    await consumer.ready({ timeoutMs: 3000 });

    await assert.rejects(
      loadSecrets(consumer, { OK: 'sec/shared/k', WAT: 'not-a-sec-path' }, { timeoutMs: 3000 }),
      /mapping\["WAT"\].+not a valid secret path/,
    );
  });
});