'use strict';

/**
 * Shared inbound-envelope validation for the client and the hub.
 *
 * Both ends run the exact same gauntlet on every frame off the wire -
 * size cap, JSON parse, non-empty id, HMAC signature, protocol version,
 * replay-window skew, and per-peer recent-id dedupe - and before v0.6.x
 * the two copies lived in `client/inbound.js` and `hub/dispatch.js`,
 * ~150 near-identical lines that could (and did) drift apart one fix at
 * a time. This is the same de-duplication move as `Outbox` and
 * `settleOnEvents`: one correctness-bearing implementation, parameterised
 * at the handful of points the two call sites genuinely differ.
 *
 * Why *two* validation functions, not one
 * ---------------------------------------
 * The only step that truly diverges is key resolution, and it resists a
 * single wrapper: the client already holds its key (`this.secret`, sync),
 * while the hub must `await resolveSecret(kind)` and owns the whole
 * pre-auth `hello` bootstrap (sanitise, reserved-kind reject, unknown-kind
 * reject). Folding that into one shared function would make the client's
 * synchronous verify path async for no reason. So the seam is left open
 * between two pure, synchronous helpers: `parseEnvelope` (steps 1-3) runs,
 * the caller resolves its key, then `verifyEnvelope` (steps 4-7) runs. The
 * hub's async `hello` handling sits in that gap, on the one side that
 * needs it.
 *
 * The verdicts
 * -----------
 *   parseEnvelope  -> { ok: true, msg } | { ok: false, reason, ...ctx }
 *   verifyEnvelope -> { ok: true }      | { ok: false, reason, ...ctx }
 *
 * `rejectInbound` then maps a failing verdict to a uniform drop log + a
 * `protocol-error` emit. Both sides share it; the small genuine
 * differences are passed in as `env`: the hub stamps a `kind`, the client
 * carries the "before any verified message" secret-mismatch hint and the
 * skew-counter bookkeeping its hello-ack diagnostic reads.
 */

const { verify, PROTOCOL_VERSION } = require('../protocol.js');

/**
 * Hard cap on an inbound envelope id. Library-generated ids are 36-char
 * UUIDs; 256 leaves generous room for hand-rolled clients with their own
 * id schemes. Without a cap, a peer could send e.g. rpc.requests whose
 * megabyte-scale ids must be echoed verbatim into the rpc.response - and
 * each queued response then retained that id while the outbox's byte
 * accounting (which estimates per-field now, but estimates nonetheless)
 * stayed honest only because this bound exists.
 */
const MAX_ID_LENGTH = 256;

/**
 * Steps 1-3: size cap, JSON parse, non-empty bounded string id. Pure; safe
 * to call before any key is known (the hub parses *before* it can resolve
 * a key, since the kind it needs lives inside `msg.data`).
 */
function parseEnvelope(raw, maxMessageBytes) {
  if (raw.length > maxMessageBytes) {
    return { ok: false, reason: 'oversize', size: raw.length };
  }

  let msg;
  try { msg = JSON.parse(String(raw)); }
  catch (error) { return { ok: false, reason: 'parse-error', error }; }

  if (typeof msg?.id !== 'string' || msg.id.length === 0) {
    return { ok: false, reason: 'missing-id', msg };
  }

  if (msg.id.length > MAX_ID_LENGTH) {
    return { ok: false, reason: 'oversized-id', msg, idLength: msg.id.length };
  }

  return { ok: true, msg };
}

/**
 * Steps 4-7: signature, protocol version, replay-window skew, per-peer
 * recent-id dedupe. Runs after the caller has resolved `key` for this
 * message. On a clean pass the id is recorded in `recentIds` - that
 * recording *is* the dedupe, so it lives here. `senderKind` is a thunk so
 * it is only computed when replay protection is actually engaged.
 */
function verifyEnvelope(msg, key, { hashAlgo, replayWindowMs, recentIds, senderKind }) {
  if (!verify(key, msg, hashAlgo)) {
    return { ok: false, reason: 'bad-signature' };
  }

  if (msg.v !== PROTOCOL_VERSION) {
    return { ok: false, reason: 'bad-version' };
  }

  if (replayWindowMs > 0) {
    const skew = Math.abs(Date.now() - (typeof msg.ts === 'number' ? msg.ts : 0));
    if (skew > replayWindowMs) {
      return { ok: false, reason: 'replay-window', skew };
    }
  }

  if (recentIds && msg.type !== 'rpc.response') {
    const sk = senderKind();

    if (recentIds.has(sk, msg.id)) {
      return { ok: false, reason: 'replay-id', senderKind: sk };
    }

    recentIds.add(sk, msg.id);
  }

  return { ok: true };
}

/**
 * Map a failing verdict to a drop log + a `protocol-error` emit, shared by
 * both sides. `env`:
 *
 *   - `log`, `tag`            leveled logger + log tag
 *   - `emit(payload)`         the side's `protocol-error` emitter
 *   - `kind`                  optional sender kind to stamp (hub only)
 *   - `firstContact`          true on the client before any message has
 *                             verified, to surface the secret/hashAlgo
 *                             mismatch hint on a bad signature
 *   - `onReplayWindow(skew)`  optional hook for a replay-window drop
 *                             (the client's skew-counter bookkeeping)
 */
function rejectInbound(r, { log, tag, emit, kind, firstContact = false, onReplayWindow } = {}) {
  const type = r.msg?.type;

  switch (r.reason) {
    case 'oversize':
      log.warn(tag, `dropped: message too large (${r.size} bytes)`);
      break;
    case 'parse-error':
      log.warn(tag, `dropped: parse error`);
      break;
    case 'missing-id':
      log.warn(tag, `dropped: missing or empty id (type=${type})`);
      break;
    case 'oversized-id':
      log.warn(tag, `dropped: id exceeds 256 characters (${r.idLength}, type=${type})`);
      break;
    case 'bad-signature':
      log.warn(tag, firstContact
        ? `dropped: bad signature before any verified message - likely a shared-secret or hashAlgo mismatch (type=${type})`
        : `dropped: bad signature (type=${type})`);
      break;
    case 'bad-version':
      log.warn(tag, `dropped: unsupported protocol version v=${r.msg?.v} (expected ${PROTOCOL_VERSION}, type=${type})`);
      break;
    case 'replay-window':
      onReplayWindow?.(r.skew);
      log.warn(tag, `dropped: timestamp out of replay window (skew=${r.skew}ms, type=${type})`);
      break;
    case 'replay-id':
      log.warn(tag, `dropped: replay of id ${String(r.msg?.id).slice(0, 8)} (type=${type})`);
      break;
  }

  const payload = { reason: r.reason };
  if (kind !== undefined)    payload.kind  = kind;
  if (type !== undefined)    payload.type  = type;
  if (r.msg !== undefined)   payload.msg   = r.msg;
  if (r.size !== undefined)  payload.size  = r.size;
  if (r.error !== undefined) payload.error = r.error;
  if (r.skew !== undefined)  payload.skew  = r.skew;

  emit(payload);
}

module.exports = { parseEnvelope, verifyEnvelope, rejectInbound, MAX_ID_LENGTH };