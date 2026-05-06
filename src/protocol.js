'use strict';
const crypto = require('crypto');

const PROTOCOL_VERSION  = 1;
const TOPIC_MAX_LENGTH  = 256;
const DEFAULT_HASH_ALGO = 'sha256';
const TOPIC_PATTERN     = /^[a-zA-Z0-9._\-]+$/;

/**
 * Compute the hex HMAC of `msg` (excluding `msg.sig`). Internally calls
 * `stableStringify` to produce a deterministic byte sequence regardless of
 * key order - so the leaves of `msg` (anywhere inside `data`) must be
 * `JSON.stringify`-able. `BigInt`, circular references, and other
 * JSON-incompatible values throw.
 */
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

/**
 * Build a fully-formed signed envelope. `id` is the only field with no
 * default - supply a fresh value per message (UUIDs are recommended; the
 * recent-id replay cache assumes uniqueness within `replayWindowMs`). `v`
 * defaults to `PROTOCOL_VERSION`, `ts` to `Date.now()`, `from`/`to` to
 * `null`. `data` is deep-cloned via `structuredClone` so the caller may
 * freely mutate the input afterward.
 *
 * `data` (and the rest of the envelope) must satisfy two layered
 * constraints: every value must be `structuredClone`-compatible (so the
 * clone succeeds), AND every value must be `JSON.stringify`-able once
 * cloned (so signing succeeds). `BigInt` for example clones fine but
 * throws on stringify; functions throw on clone.
 */
function makeMsg(secret, parts, algo = DEFAULT_HASH_ALGO) {
  const {
    v = PROTOCOL_VERSION,
    id, ts = Date.now(), type,
    from = null, to = null, data,
  } = parts;
  const msg = { v, id, ts, type, from, to, data: structuredClone(data) };
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
 * Canonical JSON serialization for HMAC signing. Matches `JSON.stringify`
 * semantics on the wire (drops `undefined`/function/symbol values, calls
 * `toJSON()` if present so `Date` becomes its ISO string, throws on cycles)
 * but additionally sorts object keys recursively so that two
 * semantically-equal envelopes produce the same bytes regardless of property
 * insertion order.
 *
 * Critical: the receiver runs `JSON.parse(raw)` then signs again with this
 * function, so this function MUST agree with `JSON.stringify` on what gets
 * included or stripped - otherwise the same envelope produces two different
 * signatures across the wire.
 */
function stableStringify(value) {
  const seen = new WeakSet();

  function stringify(v) {
    if (v && typeof v.toJSON === 'function') v = v.toJSON();

    if (v === undefined
     || typeof v === 'function'
     || typeof v === 'symbol'
    ) return undefined;

    if (v === null || typeof v !== 'object') {
      const out = JSON.stringify(v);
      if (out === undefined) throw new TypeError('Value is not JSON-serializable');
      return out;
    }

    if (seen.has(v)) throw new TypeError('Converting circular structure to JSON');
    seen.add(v);

    if (Array.isArray(v)) {
      const out = `[${v.map((item) => {
        const s = stringify(item);
        return s === undefined ? 'null' : s;
      }).join(',')}]`;

      seen.delete(v);
      return out;
    }

    const keys = Object.keys(v).sort();
    const parts = [];

    for (const key of keys) {
      const s = stringify(v[key]);
      if (s !== undefined) parts.push(`${JSON.stringify(key)}:${s}`);
    }

    seen.delete(v);
    return `{${parts.join(',')}}`;
  }

  const out = stringify(value);
  return out === undefined ? undefined : out;
}

function assertValidTopic(topic) {
  if (typeof topic !== 'string'
   ) throw new TypeError('Invalid topic: must be a string');
  if (topic.length === 0
   ) throw new Error('Invalid topic: must be non-empty');
  if (topic.length > TOPIC_MAX_LENGTH
   ) throw new Error(`Invalid topic: exceeds ${TOPIC_MAX_LENGTH} characters`);
  if (!TOPIC_PATTERN.test(topic)
   ) throw new Error('Invalid topic: only [a-zA-Z0-9._-] permitted (wildcards reserved for v0.5+)');
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
};