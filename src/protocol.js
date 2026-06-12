'use strict';
const crypto = require('crypto');

const PROTOCOL_VERSION  = 1;
const TOPIC_MAX_LENGTH  = 256;
const DEFAULT_HASH_ALGO = 'sha256';
const TOPIC_PATTERN     = /^[a-zA-Z0-9._-]+$/;

function sign(secret, msg, algo = DEFAULT_HASH_ALGO) {
  const clone = { ...msg };
  delete clone.sig;
  
  const payload = stableStringify(clone);
  return crypto.createHmac(algo, secret).update(payload).digest('hex');
}

function verify(secret, msg, algo = DEFAULT_HASH_ALGO) {
  if (!msg || typeof msg !== 'object') return false;
  if (!msg.sig) return false;

  try {
    const expected = sign(secret, msg, algo);

    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(String(msg.sig), 'hex');

    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function makeMsg(secret, parts, algo = DEFAULT_HASH_ALGO) {
  const {
    id,
    type,
    data,
    to    = null,
    from  = null,
    ts    = Date.now(),
    v     = PROTOCOL_VERSION,
    clone = true
  } = parts;

  const msg = { v, id, ts, type, from, to, data: clone ? structuredClone(data) : data };
  msg.sig = sign(secret, msg, algo);

  return msg;
}

function isValidTopic(topic) {
  return typeof topic === 'string'
    && topic.length > 0
    && topic.length <= TOPIC_MAX_LENGTH
    && TOPIC_PATTERN.test(topic);
}

/**
 * Reduce `v` to the value `JSON.stringify` would actually serialize at
 * property key `key`, following ECMA-262 SerializeJSONProperty exactly:
 *
 *   1. if `v` is an object (or callable) with a callable `toJSON`, replace
 *      it with `v.toJSON(key)` - native JSON passes the *property key*
 *      (`''` for the root, the object key, or the array index as a
 *      string), and a key-sensitive `toJSON` produces different output
 *      for different keys;
 *   2. unwrap boxed primitives (`new Number(1)`, `new String('x')`,
 *      `new Boolean(true)`, `Object(1n)`) to their primitive value, the
 *      way native JSON does *after* the `toJSON` step.
 *
 * Skipping either step made the canonical signing serialization diverge
 * from what `JSON.stringify` put on the wire: the receiver re-canonicalizes
 * the JSON-round-tripped value, so any divergence here is a guaranteed
 * `bad-signature` (or, for a boxed BigInt, a message dropped at send time).
 * The invariant this function protects:
 *
 *   stableStringify(x) === stableStringify(JSON.parse(JSON.stringify(x)))
 *
 * for every `x` that `JSON.stringify` accepts.
 */
function toJsonValue(v, key) {
  const t = typeof v;

  if (v !== null && (t === 'object' || t === 'function')
   && typeof v.toJSON === 'function') {
    v = v.toJSON(key);
  }

  if (v !== null && typeof v === 'object') {
    if (v instanceof Number)  return Number(v);
    if (v instanceof String)  return String(v);
    if (v instanceof Boolean) return v.valueOf();
    if (v instanceof BigInt)  return v.valueOf();
  }

  return v;
}

function stableStringify(value) {
  const seen = new WeakSet();

  function stringify(v, key) {
    v = toJsonValue(v, key);

    if (v === undefined
     || typeof v === 'function' || typeof v === 'symbol'
    ) return undefined;

    if (v === null || typeof v !== 'object') {
      const out = JSON.stringify(v);

      if (out === undefined) throw new TypeError(
        'Value is not JSON-serializable');

      return out;
    }

    if (seen.has(v)) throw new TypeError(
      'Converting circular structure to JSON');

    seen.add(v);

    if (Array.isArray(v)) {
      const items = [];

      for (let i = 0; i < v.length; i++) {
        const s = stringify(v[i], String(i));
        items.push(s === undefined ? 'null' : s);
      }

      const out = `[${items.join(',')}]`;

      seen.delete(v);
      return out;
    }

    const keys = Object.keys(v).sort();
    const parts = [];

    for (const key of keys) {
      const s = stringify(v[key], key);
      if (s !== undefined) parts.push(`${JSON.stringify(key)}:${s}`);
    }

    seen.delete(v);
    return `{${parts.join(',')}}`;
  }

  const out = stringify(value, '');
  return out === undefined ? undefined : out;
}

function assertValidTopic(topic) {
  if (typeof topic !== 'string') throw new TypeError(
    'Invalid topic: must be a string');

  if (topic.length === 0) throw new Error(
    'Invalid topic: must be non-empty');

  if (topic.length > TOPIC_MAX_LENGTH) throw new Error(
    `Invalid topic: exceeds ${TOPIC_MAX_LENGTH} characters`);

  if (!TOPIC_PATTERN.test(topic)) throw new Error(
    'Invalid topic: only [a-zA-Z0-9._-] permitted (wildcards reserved for a future minor)');
}

/**
 * Throw a `TypeError` if `value` cannot be placed on the JSON wire *with
 * its meaning intact*.
 *
 * `structuredClone` is *not* a sufficient check on its own, and neither is
 * "does `JSON.stringify` throw": a whole family of values survives both
 * probes but arrives corrupted on the other side. This walks the value the
 * way JSON will serialize it and rejects:
 *
 *   - `BigInt` (JSON.stringify throws at send time)
 *   - circular structures (likewise)
 *   - non-finite numbers - `NaN`, `Infinity`, `-Infinity` serialize to
 *     `null`, silently destroying the value
 *   - `Map`, `Set`, `RegExp`, `Error`, `Promise` - serialize to `{}`,
 *     silently destroying their contents
 *   - `ArrayBuffer`, typed arrays, `DataView` - serialize to `{}` or an
 *     index-keyed object blob; send binary as base64 or a plain array
 *
 * An object with a `toJSON` method is validated through its `toJSON(key)`
 * output, exactly as `JSON.stringify` will use it (native JSON passes the
 * property key) - so a `Date` passes (it serializes to a meaningful ISO
 * string). Boxed primitives (`new Number(1)`, `new String('x')`,
 * `new Boolean(true)`) are validated as their unwrapped primitive, which
 * is what JSON transmits; a boxed `BigInt` or `new Number(NaN)` is
 * therefore rejected like its primitive form would be.
 *
 * `undefined`, functions, and symbols are *not* rejected: JSON omits them
 * from objects (and nulls them in arrays), which is the long-standing
 * JSON convention for optional fields and is harmless on the wire.
 *
 * @param {*} value
 * @param {string} [label] prefix for the thrown message
 */
function assertJsonSerializable(value, label = 'value') {
  const seen = new Set();

  const fail = (path, what) => {
    throw new TypeError(
      `${label} is not JSON-serializable: ${what} at ${path || '(root)'} ` +
      `would be silently corrupted on the wire`);
  };

  const walk = (v, path, key) => {
    v = toJsonValue(v, key);

    const t = typeof v;

    if (t === 'bigint') {
      throw new TypeError(
        `${label} is not JSON-serializable: BigInt at ${path || '(root)'} ` +
        `(JSON.stringify throws on BigInt)`);
    }

    if (t === 'number' && !Number.isFinite(v)) {
      fail(path, `non-finite number (${v} serializes to null)`);
    }

    if (v === null || t !== 'object') return;

    if (v instanceof Map)     fail(path, 'Map (serializes to {})');
    if (v instanceof Set)     fail(path, 'Set (serializes to {})');
    if (v instanceof RegExp)  fail(path, 'RegExp (serializes to {})');
    if (v instanceof Error)   fail(path, 'Error (serializes to {})');
    if (v instanceof Promise) fail(path, 'Promise (serializes to {})');
    if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) {
      fail(path, `${v.constructor?.name || 'binary buffer'} (binary does not survive JSON; use base64 or a plain array)`);
    }

    if (seen.has(v)) {
      throw new TypeError(
        `${label} is not JSON-serializable: circular structure at ${path || '(root)'}`);
    }
    seen.add(v);

    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) walk(v[i], `${path}[${i}]`, String(i));
    } else {
      for (const k of Object.keys(v)) walk(v[k], path ? `${path}.${k}` : k, k);
    }

    seen.delete(v);
  }

  walk(value, '', '');
}

module.exports = {
  sign,
  verify,
  makeMsg,
  isValidTopic,
  stableStringify,
  assertValidTopic,
  PROTOCOL_VERSION,
  TOPIC_MAX_LENGTH,
  DEFAULT_HASH_ALGO,
  assertJsonSerializable
};