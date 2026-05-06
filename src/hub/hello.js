'use strict';

const { HELLO_KIND_MAX, HELLO_NAME_MAX } = require('./constants.js');

/**
 * Sanitize and clamp the `hello` envelope's `data` payload to the bounded
 * shape the hub accepts. Returns a frozen-by-convention `{ kind, name, pid,
 * startedAt }` snapshot. An empty `kind` (or one exceeding HELLO_KIND_MAX)
 * means the hello is rejected upstream.
 */
function sanitizeHello(data) {
  const rawKind = String(data?.kind ?? '').trim();
  const kind    = rawKind.length === 0 || rawKind.length > HELLO_KIND_MAX ? '' : rawKind;

  const name      = String(data?.name ?? '').trim().slice(0, HELLO_NAME_MAX);
  const pid       = Number.isFinite(data?.pid)       ? data.pid       : null;
  const startedAt = Number.isFinite(data?.startedAt) ? data.startedAt : null;

  return { kind, name, pid, startedAt };
}

module.exports = { sanitizeHello };