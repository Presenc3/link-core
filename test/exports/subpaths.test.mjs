import { test } from 'node:test';
import assert from 'node:assert';

/**
 * ESM mirror of `./subpaths.test.js`: confirms the `.mjs` wrappers that
 * back the `import` condition of each subpath expose both named and
 * default bindings, and that they point at the same references as the
 * CJS modules.
 */

import protoDefault, * as protoNamed   from '../../src/protocol.mjs';
import errorsDefault, * as errorsNamed from '../../src/errors.mjs';
import clientDefault, * as clientNamed from '../../src/client/index.mjs';
import hubDefault,    * as hubNamed    from '../../src/hub/index.mjs';
import primDefault,   * as primNamed   from '../../src/primitives.mjs';

import cjsProtocol from '../../src/protocol.js';
import cjsErrors   from '../../src/errors.js';
import cjsPrimitives from '../../src/primitives.js';

test('./protocol .mjs: named + default bindings present', () => {
  for (const name of ['sign', 'verify', 'makeMsg', 'PROTOCOL_VERSION']) {
    assert.notStrictEqual(protoNamed[name], undefined, `named ${name} missing`);
    assert.notStrictEqual(protoDefault[name], undefined, `default.${name} missing`);
  }
  assert.strictEqual(protoNamed.makeMsg, cjsProtocol.makeMsg,
    'ESM and CJS protocol must share the same makeMsg reference');
});

test('./errors .mjs: named + default bindings present and CJS-identical', () => {
  for (const name of ['RpcTimeoutError', 'RpcRemoteError', 'LinkError']) {
    assert.strictEqual(typeof errorsNamed[name], 'function', `named ${name} missing`);
    assert.strictEqual(errorsNamed[name], cjsErrors[name],
      `ESM ${name} should be the same class as the CJS export`);
  }
  assert.strictEqual(errorsDefault.RpcAbortError, cjsErrors.RpcAbortError);
});

test('./primitives .mjs: named + default bindings present and CJS-identical', () => {
  for (const name of ['normalizeLogger', 'settleOnEvents', 'applyOptions', 'validHashAlgo']) {
    assert.strictEqual(typeof primNamed[name], 'function', `named ${name} missing`);
    assert.strictEqual(primNamed[name], cjsPrimitives[name],
      `ESM ${name} should be the same reference as the CJS export`);
  }
  assert.strictEqual(primDefault.normalizeLogger, cjsPrimitives.normalizeLogger);
});

test('./client .mjs: LinkClient exported as named + default', () => {
  assert.strictEqual(typeof clientNamed.LinkClient, 'function');
  assert.strictEqual(clientNamed.LinkClient, clientDefault.LinkClient);
});

test('./hub .mjs: createHub + createHubServer exported as named + default', () => {
  assert.strictEqual(typeof hubNamed.createHub, 'function');
  assert.strictEqual(typeof hubNamed.createHubServer, 'function');
  assert.strictEqual(hubNamed.createHub, hubDefault.createHub);
  assert.strictEqual(hubNamed.createHubServer, hubDefault.createHubServer);
});