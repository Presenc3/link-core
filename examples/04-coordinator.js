'use strict';

/*
 * 04-coordinator.js
 *
 * Dispatches jobs to workers. Listens for direct progress updates and
 * per-peer status pushes.
 *
 * Uses the v0.5 library helpers instead of hand-rolling them:
 *   - waitForPeer(link, kind, opts)
 *   - rpcWithRetry(link, to, type, data, opts)
 *
 * See src/helpers/rpc.js for the source.
 *
 * Run from the repo root: node examples/04-coordinator.js
 */

const {
  LinkClient,
  waitForPeer, rpcWithRetry,
  RpcRemoteError, RpcDisconnectError, RpcTimeoutError,
} = require('../src/index.js');

const fn = '[ Co-ordinator ]';

const link = new LinkClient({
  url    : process.env.LINK_URL              || 'ws://localhost:8080',
  secret : process.env.LINK_KEY_COORDINATOR  || 'dev-coord-key',
  kind   : 'coordinator',
});

// Receivers  >>

// Job progress arrives as `direct` messages from the worker
link.on('direct', ({ from, type, data }) => {
  if (type === 'job.progress') {
    console.log(`${fn} ${from} #${data.jobId}: ${data.pct}%`);
  }
});

// Peer membership
link.on('peer.connect',    (p) => console.log(`${fn} peer connect:    ${p.kind}`));
link.on('peer.disconnect', (p) => console.log(`${fn} peer disconnect: ${p.kind}`));

link.on('peer.status', ({ from, status }) => {
  if (from === 'worker') {
    console.log(`${fn} worker status: load=${status?.load} ${status?.status || ''}`);
  }
});

// Error observability
link.on('rejected',       ({ reason }) => console.error(`${fn} hub rejected hello: ${reason}`));
link.on('protocol-error', ({ reason }) => console.warn (`${fn} protocol-error: ${reason}`));

// Dispatch >>

async function dispatchOnce(jobId) {
  console.log(`${fn} dispatching job #${jobId}`);
  const startedAt = Date.now();

  try {
    const result = await rpcWithRetry(link, 'worker', 'job.run', {
      jobId,
      payload: { steps: 5 },
    }, {
      tries:       3,
      timeoutMs:   30_000,
      baseDelayMs: 250,
    });

    console.log(`${fn} job #${jobId} complete in ${Date.now() - startedAt}ms:`, result);
  } catch (e) {
    if      (e instanceof RpcRemoteError)     console.warn(`${fn} job #${jobId} worker error: ${e.message}`);
    else if (e instanceof RpcTimeoutError)    console.warn(`${fn} job #${jobId} timed out after retries`);
    else if (e instanceof RpcDisconnectError) console.warn(`${fn} job #${jobId} link down`);
    else                                      throw e;
  }
}

(async () => {
  await link.ready({ timeoutMs: 10_000 });
  console.log(`${fn} ready`);

  // Block until a worker peer is present and connected
  await waitForPeer(link, 'worker', { timeoutMs: 30_000 });
  console.log(`${fn} worker is here, starting dispatch loop`);

  let nextJobId = 1;

  // Fire one immediately so you see action right away
  dispatchOnce(nextJobId++).catch((e) => console.error(`${fn} unexpected: `, e));

  setInterval(() => {
    dispatchOnce(nextJobId++).catch((e) => console.error(`${fn} unexpected: `, e));
  }, 5_000);
})().catch((e) => {
  console.error(`${fn} error: `, e);
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`${fn} ${sig}, stopping`);
    link.stop();
    process.exit(0);
  });
}