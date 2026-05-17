'use strict';

/**
 * Shared setup helpers for the integration suite.
 *
 * Each test file under `test/integration/` claims its own port range so the
 * files can run in parallel (Node's `--test` runs files concurrently by
 * default). The leading underscore on this filename keeps the test runner
 * from picking it up as a test file.
 *
 * Usage:
 *
 *   const { setupHub, makeReadyClient, tick } = require('./_helpers.js');
 *
 *   const hub = setupHub({ port: 19100 });
 *   const readyClient = makeReadyClient(hub);
 *
 *   describe('something', () => {
 *     test('does the thing', async () => {
 *       const c = await readyClient({ kind: 'whatever' });
 *       ...
 *     });
 *   });
 *
 * `setupHub()` registers `before`/`after` hooks against the active test
 * runner; the caller does not need to do any extra wiring.
 */

const { before, after } = require('node:test');

const { createHubServer, LinkClient } = require('../../src/index.js');

const DEFAULT_SECRET = 'integration-test';

/**
 * Spawn a shared hub-server for a single test file on the given port.
 * Returns `{ url, secret, get server() }` - the getter is so callers can
 * reach into `hub.server.hub` for event subscriptions inside tests.
 */
function setupHub({ port, secret = DEFAULT_SECRET, hubOpts = {} } = {}) {
  if (!Number.isFinite(port) || port <= 0) {
    throw new TypeError('setupHub: port must be a positive finite number');
  }

  const url = `ws://127.0.0.1:${port}`;
  let server = null;

  const handle = {
    url,
    secret,
    get server() { return server; },
    get hub()    { return server ? server.hub : null; },
  };

  before(async () => {
    server = createHubServer({
      secret, port, logger: null, handleSignals: false, ...hubOpts,
    });
    await server.start();
  });

  after(async () => {
    if (server) await server.stop();
  });

  return handle;
}

/**
 * Build a `readyClient(opts)` factory bound to the given hub handle.
 * Resolves once `link.ready()` has settled.
 */
function makeReadyClient(hub, { defaultTimeoutMs = 3000 } = {}) {
  return async function readyClient(opts = {}) {
    const c = new LinkClient({
      url: hub.url, secret: hub.secret, logger: null, ...opts,
    });
    await c.ready({ timeoutMs: defaultTimeoutMs });
    return c;
  };
}

/** Small async sleep helper - used to let the bus settle between sends. */
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

module.exports = { setupHub, makeReadyClient, tick, DEFAULT_SECRET };
