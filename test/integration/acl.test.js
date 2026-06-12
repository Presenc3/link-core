'use strict';

/**
 * Integration tests: hub ACL hooks
 * (`canRpc` / `canPublish` / `canSubscribe` / `canSend`).
 *
 * Each test stands up its own hub on a distinct port (20000-20009) so
 * the ACL callbacks under test cannot leak between cases - `setupHub`
 * registers one shared hub per file, but ACL config is per-hub, so these
 * use `createHubServer` directly.
 *
 * Covers: allow / generic-deny / structured-deny verdicts, the
 * caller-facing `RpcRemoteError` on RPC denial, the `acl-denied` event,
 * async callbacks, fail-closed behaviour (throw / non-conforming
 * return), and construction-time validation.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { createHubServer, LinkClient, RpcRemoteError } = require('../../src/index.js');

const SECRET = 'acl-test';
const tick   = (ms = 40) => new Promise((r) => setTimeout(r, ms));

/**
 * Spin up a hub with the given ACL config plus two ready clients
 * (`alice`, `bob`). Returns a teardown-aware bundle.
 */
async function withAclHub(port, aclOpts, { bobHandlers } = {}) {
  const server = createHubServer({
    secret: SECRET, port, logger: null, handleSignals: false, ...aclOpts,
  });
  await server.start();

  const url = `ws://127.0.0.1:${port}`;
  const denied = [];
  server.hub.on('acl-denied', (info) => denied.push(info));

  const alice = new LinkClient({ url, secret: SECRET, kind: 'alice', logger: null });
  const bob   = new LinkClient({
    url, secret: SECRET, kind: 'bob', logger: null, rpcHandlers: bobHandlers || {},
  });
  await Promise.all([
    alice.ready({ timeoutMs: 3000 }),
    bob.ready({ timeoutMs: 3000 }),
  ]);

  return {
    server, alice, bob, denied,
    async close() {
      alice.stop({ drain: false });
      bob.stop({ drain: false });
      await server.stop();
    },
  };
}

describe('hub ACL: canRpc', () => {
  test('allows when the verdict is true, denies when false', async () => {
    const h = await withAclHub(20000, {
      canRpc: (ctx) => ctx.from === 'alice',
    }, { bobHandlers: { ping: () => 'pong' } });
    try {
      // alice is allowed
      assert.strictEqual(await h.alice.rpc('bob', 'ping', {}), 'pong');

      // bob is denied (canRpc returns false for from !== 'alice')
      let caught;
      try { await h.bob.rpc('alice', 'ping', {}); } catch (e) { caught = e; }
      assert.ok(caught instanceof RpcRemoteError, 'denied RPC should reject with RpcRemoteError');
      assert.strictEqual(caught.code, 'RPC_FORBIDDEN');
      assert.strictEqual(caught.message, 'Forbidden');

      await tick();
      const rpcDenials = h.denied.filter((d) => d.op === 'rpc');
      assert.strictEqual(rpcDenials.length, 1);
      assert.strictEqual(rpcDenials[0].from, 'bob');
      assert.strictEqual(rpcDenials[0].code, 'RPC_FORBIDDEN');
    } finally {
      await h.close();
    }
  });

  test('a structured verdict forwards code + error to the caller', async () => {
    const h = await withAclHub(20001, {
      canRpc: () => ({ ok: false, code: 'TENANT_MISMATCH', error: 'wrong tenant' }),
    }, { bobHandlers: { ping: () => 'pong' } });
    try {
      let caught;
      try { await h.alice.rpc('bob', 'ping', {}); } catch (e) { caught = e; }
      assert.ok(caught instanceof RpcRemoteError);
      assert.strictEqual(caught.code, 'TENANT_MISMATCH');
      assert.strictEqual(caught.message, 'wrong tenant');
    } finally {
      await h.close();
    }
  });

  test('gates to:"server" RPCs as well', async () => {
    const h = await withAclHub(20002, {
      canRpc: (ctx) => ctx.to !== 'server',
    });
    try {
      let caught;
      try { await h.alice.rpc('server', 'link.health', {}); } catch (e) { caught = e; }
      assert.ok(caught instanceof RpcRemoteError);
      assert.strictEqual(caught.code, 'RPC_FORBIDDEN');
    } finally {
      await h.close();
    }
  });

  test('an async callback is awaited', async () => {
    const h = await withAclHub(20003, {
      canRpc: async (ctx) => {
        await tick(10);
        return ctx.rpcData && ctx.rpcData.token === 'good';
      },
    }, { bobHandlers: { ping: () => 'pong' } });
    try {
      assert.strictEqual(await h.alice.rpc('bob', 'ping', { token: 'good' }), 'pong');
      await assert.rejects(h.alice.rpc('bob', 'ping', { token: 'bad' }), RpcRemoteError);
    } finally {
      await h.close();
    }
  });

  test('a throwing callback fails closed (denies)', async () => {
    const h = await withAclHub(20004, {
      canRpc: () => { throw new Error('acl backend down'); },
    }, { bobHandlers: { ping: () => 'pong' } });
    try {
      let caught;
      try { await h.alice.rpc('bob', 'ping', {}); } catch (e) { caught = e; }
      assert.ok(caught instanceof RpcRemoteError, 'a thrown ACL error must deny, not allow');
      assert.strictEqual(caught.code, 'RPC_FORBIDDEN');
    } finally {
      await h.close();
    }
  });

  test('a non-conforming return value fails closed (denies)', async () => {
    const h = await withAclHub(20005, {
      canRpc: () => undefined, // forgot to return a verdict
    }, { bobHandlers: { ping: () => 'pong' } });
    try {
      await assert.rejects(h.alice.rpc('bob', 'ping', {}), RpcRemoteError);
    } finally {
      await h.close();
    }
  });
});

describe('hub ACL: canPublish / canSubscribe / canSend', () => {
  test('canPublish denial drops the message and fires acl-denied', async () => {
    const h = await withAclHub(20006, {
      canPublish: (ctx) => ctx.topic.startsWith('public.'),
    });
    try {
      const got = [];
      h.bob.subscribe('public.ok',  (p) => got.push(['public.ok', p]));
      h.bob.subscribe('private.no', (p) => got.push(['private.no', p]));
      await tick();

      h.alice.publish('public.ok',  { n: 1 });
      h.alice.publish('private.no', { n: 2 });
      await tick(80);

      assert.deepStrictEqual(got, [['public.ok', { n: 1 }]],
        'only the allowed topic should have been delivered');

      const pubDenials = h.denied.filter((d) => d.op === 'publish');
      assert.strictEqual(pubDenials.length, 1);
      assert.strictEqual(pubDenials[0].topic, 'private.no');
    } finally {
      await h.close();
    }
  });

  test('canSubscribe denial means the subscription is never recorded', async () => {
    const h = await withAclHub(20007, {
      canSubscribe: (ctx) => ctx.topic !== 'secret',
    });
    try {
      const got = [];
      h.bob.subscribe('secret', (p) => got.push(p));
      await tick();

      h.alice.publish('secret', { leak: true });
      await tick(80);

      assert.strictEqual(got.length, 0, 'a denied subscription must not receive messages');
      const subDenials = h.denied.filter((d) => d.op === 'subscribe');
      assert.strictEqual(subDenials.length, 1);
      assert.strictEqual(subDenials[0].topic, 'secret');
    } finally {
      await h.close();
    }
  });

  test('canSend denial drops the directed message', async () => {
    const h = await withAclHub(20008, {
      canSend: (ctx) => ctx.type !== 'forbidden-type',
    });
    try {
      const got = [];
      h.bob.on('direct', (info) => got.push(info.type));
      await tick();

      h.alice.send('bob', 'allowed-type',   { ok: true });
      h.alice.send('bob', 'forbidden-type', { ok: false });
      await tick(80);

      assert.deepStrictEqual(got, ['allowed-type']);
      const sendDenials = h.denied.filter((d) => d.op === 'send');
      assert.strictEqual(sendDenials.length, 1);
      assert.strictEqual(sendDenials[0].type, 'forbidden-type');
      assert.strictEqual(sendDenials[0].to, 'bob');
    } finally {
      await h.close();
    }
  });
});

describe('hub ACL: construction', () => {
  test('a non-function ACL option throws TypeError at construction', () => {
    assert.throws(
      () => createHubServer({ secret: SECRET, port: 20009, logger: null, canRpc: true }),
      (e) => e instanceof TypeError && /canRpc/.test(e.message),
    );
  });

  test('a hub with no ACL options behaves exactly as before', async () => {
    const h = await withAclHub(20009, {}, { bobHandlers: { ping: () => 'pong' } });
    try {
      assert.strictEqual(await h.alice.rpc('bob', 'ping', {}), 'pong');
      assert.strictEqual(h.denied.length, 0);
    } finally {
      await h.close();
    }
  });
});