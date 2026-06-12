'use strict';

/**
 * Regression tests for the v0.6.0 lifecycle hardening pass:
 *   - #1 a displaced (same-kind) client stops instead of fighting back;
 *   - #2 `reconnectOnRejection: true` actually retries with backoff;
 *   - #3 a graceful `stop()` cannot re-enter `ready` mid-shutdown;
 *   - #5 an explicit `stop()` clears the entire outbox.
 *
 * Real hub on 19630; a throwaway raw-ws rejecting hub on 19631 for #2.
 */

const { test, describe } = require('node:test');
const assert             = require('node:assert');
const http               = require('node:http');
const { randomUUID }     = require('node:crypto');
const { WebSocketServer } = require('ws');

const { LinkClient } = require('../../src/index.js');
const { makeMsg }    = require('../../src/protocol.js');
const { setupHub, makeReadyClient, tick, DEFAULT_SECRET } = require('./_helpers.js');

const PORT = 19630;

const harness     = setupHub({ port: PORT });
const readyClient = makeReadyClient(harness);

describe('#1 displaced same-kind client does not fight back', () => {
  test('the older client stops (displaced) while the newer stays ready', async (t) => {
    const a = await readyClient({ kind: 'dup', reconnectInitialMs: 40 });

    const disconnects = [];
    let aReadyAgain = 0;
    a.on('disconnect', (i) => disconnects.push(i));
    a.on('ready', () => { aReadyAgain += 1; });

    const b = await readyClient({ kind: 'dup' });
    t.after(() => { a.stop({ drain: false }); b.stop({ drain: false }); });

    await tick(250);

    const displaced = disconnects.find((d) => d.displaced === true);
    assert.ok(displaced, 'A emitted a displaced disconnect');
    assert.strictEqual(displaced.willReconnect, false, 'displaced => no reconnect');
    assert.strictEqual(a.health().stopped, true, 'A is stopped after displacement');
    assert.strictEqual(aReadyAgain, 0, 'A never re-entered ready (no replacement war)');
    assert.strictEqual(b.isReady(), true, 'B (the newer client) is ready');
  });
});

describe('#3 stop() does not re-enter ready during shutdown', () => {
  test('an in-flight RPC settles on graceful stop without a spurious ready', async (t) => {
    const worker = await readyClient({
      kind: 'st-w',
      rpcHandlers: { slow: async () => { await tick(120); return { ok: true }; } },
    });
    const caller = await readyClient({ kind: 'st-c' });
    t.after(() => { worker.stop({ drain: false }); });

    let readyAfter = 0;
    caller.on('ready', () => { readyAfter += 1; });

    const p = caller.rpc('st-w', 'slow', {}, { timeoutMs: 2000 });
    await tick(20);
    await caller.stop();
    const res = await p.catch((e) => ({ err: e.code }));

    assert.strictEqual(caller.isReady(), false, 'not ready after stop()');
    assert.strictEqual(readyAfter, 0, 'no spurious ready emitted during shutdown');
    assert.deepStrictEqual(res, { ok: true }, 'the in-flight RPC still settled during drain');
  });
});

describe('#5 explicit stop clears the entire outbox', () => {
  test('queued non-RPC messages do not survive stop({ drain: false })', async (t) => {
    const c = await readyClient({ kind: 'cl-stop', maxBufferedBytes: 50 });
    t.after(() => c.stop({ drain: false }));

    Object.defineProperty(c.ws, 'bufferedAmount', { get: () => 10_000, configurable: true });

    c.send('cl-stop', 'evt', { n: 1 });
    c.publish('cl.topic', { n: 2 });   
    assert.ok(c._outbox.size >= 2, 'messages queued while congested');

    await c.stop({ drain: false });
    assert.strictEqual(c._outbox.size, 0, 'outbox fully cleared on explicit stop');
  });
});

describe('#2 reconnectOnRejection retries with backoff', () => {
  test('a rejecting hub is retried (repeated hellos), not wedged open', async (t) => {
    const httpd = http.createServer();
    const wss   = new WebSocketServer({ server: httpd });

    let hellos = 0;
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(String(raw)); } catch { return; }
        if (msg.type === 'hello') {
          hellos += 1;
          const ack = makeMsg(DEFAULT_SECRET, {
            id: randomUUID(), type: 'hello.ack', to: msg.data.kind, from: 'server',
            data: { ok: false, error: 'nope' },
          });
          ws.send(JSON.stringify(ack));
        }
      });
    });
    await new Promise((r) => httpd.listen(19631, '127.0.0.1', r));
    t.after(() => { wss.close(); httpd.close(); });

    const c = new LinkClient({
      url: 'ws://127.0.0.1:19631', secret: DEFAULT_SECRET, kind: 'roj', logger: null,
      reconnectOnRejection: true, reconnectInitialMs: 40, reconnectMaxMs: 40,
      helloAckDiagnosticMs: 0,
    });
    let rejected = 0, reconnecting = 0;
    c.on('rejected', () => { rejected += 1; });
    c.on('reconnecting', () => { reconnecting += 1; });
    t.after(() => c.stop({ drain: false }));
    c.start();

    await tick(300);

    assert.ok(hellos >= 2,       `hub should see repeated hellos (saw ${hellos})`);
    assert.ok(reconnecting >= 1, 'client scheduled at least one backoff reconnect');
    assert.ok(rejected >= 2,     `rejected fired per attempt (saw ${rejected})`);
  });
});