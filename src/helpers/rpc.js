'use strict';

/**
 * RPC + topic helpers built on top of LinkClient.
 *
 *   await waitForPeer(link, 'vault', { timeoutMs: 30_000 });
 *   const result = await rpcWithRetry(link, 'worker', 'job.run', payload);
 *   const publish = createSafePublisher(link, { logger });
 *   publish('topic.name', { ... });
 */

const {
  RpcAbortError,
  RpcRemoteError,
  RpcTimeoutError,
  RpcDisconnectError,
  LinkNotReadyError,
  FeatureUnsupportedError,
} = require('../internal/errors.js');

const { nonNegFinite } = require('../internal/options.js');

/**
 * Resolve as soon as any of `events` fires on `link`, or reject on
 * `timeoutMs` elapsing / `signal` aborting. Single listener per event,
 * all cleaned up on settle - no listener leak when one event "wins"
 * and the others never fire. `timeoutMs: 0` means "no timeout" (the
 * same convention as `link.waitFor()`).
 *
 * Internal-only - used by `waitForPeer` to wake on both `peer.connect`
 * and `peer.replaced` (a same-kind reconnect doesn't fire `peer.connect`,
 * which is why the v0.4.x waitForPeer could time out despite the peer
 * being present).
 */
function waitForAnyEvent(link, events, opts = {}) {
  const { timeoutMs = 0, signal } = opts;

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer   = null;
    let onAbort = null;
    const listeners = [];

    const cleanup = () => {
      settled = true;
      if (timer) clearTimeout(timer);
      for (const [ev, fn] of listeners) {
        try { link.off(ev, fn); } catch {}
      }
      if (signal && onAbort) {
        try { signal.removeEventListener('abort', onAbort); } catch {}
      }
    };

    for (const ev of events) {
      const fn = (...args) => {
        if (settled) return;
        cleanup();
        resolve(args.length <= 1 ? args[0] : args);
      };
      link.on(ev, fn);
      listeners.push([ev, fn]);
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) return;
        cleanup();
        reject(new Error(`waitForAnyEvent: timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
    }

    if (signal) {
      if (signal.aborted) {
        cleanup();
        const err = new Error('waitForAnyEvent: aborted');
        err.name = 'AbortError';
        reject(err);
        return;
      }
      onAbort = () => {
        if (settled) return;
        cleanup();
        const err = new Error('waitForAnyEvent: aborted');
        err.name = 'AbortError';
        reject(err);
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * Block until a peer of the given kind appears (and, by default, is
 * connected). No polling - uses link-core's `peer.connect` AND
 * `peer.replaced` events, so a same-kind socket replacement mid-wait
 * also wakes the helper.
 *
 *   await waitForPeer(link, 'vault');
 *   await waitForPeer(link, 'vault', { timeoutMs: 5_000, requireConnected: false });
 *   await waitForPeer(link, 'vault', { signal: ctl.signal });
 *
 * Returns the matching peer object (the same shape link.getPeers()
 * returns: { kind, hello, connectedAt, connected }).
 *
 * Throws `TypeError` synchronously on invalid `timeoutMs` (NaN, negative,
 * non-finite, wrong type). `timeoutMs: 0` means "no timeout" - matches
 * `link.ready()` / `link.waitFor()` / `link.rpc()` semantics.
 *
 * Throws an `AbortError` (name === 'AbortError') if `opts.signal`
 * aborts (matches `link.ready()` / `link.waitFor()` semantics).
 *
 * Throws a regular `Error` on timeout.
 */
async function waitForPeer(link, kind, opts = {}) {
  const timeoutMs = nonNegFinite(opts.timeoutMs, 30_000, 'waitForPeer: opts.timeoutMs');
  const requireConnected = opts.requireConnected !== false;
  const signal = opts.signal;

  if (typeof link?.getPeers !== 'function'
   || typeof link?.on       !== 'function'
   || typeof link?.off      !== 'function'
   ) throw new TypeError(
    'waitForPeer: `link` must be a LinkClient (or wrapper) exposing ' +
    '`getPeers()`, `on()`, and `off()`. If you wrap LinkClient, ' +
    'add EventEmitter pass-throughs for on/once/off - `waitForPeer` ' +
    'listens for `peer.connect` and `peer.replaced` directly.',
  );

  if (signal && signal.aborted) {
    const err = new Error('waitForPeer: aborted');
    err.name = 'AbortError';
    throw err;
  }

  const matches = (p) => p.kind === kind && (!requireConnected || p.connected);

  const already = link.getPeers().find(matches);
  if (already) return already;

  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : null;

  while (true) {
    if (signal && signal.aborted) {
      const err = new Error('waitForPeer: aborted');
      err.name = 'AbortError';
      throw err;
    }

    const remaining = deadline !== null ? deadline - Date.now() : 0;
    if (deadline !== null && remaining <= 0) break;

    try {
      await waitForAnyEvent(
        link, ['peer.connect', 'peer.replaced'], { timeoutMs: remaining, signal },
      );
    } catch (e) {
      // AbortError from the signal propagates; timeouts fall through
      // to the bounded retry loop and surface as the helper-level
      // "timed out after N ms" error below.
      if (e && e.name === 'AbortError') throw e;
      break;
    }

    const found = link.getPeers().find(matches);
    if (found) return found;
  }

  throw new Error(
    `waitForPeer: timed out after ${timeoutMs}ms waiting for kind=${kind}` +
    (requireConnected ? ' (requireConnected)' : ''),
  );
}

/**
 * Sleep that resolves after `ms` or rejects with `RpcAbortError` if
 * `signal` aborts before then. Used between retry attempts in
 * `rpcWithRetry` so callers cancelling mid-backoff get fast cleanup
 * instead of waiting out the delay.
 */
function abortAwareSleep(ms, signal) {
  if (!signal) return new Promise((r) => { setTimeout(r, ms).unref?.(); });

  if (signal.aborted) {
    return Promise.reject(new RpcAbortError('rpcWithRetry: aborted during backoff', {}));
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(new RpcAbortError('rpcWithRetry: aborted during backoff', {}));
    }

    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * RPC with bounded retries and sensible error classification.
 *
 *   await rpcWithRetry(link, 'worker', 'job.run', payload, {
 *     tries: 3,
 *     timeoutMs: 30_000,
 *     baseDelayMs: 250,   // backoff = baseDelayMs * attempt + jitter
 *     signal,
 *   });
 *
 * Retry policy:
 *   - RpcAbortError      → never retry (caller cancelled)
 *   - RpcRemoteError     → never retry (handler said no)
 *   - RpcTimeoutError    → retry until tries exhausted
 *   - RpcDisconnectError → retry until tries exhausted
 *   - anything else      → throw immediately
 */
async function rpcWithRetry(link, to, type, data, opts = {}) {
  const tries       = opts.tries       ?? 3;
  const timeoutMs   = nonNegFinite(opts.timeoutMs,   30_000, 'rpcWithRetry: opts.timeoutMs');
  const baseDelayMs = nonNegFinite(opts.baseDelayMs, 250,    'rpcWithRetry: opts.baseDelayMs');
  const signal      = opts.signal;

  if (!Number.isInteger(tries) || tries < 1
   ) throw new TypeError(
    `rpcWithRetry: opts.tries must be a positive integer (got ${
      typeof tries === 'number' ? tries : `${typeof tries} ${String(tries)}`
    })`,
  );

  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      return await link.rpc(to, type, data, { timeoutMs, signal });
    } catch (e) {
      lastErr = e;

      if (e instanceof RpcAbortError)  throw e;
      if (e instanceof RpcRemoteError) throw e;
      if (i >= tries) throw e;

      if (!(e instanceof RpcTimeoutError) &&
          !(e instanceof RpcDisconnectError)) throw e;

      const delay = baseDelayMs * i + Math.floor(Math.random() * baseDelayMs);
      await abortAwareSleep(delay, signal);
    }
  }
  throw lastErr;
}

/**
 * Wrap link.publish() so it never throws on the common transient
 * conditions (link-not-ready mid-reconnect, hub doesn't advertise
 * topics) - those become quiet drops with a debug-level log.
 *
 * The "feature unsupported" warning fires once at warn, then drops
 * to debug for subsequent skips so a v0.3-era hub doesn't fill the
 * logs with the same warning every publish.
 *
 *   const publish = createSafePublisher(link, {
 *     logger,
 *     context: 'handlers',
 *     featureCheck: true,        // optional - short-circuit at the gate
 *   });
 *
 *   publish('user.changed', { id: 42 });   // returns boolean
 *
 * Returns false on any drop, true on a successful publish call.
 * (link-core's publish() returns boolean already; this wrapper just
 * doesn't propagate exceptions.)
 *
 * Options:
 *   logger        required ({ lD, lW })
 *   context       log context prefix (default 'safe-publish')
 *   featureCheck  if true, pre-check `link.hubFeatures.includes('topics')`
 *                 and short-circuit before the try/throw round-trip. The
 *                 first-skip-warns-then-debug pattern still applies.
 *                 Default false (rely on FeatureUnsupportedError from
 *                 link-core, which gives the same logging behaviour but
 *                 with one wasted throw per call on a v0.3 hub).
 */
function createSafePublisher(link, opts = {}) {
  const logger = opts.logger;
  const ctx    = opts.context || 'safe-publish';
  const featureCheck = !!opts.featureCheck;

  if (!logger
    || typeof logger.lD !== 'function'
    || typeof logger.lW !== 'function'
   ) throw new TypeError('createSafePublisher: logger with { lD, lW } is required');

  let featureWarned = false;

  function noteFeatureSkip(feature, topic) {
    if (!featureWarned) {
      featureWarned = true;
      logger.lW(ctx,
        `publish disabled: hub does not advertise feature='${feature}'. ` +
        `Subsequent skips will log at debug only.`);
    } else {
      logger.lD(ctx, `publish ${topic} skipped: feature='${feature}' unsupported`);
    }
  }

  return function safePublish(topic, payload) {
    if (featureCheck) {
      const features = link.hubFeatures;
      if (Array.isArray(features) && !features.includes('topics')) {
        noteFeatureSkip('topics', topic);
        return false;
      }
    }

    try {
      return link.publish(topic, payload) !== false;
    } catch (e) {
      if (e instanceof LinkNotReadyError) {
        logger.lD(ctx, `publish ${topic} skipped: link not ready`);
        return false;
      }

      if (e instanceof FeatureUnsupportedError) {
        noteFeatureSkip(e.feature, topic);
        return false;
      }

      // Genuinely unexpected - keep visible
      logger.lW(ctx, `publish ${topic} failed: `, e?.message || e);
      return false;
    }
  };
}

/**
 * Wrap link.send() so it never throws on the common transient conditions.
 * Companion to `createSafePublisher` - same shape, but uses the `direct`
 * feature instead of `topics`.
 *
 *   const send = createSafeSend(link, { logger, context: 'fanout' });
 *   send('worker', 'job.queued', { id });
 *
 * Returns false on any drop, true on a successful send call.
 *
 * Options:
 *   logger        required ({ lD, lW })
 *   context       log context prefix (default 'safe-send')
 *   featureCheck  if true, pre-check `link.hubFeatures.includes('direct')`
 *                 and short-circuit. Default false.
 */
function createSafeSend(link, opts = {}) {
  const logger = opts.logger;
  const ctx    = opts.context || 'safe-send';
  const featureCheck = !!opts.featureCheck;

  if (!logger
    || typeof logger.lD !== 'function'
    || typeof logger.lW !== 'function'
   ) throw new TypeError('createSafeSend: logger with { lD, lW } is required');

  let featureWarned = false;

  function noteFeatureSkip(feature, to, type) {
    if (!featureWarned) {
      featureWarned = true;
      logger.lW(ctx,
        `send disabled: hub does not advertise feature='${feature}'. ` +
        `Subsequent skips will log at debug only.`);
    } else {
      logger.lD(ctx, `send ${type} -> ${to} skipped: feature='${feature}' unsupported`);
    }
  }

  return function safeSend(to, type, data) {
    if (featureCheck) {
      const features = link.hubFeatures;
      if (Array.isArray(features) && !features.includes('direct')) {
        noteFeatureSkip('direct', to, type);
        return false;
      }
    }

    try {
      return link.send(to, type, data) !== false;
    } catch (e) {
      if (e instanceof LinkNotReadyError) {
        logger.lD(ctx, `send ${type} -> ${to} skipped: link not ready`);
        return false;
      }

      if (e instanceof FeatureUnsupportedError) {
        noteFeatureSkip(e.feature, to, type);
        return false;
      }

      // Genuinely unexpected - keep visible
      logger.lW(ctx, `send ${type} -> ${to} failed:`, e?.message || e);
      return false;
    }
  };
}

module.exports = {
  waitForPeer,    rpcWithRetry,
  createSafeSend, createSafePublisher
};