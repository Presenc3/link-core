'use strict';

const { test } = require('node:test');
const assert   = require('node:assert');

const {
  sign, verify, makeMsg, stableStringify,
  isValidTopic, assertValidTopic,
  PROTOCOL_VERSION, TOPIC_MAX_LENGTH, DEFAULT_HASH_ALGO,
} = require('../../src/index.js');

const SECRET = 'shared-test-secret';

test('PROTOCOL_VERSION is 1', () => {
  assert.strictEqual(PROTOCOL_VERSION, 1);
});

test('TOPIC_MAX_LENGTH is 256', () => {
  assert.strictEqual(TOPIC_MAX_LENGTH, 256);
});

test('DEFAULT_HASH_ALGO is sha256', () => {
  assert.strictEqual(DEFAULT_HASH_ALGO, 'sha256');
});

test('stableStringify sorts object keys', () => {
  assert.strictEqual(stableStringify({ b: 2, a: 1 }), '{"a":1,"b":2}');
  assert.strictEqual(
    stableStringify({ z: { y: 1, x: 2 }, a: [3, 1, 2] }),
    '{"a":[3,1,2],"z":{"x":2,"y":1}}',
  );
});

test('stableStringify handles primitives and null', () => {
  assert.strictEqual(stableStringify(null),   'null');
  assert.strictEqual(stableStringify(42),     '42');
  assert.strictEqual(stableStringify('hi'),   '"hi"');
  assert.strictEqual(stableStringify(true),   'true');
  assert.strictEqual(stableStringify([1, 2]), '[1,2]');
});

test('stableStringify treats sparse-array holes as null (matches JSON.stringify)', () => {
  const arr = [1, , 3];

  assert.strictEqual(stableStringify(arr), '[1,null,3]');
  assert.strictEqual(stableStringify(arr), JSON.stringify(arr));

  const allHoles = new Array(3);
  assert.strictEqual(stableStringify(allHoles), '[null,null,null]');
  assert.strictEqual(stableStringify(allHoles), JSON.stringify(allHoles));
});

test('signature stable across the JSON round-trip for sparse arrays', () => {
  const original = makeMsg(SECRET, { id: 'a', type: 't', data: { arr: [1, , 3] } });
  const onWire = JSON.parse(JSON.stringify(original));
  assert.strictEqual(verify(SECRET, onWire), true);
});

test('sign + verify roundtrips on a valid envelope', () => {
  const msg = makeMsg(SECRET, { id: 'a', type: 't', data: { x: 1 } });
  assert.strictEqual(verify(SECRET, msg), true);
});

test('verify rejects on a wrong secret', () => {
  const msg = makeMsg(SECRET, { id: 'a', type: 't', data: { x: 1 } });
  assert.strictEqual(verify('different-secret', msg), false);
});

test('verify rejects on tampered field', () => {
  const msg = makeMsg(SECRET, { id: 'a', type: 't', data: { x: 1 } });
  const tampered = { ...msg, type: 'evil' };
  assert.strictEqual(verify(SECRET, tampered), false);
});

test('verify rejects on tampered nested data', () => {
  const msg = makeMsg(SECRET, { id: 'a', type: 't', data: { x: 1 } });
  const tampered = { ...msg, data: { x: 2 } };
  assert.strictEqual(verify(SECRET, tampered), false);
});

test('verify rejects on missing sig', () => {
  const msg = makeMsg(SECRET, { id: 'a', type: 't', data: { x: 1 } });
  delete msg.sig;
  assert.strictEqual(verify(SECRET, msg), false);
});

test('verify rejects on null/undefined/non-object input', () => {
  assert.strictEqual(verify(SECRET, null),      false);
  assert.strictEqual(verify(SECRET, undefined), false);
  assert.strictEqual(verify(SECRET, 'string'),  false);
  assert.strictEqual(verify(SECRET, 42),        false);
});

test('verify rejects sig of wrong length without throwing', () => {
  const msg = makeMsg(SECRET, { id: 'a', type: 't', data: { x: 1 } });
  msg.sig = 'beef';
  assert.strictEqual(verify(SECRET, msg), false);
});

test('verify with non-hex sig fails gracefully', () => {
  const msg = makeMsg(SECRET, { id: 'a', type: 't', data: { x: 1 } });
  msg.sig = 'not-hex-at-all';
  assert.strictEqual(verify(SECRET, msg), false);
});

test('signatures are stable across object key order', () => {
  const a = makeMsg(SECRET, { id: 'a', ts: 1, type: 't', data: { x: 1, y: 2 } });
  const b = makeMsg(SECRET, { id: 'a', ts: 1, type: 't', data: { y: 2, x: 1 } });
  assert.strictEqual(a.sig, b.sig);
});

test('alternative hash algorithm works end-to-end', () => {
  const msg = makeMsg(SECRET, { id: 'a', type: 't', data: { x: 1 } }, 'sha512');
  assert.strictEqual(verify(SECRET, msg, 'sha512'), true);
  assert.strictEqual(verify(SECRET, msg), false);
});

test('makeMsg deep-clones data so caller can mutate after', () => {
  const obj = { a: 1, nested: { b: 2 } };
  const msg = makeMsg(SECRET, { id: 'a', type: 't', data: obj });
  obj.a        = 999;
  obj.nested.b = 999;
  assert.strictEqual(msg.data.a, 1);
  assert.strictEqual(msg.data.nested.b, 2);
});

test('makeMsg fills sensible defaults', () => {
  const before = Date.now();
  const msg = makeMsg(SECRET, { id: 'a', type: 't', data: {} });
  const after = Date.now();
  assert.strictEqual(msg.v, PROTOCOL_VERSION);
  assert.strictEqual(msg.from, null);
  assert.strictEqual(msg.to,   null);
  assert.ok(msg.ts >= before && msg.ts <= after);
});

test('makeMsg throws on JSON-incompatible data (BigInt)', () => {
  assert.throws(
    () => makeMsg(SECRET, { id: 'a', type: 't', data: { v: 1n } }),
    /BigInt/,
  );
});

test('isValidTopic accepts ordinary names', () => {
  assert.strictEqual(isValidTopic('events.user.signup'), true);
  assert.strictEqual(isValidTopic('a'),                  true);
  assert.strictEqual(isValidTopic('a-b'),                true);
  assert.strictEqual(isValidTopic('a_b'),                true);
});

test('isValidTopic rejects empty, oversized, wildcards, slashes', () => {
  assert.strictEqual(isValidTopic(''),                          false);
  assert.strictEqual(isValidTopic('x'.repeat(TOPIC_MAX_LENGTH + 1)), false);
  assert.strictEqual(isValidTopic('a*b'),                       false);
  assert.strictEqual(isValidTopic('a**'),                       false);
  assert.strictEqual(isValidTopic('a/b'),                       false);
  assert.strictEqual(isValidTopic('a b'),                       false);
  assert.strictEqual(isValidTopic('a$b'),                       false);
});

test('isValidTopic rejects non-strings', () => {
  assert.strictEqual(isValidTopic(undefined), false);
  assert.strictEqual(isValidTopic(null),      false);
  assert.strictEqual(isValidTopic(42),        false);
  assert.strictEqual(isValidTopic({}),        false);
});

test('assertValidTopic throws TypeError on non-string', () => {
  assert.throws(() => assertValidTopic(42), TypeError);
});

test('assertValidTopic throws Error with descriptive message on bad pattern', () => {
  assert.throws(() => assertValidTopic('a*b'), /Invalid topic/);
  assert.throws(() => assertValidTopic(''),    /non-empty/);
  assert.throws(() => assertValidTopic('x'.repeat(TOPIC_MAX_LENGTH + 1)),
    new RegExp(`exceeds ${TOPIC_MAX_LENGTH}`));
});