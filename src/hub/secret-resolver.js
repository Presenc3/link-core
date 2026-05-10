'use strict';

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
      if (!Object.hasOwn(map, kind)) return null;

      const v = map[kind];

      return (typeof v === 'string' && v.length > 0) ? v : null;
    };
  }

  throw new Error('createHub({ secret }): must be a string, object, or function');
}

module.exports = { makeSecretResolver };