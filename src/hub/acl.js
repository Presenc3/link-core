'use strict';

const { TAG } = require('./constants.js');

/**
 * Optional per-operation authorization gate for the hub.
 *
 * `createHub` / `createHubServer` accept four optional callbacks -
 * `canRpc`, `canPublish`, `canSubscribe`, `canSend` - that run at the
 * hub's existing dispatch choke-points, *after* a message has been
 * verified and the sender's `from` identity established, but *before*
 * the hub acts on it (forwards an RPC, fans out a topic message, records
 * a subscription, forwards a directed message).
 *
 * Each callback is invoked with an operation-specific context object and
 * may be sync or async. The return value decides the outcome:
 *
 *   - `true`                       -> allow
 *   - `false`                      -> deny (generic forbidden)
 *   - `{ ok: true }`               -> allow
 *   - `{ ok: false, code, error }` -> deny; `code` / `error` are
 *                                     surfaced to the caller (for RPC)
 *                                     and on the `'acl-denied'` event
 *
 * Anything else - `undefined`, `null`, a thrown error - is treated as a
 * denial. An authorization gate must fail *closed*: a buggy callback
 * that forgets to return must not silently authorize traffic. A warning
 * is logged so the misbehaving callback is easy to spot.
 *
 * When a callback is not supplied, the corresponding `check*` is `null`
 * and the dispatcher skips the check entirely - the gate adds zero
 * overhead to a hub that does not use ACLs.
 *
 * Note on payload references: the `rpcData` / `payload` / `data` carried in
 * a callback's context is the *same* object the hub then forwards to the
 * target (the hub does not snapshot it for the check). Treat these as
 * read-only - mutating them mutates what is delivered downstream. This is
 * deliberate (no clone cost on the gated path), but it means an ACL
 * callback that edits ctx data doubles as an unintended transform. Keep
 * authorization callbacks pure; do any redaction explicitly elsewhere.
 */

/** Shared frozen "allowed" verdict - avoids an allocation per allow. */
const ALLOW = Object.freeze({ allowed: true });

/**
 * Coerce a callback's return value into a normalized verdict, failing
 * closed on anything that is not an explicit allow.
 *
 * @param {*} result the raw callback return value
 * @param {string} defaultCode code used when a denial supplies none
 * @param {object} log normalized logger
 * @param {string} op callback name, for diagnostics
 * @returns {{ allowed: true } | { allowed: false, code: string, error: string }}
 */
function normalizeAclResult(result, defaultCode, log, op) {
  if (result === true) return ALLOW;

  if (result && typeof result === 'object') {
    if (result.ok === true) return ALLOW;
    if (result.ok === false) {
      return {
        allowed: false,
        code:  (typeof result.code  === 'string' && result.code)  ? result.code  : defaultCode,
        error: (typeof result.error === 'string' && result.error) ? result.error : 'Forbidden',
      };
    }
  }

  if (result === false) {
    return { allowed: false, code: defaultCode, error: 'Forbidden' };
  }

  log.warn(TAG,
    `${op}: callback returned a non-conforming value ` +
    `(${typeof result}) - denying. Return true/false or { ok, code, error }.`);
    
  return { allowed: false, code: defaultCode, error: 'Forbidden' };
}

/**
 * Validate that an ACL option is a function or absent. Called by
 * `createHub` so a typo (`canRpc: true`) fails at construction with a
 * clear message rather than silently disabling the gate.
 *
 * @param {*} cb
 * @param {string} name
 */
function assertAclOption(cb, name) {
  if (cb != null && typeof cb !== 'function') {
    throw new TypeError(
      `createHub({ ${name} }): must be a function (got ${typeof cb})`);
  }
}

/**
 * Build the four-check gate from the supplied callbacks.
 *
 * @param {object} callbacks
 * @param {Function} [callbacks.canRpc]
 * @param {Function} [callbacks.canPublish]
 * @param {Function} [callbacks.canSubscribe]
 * @param {Function} [callbacks.canSend]
 * @param {object} log normalized logger
 * @returns {{
 *   checkRpc:       null | ((ctx: object) => Promise<object>),
 *   checkPublish:   null | ((ctx: object) => Promise<object>),
 *   checkSubscribe: null | ((ctx: object) => Promise<object>),
 *   checkSend:      null | ((ctx: object) => Promise<object>),
 * }}
 */
function makeAclGate(callbacks, log) {
  const { canRpc, canPublish, canSubscribe, canSend } = callbacks || {};

  const wrap = (cb, defaultCode, op) => {
    if (typeof cb !== 'function') return null;

    return async (ctx) => {
      let result;
      try {
        result = await cb(ctx);
      } catch (e) {
        log.error(TAG, `${op}: callback threw - denying:`, e?.message || e);
        return { allowed: false, code: defaultCode, error: 'Forbidden' };
      }
      return normalizeAclResult(result, defaultCode, log, op);
    };
  };

  const checkRpc       = wrap(canRpc,       'RPC_FORBIDDEN',       'canRpc');
  const checkPublish   = wrap(canPublish,   'PUBLISH_FORBIDDEN',   'canPublish');
  const checkSubscribe = wrap(canSubscribe, 'SUBSCRIBE_FORBIDDEN', 'canSubscribe');
  const checkSend      = wrap(canSend,      'SEND_FORBIDDEN',      'canSend');

  return {
    checkRpc,
    checkPublish,
    checkSubscribe,
    checkSend,
  };
}

module.exports = { makeAclGate, assertAclOption };