'use strict';

/*
 * 03-worker.js
  * Does work for the coordinator. On startup, asks the vault for its DB
  * password (via peer-routed RPC). Handles `job.run` requests, simulating
  * per-step work and sending progress updates back via `link.send` (the
  * directed-fire-and-forget primitive). Reports its load every 10s via
  * makeStatus.
  *
  * Run from the repo root: node examples/03-worker.js
**/

const {
  LinkClient,      RpcDisconnectError,
  RpcTimeoutError, RpcRemoteError,
} = require('../src/index.js');

const fn = '[ Worker ]';
const NAME = `worker-${process.pid}`;

let dbPassword = null, load = 0;

const link = new LinkClient({
  url    :   process.env.LINK_URL        || 'ws://localhost:8080',
  secret :   process.env.LINK_KEY_WORKER || 'dev-worker-key',
  kind   :   'worker',
  name   :   NAME,

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

          // Progress is fire-and-forget. link.send returns true/false; a throw means the link itself is no longer ready (which we report and bail)
          try {
            link.send(msg.from, 'job.progress', {
              jobId,
              pct:  Math.round((i / total) * 100),
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

// Helper: wait until a peer of `kind` shows up in the latest peers.update
async function waitForPeer(kind, timeoutMs = 30_000) {
  if (link.getPeers().some((p) => p.kind === kind)) return;

  const deadline = Date.now() + timeoutMs;

  while (!link.getPeers().some((p) => p.kind === kind)) {
    const remaining = deadline - Date.now();

    if (remaining <= 0) throw new Error(`Peer "${kind}" did not appear within ${timeoutMs}ms`);

    try {
      await link.waitFor('peer.connect', { timeoutMs: Math.min(remaining, 5_000) });
    } catch {
      // No connect this tick; loop and check again
    }
  }
}

// Bootstrap: get our DB password from the vault, with simple retry
async function fetchSecret(name, { tries = 5 } = {}) {
  for (let i = 1; i <= tries; i++) {
    try {
      const { value } = await link.rpc('vault', 'secrets.get', { name }, 5_000);

      return value;
    } catch (e) {
      // remote said no - don't retry
      if (e instanceof RpcRemoteError) throw e; 

      if (i === tries) throw e;

      console.log(`${fn} secrets.get(${name}) attempt ${i} failed (${e.code || e.message}), retrying…`);

      await new Promise((r) => setTimeout(r, 500 * i));
    }
  }
}

link.on('ready', () => console.log(`${fn} ready as ${NAME}`));
link.on('rejected', ({ reason }) => console.error(`${fn} hub rejected hello: ${reason}`));
link.on('protocol-error', ({ reason }) => console.warn(`${fn} protocol-error: ${reason}`));

(async () => {
  await link.ready({ timeoutMs: 10_000 });
  await waitForPeer('vault');

  try {
    dbPassword = await fetchSecret('db-password');

    console.log(`${fn} got db-password from vault (length=${dbPassword.length})`);
  } catch (e) {
    if (e instanceof RpcDisconnectError) console.warn(`${fn} disconnected during bootstrap - will retry on next reconnect`);
    else if (e instanceof RpcTimeoutError) console.warn(`${fn} vault did not respond in time`);
    else console.warn(`${fn} could not fetch db-password: ${e.message}`);
  }

  console.log(`${fn} ready for work`);
})().catch((e) => {
  console.error(`${fn} error: `, e);
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { console.log(`${fn} ${sig}, stopping`); link.stop(); process.exit(0); });
}