import { test } from 'node:test';
import assert from 'node:assert';

/**
 * Export smoke tests (ESM).
 *
 * Mirror of `./cjs.test.js` but exercises the ESM entry points:
 *
 *   import linkCore       from '@presenc3/link-core';
 *   import linkCoreHelpers from '@presenc3/link-core/helpers';
 *
 * Both the default export AND every named export must work, since the
 * package advertises both styles in its README.
 */

import linkCoreDefault, * as linkCoreNamed     from '../../src/index.mjs';
import helpersDefault,  * as helpersNamed      from '../../src/helpers/index.mjs';

const EXPECTED_ROOT_EXPORTS = [
  'LinkClient', 'createHub', 'createHubServer',
  'sign', 'verify', 'makeMsg',
  'isValidTopic', 'assertValidTopic', 'stableStringify',
  'PROTOCOL_VERSION', 'TOPIC_MAX_LENGTH', 'DEFAULT_HASH_ALGO',
  'LinkError', 'ProtocolError',
  'RpcError', 'RpcAbortError', 'RpcRemoteError',
  'RpcTimeoutError', 'RpcDisconnectError',
  'BackpressureError', 'LinkNotReadyError',
  'HelloRejectedError', 'FeatureUnsupportedError',
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

test('ESM root: default export exposes every expected symbol', () => {
  assert.ok(linkCoreDefault, 'default export should be present');
  for (const name of EXPECTED_ROOT_EXPORTS) {
    assert.notStrictEqual(
      linkCoreDefault[name], undefined,
      `default.${name} is undefined`,
    );
  }
});

test('ESM root: every expected symbol is a named export', () => {
  for (const name of EXPECTED_ROOT_EXPORTS) {
    assert.notStrictEqual(
      linkCoreNamed[name], undefined,
      `named export ${name} is undefined`,
    );
  }
});

test('ESM root: named and default exports point at the same references', () => {
  for (const name of EXPECTED_ROOT_EXPORTS) {
    assert.strictEqual(
      linkCoreNamed[name], linkCoreDefault[name],
      `named ${name} should be identity-equal to default.${name}`,
    );
  }
});

test('ESM helpers subpath: default export exposes every expected symbol', () => {
  assert.ok(helpersDefault, 'helpers default export should be present');
  for (const name of EXPECTED_HELPERS_EXPORTS) {
    assert.notStrictEqual(
      helpersDefault[name], undefined,
      `helpers default.${name} is undefined`,
    );
  }
});

test('ESM helpers subpath: every expected symbol is a named export', () => {
  for (const name of EXPECTED_HELPERS_EXPORTS) {
    assert.notStrictEqual(
      helpersNamed[name], undefined,
      `helpers named export ${name} is undefined`,
    );
  }
});

test('ESM helpers ≡ ESM root for shared symbols', () => {
  for (const name of EXPECTED_HELPERS_EXPORTS) {
    assert.strictEqual(
      helpersNamed[name], linkCoreNamed[name],
      `helpers named ${name} should be the same reference as root named ${name}`,
    );
  }
});