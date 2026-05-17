'use strict';

/**
 * Export smoke tests (CJS).
 *
 * Locks in the public surface that ships in the npm tarball:
 *
 *   require('@presenc3/link-core')           - root barrel (flat surface)
 *   require('@presenc3/link-core/helpers')   - helpers subpath
 *
 * If you add a new public symbol, add it here. If a test fails because a
 * name is missing, you probably forgot to re-export it from one of the
 * barrels (`src/index.js`, `src/helpers/index.js`) or its ESM mirror.
 *
 * The ESM-side mirror lives in `./esm.test.mjs`; the two must stay in sync.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const root    = require('../../src/index.js');
const helpers = require('../../src/helpers/index.js');

const EXPECTED_ROOT_EXPORTS = [
  // Classes / factories
  'createHub',
  'LinkClient',
  'createHubServer',

  // Protocol helpers
  'sign', 'verify', 'makeMsg',
  'isValidTopic', 'assertValidTopic', 'stableStringify',
  'PROTOCOL_VERSION', 'TOPIC_MAX_LENGTH', 'DEFAULT_HASH_ALGO',

  // Typed errors
  'LinkError', 'ProtocolError',
  'RpcError', 'RpcAbortError', 'RpcRemoteError',
  'RpcTimeoutError', 'RpcDisconnectError',
  'BackpressureError', 'LinkNotReadyError',
  'HelloRejectedError', 'FeatureUnsupportedError',

  // Helpers - flat at root
  'createLogger', 'LEVELS',
  'num', 'bool', 'requireEnv', 'linkClientOptionsFromEnv',
  'waitForPeer', 'rpcWithRetry', 'createSafeSend', 'createSafePublisher',
  'installProcessHandlers', 'createGracefulShutdown',
  'attachClientObservability', 'attachHubObservability',
  'DEFAULT_CLIENT_CONCERNING_REASONS', 'DEFAULT_HUB_CONCERNING_REASONS',
  'loadSecrets', 'LOADED_SECRETS_UNWATCH',
  'createEventRecorder', 'RECORDED_CLIENT_EVENTS', 'SNAPSHOT_TRIGGERS',
];

const EXPECTED_HELPERS_EXPORTS = [
  'createLogger', 'LEVELS',
  'num', 'bool', 'requireEnv', 'linkClientOptionsFromEnv',
  'waitForPeer', 'rpcWithRetry', 'createSafeSend', 'createSafePublisher',
  'installProcessHandlers', 'createGracefulShutdown',
  'attachClientObservability', 'attachHubObservability',
  'DEFAULT_CLIENT_CONCERNING_REASONS', 'DEFAULT_HUB_CONCERNING_REASONS',
  'loadSecrets', 'LOADED_SECRETS_UNWATCH',
  'createEventRecorder', 'RECORDED_CLIENT_EVENTS', 'SNAPSHOT_TRIGGERS',
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

test('CJS helpers subpath: every expected symbol is exported', () => {
  for (const name of EXPECTED_HELPERS_EXPORTS) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(helpers, name),
      `missing helpers export: ${name}`,
    );
    assert.notStrictEqual(helpers[name], undefined, `helpers.${name} is undefined`);
  }
});

test('CJS helpers subpath: no unexpected symbols', () => {
  const actual = new Set(Object.keys(helpers));
  const expected = new Set(EXPECTED_HELPERS_EXPORTS);
  const extras = [...actual].filter((k) => !expected.has(k));
  assert.deepStrictEqual(extras, [], `unexpected helpers exports: ${extras.join(', ')}`);
});

test('helpers symbols are identity-equal to their root counterparts', () => {
  for (const name of EXPECTED_HELPERS_EXPORTS) {
    assert.strictEqual(
      helpers[name], root[name],
      `helpers.${name} and root.${name} should be the same reference`,
    );
  }
});

test('classes are constructible / factories are callable', () => {
  assert.strictEqual(typeof root.LinkClient,       'function');
  assert.strictEqual(typeof root.createHub,        'function');
  assert.strictEqual(typeof root.createHubServer,  'function');
  assert.strictEqual(typeof root.createLogger,     'function');
  assert.strictEqual(typeof root.makeMsg,          'function');

  for (const name of [
    'LinkError', 'ProtocolError',
    'RpcError', 'RpcAbortError', 'RpcRemoteError',
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