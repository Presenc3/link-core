'use strict';

/**
 * Wire-safety: `send` / `publish` / `rpc` must reject a payload that
 * cannot be placed on the JSON wire *at the call site* - not later as a
 * delayed `outbox-error` or a confusing RPC timeout. And an RPC handler
 * that returns a non-serializable value must produce a structured
 * `RpcRemoteError` for the caller, not a bare timeout.
 *
 * Port range for this file: 19800.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { RpcRemoteError } = require('../../src/index.js');
const { setupHub, makeReadyClient, tick } = require('./_helpers.js');

const harness = setupHub({
  port: 19800,
  hubOpts: {
    rpcHandlers: {
      'server.bad.result': () => ({ big: 10n }),
    },
  },
});
const readyClient = makeReadyClient(harness);

describe('wire-safety: outbound payload validation', () => {
  test('send() rejects a BigInt payload synchronously', async () => {
    const a = await readyClient({ kind: 'ws-send-a' });
    try {
      assert.throws(
        () => a.send('ws-send-a', 'evt', { n: 1n }),
        (e) => e instanceof TypeError && /JSON-serializable/.test(e.message),
      );
    } finally { await a.stop(); }
  });

  test('publish() rejects a BigInt payload synchronously', async () => {
    const a = await readyClient({ kind: 'ws-pub-a' });
    try {
      assert.throws(
        () => a.publish('ws.topic', { n: 1n }),
        (e) => e instanceof TypeError && /JSON-serializable/.test(e.message),
      );
    } finally { await a.stop(); }
  });

  test('rpc() rejects a BigInt payload synchronously', async () => {
    const a = await readyClient({ kind: 'ws-rpc-a' });
    try {
      assert.throws(
        () => a.rpc('ws-rpc-a', 'echo', { n: 1n }),
        (e) => e instanceof TypeError && /JSON-serializable/.test(e.message),
      );
    } finally { await a.stop(); }
  });

  test('send() rejects a circular payload', async () => {
    const a = await readyClient({ kind: 'ws-circ-a' });
    try {
      const circular = { ok: true };
      circular.self = circular;
      assert.throws(
        () => a.send('ws-circ-a', 'evt', circular),
        (e) => e instanceof TypeError,
      );
    } finally { await a.stop(); }
  });

  test('send() rejects a non-cloneable payload (function)', async () => {
    const a = await readyClient({ kind: 'ws-fn-a' });
    try {
      assert.throws(
        () => a.send('ws-fn-a', 'evt', { fn: () => 1 }),
        (e) => e instanceof TypeError && /structured-cloneable/.test(e.message),
      );
    } finally { await a.stop(); }
  });

  test('a valid payload still sends and arrives', async () => {
    const a = await readyClient({ kind: 'ws-ok-a' });
    const b = await readyClient({ kind: 'ws-ok-b' });
    try {
      const got = new Promise((resolve) => b.once('direct', resolve));
      assert.strictEqual(a.send('ws-ok-b', 'evt', { hello: 'world', n: 7 }), true);
      const evt = await got;
      assert.strictEqual(evt.type, 'evt');
      assert.deepStrictEqual(evt.data, { hello: 'world', n: 7 });
    } finally { await a.stop(); await b.stop(); }
  });
});

describe('wire-safety: RPC handler result validation', () => {
  test('peer RPC handler returning a BigInt yields a structured RpcRemoteError', async () => {
    const caller = await readyClient({ kind: 'ws-res-caller' });
    const target = await readyClient({ kind: 'ws-res-target' });
    target.handle('bad.result', () => ({ value: 99n }));
    try {
      await tick();
      await assert.rejects(
        caller.rpc('ws-res-target', 'bad.result', {}, { timeoutMs: 2_000 }),
        (e) => e instanceof RpcRemoteError && e.code === 'RPC_RESULT_NOT_SERIALIZABLE',
      );
    } finally { await caller.stop(); await target.stop(); }
  });

  test('hub-handled RPC returning a BigInt yields a structured RpcRemoteError', async () => {
    const caller = await readyClient({ kind: 'ws-res-server-caller' });
    try {
      await assert.rejects(
        caller.rpc('server', 'server.bad.result', {}, { timeoutMs: 2_000 }),
        (e) => e instanceof RpcRemoteError && e.code === 'RPC_RESULT_NOT_SERIALIZABLE',
      );
    } finally { await caller.stop(); }
  });
});