'use strict';

/**
 * Integration tests: per-peer replay windows are released on disconnect.
 *
 * Regression coverage for the wiring of `PeerRecentIds.forget(kind)` into
 * both disconnect paths. The method existed and was unit-tested, but was
 * never called from the live code, so a peer's replay window lingered for
 * the life of the process (one `RecentIds` sub-map per distinct kind ever
 * seen). These tests assert the window is actually dropped when a peer
 * leaves - on the hub side and on the client side.
 *
 * Port range: 19600-19609.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { setupHub, makeReadyClient, tick, waitFor } = require('./_helpers.js');

const hub = setupHub({ port: 19600 });
const readyClient = makeReadyClient(hub);

describe('replay window release on disconnect', () => {
  test('hub forgets a peer\'s recent-id window when it disconnects', async () => {
    const before = hub.server.health().recentIdsSize;

    const a = await readyClient({ kind: 'ha_a' });
    const b = await readyClient({ kind: 'ha_b' });

    await waitFor(() => hub.server.health().recentIdsSize === before + 2,
      { label: 'two hellos to add two recent ids' });
    const withBoth = hub.server.health().recentIdsSize;

    await b.stop();

    await waitFor(() => hub.server.health().recentIdsSize === withBoth - 1,
      { label: "b's window to be forgotten on disconnect" });
    const afterDrop = hub.server.health().recentIdsSize;
    assert.equal(afterDrop, withBoth - 1);

    await a.stop();
  });

  test('client forgets a peer\'s recent-id window when that peer leaves', async () => {
    const a = await readyClient({ kind: 'cs_a' });
    const b = await readyClient({ kind: 'cs_b' });

    const gotDirect = new Promise((resolve) => {
      a.once('direct', (info) => resolve(info.msg.id));
    });

    b.send('cs_a', 'ping', { n: 1 });
    const directId = await gotDirect;

    await waitFor(() => a.recentIds.has('cs_b', directId),
      { label: "a to record b's message id in b's window" });

    await b.stop();

    await waitFor(() => !a.recentIds.has('cs_b', directId),
      { label: "a to drop b's replay window once b disconnects" });

    await a.stop();
  });
});