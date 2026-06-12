'use strict';

/**
 * Small validation helpers for constructor options. Centralized here so
 * `LinkClient`, `createHub`, and `createHubServer` all reject invalid
 * numeric inputs the same way - with a clear TypeError pointing at the
 * offending option name - instead of silently letting `NaN`, `Infinity`,
 * or negatives propagate into `setTimeout`/`setInterval` (where they
 * behave like 0 and produce confusing immediate-fire bugs).
 *
 * All helpers accept `undefined`/`null` as "not provided" and return
 * the fallback. They throw on anything supplied but invalid.
 */

const crypto = require('crypto');

function _badType(name, value, requirement) {
  return new TypeError(
    `${name}: must be ${requirement} (got ${
      typeof value === 'number' ? value : `${typeof value} ${String(value)}`
    })`);
}

/**
 * Must be a finite number in `[min, max]`. Use for normalized fractions
 * like `reconnectJitter: [0, 1]`.
 */
function inRange(value, fallback, min, max, name) {
  if (value == null) return fallback;

  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max
     ) throw _badType(name, value, `a finite number in [${min}, ${max}]`);

  return value;
}

/**
 * Must be a finite number >= min. Use for `reconnectGrowth >= 1` (any
 * value < 1 means the backoff shrinks per attempt, which is never
 * intended).
 */
function atLeast(value, fallback, min, name) {
  if (value == null) return fallback;

  if (typeof value !== 'number' || !Number.isFinite(value) || value < min
     ) throw _badType(name, value, `a finite number >= ${min}`);

  return value;
}

/**
 * Must be a non-negative integer. Use for things measured in whole units
 * where 0 is a meaningful value (e.g. `maxListeners`, where 0 means
 * "unlimited" per Node's EventEmitter convention).
 */
function nonNegInt(value, fallback, name) {
  if (value == null) return fallback;

  if (!Number.isInteger(value) || value < 0
    ) throw _badType(name, value, 'a non-negative integer');

  return value;
}

/**
 * Must be a positive integer (>= 1). Use for count- and byte-style caps
 * where a fractional value is meaningless - `maxRecentIds: 1024.5` or
 * `maxOutboxBytes: 1.5e6 + 0.5` would have "worked" under `positiveFinite`
 * but describes nothing real. Stricter than `positiveFinite`; rejects the
 * same `NaN`/`Infinity`/`<= 0` inputs *and* any non-integer.
 */
function positiveInt(value, fallback, name) {
  if (value == null) return fallback;

  if (!Number.isInteger(value) || value < 1
     ) throw _badType(name, value, 'a positive integer');

  return value;
}

/**
 * Must be a finite number >= 0. Use for options where 0 is a documented
 * "disabled" sentinel (e.g. `replayWindowMs: 0` to disable replay
 * protection, `helloTimeoutMs: 0` to disable the pre-hello reaper).
 */
function nonNegFinite(value, fallback, name) {
  if (value == null) return fallback;

  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0
     ) throw _badType(name, value, 'a non-negative finite number');

  return value;
}

/**
 * Must be a hash algorithm name that is both (a) a canonical digest this
 * Node build lists in `crypto.getHashes()` and (b) actually usable to drive
 * an HMAC. Use for the `hashAlgo` option: a typo (`'sha-256'`, `'SHA256'`)
 * otherwise fails silently much later - every `verify()` returns false and
 * the symptom is an unexplained "nothing connects". Validating at
 * construction turns that into a clear boot-time error.
 *
 * Both checks are needed because neither alone is sufficient:
 *
 *   - `getHashes()` membership rejects typos/aliases (`'sha-256'` and
 *     `'SHA256'` are not in the list, though OpenSSL would resolve them),
 *     but it also lists extendable-output functions like `shake128` /
 *     `shake256` that *throw* inside `createHmac` (an XOF has no fixed
 *     digest length). Gating on the list alone would let those through
 *     construction and then throw on the first `makeMsg()`.
 *
 *   - the `createHmac` probe rejects the XOFs, but on its own it would
 *     *accept* aliases like `'sha-256'`, weakening the typo guard.
 *
 * Requiring both keeps the strict canonical-name contract while also
 * refusing any listed-but-not-HMAC-usable digest, on this build, up front.
 */
function validHashAlgo(value, fallback, name) {
  if (value == null) return fallback;

  if (typeof value !== 'string' || value.length === 0
     ) throw _badType(name, value, 'a non-empty hash algorithm name');

  if (!crypto.getHashes().includes(value)) throw new TypeError(
    `${name}: unsupported hash algorithm ${JSON.stringify(value)} - ` +
    `not in crypto.getHashes() for this Node build`,
  );

  try {
    crypto.createHmac(value, 'probe').update('probe').digest();
  } catch {
    throw new TypeError(
      `${name}: hash algorithm ${JSON.stringify(value)} is listed by ` +
      `crypto.getHashes() but is not usable with HMAC on this Node build ` +
      `(extendable-output functions like shake128/shake256 cannot key an HMAC)`,
    );
  }

  return value;
}

/**
 * Must be a finite number > 0. Use for timers, intervals, and caps
 * that have no "disabled" semantics (a 0-ms timer fires immediately,
 * which is essentially never what you want).
 */
function positiveFinite(value, fallback, name) {
  if (value == null) return fallback;

  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0
     ) throw _badType(name, value, 'a positive finite number');

  return value;
}

/**
 * Must be either a positive integer or `Infinity`. Use for count-style caps
 * that have an explicit "unbounded" mode (e.g. `maxReconnectAttempts`, where
 * `Infinity` means "reconnect forever").
 */
function positiveIntOrInfinity(value, fallback, name) {
  if (value ==  null)     return fallback;
  if (value === Infinity) return Infinity;

  if (!Number.isInteger(value) || value < 1
     ) throw _badType(name, value, 'a positive integer or Infinity');

  return value;
}

/**
 * Validate that every value in a constructor-supplied RPC handler map is a
 * function. The runtime mutators (`handle()` / `unhandle()`) enforce this
 * per call; the constructor map must hold the same contract, or a typo
 * only surfaces when the first matching `rpc.request` arrives.
 *
 * @param {*} map the caller-supplied `rpcHandlers` (may be null/undefined)
 * @param {string} label call-site prefix for the thrown message
 */
function assertRpcHandlerMap(map, label) {
  if (map == null) return;

  if (typeof map !== 'object' || Array.isArray(map)) {
    throw new TypeError(`${label}: must be an object mapping rpcType -> handler function`);
  }

  for (const [rpcType, fn] of Object.entries(map)) {
    if (typeof fn !== 'function') {
      throw new TypeError(
        `${label}: handler for ${JSON.stringify(rpcType)} must be a function (got ${typeof fn})`);
    }
  }
}

/**
 * Validate a table of numeric options and assign each onto `target`.
 *
 * Drives the per-option validators above from a declarative spec instead
 * of two hand-maintained columns (validate-the-local, then copy-to-`this`)
 * in every constructor - which is where an option could be validated but
 * silently never assigned. Each spec entry is
 * `{ name, validate, def, args? }`; `args` threads any extra parameters a
 * validator takes *before* its trailing `name` (e.g. `inRange`'s
 * `[min, max]`, `atLeast`'s `[min]`), matching the `(value, fallback,
 * ...extra, name)` shape every validator here shares.
 *
 * @param {object} target the instance to assign onto (usually `this`)
 * @param {object} raw    the caller-supplied options object
 * @param {Array<{ name: string, validate: Function, def: *, args?: any[] }>} spec
 */
function applyOptions(target, raw, spec) {
  for (const { name, validate, def, args = [] } of spec) {
    target[name] = validate(raw[name], def, ...args, name);
  }
}

module.exports = {
  inRange,
  atLeast,
  nonNegInt,
  applyOptions,
  positiveInt,
  nonNegFinite,
  validHashAlgo,
  positiveFinite,
  assertRpcHandlerMap,
  positiveIntOrInfinity
};