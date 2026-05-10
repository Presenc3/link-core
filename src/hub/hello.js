'use strict';

const { HELLO_KIND_MAX, HELLO_NAME_MAX, KIND_PATTERN } = require('./constants.js');

function sanitizeHello(data) {
  const rawKind  = String(data?.kind ?? '').trim();
  const tooShort = rawKind.length === 0;
  const tooLong  = rawKind.length > HELLO_KIND_MAX;
  const badChars = !KIND_PATTERN.test(rawKind);
  const kind     = (tooShort || tooLong || badChars) ? '' : rawKind;

  const name      = String(data?.name ?? '').trim().slice(0, HELLO_NAME_MAX);
  const pid       = Number.isFinite(data?.pid)       ? data.pid       : null;
  const startedAt = Number.isFinite(data?.startedAt) ? data.startedAt : null;

  return { kind, name, pid, startedAt };
}

module.exports = { sanitizeHello };