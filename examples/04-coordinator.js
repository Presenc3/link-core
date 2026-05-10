'use strict';

/*
 * 04-coordinator.js
  * Dispatches jobs to workers. Listens for direct progress updates and
  * per-peer status pushes.
  * 
  * Run from the repo root: node examples/04-coordinator.js
**/

const {
  LinkClient,
  RpcRemoteError, RpcDisconnectError, RpcTimeoutError, RpcAbortError,
} = require('../src/index.js');

const fn = '[ Co-ordinator ]';

const link = new LinkClient({
  url    : process.env.LINK_URL              || 'ws://localhost:8080',
  secret : process.env.LINK_KEY_COORDINATOR  || 'dev-coord-key',
  kind   : 'coordinator'
});

// Receivers

// Job progress arrives as `direct` messages from the worker
link.on('direct', ({ from, type, data }) => {
  if (type === 'job.progress') {
    console.log(`${fn} ${from} #${data.jobId}: ${data.pct}%`);
  }
});

// Peer events
link.on('peer.connect',    (p) => console.log(`${fn} peer connect:    ${p.kind}`));
link.on('peer.disconnect', (p) => console.log(`${fn} peer disconnect: ${p.kind}`));

link.on('peer.status',     ({ from, status }) => {
  if (from === 'worker') {
    console.log(`${fn} worker status: load=${status?.load} ${status?.status || ''}`);
  }
});

// Error observability
link.on('rejected',       ({ reason }) => console.error(`${fn} hub rejected hello: ${reason}`));
link.on('protocol-error', ({ reason }) => console.warn (`${fn} protocol-error: ${reason}`));

// Dispatch

async function rpcWithRetry(to, type, data, { tries = 3, timeoutMs = 30_000 } = {}) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      return await link.rpc(to, type, data, { timeoutMs });
    } catch (e) {
      lastErr = e;
      
      // user cancelled - don't retry
      if (e instanceof RpcAbortError)  throw e;

      // remote said no - don't retry
      if (e instanceof RpcRemoteError) throw e;   

      if (e instanceof RpcTimeoutError    && i < tries) continue;
      if (e instanceof RpcDisconnectError && i < tries) continue;

      throw e;
    }
  }
  throw lastErr;
}

async function dispatchOnce(jobId) {
  console.log(`${fn} dispatching job #${jobId}`);
  const startedAt = Date.now();
  try {
    const result = await rpcWithRetry('worker', 'job.run', {
      jobId,
      payload: { steps: 5 },
    });

    console.log(`${fn} job #${jobId} complete in ${Date.now() - startedAt}ms:`, result);
  } catch (e) {
    if (e instanceof RpcRemoteError) console.warn(`${fn} job #${jobId} worker error: ${e.message}`);
    else if (e instanceof RpcTimeoutError) console.warn(`${fn} job #${jobId} timed out after retries`);
    else if (e instanceof RpcDisconnectError) console.warn(`${fn} job #${jobId} link down`);
    else throw e;
  }
}

// Wait until a worker peer exists
async function waitForPeer(kind, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;

  while (!link.getPeers().some((p) => p.kind === kind)) {
    const remaining = deadline - Date.now();

    if (remaining <= 0) throw new Error(`peer "${kind}" did not appear in ${timeoutMs}ms`);
    console.log(`${fn} waiting for ${kind}…`);
    
    try { await link.waitFor('peer.connect', { timeoutMs: Math.min(remaining, 5_000) }); }
    catch { /* loop */ }
  }
}

(async () => {
  await link.ready({ timeoutMs: 10_000 });
  console.log(`${fn} ready`);

  await waitForPeer('worker');
  console.log(`${fn} worker is here, starting dispatch loop`);

  let nextJobId = 1;
  setInterval(() => {
    dispatchOnce(nextJobId++).catch((e) => console.error(`${fn} unexpected: `, e));
  }, 5_000);

  // Fire one immediately so you see action right away
  dispatchOnce(nextJobId++).catch((e) => console.error(`${fn}  unexpected: `, e));
})().catch((e) => {
  console.error(`${fn} error: `, e);
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { console.log(`${fn} ${sig}, stopping`); link.stop(); process.exit(0); });
}