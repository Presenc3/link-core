'use strict';

/**
 * Logger factory.
 *
 *   const log = createLogger();
 *   log.l ('boot', 'starting up');
 *   log.lD('boot', 'verbose detail');
 *   log.lW('link', 'unexpected, but recoverable');
 *   log.lE('link', 'init failed', err);
 *
 * Output shape: `[HH:MM:SS.mmm] [context] message ...args`. All four
 * methods take `(context, message, ...args)`.
 *
 * Options:
 *   minLevel      Number (use LEVELS.*) or string ('DEBUG'|'INFO'|'WARN'|'ERROR').
 *                 Default: NODE_ENV='production' → INFO, else DEBUG.
 *   errorSink     (context, message, error) => void | Promise<void>
 *                 Called on every lE() with an Error instance. Useful for
 *                 mirroring errors to a Discord webhook, Sentry, etc.
 *                 The sink runs after console output. Sink failures are
 *                 logged via `console.error` and never propagate.
 *   timestamp     () => string  Optional override for the timestamp prefix.
 *                 Default: ISO time slice (HH:MM:SS.mmm).
 *
 * Returns: { l, lD, lW, lE, LEVELS, setMinLevel, setErrorSink, clearErrorSink }
 */

const LEVELS = Object.freeze({
  DEBUG: 0,
  INFO:  1,
  WARN:  2,
  ERROR: 3,
});

const NAME_TO_LEVEL = Object.freeze({
  debug: 0, info: 1, warn: 2, error: 3,
  DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3,
});

function defaultMinLevel() {
  return process.env.NODE_ENV === 'production' ? LEVELS.INFO : LEVELS.DEBUG;
}

function defaultTimestamp() {
  // ISO 'YYYY-MM-DDTHH:MM:SS.mmmZ' → slice(11, 23) → 'HH:MM:SS.mmm'
  return new Date().toISOString().slice(11, 23);
}

function resolveLevel(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const n = NAME_TO_LEVEL[value];
    if (typeof n === 'number') return n;
  }
  return fallback;
}

function createLogger(opts = {}) {
  let minLevel = resolveLevel(opts.minLevel, defaultMinLevel());
  let errorSink = typeof opts.errorSink === 'function' ? opts.errorSink : null;
  const timestamp = typeof opts.timestamp === 'function' ? opts.timestamp : defaultTimestamp;

  function emit(level, context, message, ...args) {
    if (level < minLevel) return;
    const prefix = `[${timestamp()}] [${context}]`;
    switch (level) {
      case LEVELS.DEBUG: console.debug(prefix, message, ...args); break;
      case LEVELS.INFO:  console.log  (prefix, message, ...args); break;
      case LEVELS.WARN:  console.warn (prefix, message, ...args); break;
      case LEVELS.ERROR: console.error(prefix, message, ...args); break;
    }
  }

  function l (ctx, msg, ...args) { emit(LEVELS.INFO,  ctx, msg, ...args); }
  function lD(ctx, msg, ...args) { emit(LEVELS.DEBUG, ctx, msg, ...args); }
  function lW(ctx, msg, ...args) { emit(LEVELS.WARN,  ctx, msg, ...args); }

  function lE(ctx, msg, ...args) {
    emit(LEVELS.ERROR, ctx, msg, ...args);

    if (!errorSink) return;

    const err = args.find((a) => a instanceof Error);
    if (!err) return;

    let result;
    try { result = errorSink(ctx, msg, err); }
    catch (sinkErr) {
      console.error('[link-core:log] errorSink threw:', sinkErr?.message || sinkErr);
      return;
    }

    if (result && typeof result.catch === 'function') {
      result.catch((sinkErr) => {
        console.error('[link-core:log] errorSink rejected:', sinkErr?.message || sinkErr);
      });
    }
  }

  return {
    LEVELS,
    l, lD, lW, lE,
    
    log:  l,
    warn: lW,

    setMinLevel(value) {
      minLevel = resolveLevel(value, minLevel);
    },

    setErrorSink(fn) {
      if (fn != null && typeof fn !== 'function'
       ) throw new TypeError('setErrorSink: fn must be a function or null');
      errorSink = fn || null;
    },

    clearErrorSink() { errorSink = null; },
  };
}

module.exports = { createLogger, LEVELS };