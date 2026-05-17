'use strict';

/**
 * Env coercion helpers and a one-shot LinkClient option assembler.
 *
 *   const { num, bool, requireEnv, linkClientOptionsFromEnv } = require('@presenc3/link-core');
 *
 *   requireEnv(['LINK_URL', 'LINK_KIND', 'LINK_SECRET']);
 *
 *   const link = new LinkClient({
 *     ...linkClientOptionsFromEnv(),
 *     name: 'My Service',
 *     makeStatus,
 *     rpcHandlers,
 *     logger: { log: l, warn: lW },
 *   });
 *
 * The coercion functions return `undefined` for missing/empty values so
 * callers can chain `?? defaultValue` without sentinels colliding with
 * legitimate `0` / `false`.
 */

function num(v) {
  if (v == null) return undefined;
  const s = String(v).trim();
  if (s === '') return undefined;
  return Number(s);
}

function bool(v) {
  if (v == null) return undefined;
  const s = String(v).trim().toLowerCase();
  if (s === '') return undefined;
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

/**
 * Throw if any of the named env vars are unset or empty. Returns an object
 * mapping every required key to its (non-empty) string value.
 *
 *   const { LINK_URL, LINK_KIND, LINK_SECRET } = requireEnv(
 *     ['LINK_URL', 'LINK_KIND', 'LINK_SECRET']
 *   );
 *
 * Pass a custom env object as the second arg for testing.
 */
function requireEnv(keys, env = process.env) {
  if (!Array.isArray(keys)) throw new TypeError('requireEnv: keys must be an array of strings');

  const missing = [], out = {};

  for (const k of keys) {
    const v = env[k];
    if (v == null || String(v).trim() === '') missing.push(k);
    else out[k] = v;
  }

  if (missing.length > 0
   ) throw new Error(`missing required env vars: ${missing.join(', ')}`);

  return out;
}

/**
 * Assemble the standard LinkClient options bag from env. Reads the
 * common LINK_* knobs and runs them through num/bool. Caller is
 * expected to spread the result and add app-specific fields
 * (name, makeStatus, rpcHandlers, logger).
 *
 * Pass `{ envPrefix: 'FOO_' }` to read FOO_URL/FOO_KIND/etc instead.
 *
 * Coverage: this is deliberately the *common* subset, not exhaustive.
 * It maps the eleven knobs that vary most often between environments
 * (URL, kind, secret, hashAlgo, replayWindowMs, maxRecentIds,
 * maxMessageBytes, maxBufferedBytes, reconnectJitter, perMessageDeflate,
 * reconnectOnRejection). Reconnect-timing knobs (`reconnectInitialMs`,
 * `reconnectMaxMs`, `reconnectGrowth`), per-call timing
 * (`defaultRpcTimeoutMs`, `statusIntervalMs`, `helloAckDiagnosticMs`)
 * are not env-mapped here - they're library defaults you'd usually
 * pin in code per service, not per deployment. If you need them from
 * env, layer your own `num(process.env.LINK_RECONNECT_INITIAL_MS)`
 * onto the returned object before passing it to `new LinkClient(...)`.
 *
 * Notes
 *  - LINK_URL/LINK_KIND/LINK_SECRET are NOT validated here. Use
 *    requireEnv() if you want the loud-fail-at-boot behavior.
 *  - Any knob whose env var is missing comes back as `undefined`,
 *    which means LinkClient will use its own library default.
 */
function linkClientOptionsFromEnv(env = process.env, opts = {}) {
  const prefix = opts.envPrefix || 'LINK_';
  const get = (suffix) => env[prefix + suffix];

  return {
    url:      get('URL'),
    kind:     get('KIND'),
    secret:   get('SECRET'),
    hashAlgo: get('HASH_ALGO') || undefined,
    maxRecentIds:         num(get('MAX_RECENT_IDS')),
    reconnectJitter:      num(get('RECONNECT_JITTER')),
    replayWindowMs:       num(get('REPLAY_WINDOW_MS')),
    maxMessageBytes:      num(get('MAX_MESSAGE_BYTES')),
    maxBufferedBytes:     num(get('MAX_BUFFERED_BYTES')),
    perMessageDeflate:    bool(get('PERMESSAGE_DEFLATE')),
    reconnectOnRejection: bool(get('RECONNECT_ON_REJECTION'))
  };
}

module.exports = { num, bool, requireEnv, linkClientOptionsFromEnv };