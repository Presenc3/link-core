'use strict';

/*
 * 08-loadsecrets-consumer.js
 *
 * A small consumer that bootstraps its config via the loadSecrets()
 * helper and hot-reloads on rotation. Pair with 07-loadsecrets-vault.js
 * (which rotates `sec/shared/api-token` every 8s).
 *
 * What loadSecrets() does for you, in one call:
 *   1. Waits for link.ready() within a shared deadline.
 *   2. Waits for the secrets vault peer (kind: link_secs by default)
 *      to be present and connected.
 *   3. Fetches each path via `secs.get` and assembles a frozen
 *      `Record<string, string>` cfg snapshot.
 *   4. (watch: true) Subscribes to `secs.changed.<ns>` for every
 *      namespace referenced in the mapping; on each event, refetches
 *      the affected path and mutates `out[name]` in place, calling
 *      `onChange` with { name, path, action, oldValue, newValue }.
 *   5. Returns the cfg with a non-enumerable LOADED_SECRETS_UNWATCH
 *      symbol-keyed teardown function.
 *
 * Run from the repo root: node examples/08-loadsecrets-consumer.js
 */

const {
    LinkClient,
    loadSecrets,
    LOADED_SECRETS_UNWATCH
} = require('../src/index.js');

const fn = '[ Consumer ]';

const link = new LinkClient({
    url    : process.env.LINK_URL  || 'ws://localhost:8080',
    /*
     * `consumer` isn't in the hub's KEYS map by default; add it there
     * or set LINK_KEY to one of the existing dev keys for this demo
     */
    secret : process.env.LINK_KEY  || 'dev-coord-key',
    kind   : process.env.LINK_KIND || 'coordinator',
    name   : 'loadsecrets-consumer',
});

(async () => {
    const cfg = await loadSecrets(link, {
        DB_PASSWORD: 'sec/shared/db-password',
        API_TOKEN:   'sec/shared/api-token',
        DSN:         'sec/datastore/dsn',
    }, {
        timeoutMs: 30_000,
        watch:     true,
        onChange:  ({ name, action, oldValue, newValue }) => {
            console.log(`${fn} rotated: ${name} (${action}) ${oldValue} → ${newValue}`);
        },
    });

    /*
     * cfg is a Record<string, string>. Use as you would any config object.
     * The watch path mutates it in place, so a frozen snapshot would go
     * stale - rebuild your dependent clients inside `onChange` if you
     * need an immutable view.
     */
    console.log(`${fn} loaded: DB_PASSWORD len=${cfg.DB_PASSWORD.length}, `
      + `API_TOKEN=${cfg.API_TOKEN}, DSN=${cfg.DSN}`);

    // Heartbeat: print the current api token every 4s so the rotation is visible
    const tick = setInterval(() => {
        console.log(`${fn} current API_TOKEN: ${cfg.API_TOKEN}`);
    }, 4_000);

    tick.unref?.();

    // Clean teardown on shutdown
    for (const sig of ['SIGINT', 'SIGTERM']) {
        process.on(sig, () => {
            console.log(`${fn} ${sig}, stopping`);
            clearInterval(tick);
            
            // Removes only the rotation subscriptions this helper installed
            cfg[LOADED_SECRETS_UNWATCH]?.();
            
            link.stop();
            process.exit(0);
        });
    }
})().catch((e) => {
    console.error(`${fn} error: `, e.message || e);
    process.exit(1);
});