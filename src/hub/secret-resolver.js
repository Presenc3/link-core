'use strict';

/**
 * Normalize the `secret` option into an async `(kind) => secret | null`
 * resolver. Three input shapes are accepted:
 *
 *   - `string` - shared-secret mode. Same key for every kind.
 *   - `Record<kind, string>` - static per-kind map. Unknown kinds resolve null.
 *   - `(kind) => string | null | Promise<string | null>` - dynamic resolver.
 *     Throws are swallowed and surfaced as `null`.
 *
 * Returning `null` means "no key for that kind" - the hub will silently drop
 * the hello.
 */
function makeSecretResolver(secret) {
  if (typeof secret === 'string') {
    if (!secret) throw new Error('createHub({ secret }): string must be non-empty');
    return async () => secret;
  }

  if (typeof secret === 'function') {
    return async (kind) => {
      let val;

      try { val = await secret(kind); }
      catch { return null; }
      return (typeof val === 'string' && val.length > 0) ? val : null;
    };
  }

  if (secret && typeof secret === 'object') {
    const map = secret;

    return async (kind) => {
      const v = map[kind];

      return (typeof v === 'string' && v.length > 0) ? v : null;
    };
  }

  throw new Error('createHub({ secret }): must be a string, object, or function');
}

module.exports = { makeSecretResolver };