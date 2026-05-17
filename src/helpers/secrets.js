'use strict';

/**
 * Helper for fetching secrets from a secrets vault client at boot, with
 * optional hot-reload on rotation.
 *
 * Call this once during init(), AFTER you've created your LinkClient
 * (so it can call .ready() / .waitFor()) but BEFORE you use any of
 * the secret values.
 *
 * Basic usage (snapshot at boot, no hot-reload):
 *
 *   const cfg = await loadSecrets(link, {
 *     OPENAI_API_KEY: 'sec/shared/openai',
 *     SENTRY_DSN:     'sec/datastore/sentry-dsn',
 *   });
 *
 * Watch mode (subscribes to secs.changed.<ns> events from link_secs
 * and refetches on rotation; requires a v0.4+ hub):
 *
 *   const cfg = await loadSecrets(link, {
 *     OPENAI_API_KEY: 'sec/shared/openai',
 *   }, {
 *     watch: true,
 *     onChange: ({ name, action, newValue }) => {
 *       // build a new frozen cfg snapshot, re-init clients, etc.
 *     },
 *   });
 *
 * The returned object is mutated in-place when watched secrets
 * change, so a frozen snapshot held by the caller will go stale.
 * Use onChange to rebuild your cfg snapshot.
 */

const {
  RpcRemoteError,
  RpcTimeoutError,
  HelloRejectedError,
  RpcDisconnectError,
} = require('../internal/errors.js');

const { waitForPeer } = require('./rpc.js');

const DEFAULT_TIMEOUT_MS  = 30_000;
const DEFAULT_KIND        = 'link_secs';
const SECRET_PATH_PATTERN = /^sec\/[a-zA-Z0-9._-]+\/.+$/;

/**
 * Extract the namespace component from a `sec/<ns>/<rest>` path.
 * Returns '' if the path doesn't match that shape - callers must
 * treat '' as "malformed, don't subscribe to a watcher".
 *
 * The previous version accepted any `a/b` string and silently
 * pulled `b` as the namespace; a caller passing `'foo/bar'` would
 * end up with a watcher on `secs.changed.bar` that would never
 * fire, and the typo would only surface in production.
 */
function nsOf(p) {
  if (typeof p !== 'string' || !SECRET_PATH_PATTERN.test(p)) return '';
  return p.split('/')[1];
}

/**
 * Throw on any mapping value that doesn't look like a secret path.
 * Called once at the top of `loadSecrets` so misconfiguration
 * surfaces at the call site instead of as an "RPC timeout" or
 * "vault refused" much later.
 */
function assertMapping(mapping) {
  if (!mapping || typeof mapping !== 'object') {
    throw new TypeError('loadSecrets: mapping must be an object of envName -> path');
  }

  for (const [name, p] of Object.entries(mapping)) {
    if (typeof p !== 'string' || !SECRET_PATH_PATTERN.test(p)) {
      throw new TypeError(
        `loadSecrets: mapping["${name}"] = ${JSON.stringify(p)} ` +
        `is not a valid secret path (expected "sec/<ns>/<rest>")`,
      );
    }
  }
}

/**
 * Wait for two things in sequence, bounded by a single shared deadline:
 *   1. The hub has accepted our hello (`link.ready()` resolves).
 *   2. The secrets vault peer is present (and connected) in our peer list.
 *
 * Both steps are event-driven - no polling. The caller passes the
 * absolute deadline (ms since epoch) so the total budget is shared
 * across this function AND the per-get RPCs that follow.
 *
 * Important: every downstream `timeoutMs` we pass must be `> 0`.
 * `link.ready({ timeoutMs: 0 })` and `link.rpc(..., { timeoutMs: 0 })`
 * both mean "no timeout, wait forever" inside the client, so an
 * already-expired budget would silently turn into an indefinite wait.
 * We treat expiry as an immediate hard failure.
 */
async function waitForReady(link, secretsKind, deadline, totalBudgetMs) {
  const readyMs = deadline - Date.now();
  if (readyMs <= 0) {
    throw new Error(`loadSecrets: budget of ${totalBudgetMs}ms exhausted before link.ready()`);
  }
  try {
    await link.ready({ timeoutMs: readyMs });
  } catch (e) {
    if (e instanceof HelloRejectedError) throw e;
    const wrapped = new Error(
      `loadSecrets: link not ready within ${totalBudgetMs}ms` +
      (e?.message ? ` (${e.message})` : ''),
    );
    wrapped.cause = e;
    throw wrapped;
  }

  const peerMs = deadline - Date.now();
  if (peerMs <= 0) {
    throw new Error(
      `loadSecrets: budget of ${totalBudgetMs}ms exhausted after link.ready(), ` +
      `before kind=${secretsKind} peer was seen`,
    );
  }
  try {
    await waitForPeer(link, secretsKind, {
      timeoutMs: peerMs,
      requireConnected: true,
    });
  } catch (e) {
    if (e instanceof TypeError) throw e;
    
    const wrapped = new Error(
      `loadSecrets: timed out after ${totalBudgetMs}ms ` +
      `waiting for kind=${secretsKind} on the bus` +
      (e?.message ? ` (${e.message})` : ''),
    );
    wrapped.cause = e;
    throw wrapped;
  }
}

/**
 * Well-known Symbol attached to the object returned by `loadSecrets`
 * when `watch: true`. Call it to tear down the topic subscriptions
 * the helper installed and stop receiving rotation updates. Safe to
 * call multiple times. Absent (and the cleanup is a no-op) for
 * non-watch loads.
 *
 *   const { LOADED_SECRETS_UNWATCH } = require('@presenc3/link-core');
 *   const cfg = await loadSecrets(link, mapping, { watch: true });
 *   // ... later, on shutdown / test teardown:
 *   cfg[LOADED_SECRETS_UNWATCH]?.();
 *
 * Symbol-keyed (rather than a `.close` method) so it can never collide
 * with a secret whose env name happens to be `close`.
 */
const LOADED_SECRETS_UNWATCH = Symbol.for('@presenc3/link-core:loadSecrets.unwatch');

function defaultWarn(ctx, msg, ...args) {
  // eslint-disable-next-line no-console
  console.warn(`[${ctx}]`, msg, ...args);
}

/**
 * Subscribe to secs.changed.<ns> for every namespace referenced in
 * `mapping`, refetching the affected secret on each event. Returns an
 * `unwatch()` function that removes every subscription this helper
 * installed (and only those) - safe to call repeatedly.
 *
 * `warn` is called with `(context, message, ...args)` - matches every
 * other helper's `LeveledLogger.lW` shape so callers can pass `log.lW`
 * directly. Defaults to a console wrapper when the caller doesn't
 * inject one.
 */
function installWatch(link, mapping, secretsKind, out, onChange, warn = defaultWarn) {
  const pathToName = Object.create(null);
  for (const [name, p] of Object.entries(mapping)) pathToName[p] = name;

  const namespaces = new Set();
  for (const p of Object.keys(pathToName)) {
    const ns = nsOf(p);
    if (ns) namespaces.add(ns);
  }

  const installed = [];

  for (const ns of namespaces) {
    const topic = `secs.changed.${ns}`;

    const handler = async ({ path, action }, msg) => {
      if (msg?.from !== secretsKind) {
        warn('link-core:secrets',
          `ignored rotation event from "${msg?.from || '<unknown>'}" ` +
          `for "${path}"; expected "${secretsKind}"`);
        return;
      }

      const name = pathToName[path];
      if (!name) return;

      try {
        if (action === 'set') {
          const res = await link.rpc(secretsKind, 'secs.get', { path });
          if (res?.value != null) {
            if (typeof res.value !== 'string') {
              warn('link-core:secrets',
                `ignored non-string rotated value for "${name}" from "${path}" ` +
                `(type=${typeof res.value})`);
              return;
            }
            const oldValue = out[name];
            out[name] = res.value;
            if (onChange) onChange({ name, path, action: 'set', oldValue, newValue: res.value });
          }
        } else if (action === 'del') {
          const oldValue = out[name];
          delete out[name];
          if (onChange) onChange({ name, path, action: 'del', oldValue, newValue: null });
        }
      } catch (e) {
        let tag = 'rpc failed';
        if      (e instanceof RpcRemoteError)     tag = 'vault refused';
        else if (e instanceof RpcTimeoutError)    tag = 'vault timed out';
        else if (e instanceof RpcDisconnectError) tag = 'disconnected';
        warn('link-core:secrets',
          `${tag} reloading "${name}" from "${path}":`, e?.message || e);
      }
    };
    link.subscribe(topic, handler);
    installed.push([topic, handler]);
  }

  let closed = false;
  return function unwatch() {
    if (closed) return;
    closed = true;
    for (const [topic, handler] of installed) {
      try { link.unsubscribe(topic, handler); } catch { }
    }
    installed.length = 0;
  };
}

/**
 * Fetch a map of `envName -> path` and return `{ envName: value }`.
 *
 * Throws if any secret is missing on the initial load (value === null).
 * Fail-fast at boot is much better than silently running with
 * `undefined` keys.
 *
 * @param {object}   link        a constructed LinkClient (or wrapper exposing rpc/ready/waitFor/getPeers/subscribe)
 * @param {object}   mapping     { LOCAL_NAME: 'sec/path/here', ... }
 * @param {object}   [opts]
 * @param {number}   [opts.timeoutMs=30_000]    covers ready + peer wait + each get
 * @param {string}   [opts.secretsKind='link_secs']
 * @param {boolean}  [opts.watch=false]         v0.4 hot-reload via secs.changed.<ns>
 * @param {function} [opts.onChange]            ({name,path,action,oldValue,newValue}) => void
 */
async function loadSecrets(link, mapping, opts = {}) {
  const timeoutMs   = opts.timeoutMs   ?? DEFAULT_TIMEOUT_MS;
  const secretsKind = opts.secretsKind ?? DEFAULT_KIND;
  const watch       = !!opts.watch;
  const onChange    = typeof opts.onChange === 'function' ? opts.onChange : null;

  const warn = (opts.logger && typeof opts.logger.lW === 'function')
    ? opts.logger.lW
    : undefined;

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError(
      `loadSecrets: opts.timeoutMs must be a positive finite number (got ${timeoutMs})`,
    );
  }

  assertMapping(mapping);

  const deadline = Date.now() + timeoutMs;

  await waitForReady(link, secretsKind, deadline, timeoutMs);

  const out = {};
  for (const [name, p] of Object.entries(mapping)) {
    const getMs = deadline - Date.now();
    if (getMs <= 0) {
      throw new Error(
        `loadSecrets: budget of ${timeoutMs}ms exhausted before fetching "${p}" ` +
        `(env=${name})`,
      );
    }

    let res;
    try {
      res = await link.rpc(secretsKind, 'secs.get', { path: p }, { timeoutMs: getMs });
    } catch (e) {
      if (e instanceof RpcRemoteError) {
        throw new Error(`loadSecrets: vault refused get "${p}" (env=${name}): ${e.message}`);
      }
      if (e instanceof RpcTimeoutError) {
        throw new Error(`loadSecrets: vault did not respond fetching "${p}" (env=${name})`);
      }
      if (e instanceof RpcDisconnectError) {
        throw new Error(`loadSecrets: link disconnected mid-fetch of "${p}" (env=${name})`);
      }
      throw e;
    }

    if (res?.value == null) {
      throw new Error(`loadSecrets: missing secret at path "${p}" (env name ${name})`);
    }
    if (typeof res.value !== 'string') {
      throw new TypeError(
        `loadSecrets: vault returned non-string value for "${p}" (env=${name}, ` +
        `type=${typeof res.value})`,
      );
    }
    out[name] = res.value;
  }

  if (watch) {
    const unwatch = installWatch(link, mapping, secretsKind, out, onChange, warn);
    Object.defineProperty(out, LOADED_SECRETS_UNWATCH, {
      value: unwatch,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }

  return out;
}

module.exports = { loadSecrets, LOADED_SECRETS_UNWATCH };