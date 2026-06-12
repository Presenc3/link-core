'use strict';

/**
 * Export smoke tests (CJS).
 * Locks in the public surface that ships in the npm tarball:
 *   require('@presenc3/link-core')   - root barrel (flat surface)
 *
 * Companion helpers moved to @presenc3/link-helpers and are no longer
 * exported here. The ESM-side mirror lives in `./esm.test.mjs`; the two
 * must stay in sync.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const root = require('../../src/index.js');

const EXPECTED_ROOT_EXPORTS = [
  // Classes / factories
  'createHub',
  'LinkClient',
  'createHubServer',

  // Protocol helpers
  'sign', 'verify', 'makeMsg',
  'isValidTopic', 'assertValidTopic', 'stableStringify', 'assertJsonSerializable',
  'PROTOCOL_VERSION', 'TOPIC_MAX_LENGTH', 'DEFAULT_HASH_ALGO',

  // Typed errors
  'LinkError', 'ProtocolError',
  'RpcError', 'RpcAbortError', 'RpcRemoteError', 'RpcHandlerError',
  'RpcTimeoutError', 'RpcDisconnectError',
  'BackpressureError', 'LinkNotReadyError',
  'HelloRejectedError', 'FeatureUnsupportedError',
];

test('CJS root: every expected symbol is exported', () => {
  for (const name of EXPECTED_ROOT_EXPORTS) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(root, name),
      `missing root export: ${name}`,
    );
    assert.notStrictEqual(root[name], undefined, `root.${name} is undefined`);
  }
});

test('CJS root: no unexpected symbols (catch accidental leaks)', () => {
  const actual = new Set(Object.keys(root));
  const expected = new Set(EXPECTED_ROOT_EXPORTS);
  const extras = [...actual].filter((k) => !expected.has(k));
  assert.deepStrictEqual(
    extras, [],
    `unexpected root exports - either add them to EXPECTED_ROOT_EXPORTS or stop exporting them: ${extras.join(', ')}`,
  );
});

test('CJS root: total export count matches the contract', () => {
  assert.strictEqual(
    Object.keys(root).length,
    EXPECTED_ROOT_EXPORTS.length,
    'root export count drifted - update the contract or the barrel',
  );
});

test('CJS root: helper symbols are NOT exported (moved to @presenc3/link-helpers)', () => {
  for (const gone of [
    'createLogger', 'loadSecrets', 'createGracefulShutdown',
    'attachClientObservability', 'createEventRecorder', 'linkClientOptionsFromEnv',
    'waitForPeer', 'rpcWithRetry', 'createSafePublisher',
  ]) {
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(root, gone), false,
      `root should no longer export helper '${gone}' (it lives in @presenc3/link-helpers)`,
    );
  }
});

test('classes are constructible / factories are callable', () => {
  assert.strictEqual(typeof root.LinkClient,       'function');
  assert.strictEqual(typeof root.createHub,        'function');
  assert.strictEqual(typeof root.createHubServer,  'function');
  assert.strictEqual(typeof root.makeMsg,          'function');

  for (const name of [
    'LinkError', 'ProtocolError',
    'RpcError', 'RpcAbortError', 'RpcRemoteError', 'RpcHandlerError',
    'RpcTimeoutError', 'RpcDisconnectError',
    'BackpressureError', 'LinkNotReadyError',
    'HelloRejectedError', 'FeatureUnsupportedError',
  ]) {
    assert.strictEqual(typeof root[name], 'function', `${name} should be a constructor`);
    assert.ok(
      root[name].prototype instanceof Error || root[name] === Error,
      `${name} should extend Error`,
    );
  }
});

test('protocol constants have plausible values', () => {
  assert.strictEqual(typeof root.PROTOCOL_VERSION, 'number');
  assert.ok(root.PROTOCOL_VERSION >= 1);
  assert.strictEqual(typeof root.TOPIC_MAX_LENGTH, 'number');
  assert.ok(root.TOPIC_MAX_LENGTH > 0);
  assert.strictEqual(typeof root.DEFAULT_HASH_ALGO, 'string');
});