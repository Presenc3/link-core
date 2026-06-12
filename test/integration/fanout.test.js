'use strict';

/**
 * Regression test for hub-side `status.update` conflation.
 *
 * The hub fans a peer's status out to every *other* peer, stamping the
 * envelope `from` as 'server' and carrying the originating kind in
 * `data.from`. When a recipient socket is congested, those fan-out
 * messages queue in that socket's per-socket outbox, where they are
 * conflated so a backlog of stale snapshots cannot pile up.
 *
 * Conflation must be keyed on the *originating peer* (`data.from`), not
 * the envelope `from` (which is always 'server'). Keying on the envelope
 * `from` collapsed every peer's status into a single queued item and
 * dropped all but the newest - so a congested recipient would silently
 * lose other peers' statuses entirely. This test pins a recipient's
 * hub-side `bufferedAmount` above a deliberately tiny cap to force the
 * queue path, then asserts one survivor *per originating peer*.
 *
 * Dedicated hub on port 19620 so this file runs in parallel with the rest
 * of the integration suite.
 */

const { test, describe } = require('node:test');
const assert             = require('node:assert');

const { setupHub, makeReadyClient, tick } = require('./_helpers.js');

const PORT = 19620;

const harness     = setupHub({ port: PORT, hubOpts: { maxBufferedBytes: 50 } });
const readyClient = makeReadyClient(harness);

describe('hub status.update conflation is per originating peer', () => {
  test('a congested recipient keeps the latest status from EACH peer', async (t) => {
    const r = await readyClient({ kind: 'sf-recipient' });
    const a = await readyClient({ kind: 'sf-a' });
    const b = await readyClient({ kind: 'sf-b' });
    const c = await readyClient({ kind: 'sf-c' });
    t.after(() => { for (const x of [r, a, b, c]) x.stop({ drain: false }); });

    await tick(50);
    let rws = null;
    for (const ws of harness.server.wss.clients) {
      if (ws.__kind === 'sf-recipient') rws = ws;
    }
    assert.ok(rws, 'located recipient hub-side socket');
    Object.defineProperty(rws, 'bufferedAmount', { get: () => 10_000, configurable: true });

    a._send('status.update', { tag: 'a1' });
    b._send('status.update', { tag: 'b1' });
    c._send('status.update', { tag: 'c1' });
    await tick(80);
    a._send('status.update', { tag: 'a2' });
    await tick(80);

    const queued = rws.__outbox.filter((it) => it.type === 'status.update');
    const byPeer = new Map(queued.map((it) => [it.data.from, it.data.status]));

    assert.strictEqual(queued.length, 3, 'one queued status.update per originating peer');
    assert.deepStrictEqual(byPeer.get('sf-a'), { tag: 'a2' }, 'peer a: newest status survives');
    assert.deepStrictEqual(byPeer.get('sf-b'), { tag: 'b1' }, 'peer b: status retained');
    assert.deepStrictEqual(byPeer.get('sf-c'), { tag: 'c1' }, 'peer c: status retained');
  });
});