'use strict';

const {
  KIND_PATTERN,
  HELLO_KIND_MAX,
  HELLO_NAME_MAX
} = require('./constants.js');

/**
 * Reserved kinds that pass `KIND_PATTERN` but must not be accepted as
 * a peer's authenticated kind:
 *
 *   - `__proto__`, `constructor`, `prototype` - used as plain-object
 *     keys in snapshot builders elsewhere in the hub. Allowing a peer
 *     to authenticate as one of these is a local prototype-pollution
 *     foothold (snapshot drops the peer + mutates a prototype chain).
 *     The downstream builders are also defensive (null-prototype maps),
 *     but the cheap check here makes the failure loud at hello time
 *     instead of silently odd later.
 *
 *   - `server` - `dispatch.js` intercepts `to === 'server'` for
 *     hub-handled RPCs. A peer registering as `server` could not
 *     receive RPCs (the hub would shadow it), so reject at hello time
 *     and surface the misconfiguration immediately.
 */
const RESERVED_KINDS = new Set([
  '__proto__',
  'constructor',
  'prototype',
  'server',
]);

function sanitizeHello(data) {
  const rawKind   = String(data?.kind ?? '').trim();
  const tooShort  = rawKind.length === 0;
  const badChars  = !KIND_PATTERN.test(rawKind);
  const tooLong   = rawKind.length > HELLO_KIND_MAX;
  const reserved  = RESERVED_KINDS.has(rawKind);
  const kind      = (tooShort || tooLong || badChars || reserved) ? '' : rawKind;
  const name      = String(data?.name ?? '').trim().slice(0, HELLO_NAME_MAX);
  const pid       = Number.isFinite(data?.pid)       ? data.pid       : null;
  const startedAt = Number.isFinite(data?.startedAt) ? data.startedAt : null;

  return { kind, name, pid, startedAt };
}

module.exports = { sanitizeHello, RESERVED_KINDS };