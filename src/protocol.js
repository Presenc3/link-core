'use strict';

const crypto = require('crypto');

function stableStringify(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(',')}]`;
  const keys = Object.keys(obj).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function sign(secret, msg) {
  const clone = { ...msg };
  delete clone.sig;
  const payload = stableStringify(clone);
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function verify(secret, msg) {
  if (!msg || typeof msg !== 'object') return false;
  if (!msg.sig) return false;
  try {
    const expected = sign(secret, msg);
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(String(msg.sig), 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function makeMsg(secret, { v = 1, id, ts = Date.now(), type, from = null, to = null, data }) {
  const msg = JSON.parse(JSON.stringify({ v, id, ts, type, from, to, data }));
  msg.sig = sign(secret, msg);
  return msg;
}

module.exports = { makeMsg, verify, sign, stableStringify };