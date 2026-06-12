'use strict';

/*
 * 03-worker.js
 *
 * Does work for the coordinator. On startup, asks the vault for its
 * DB password (via peer-routed RPC, with bounded retry). Handles
 * `job.run` requests, simulating per-step work and sending progress
 * updates back via `link.send` (the directed-fire-and-forget primitive).
 * Reports its load every 10s via `makeStatus`.
 *
 * Uses the v0.5 library helpers instead of hand-rolling them:
 *   - waitForPeer(link, kind, opts)
 *       Event-driven peer-wait. Wakes on peer.connect AND peer.replaced
 *       (a same-kind socket replacement mid-wait). Honors opts.signal.
 *   - rpcWithRetry(link, to, type, data, opts)
 *       Bounded-retry RPC with sensible error classification:
 *       RpcAbortError / RpcRemoteError never retry; RpcTimeoutError /
 *       RpcDisconnectError do.
 *
 * If you want to see what these helpers do under the hood, the v0.5
 * source is small: src/helpers/rpc.js.
 *
 * Run from the repo root: node examples/03-worker.js
 */

const {
  LinkClient,
  RpcDisconnectError,
  RpcTimeoutError, RpcRemoteError,
} = require('../src/index.js');
const { waitForPeer, rpcWithRetry } = require('@presenc3/link-helpers');

const fn   = '[ Worker ]';
const NAME = `worker-${process.pid}`;

let dbPassword = null;
let load       = 0;

const link = new LinkClient({
  url    : process.env.LINK_URL        || 'ws://localhost:8080',
  secret : process.env.LINK_KEY_WORKER || 'dev-worker-key',
  kind   : 'worker',
  name   : NAME,

  // Pushed to the hub on connect and every statusIntervalMs
  makeStatus: () => ({
    load,
    status: load > 0 ? 'busy' : 'idle',
    name:   NAME,
  }),

  rpcHandlers: {
    'job.run': async ({ jobId, payload } = {}, msg) => {
      console.log(`${fn} job.run #${jobId} from ${msg.from}`);
      load += 1;

      try {
        const total = (payload && typeof payload.steps === 'number') ? payload.steps : 5;

        for (let i = 1; i <= total; i++) {
          await new Promise((r) => setTimeout(r, 200));

          /*
           * Progress is fire-and-forget. link.send returns true/false;
           * a throw means the link itself is no longer ready (which
           * we report and bail out of the progress loop on).
           */
          try {
            link.send(msg.from, 'job.progress', {
              jobId,
              pct: Math.round((i / total) * 100),
            });
          } catch (e) {
            console.warn(`${fn} could not send progress for #${jobId}: ${e.message}`);
            break;
          }
        }

        return { jobId, ok: true, by: NAME };
      } finally {
        load -= 1;
      }
    },
  },
});

link.on('ready',          ()             => console.log(`${fn} ready as ${NAME}`));
link.on('rejected',       ({ reason })   => console.error(`${fn} hub rejected hello: ${reason}`));
link.on('protocol-error', ({ reason })   => console.warn (`${fn} protocol-error: ${reason}`));

(async () => {
  await link.ready({ timeoutMs: 10_000 });

  /*
   * Wait for the vault to be present and connected before bootstrapping.
   * waitForPeer is event-driven (no polling) and resolves immediately
   * if the peer is already in the membership snapshot. Wakes on both
   * peer.connect and peer.replaced.
   */
  await waitForPeer(link, 'vault', { timeoutMs: 30_000 });

  /*
   * Fetch the DB password with bounded retry. rpcWithRetry's policy:
   *   - RpcRemoteError > throw immediately (vault said no, don't retry)
   *   - RpcAbortError  > throw immediately (caller cancelled)
   *   - RpcTimeoutError or RpcDisconnectError > retry, with jittered
   *     backoff = baseDelayMs * attempt + jitter
   */
  try {
    const { value } = await rpcWithRetry(link, 'vault', 'secrets.get', {
      name: 'db-password',
    }, {
      tries:       5,
      timeoutMs:   5_000,
      baseDelayMs: 500,
    });

    dbPassword = value;
    console.log(`${fn} got db-password from vault (length=${dbPassword.length})`);
  } catch (e) {
    if      (e instanceof RpcDisconnectError) console.warn(`${fn} disconnected during bootstrap - will retry on next reconnect`);
    else if (e instanceof RpcTimeoutError)    console.warn(`${fn} vault did not respond in time`);
    else if (e instanceof RpcRemoteError)     console.warn(`${fn} vault refused: ${e.message}`);
    else                                      console.warn(`${fn} could not fetch db-password: ${e.message}`);
  }

  console.log(`${fn} ready for work`);
})().catch((e) => {
  console.error(`${fn} error: `, e);
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { console.log(`${fn} ${sig}, stopping`); link.stop(); process.exit(0); });
}