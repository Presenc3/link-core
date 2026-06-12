import { test } from 'node:test';
import assert from 'node:assert';

/**
 * Export smoke tests (ESM).
 * Mirror of `./cjs.test.js` but exercises the ESM entry point:
 *   import linkCore from '@presenc3/link-core';
 *
 * Companion helpers moved to @presenc3/link-helpers and are no longer
 * exported here.
 */

import linkCoreDefault, * as linkCoreNamed from '../../src/index.mjs';

const EXPECTED_ROOT_EXPORTS = [
  'LinkClient', 'createHub', 'createHubServer',
  'sign', 'verify', 'makeMsg',
  'isValidTopic', 'assertValidTopic', 'stableStringify', 'assertJsonSerializable',
  'PROTOCOL_VERSION', 'TOPIC_MAX_LENGTH', 'DEFAULT_HASH_ALGO',
  'LinkError', 'ProtocolError',
  'RpcError', 'RpcAbortError', 'RpcRemoteError', 'RpcHandlerError',
  'RpcTimeoutError', 'RpcDisconnectError',
  'BackpressureError', 'LinkNotReadyError',
  'HelloRejectedError', 'FeatureUnsupportedError',
];

const GONE_HELPER_EXPORTS = [
  'createLogger', 'loadSecrets', 'createGracefulShutdown',
  'attachClientObservability', 'createEventRecorder', 'linkClientOptionsFromEnv',
  'waitForPeer', 'rpcWithRetry', 'createSafePublisher',
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

test('ESM root: helper symbols are NOT exported (moved to @presenc3/link-helpers)', () => {
  for (const gone of GONE_HELPER_EXPORTS) {
    assert.strictEqual(linkCoreNamed[gone], undefined,
      `named export ${gone} should be gone (moved to @presenc3/link-helpers)`);
    assert.strictEqual(linkCoreDefault[gone], undefined,
      `default.${gone} should be gone (moved to @presenc3/link-helpers)`);
  }
});