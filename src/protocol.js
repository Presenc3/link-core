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
    to   = null,
    from = null,
    ts   = Date.now(),
    v    = PROTOCOL_VERSION
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

function stableStringify(value) {
  const seen = new WeakSet();

  function stringify(v) {
    if (v && typeof v.toJSON === 'function') v = v.toJSON();

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
        const s = stringify(v[i]);
        items.push(s === undefined ? 'null' : s);
      }

      const out = `[${items.join(',')}]`;

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
  if (typeof topic !== 'string') throw new TypeError(
    'Invalid topic: must be a string');

  if (topic.length === 0) throw new Error(
    'Invalid topic: must be non-empty');

  if (topic.length > TOPIC_MAX_LENGTH) throw new Error(
    `Invalid topic: exceeds ${TOPIC_MAX_LENGTH} characters`);

  if (!TOPIC_PATTERN.test(topic)) throw new Error(
    'Invalid topic: only [a-zA-Z0-9._-] permitted (wildcards reserved for a future minor)');
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