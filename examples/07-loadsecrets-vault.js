'use strict';

/*
 * 07-loadsecrets-vault.js
 *
 * A vault peer with the wire convention the `loadSecrets()` helper
 * expects. Same job as 02-vault.js (serve credentials over RPC), but
 * with the contract the helper assumes:
 *
 *   - kind            : `link_secs` (helper default; override via opts.secretsKind)
 *   - RPC method      : `secs.get`         (instead of `secrets.get`)
 *   - Path convention : `sec/<ns>/<rest>`  (the `<ns>` part enables topic-scoped
 *                                           hot-reload via `secs.changed.<ns>`)
 *   - Hot-reload      : publish `secs.changed.<ns>` topic events on rotation
 *
 * Pair with 08-loadsecrets-consumer.js. To demo rotation, this vault
 * rotates `sec/shared/api-token` every 8s - watch the consumer pick it
 * up without restarting.
 *
 * Run from the repo root: node examples/07-loadsecrets-vault.js
 */

const { LinkClient } = require('../src/index.js');
const crypto = require('crypto');

const fn = '[ Secs ]';

/*
 * STORE keys must match the path shape `sec/<ns>/<rest>`. Namespace
 * is the chunk between the first and second `/`. Anything else is
 * routing-flat (loadSecrets uses the full path as the lookup key).
 */
const STORE = {
    'sec/shared/db-password': 'super-secret-db-password',
    'sec/shared/api-token':   `tok-${crypto.randomUUID().slice(0, 8)}`,
    'sec/datastore/dsn':      'postgres://localhost:5432/app',
};

const ALLOW = new Set(['worker', 'coordinator', 'consumer']);

const link = new LinkClient({
    kind   : 'link_secs',
    name   : 'link_secs',
    url    : process.env.LINK_URL           || 'ws://localhost:8080',
    secret : process.env.LINK_KEY_LINK_SECS || 'dev-secs-key',

    rpcHandlers: {
        /*
         * secs.get({ path }) → { value }
         *
         * `path` is the full `sec/<ns>/<rest>` string. Returning
         * `{ value: null }` (or omitting `value`) signals "missing" to
         * loadSecrets, which then throws on initial load.
         */
        'secs.get': async ({ path } = {}, msg) => {
            if (!ALLOW.has(msg.from)) throw new Error(`Forbidden: ${msg.from}`);
            if (typeof path !== 'string' || !path) throw new Error('secs.get: "path" is required');
            
            const value = STORE[path];
            console.log(`${fn} secs.get(${path}) → ${msg.from} ${value ? '(hit)' : '(miss)'}`);
            return { value: value ?? null };
        },
    },
});

link.on('protocol-error', ({ reason }) => console.warn (`${fn} protocol-error: ${reason}`));
link.on('rejected',       ({ reason }) => console.error(`${fn} hub rejected hello: ${reason}`));

(async () => {
    await link.ready({ timeoutMs: 10_000 });
    console.log(`${fn} ready`);

    /*
     * Rotate `sec/shared/api-token` every 8s and announce on the
     * `secs.changed.shared` topic. The loadSecrets consumer subscribes
     * to that topic per-namespace and refetches affected paths.
     *
     * For deletions: emit `{ path, action: 'del' }` - the consumer
     * removes the key from its config.
     */
    setInterval(() => {
        const path     = 'sec/shared/api-token';
        const oldValue = STORE[path];
        STORE[path]    = `tok-${crypto.randomUUID().slice(0, 8)}`;

        console.log(`${fn} rotated ${path}: ${oldValue} → ${STORE[path]}`);

        /*
         * Publish on `secs.changed.<ns>` where <ns> is the first segment
         * after `sec/`. The consumer derives the same namespace from each
         * mapping path and only subscribes to namespaces it cares about.
         */
        try {
            link.publish('secs.changed.shared', { path, action: 'set' });
        } catch (e) {
            // LinkNotReadyError mid-reconnect, FeatureUnsupportedError on a
            // v0.3 hub - both are non-fatal here
            console.warn(`${fn} rotation announce failed: ${e.message}`);
        }
    }, 8_000).unref?.();
})().catch((e) => {
    console.error(`${fn} error: `, e.message || e);
    process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
        console.log(`${fn} ${sig}, stopping`);

        link.stop();
        process.exit(0);
    });
}