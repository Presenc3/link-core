'use strict';

/**
 * Subpath export tests.
 *   require('@presenc3/link-core/protocol')  - ws-free protocol helpers
 *   require('@presenc3/link-core/errors')    - ws-free typed errors
 *   require('@presenc3/link-core/client')    - just LinkClient
 *   require('@presenc3/link-core/hub')       - createHub + createHubServer
 *
 * Two things are verified: the modules expose the expected symbols (and,
 * for the curated subpaths, *only* those), and the `ws`-free subpaths
 * really do not pull `ws` into the module graph.
 */

const { test }    = require('node:test');
const assert      = require('node:assert');
const path        = require('node:path');
const { execFileSync } = require('node:child_process');

const SRC = path.join(__dirname, '..', '..', 'src');

const protocol   = require('../../src/protocol.js');
const primitives = require('../../src/primitives.js');
const errors   = require('../../src/errors.js');
const client   = require('../../src/client/index.js');
const hub      = require('../../src/hub/index.js');
const pkg      = require('../../package.json');

const EXPECTED_PROTOCOL = [
  'sign', 'verify', 'makeMsg',
  'isValidTopic', 'assertValidTopic', 'stableStringify', 'assertJsonSerializable',
  'PROTOCOL_VERSION', 'TOPIC_MAX_LENGTH', 'DEFAULT_HASH_ALGO',
];

const EXPECTED_PRIMITIVES = [
  'inRange', 'atLeast', 'nonNegInt', 'noopLogger', 'positiveInt',
  'applyOptions', 'nonNegFinite', 'consoleLogger', 'validHashAlgo',
  'settleOnEvents', 'positiveFinite', 'normalizeLogger',
  'positiveIntOrInfinity',
];

const EXPECTED_ERRORS = [
  'LinkError', 'RpcError', 'RpcAbortError', 'ProtocolError',
  'RpcRemoteError', 'RpcHandlerError', 'RpcTimeoutError',
  'BackpressureError', 'LinkNotReadyError', 'RpcDisconnectError',
  'HelloRejectedError', 'FeatureUnsupportedError',
];

test('./protocol exposes exactly the protocol surface', () => {
  for (const name of EXPECTED_PROTOCOL) {
    assert.notStrictEqual(protocol[name], undefined, `protocol.${name} missing`);
  }
  const extras = Object.keys(protocol).filter((k) => !EXPECTED_PROTOCOL.includes(k));
  assert.deepStrictEqual(extras, [], `unexpected ./protocol exports: ${extras.join(', ')}`);
});

test('./primitives exposes exactly the promoted primitive surface', () => {
  for (const name of EXPECTED_PRIMITIVES) {
    assert.notStrictEqual(primitives[name], undefined, `primitives.${name} missing`);
  }
  const extras = Object.keys(primitives).filter((k) => !EXPECTED_PRIMITIVES.includes(k));
  assert.deepStrictEqual(extras, [], `unexpected ./primitives exports: ${extras.join(', ')}`);
});

test('./errors exposes exactly the public error classes', () => {
  for (const name of EXPECTED_ERRORS) {
    assert.strictEqual(typeof errors[name], 'function', `errors.${name} missing`);
    assert.ok(errors[name].prototype instanceof Error, `errors.${name} should extend Error`);
  }
  const extras = Object.keys(errors).filter((k) => !EXPECTED_ERRORS.includes(k));
  assert.deepStrictEqual(extras, [], `unexpected ./errors exports: ${extras.join(', ')}`);
  assert.strictEqual(errors.rpcErrorResponse, undefined,
    'internal rpcErrorResponse must not be exported from ./errors');
});

test('./errors classes are identity-equal to the root exports', () => {
  const root = require('../../src/index.js');
  for (const name of EXPECTED_ERRORS) {
    assert.strictEqual(errors[name], root[name],
      `./errors ${name} should be the same reference as the root export`);
  }
});

test('./client exposes LinkClient', () => {
  assert.strictEqual(typeof client.LinkClient, 'function');
  assert.deepStrictEqual(Object.keys(client), ['LinkClient']);
});

test('./hub exposes createHub and createHubServer', () => {
  assert.strictEqual(typeof hub.createHub, 'function');
  assert.strictEqual(typeof hub.createHubServer, 'function');
  assert.deepStrictEqual(Object.keys(hub).sort(), ['createHub', 'createHubServer']);
});

test('package.json#exports declares all four subpaths', () => {
  for (const sub of ['./protocol', './errors', './client', './hub']) {
    const entry = pkg.exports[sub];
    assert.ok(entry, `exports map missing ${sub}`);
    for (const cond of ['types', 'import', 'require', 'default']) {
      assert.strictEqual(typeof entry[cond], 'string', `${sub} missing '${cond}' condition`);
    }
  }
});

/**
 * Run `node -e <probe>` and return whether `ws` was found in the child's
 * `require.cache`. A child process gives a pristine module graph.
 */
function loadsWs(probe) {
  const code =
    probe +
    ';process.stdout.write(String(Object.keys(require.cache)' +
    ".some(k => k.replace(/\\\\/g, '/').includes('/node_modules/ws/'))))";
  return execFileSync(process.execPath, ['-e', code], { encoding: 'utf8' }) === 'true';
}

test('./protocol does not pull ws into the module graph', () => {
  assert.strictEqual(
    loadsWs(`require(${JSON.stringify(path.join(SRC, 'protocol.js'))})`),
    false,
    './protocol must be importable without loading ws',
  );
});

test('./primitives does not pull ws into the module graph', () => {
  assert.strictEqual(
    loadsWs(`require(${JSON.stringify(path.join(SRC, 'primitives.js'))})`),
    false,
    './primitives must be importable without loading ws',
  );
});

test('./errors does not pull ws into the module graph', () => {
  assert.strictEqual(
    loadsWs(`require(${JSON.stringify(path.join(SRC, 'errors.js'))})`),
    false,
    './errors must be importable without loading ws',
  );
});

test('the root entry still loads ws (sanity check on the probe)', () => {
  assert.strictEqual(
    loadsWs(`require(${JSON.stringify(path.join(SRC, 'index.js'))})`),
    true,
    'the root entry loads the client/hub, so ws should be present',
  );
});