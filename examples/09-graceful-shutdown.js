'use strict';

/*
 * 09-graceful-shutdown.js
 *
 * A service with three resources that all need to be cleaned up in
 * order on shutdown: a link to the bus, a write-buffer that needs to
 * be flushed to disk, and a (simulated) DB pool that needs to drain.
 *
 * Demonstrates the v0.5 lifecycle helpers:
 *   - createLogger()
 *   - createGracefulShutdown({ logger, steps, timeoutMs })
 *       Watchdog-bounded sequencer. Steps run in order; a throwing step
 *       is logged but does NOT abort subsequent steps. A hung step is
 *       force-exited at timeoutMs.
 *   - installProcessHandlers({ shutdown, logger })
 *       Wires SIGINT/SIGTERM/uncaughtException/unhandledRejection.
 *       Returns an `uninstall()` for tests.
 *
 * Run from the repo root: node examples/09-graceful-shutdown.js
 * Press Ctrl-C and watch the shutdown sequence.
 */

const {
    LinkClient,
    createLogger,
    createGracefulShutdown,
    installProcessHandlers
} = require('../src/index.js');

const fn  = 'demo';
const log = createLogger({ minLevel: 'DEBUG' });

/*
 * Simulated resources. In a real service these would be the actual
 * SDK clients (Sequelize, pg pool, fs.WriteStream, etc.)
 */
const writeBuffer = {
    size: 0,
    async flush() {
        log.l(fn, `flushing ${this.size} pending writes…`);
        
        await new Promise((r) => setTimeout(r, 250));
        this.size = 0;
        
        log.l(fn, 'write buffer flushed');
    },
};

const dbPool = {
    inflight: 3,
    async drain() {
        log.l(fn, `draining DB pool (${this.inflight} inflight)…`);
        
        while (this.inflight > 0) {
            await new Promise((r) => setTimeout(r, 100));
            this.inflight -= 1;
        }
      
        log.l(fn, 'DB pool drained');
    },
};

const link = new LinkClient({
    url    : process.env.LINK_URL    || undefined,
    secret : process.env.LINK_SECRET || undefined,
    kind   : process.env.LINK_KIND   || undefined,
    name   : 'graceful-demo',
    logger : log,
});

/*
 * Build the shutdown sequence. Each step is `(signal) => …` and may
 * return a promise. They run in order - link first (stop new work),
 * write buffer next (don't lose in-progress data), DB pool last
 * (the underlying connections might still be needed by the flush).
 *
 * timeoutMs is the watchdog: if the whole sequence hasn't finished by
 * then, process.exit(1) fires. Aim high enough to cover the slowest
 * realistic step
 */
const shutdown = createGracefulShutdown({
    logger:    log,
    context:   'shutdown',
    timeoutMs: 10_000,
    exitCode:  0,
    steps: [
        (sig) => { log.l(fn, `shutdown reason=${sig}`); },
        () => link.stop(),
        () => writeBuffer.flush(),
        () => dbPool.drain(),
    ],
});

installProcessHandlers({
    shutdown,
    logger:  log,
    context: 'process',
    // signals: ['SIGINT', 'SIGTERM'], // defaults
    // exitOnUncaught: true            // defaults
});

(async () => {
    // Best-effort link bring-up. The shutdown sequence handles both the
    // "link came up" and "link disabled" branches uniformly - link.stop()
    // on a disabled link is a no-op

    try {
        await link.ready({ timeoutMs: 5_000 });
        log.l(fn, 'link ready');
    } catch (e) {
        log.lW(fn, `link not up (${e.message}); continuing standalone`);
    }

    // Simulate normal work. Press Ctrl-C while this is running
    log.l(fn, 'running. Ctrl-C to trigger graceful shutdown.');
    log.l(fn, `(also try kill -TERM ${process.pid})`);

    // NOT unref'd - keeps the process alive even in disabled mode so the
    // signal-handler demo is reachable. In a real service one of your
    // resources (link socket, DB pool, HTTP server) would keep it alive.
    setInterval(() => {
        writeBuffer.size += 1;
        log.lD(fn, `tick - buffered writes: ${writeBuffer.size}`);
    }, 750);

})().catch((e) => {
    log.lE(fn, 'startup failed', e);
    process.exit(1);
});