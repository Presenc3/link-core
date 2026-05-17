'use strict';

const { nonNegFinite } = require('../internal/options.js');

/**
 * Process-level lifecycle helpers.
 *
 *   const log = createLogger();
 *
 *   const shutdown = createGracefulShutdown({
 *     logger: log,
 *     timeoutMs: 30_000,
 *     steps: [
 *       () => link.stop(),
 *       () => closeDBs(),
 *     ],
 *   });
 *
 *   installProcessHandlers({ shutdown, logger: log });
 *
 *   // ...
 *   await shutdown('manual'); // can be called directly too
 *
 * Kept separate from each other so the shutdown procedure can be
 * unit-tested without touching `process.on(...)`.
 */

function assertLogger(logger, fnName) {
  if (!logger
    || typeof logger.l  !== 'function'
    || typeof logger.lD !== 'function'
    || typeof logger.lE !== 'function'
   ) throw new TypeError(`${fnName}: logger with { l, lD, lE } is required`);
}

/**
 * Wire up SIGINT, SIGTERM, uncaughtException, unhandledRejection.
 * Call once during boot.
 *
 *   installProcessHandlers({
 *     shutdown,                  // (signal) => Promise<void> | void
 *     logger,                    // required
 *     context: 'process',        // log context prefix
 *     signals: ['SIGINT', 'SIGTERM'],
 *     exitOnUncaught: true,      // set false to keep limping
 *   });
 *
 * Returns an `uninstall()` function that removes everything it added,
 * useful for tests.
 */
function installProcessHandlers(opts = {}) {
  if (typeof opts.shutdown !== 'function'
   ) throw new TypeError('installProcessHandlers: shutdown function is required');

  assertLogger(opts.logger, 'installProcessHandlers');

  const { l, lD, lE } = opts.logger;
  const ctx     = opts.context || 'process';
  const signals = opts.signals || ['SIGINT', 'SIGTERM'];
  const exitOnUncaught = opts.exitOnUncaught !== false;

  const removers = [];

  for (const sig of signals) {
    const handler = () => {
      Promise.resolve()
        .then(() => opts.shutdown(sig))
        .catch((e) => lE(ctx, `shutdown(${sig}) threw`, e));
    };
    process.on(sig, handler);
    removers.push(() => { try { process.off(sig, handler); } catch {} });
  }

  const onRejection = (reason, promise) => {
    const err = reason instanceof Error
      ? reason
      : new Error(`non-Error rejection: ${String(reason)}`);

    lE(ctx, 'unhandled rejection', err);
    if (promise) lD(ctx, 'rejected promise:', promise);
  };
  process.on('unhandledRejection', onRejection);
  removers.push(() => { try { process.off('unhandledRejection', onRejection); } catch {} });

  const onUncaught = (err) => {
    lE(ctx, 'uncaught exception', err);
    if (exitOnUncaught) {
      setTimeout(() => process.exit(1), 50).unref?.();
    }
  };
  
  process.on('uncaughtException', onUncaught);
  removers.push(() => { try { process.off('uncaughtException', onUncaught); } catch {} });

  return function uninstall() {
    while (removers.length) {
      const r = removers.pop();
      try { r(); } catch {}
    }
  };
}

/**
 * Build a graceful-shutdown function that runs a sequence of steps,
 * bounded by a watchdog timer that force-exits if anything hangs.
 *
 *   const shutdown = createGracefulShutdown({
 *     logger,
 *     context: 'shutdown',
 *     timeoutMs: 30_000,
 *     exitCode: 0,
 *     steps: [
 *       () => link.stop(),                  // sync or async, return ignored
 *       async () => { await closeDBs(); },
 *       (signal) => log.l('done', signal),  // each step receives the signal arg
 *     ],
 *   });
 *
 *   await shutdown('SIGTERM');
 *
 * Behaviors:
 *   - Calling shutdown() while one is in progress is a no-op (logs
 *     a "shutdown already in progress" line at info).
 *   - Each step runs sequentially. A throwing step is logged via lE
 *     but does NOT stop subsequent steps from running.
 *   - When all steps complete, process.exit(exitCode) is called.
 *   - If steps don't finish within timeoutMs, process.exit(1) fires
 *     via the watchdog regardless of step state.
 *
 * Pass `exitProcess: false` if you want the function to settle without
 * calling process.exit (useful in tests).
 */
function createGracefulShutdown(opts = {}) {
  assertLogger(opts.logger, 'createGracefulShutdown');

  const { l, lE } = opts.logger;
  const ctx       = opts.context   || 'shutdown';
  const timeoutMs = nonNegFinite(opts.timeoutMs, 30_000, 'createGracefulShutdown: opts.timeoutMs');
  const exitCode  = opts.exitCode  ?? 0;
  const steps     = Array.isArray(opts.steps) ? opts.steps.slice() : [];
  const exitProcess = opts.exitProcess !== false;

  let inFlight = null;

  return async function shutdown(signal) {
    if (inFlight) {
      l(ctx, `shutdown already in progress (received ${signal || 'manual'})`);
      return inFlight;
    }

    inFlight = (async () => {
      l(ctx, `received ${signal || 'manual'}, shutting down gracefully`);

      let watchdog = null;
      if (timeoutMs > 0) {
        watchdog = setTimeout(() => {
          lE(ctx, `shutdown timed out after ${timeoutMs}ms, forcing exit`);
          if (exitProcess) process.exit(1);
        }, timeoutMs);
        watchdog.unref?.();
      }

      try {
        for (const step of steps) {
          try {
            const ret = step(signal);
            if (ret && typeof ret.then === 'function') await ret;
          } catch (e) {
            lE(ctx, 'shutdown step threw', e);
          }
        }
        if (watchdog) clearTimeout(watchdog);
        l(ctx, 'graceful shutdown complete');
        if (exitProcess) process.exit(exitCode);
      } catch (e) {
        if (watchdog) clearTimeout(watchdog);
        lE(ctx, 'shutdown error', e);
        if (exitProcess) process.exit(1);
      }
    })();

    return inFlight;
  };
}

module.exports = { installProcessHandlers, createGracefulShutdown };