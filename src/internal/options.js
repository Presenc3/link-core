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

function _badType(name, value, requirement) {
  return new TypeError(
    `${name}: must be ${requirement} (got ${
      typeof value === 'number' ? value : `${typeof value} ${String(value)}`
    })`,
  );
}

/**
 * Must be a finite number > 0. Use for timers, intervals, and caps
 * that have no "disabled" semantics (a 0-ms timer fires immediately,
 * which is essentially never what you want).
 */
function positiveFinite(value, fallback, name) {
  if (value == null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw _badType(name, value, 'a positive finite number');
  }
  return value;
}

/**
 * Must be a finite number >= 0. Use for options where 0 is a documented
 * "disabled" sentinel (e.g. `replayWindowMs: 0` to disable replay
 * protection, `helloTimeoutMs: 0` to disable the pre-hello reaper).
 */
function nonNegFinite(value, fallback, name) {
  if (value == null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw _badType(name, value, 'a non-negative finite number');
  }
  return value;
}

/**
 * Must be a finite number in `[min, max]`. Use for normalized fractions
 * like `reconnectJitter: [0, 1]`.
 */
function inRange(value, fallback, min, max, name) {
  if (value == null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw _badType(name, value, `a finite number in [${min}, ${max}]`);
  }
  return value;
}

/**
 * Must be a finite number >= min. Use for `reconnectGrowth >= 1` (any
 * value < 1 means the backoff shrinks per attempt, which is never
 * intended).
 */
function atLeast(value, fallback, min, name) {
  if (value == null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) {
    throw _badType(name, value, `a finite number >= ${min}`);
  }
  return value;
}

module.exports = { positiveFinite, nonNegFinite, inRange, atLeast };