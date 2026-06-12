'use strict';

/**
 * Regression: RPC dispatch must only ever reach explicitly registered *own*
 * handlers. Inherited Object.prototype members ('constructor', 'toString',
 * 'valueOf', ...) previously resolved through plain-object handler maps and
 * were invoked as if they were handlers - e.g. rpcType 'constructor' returned
 * a bogus success instead of RPC_UNKNOWN_TYPE, on both the peer-handled path
 * and the hub's `to: 'server'` path. Both maps are now null-prototype.
 *
 * Dedicated hub on port 19260 so this file runs in parallel with the rest.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { RpcRemoteError } = require('../../src/index.js');
const { setupHub, makeReadyClient } = require('./_helpers.js');

const PORT = 19260;

const harness     = setupHub({ port: PORT });
const readyClient = makeReadyClient(harness);

const INHERITED = [
  'constructor',
  'toString',
  'hasOwnProperty',
  'valueOf',
  '__defineGetter__',
  '__proto__',
  'prototype',
];

describe('rpc prototype-name safety', () => {
  test('peer handler path: inherited names > RPC_UNKNOWN_TYPE', async () => {
    const caller = await readyClient({ kind: 'pn-caller' });
    const worker = await readyClient({ kind: 'pn-worker', rpcHandlers: {} });

    for (const name of INHERITED) {
      let caught;
      try { await caller.rpc('pn-worker', name, { a: 1 }, 1500); }
      catch (e) { caught = e; }

      assert.ok(caught instanceof RpcRemoteError, `${name}: expected RpcRemoteError, got ${caught}`);
      assert.strictEqual(caught.code, 'RPC_UNKNOWN_TYPE', `${name}: wrong code (${caught.code})`);
    }

    caller.stop(); worker.stop();
  });

  test('hub server path: inherited names > RPC_UNKNOWN_TYPE', async () => {
    const caller = await readyClient({ kind: 'pn-caller-s' });

    for (const name of INHERITED) {
      let caught;
      try { await caller.rpc('server', name, { a: 1 }, 1500); }
      catch (e) { caught = e; }

      assert.ok(caught instanceof RpcRemoteError, `${name}: expected RpcRemoteError, got ${caught}`);
      assert.strictEqual(caught.code, 'RPC_UNKNOWN_TYPE', `${name}: wrong code (${caught.code})`);
    }

    caller.stop();
  });

  test('an explicit OWN handler named "constructor" still works (Option A)', async () => {
    const caller = await readyClient({ kind: 'pn-caller-2' });
    const worker = await readyClient({ kind: 'pn-worker-2', rpcHandlers: {
      constructor: (data) => ({ handled: true, echo: data }),
    } });

    const r = await caller.rpc('pn-worker-2', 'constructor', { x: 9 }, 1500);
    assert.deepStrictEqual(r, { handled: true, echo: { x: 9 } });

    caller.stop(); worker.stop();
  });
});