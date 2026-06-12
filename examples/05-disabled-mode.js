'use strict';

/*
 * 05-disabled-mode.js
 *
 * A small CLI-style service that shares one code path between a
 * "real run" (link bus available) and a "no link bus" local-dev run.
 *
 * The pattern: LinkClient is constructed unconditionally. If any of
 * url/secret/kind are missing in the environment, the link is
 * disabled - start() becomes a logged no-op, and ready() rejects
 * synchronously with LinkNotReadyError. The service catches that
 * specific error and continues without the bus.
 *
 * Pre-v0.5 this pattern was a trap: ready() with the default
 * timeoutMs: 0 ("wait forever") would hang any code path that
 * happened to be missing config. v0.5 makes it explicit.
 *
 * Try it both ways:
 *
 *   # With the bus:
 *   node examples/05-disabled-mode.js
 *   # > connects, ready, publishes the report on a topic
 *
 *   # Without:
 *   LINK_URL= LINK_SECRET= LINK_KIND= node examples/05-disabled-mode.js
 *   # > "link disabled, running standalone", does the work anyway
 */

const {
    LinkClient,
    LinkNotReadyError,
} = require('../src/index.js');
const { createSafePublisher } = require('@presenc3/link-helpers');

const fn = '[ Reporter ]';

const link = new LinkClient({
    url    : process.env.LINK_URL    || undefined,
    secret : process.env.LINK_SECRET || undefined,
    kind   : process.env.LINK_KIND   || undefined,
    name   : 'reporter',
});

/*
 * createSafePublisher swallows the predictable transient errors
 * (LinkNotReadyError if the link is mid-reconnect, FeatureUnsupportedError
 * if the hub is too old to advertise topics). On a disabled link, every
 * publish() throws LinkNotReadyError, which the wrapper drops to debug
 * - so the same `publish()` call is a no-op in disabled mode and a real
 * fan-out when the bus is up. The application code path doesn't fork.
 */
const publish = createSafePublisher(link, {
    logger: {
        lD: () => {},
        lW: (ctx, msg, ...args) => console.warn(`[${ctx}]`, msg, ...args),
    },
});

async function doTheWork() {
    console.log(`${fn} computing the daily report…`);

    await new Promise((r) => setTimeout(r, 500));

    return {
        ok: true,
        recordCount: 42,
        generatedAt: new Date().toISOString()
    };
}

(async () => {
    /*
     * Try to come up on the bus. If the link is disabled (missing url /
     * secret / kind), ready() rejects immediately with LinkNotReadyError.
     * Other rejection types (HelloRejectedError, timeout, AbortError) are
     * surfaced - they're real failures, not "intentionally no bus."
     */
    let linkUp = false;
    try {
        await link.ready({ timeoutMs: 5_000 });
        linkUp = true;
        console.log(`${fn} link ready (kind=${link.kind})`);
    } catch (e) {
        if (e instanceof LinkNotReadyError) {
            console.log(`${fn} link disabled, running standalone (${e.message})`);
        } else {
            console.warn(`${fn} link came up unhappy: ${e.message}; running standalone`);
        }
    }

    // The actual work doesn't care whether the bus is up
    const report = await doTheWork();
    console.log(`${fn} report:`, report);

    // This publish is a no-op when the link is disabled, a fan-out when it's up
    publish('daily.report', report);

    if (linkUp) link.stop();
})().catch((e) => {
    console.error(`${fn} unexpected: `, e);
    process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { console.log(`${fn} ${sig}, stopping`); try { link.stop(); } catch {} process.exit(0); });
}