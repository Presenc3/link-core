'use strict';

/**
 * The logger contract used throughout link-core.
 *
 * A logger is an object with four methods - `debug`, `info`, `warn`,
 * `error` - each called as `(context, message, ...args)`. `context` is a
 * short tag (e.g. `'link-core:client'`); the rest is free-form.
 */

const noopLogger = Object.freeze({
  debug: () => {},
  info:  () => {},
  warn:  () => {},
  error: () => {},
});

const consoleLogger = Object.freeze({
  debug: (ctx, ...args) => console.debug(`[${ctx}]`, ...args),
  info:  (ctx, ...args) => console.log  (`[${ctx}]`, ...args),
  warn:  (ctx, ...args) => console.warn (`[${ctx}]`, ...args),
  error: (ctx, ...args) => console.error(`[${ctx}]`, ...args),
});

const RESOLVE = {
  debug: ['debug', 'lD', 'log', 'l', 'info'],
  info:  ['info',  'l',  'log'],
  warn:  ['warn',  'lW'],
  error: ['error', 'lE', 'warn', 'lW'],
};

/**
 * Adapt any caller-supplied logger to the canonical
 * `{ debug, info, warn, error }` contract.
 *
 * Accepted inputs:
 *   - a canonical `{ debug, info, warn, error }` logger
 *   - a `console`-like object
 *   - the minimal `{ log, warn }` shape
 *   - the legacy `{ l, lD, lW, lE }` shape (pre-v0.6 `createLogger`)
 *   - `null`      -> a silent (no-op) logger
 *   - `undefined` -> the default `consoleLogger`
 *
 * Levels with no matching method fall back sensibly (e.g. `debug` -> `info`
 * -> `log`, `error` -> `warn`). Calls are dispatched through the original
 * object, so `this`-bound methods keep working.
 *
 * @param {*} logger
 * @returns {{ debug: Function, info: Function, warn: Function, error: Function }}
 */
function normalizeLogger(logger) {
  if (logger === null)      return noopLogger;
  if (logger === undefined) return consoleLogger;
  if (typeof logger !== 'object' && typeof logger !== 'function') {
    return consoleLogger;
  }

  const resolve = (names) => {
    for (const name of names) {
      if (typeof logger[name] === 'function') {
        return (...args) => logger[name](...args);
      }
    }
    return () => {};
  };

  return {
    debug: resolve(RESOLVE.debug),
    info:  resolve(RESOLVE.info),
    warn:  resolve(RESOLVE.warn),
    error: resolve(RESOLVE.error),
  };
}

module.exports = { noopLogger, consoleLogger, normalizeLogger };