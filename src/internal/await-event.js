'use strict';

/**
 * Shared "resolve/reject on an EventEmitter event" primitive.
 *
 * Three call sites need the exact same listener + timeout + abort + settle-once
 * machinery: `LinkClient.waitFor()` (one resolving event), `LinkClient.ready()`
 * (a resolving `ready` plus a rejecting `rejected`), and the `waitForAnyEvent`
 * helper behind `waitForPeer` (several resolving events). Before this was
 * factored out, each maintained its own copy of the `settled` flag, the
 * `cleanup()` that detaches every listener, the abort wiring, and the
 * `timer.unref()` dance - three places a leak-on-edge-case could regress
 * independently.
 *
 * The only things that differ between the call sites are expressed as options:
 *
 *   - which events resolve (`resolveEvents`)
 *   - which events reject, and how their payload maps to an Error
 *     (`rejectEvents`)
 *   - the timeout / abort error each wants to surface
 *
 * On the first settle - whichever of a resolve event, reject event, timeout,
 * or abort fires first - every listener is removed, the timer is cleared, and
 * the abort listener is detached, so nothing leaks no matter which path wins.
 *
 * A resolving event's payload is unwrapped the same way the old call sites did
 * it: a single argument resolves as that argument, multiple arguments resolve
 * as the args array. `timeoutMs <= 0` means "no timeout" (the convention used
 * across `ready()` / `waitFor()` / `rpc()`).
 *
 * @param {import('events').EventEmitter} emitter
 * @param {object}   spec
 * @param {string[]} [spec.resolveEvents]   events that resolve with their payload
 * @param {Array<{ event: string, toError: (payload: *) => Error }>} [spec.rejectEvents]
 * @param {number}   [spec.timeoutMs]       0 = no timeout
 * @param {AbortSignal} [spec.signal]
 * @param {() => Error} spec.timeoutError   built lazily when the timeout fires
 * @param {() => Error} spec.abortError     built lazily when the signal aborts
 * @returns {Promise<*>}
 */
function settleOnEvents(emitter, {
  resolveEvents = [],
  rejectEvents  = [],
  timeoutMs     = 0,
  signal,
  timeoutError,
  abortError,
}) {
  const unwrap = (args) => (args.length <= 1 ? args[0] : args);

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer   = null;
    let onAbort = null;
    const listeners = [];

    /**
     * Build an error via a caller-supplied factory without letting a
     * throwing factory escape a timer/abort/event callback as an uncaught
     * exception - whatever it throws becomes the rejection instead.
     */
    const buildError = (factory, payload) => {
      try { return factory(payload); }
      catch (e) { return e instanceof Error ? e : new Error(String(e)); }
    };

    const cleanup = () => {
      settled = true;

      if (timer) clearTimeout(timer);

      for (const [ev, fn] of listeners) {
        try { emitter.off(ev, fn); } catch {}
      }

      if (signal && onAbort) {
        try { signal.removeEventListener('abort', onAbort); } catch {}
      }
    };

    for (const ev of resolveEvents) {
      const fn = (...args) => {
        if (settled) return;
        cleanup();
        resolve(unwrap(args));
      };
      emitter.on(ev, fn);
      listeners.push([ev, fn]);
    }

    for (const { event, toError } of rejectEvents) {
      const fn = (...args) => {
        if (settled) return;
        cleanup();
        reject(buildError(toError, unwrap(args)));
      };
      emitter.on(event, fn);
      listeners.push([event, fn]);
    }

    if (signal) {
      if (signal.aborted) {
        cleanup();
        reject(buildError(abortError));
        return;
      }
      onAbort = () => {
        if (settled) return;
        cleanup();
        reject(buildError(abortError));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) return;
        cleanup();
        reject(buildError(timeoutError));
      }, timeoutMs);
      timer.unref?.();
    }
  });
}

module.exports = { settleOnEvents };