'use strict';

/**
 * link-core micro-benchmark.
 *
 *   npm run bench
 *
 * Spins up an in-process hub and two clients over a loopback WebSocket and
 * measures the paths that matter for a service bus:
 *
 *   - RPC round-trip latency  (sequential)  -> mean / p50 / p99 / max
 *   - RPC throughput          (concurrent)  -> calls/sec
 *   - send()  fire-and-forget throughput    -> msgs/sec
 *   - publish() fan-out throughput          -> msgs/sec
 *
 * This is intentionally a loopback micro-benchmark: it measures the
 * library's own per-message overhead (sign / verify / clone / JSON /
 * outbox bookkeeping), not network behaviour.
 */

const { createHubServer, LinkClient } = require('../src/index.js');

const SECRET   = 'bench-secret';
const PORT     = Number(process.env.BENCH_PORT) || 18830;
const URL      = `ws://127.0.0.1:${PORT}`;

const WARMUP_N      = 500;
const RPC_SEQ_N     = Number(process.env.BENCH_RPC_SEQ)     || 5_000;
const RPC_CONC_N    = Number(process.env.BENCH_RPC_CONC)    || 20_000;
const SEND_N        = Number(process.env.BENCH_SEND)        || 50_000;
const PUBLISH_N     = Number(process.env.BENCH_PUBLISH)     || 50_000;

const PAYLOAD = { kind: 'event', seq: 0, ts: 0, tags: ['a', 'b', 'c'], nested: { ok: true, n: 42 } };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitForCount(read, target, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (read() >= target) return resolve();
      if (Date.now() >= deadline) {
        return reject(new Error(`waitForCount: stuck at ${read()}/${target}`));
      }
      setTimeout(tick, 1);
    };
    tick();
  });
}

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    mean: sum / sorted.length,
    p50:  at(0.50),
    p99:  at(0.99),
    min:  sorted[0],
    max:  sorted[sorted.length - 1],
  };
}

function row(label, value) {
  console.log(`  ${label.padEnd(34)} ${value}`);
}

async function main() {
  console.log(`\nlink-core bench  -  node ${process.version}\n`);

  const server = createHubServer({
    secret: SECRET, port: PORT, logger: null, handleSignals: false,
  });
  await server.start();

  const a = new LinkClient({ url: URL, secret: SECRET, kind: 'bench-a', logger: null });
  const b = new LinkClient({ url: URL, secret: SECRET, kind: 'bench-b', logger: null, maxConcurrentRpc: 0 });

  let directCount = 0;
  let topicCount  = 0;
  b.handle('echo', (data) => data);
  b.on('direct', () => { directCount++; });
  b.subscribe('bench.topic', () => { topicCount++; });

  await Promise.all([
    a.ready({ timeoutMs: 5_000 }),
    b.ready({ timeoutMs: 5_000 }),
  ]);
  
  await sleep(100);

  // warmup (JIT, socket buffers)
  for (let i = 0; i < WARMUP_N; i++) await a.rpc('bench-b', 'echo', PAYLOAD);
  for (let i = 0; i < WARMUP_N; i++) a.send('bench-b', 'warmup', PAYLOAD);
  await waitForCount(() => directCount, WARMUP_N);
  directCount = 0;

  // sequential RPC round-trip latency
  {
    const samples = new Array(RPC_SEQ_N);
    const t0 = performance.now();
    for (let i = 0; i < RPC_SEQ_N; i++) {
      const s = performance.now();
      await a.rpc('bench-b', 'echo', { ...PAYLOAD, seq: i });
      samples[i] = performance.now() - s;
    }
    const wall = performance.now() - t0;
    const s = stats(samples);
    console.log('RPC round-trip latency  (sequential)');
    row('iterations', RPC_SEQ_N);
    row('mean',  `${s.mean.toFixed(3)} ms`);
    row('p50',   `${s.p50.toFixed(3)} ms`);
    row('p99',   `${s.p99.toFixed(3)} ms`);
    row('max',   `${s.max.toFixed(3)} ms`);
    row('throughput', `${Math.round(RPC_SEQ_N / (wall / 1000)).toLocaleString()} calls/sec`);
    console.log();
  }

  // concurrent RPC throughput
  {
    const t0 = performance.now();
    const batch = [];
    for (let i = 0; i < RPC_CONC_N; i++) batch.push(a.rpc('bench-b', 'echo', { ...PAYLOAD, seq: i }));
    await Promise.all(batch);
    const wall = performance.now() - t0;
    console.log('RPC throughput  (concurrent, all in flight)');
    row('iterations', RPC_CONC_N);
    row('wall', `${wall.toFixed(0)} ms`);
    row('throughput', `${Math.round(RPC_CONC_N / (wall / 1000)).toLocaleString()} calls/sec`);
    console.log();
  }

  // send() fire-and-forget throughput
  {
    directCount = 0;
    const t0 = performance.now();
    for (let i = 0; i < SEND_N; i++) a.send('bench-b', 'evt', { ...PAYLOAD, seq: i });
    await waitForCount(() => directCount, SEND_N);
    const wall = performance.now() - t0;
    console.log('send()  fire-and-forget throughput');
    row('iterations', SEND_N);
    row('wall', `${wall.toFixed(0)} ms`);
    row('throughput', `${Math.round(SEND_N / (wall / 1000)).toLocaleString()} msgs/sec`);
    console.log();
  }

  // publish() fan-out throughput
  {
    topicCount = 0;
    const t0 = performance.now();
    for (let i = 0; i < PUBLISH_N; i++) a.publish('bench.topic', { ...PAYLOAD, seq: i });
    await waitForCount(() => topicCount, PUBLISH_N);
    const wall = performance.now() - t0;
    console.log('publish()  fan-out throughput');
    row('iterations', PUBLISH_N);
    row('wall', `${wall.toFixed(0)} ms`);
    row('throughput', `${Math.round(PUBLISH_N / (wall / 1000)).toLocaleString()} msgs/sec`);
    console.log();
  }

  await a.stop();
  await b.stop();
  await server.stop();
  console.log('done.\n');
}

main().catch((e) => {
  console.error('bench failed:', e);
  process.exit(1);
});