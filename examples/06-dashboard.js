'use strict';

/*
 * 06-dashboard.js
 *
 * A live "what's happening on the bus right now" dashboard. Connects
 * to the hub as a passive observer peer (kind: dashboard), uses
 * createEventRecorder() to maintain a ring buffer of normalized hub
 * events alongside a full snapshot of bus state, and streams those
 * snapshots over Server-Sent Events.
 *
 * Open http://localhost:9000 in a browser, or
 *   curl -N http://localhost:9000/events
 * for the raw stream.
 *
 * Demonstrates three v0.5 surfaces together:
 *   - createLogger() - leveled logger, passed directly to LinkClient
 *     (no `{ log: l, warn: lW }` adapter required since v0.5).
 *   - attachClientObservability() - wires the standard listener bundle
 *     onto a LinkClient with one call.
 *   - createEventRecorder() - observation-only ring buffer + snapshot.
 *
 * Run from the repo root: node examples/06-dashboard.js
 */

const http = require('http');

const { LinkClient } = require('../src/index.js');
const {
    createLogger,
    createEventRecorder,
    attachClientObservability
} = require('@presenc3/link-helpers');

const ctx = 'dashboard';
const log = createLogger({ minLevel: 'INFO' });
const DASHBOARD_PORT = Number(process.env.DASHBOARD_PORT) || 9000;

/*
 * The dashboard authenticates against the same per-peer-keys hub the
 * other examples use. The hub's KEYS map in 01-hub.js doesn't have a
 * `dashboard` entry by default - set LINK_KEY_DASHBOARD in env to
 * something the hub recognizes (or add `dashboard: 'dev-dashboard-key'`
 * to 01-hub.js's KEYS).
 *
 * For a quick demo without modifying the hub, run it standalone with
 * LINK_KIND=worker and LINK_KEY=dev-worker-key - it'll join as a second
 * worker and observe its own bus.
 */
const link = new LinkClient({
    url    : process.env.LINK_URL  || 'ws://localhost:8080',
    secret : process.env.LINK_KEY  || process.env.LINK_KEY_DASHBOARD || 'dev-dashboard-key',
    kind   : process.env.LINK_KIND || 'dashboard',
    name   : 'dashboard',
    // Pass createLogger() straight in - no adapter object since v0.5
    logger : log,
});

// One-line observability: peer churn at INFO, drops at WARN, etc
attachClientObservability(link, { logger: log, context: 'link' });

const recorder = createEventRecorder(link, {
    ringSize:            50,
    heartbeatIntervalMs: 1_000,
});

/*
 * HTTP server: one SSE endpoint, one tiny HTML page.
 *
 * The SSE consumer registers with recorder.onSnapshot(fn). The first
 * frame is delivered synchronously inside onSnapshot; subsequent
 * frames arrive on every snapshot-trigger event (peer.connect/disconnect/
 * replaced/status, ready, rejected, disconnect) plus the heartbeat tick.
 */
const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(HTML);
        return;
    }

    if (req.url === '/events') {
        res.writeHead(200, {
            'content-type':  'text/event-stream',
            'cache-control': 'no-cache',
            'connection':    'keep-alive',
        });
      
        const send = (snap) => {
            try { res.write(`data: ${JSON.stringify(snap)}\n\n`); }
            catch { /* client disconnected; cleanup runs below */ }
        };

        const unsub = recorder.onSnapshot(send);
      
        req.on('close', () => unsub());
        return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
});

const HTML = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>link-core dashboard</title>
<style>
  body { font-family: ui-monospace, monospace; padding: 1rem; }
  h1 { font-size: 1rem; }
  .peer { display: inline-block; padding: .1rem .4rem; margin: .1rem;
          border-radius: .2rem; background: #efe; }
  .down { background: #fee; }
  .log  { white-space: pre-wrap; font-size: .8rem; color: #555;
          margin-top: 1rem; max-height: 50vh; overflow: auto; }
  .ready { color: #060; } .notready { color: #c00; }
</style>
<h1>link-core dashboard - <span id="status">connecting…</span></h1>
<div id="peers"></div>
<div class="log" id="log"></div>
<script>
const es = new EventSource('/events');
const $status = document.getElementById('status');
const $peers  = document.getElementById('peers');
const $log    = document.getElementById('log');

es.onmessage = (e) => {
  const snap = JSON.parse(e.data);
  $status.textContent = snap.ready ? 'ready' : (snap.connected ? 'verifying…' : 'disconnected');
  $status.className   = snap.ready ? 'ready' : 'notready';
  $peers.innerHTML    = (snap.peers || []).map((p) =>
    '<span class="peer ' + (p.connected ? '' : 'down') + '">' + p.kind + '</span>'
  ).join('');
  $log.textContent = (snap.eventLog || []).slice(-30).map((e) => {
    const t = new Date(e.t).toISOString().slice(11, 19);
    return t + ' ' + (e.kind + '/' + (e.from || '?')).padEnd(28) + JSON.stringify({...e, t: undefined, kind: undefined, from: undefined});
  }).join('\\n');
};
es.onerror = () => { $status.textContent = 'SSE error'; $status.className = 'notready'; };
</script>
</html>
`;

server.listen(DASHBOARD_PORT, () => {
    log.l(ctx, `HTTP on http://localhost:${DASHBOARD_PORT}`);
    log.l(ctx, `SSE  on http://localhost:${DASHBOARD_PORT}/events`);
});

(async () => {
    // ready() rejects fast in disabled mode (since v0.5); a real auth
    // failure surfaces as HelloRejectedError.
    await link.ready({ timeoutMs: 10_000 }).catch((e) => {
        log.lE(ctx, `link did not come up: ${e.message}`);
    });
})();

for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
        log.l(ctx, `${sig}, stopping`);
        recorder.close();

        try { link.stop(); } catch {}
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 1_000).unref?.();
    });
}