# @presenc3/link-core

Shared WebSocket link protocol, client, and hub for inter-service communication.

`link-core` gives you a small, opinionated way to tie multiple Node.js services together over WebSockets. It ships:

- **`LinkClient`** - a client that handles connection, reconnection, HMAC-signed messages, periodic status pushes, peer discovery, and request/response RPC.
- **`createHub`** - an embeddable hub that routes messages between peers, tracks status, enforces one connection per peer kind, and lets you expose your own server-side RPCs. Transport-agnostic - you bring the HTTP/WebSocket server.
- **`createHubServer`** - a batteries-included hub server that wraps `createHub` with an HTTP server, WebSocket server, a default `/health` route, an opt-in `/state` route, signal handling, and graceful shutdown. Use this when the hub *is* your service.

The library is unopinionated about roles - every service uses `LinkClient`, and the meaning of "coordinator", "worker", "publisher", etc. is up to you.

## Table of contents

- [Install](#install)
- [Quick start](#quick-start)
- [Connection lifecycle](#connection-lifecycle)
- [A two-service example](#a-two-service-example)
- [Custom server-side RPCs](#custom-server-side-rpcs)
- [Pub/sub topics](#pubsub-topics)
- [Directed fire-and-forget](#directed-fire-and-forget)
- [Dynamic RPC handlers](#dynamic-rpc-handlers)
- [Waiting for events](#waiting-for-events)
- [Health snapshot](#health-snapshot)
- [Errors](#errors)
- [Aborting an in-flight RPC](#aborting-an-in-flight-rpc)
- [Security & threat model](#security--threat-model)
- [Per-peer keys](#per-peer-keys)
- [Helpers](#helpers)
  - [Logger - `createLogger`](#logger---createlogger)
  - [Env - `num`, `bool`, `requireEnv`, `linkClientOptionsFromEnv`](#env---num-bool-requireenv-linkclientoptionsfromenv)
  - [Observability - `attachClientObservability`, `attachHubObservability`](#observability---attachclientobservability-attachhubobservability)
  - [RPC + topic helpers - `waitForPeer`, `rpcWithRetry`, `createSafePublisher`, `createSafeSend`](#rpc--topic-helpers---waitforpeer-rpcwithretry-createsafepublisher-createsafesend)
  - [Lifecycle - `installProcessHandlers`, `createGracefulShutdown`](#lifecycle---installprocesshandlers-creategracefulshutdown)
  - [Secrets - `loadSecrets`](#secrets---loadsecrets)
  - [Event recorder - `createEventRecorder`](#event-recorder---createeventrecorder)
- [API](#api)
  - [`new LinkClient(options)`](#new-linkclientoptions)
  - [`createHub(options)`](#createhuboptions)
  - [`createHubServer(options)`](#createhubserveroptions)
  - [Protocol helpers](#protocol-helpers)
  - [Message types](#message-types)
- [Message envelope](#message-envelope)
- [Behavior notes](#behavior-notes)
- [TypeScript](#typescript)
- [What's new in v0.5](#whats-new-in-v05)
- [What's new in v0.4](#whats-new-in-v04)
- [Examples](#examples)
- [License](#license)

## Install

```bash
npm install @presenc3/link-core
```

Requires Node.js **≥ 20**.

`link-core` ships dual CommonJS + ESM entry points, with hand-written TypeScript declarations. All three styles work without configuration:

```js
// CommonJS
const { LinkClient, createHubServer, RpcTimeoutError } = require('@presenc3/link-core');

// ESM
import { LinkClient, createHubServer, RpcTimeoutError } from '@presenc3/link-core';

// TypeScript - types resolve automatically via the package's `exports` map
import { LinkClient, type LinkClientOptions } from '@presenc3/link-core';
```

The package is marked `"sideEffects": false` so bundlers (webpack, Rollup, esbuild, Vite) can tree-shake unused exports.

## Quick start

There are two ways to run a hub:

- **`createHubServer`** - batteries-included. Spins up the HTTP server, WebSocket server, a default `/health` route, an opt-in `/state` route, signal handling, and graceful shutdown for you. Use this when the hub is the whole job.
- **`createHub`** - transport-agnostic. You bring the HTTP/WebSocket server. Use this when you're embedding the hub inside a larger app (Express, Fastify, an existing service).

### Run a hub (batteries-included)

```js
const { createHubServer } = require('@presenc3/link-core');

const server = createHubServer({
  secret: process.env.LINK_SECRET,
  port:   8080,
});

server.start();
```

That's the whole thing. You get:

- An HTTP server on `:8080` with `GET /health` already wired. (`GET /state` is opt-in: pass `enableStateRoute: true`.)
- A WebSocket server attached to it, routing connections into the hub.
- `SIGINT`/`SIGTERM` handlers that run a graceful shutdown (close WSS → close client sockets → terminate stragglers → close HTTP → stop hub).

See [`createHubServer`](#createhubserveroptions) below for the full options list, including server-side RPCs, custom routes, an `extraState` hook for `/state`, an `onShutdown` hook for cleanup like flushing files, and BYO HTTP server support.

### Run a hub (transport-agnostic)

If you want full control - e.g. you already have an Express app, a custom upgrade handler, HTTPS certs, or you don't want the default routes - use `createHub` and bring your own server:

```js
const http = require('http');
const { WebSocketServer } = require('ws');
const { createHub } = require('@presenc3/link-core');

const hub = createHub({
  secret: process.env.LINK_SECRET,
});

const server = http.createServer();
const wss = new WebSocketServer({ server });
wss.on('connection', (ws, req) => hub.attach(ws, req));

server.listen(8080, () => console.log('link hub on :8080'));
```

### Connect a client

```js
const { LinkClient } = require('@presenc3/link-core');

const link = new LinkClient({
  url:    'ws://localhost:8080',
  secret: process.env.LINK_SECRET,
  kind:   'worker',
  name:   'worker-1',
});

link.start();
```

That's enough to connect, authenticate with the shared secret, and stay connected (it'll reconnect with exponential backoff if the hub goes away).

> **`kind` is a singleton service identity, not a worker-pool name.** The hub enforces one connection per `kind`: if a second client connects with the same `kind` as a connected one, the *old* socket is closed. This is intentional - it prevents zombie connections after a hard crash + restart. If you want to run multiple instances of the same service in parallel (`worker-1`, `worker-2`, ...), give each a unique `kind`.

## Connection lifecycle

A `LinkClient` connection moves through three states. Knowing the difference matters when the hub is configured with [per-peer keys](#per-peer-keys) (where the hub may *reject* a hello) or when you want a "wait until I'm fully connected before doing X" hook.

| State        | Event       | What it means                                                  | Safe to publish/send/rpc? |
| ------------ | ----------- | -------------------------------------------------------------- | ------------------------- |
| `connected`  | `'connect'` | TCP/WebSocket open. `hello` has been sent.                     | No                        |
| `verified`   | `'verified'`| First signed message arrived. Crypto checks pass.              | No                        |
| `ready`      | `'ready'`   | Hub accepted the hello (`hello.ack.ok !== false`).             | **Yes**                   |

The reason `verified` and `ready` are split is architectural: `verified` fires when *any* correctly-signed frame from the hub has been processed, while `ready` requires the specific `hello.ack` with `ok !== false`. The `'rejected'` event handles the protocol-level case where the hub explicitly returns `hello.ack ok:false`. (Note: the bundled hub doesn't currently emit `ok:false` for unknown kinds - it silently drops to avoid confirming kind existence to attackers, and the client experiences this as a `'no-ack'` `protocol-error` after `helloAckDiagnosticMs` followed by a reconnect. The `verified`/`ready` split is forward-compatible with future hub policies that *do* return `ok:false`.) Treating `verified` as "OK to publish" would race against any of these rejection paths.

The recommended startup pattern:

```js
const link = new LinkClient({ url, secret, kind: 'worker' });

await link.ready({ timeoutMs: 5_000 });   // start()s for you if needed

link.publish('jobs.complete', { id: 42 });
```

`link.ready()`:

- Calls `start()` for you if the link isn't already running.
- Resolves with `{ kind, features }` when the hub accepts the hello.
- Rejects with `HelloRejectedError` (`code: 'HELLO_REJECTED'`) if the hub explicitly rejects.
- Rejects with a timeout error if `timeoutMs` elapses first.
- Rejects with an `AbortError` if `signal` aborts.
- Resolves immediately if the link is already ready.

If you don't want to use `await`:

```js
link.on('ready',    ({ kind, features }) => { /* gate work here */ });
link.on('rejected', ({ reason })          => { /* config error somewhere */ });
link.start();
```

By default, a `'rejected'` event also `stop()`s the client. Without this, a client with a wrong key would hammer the hub at the initial reconnect interval forever - see the v0.4.0 bugfix notes. To opt out (e.g. if you expect the hub's key registry to add your kind at runtime), set `reconnectOnRejection: true`.

Subscriptions are tracked locally and replay automatically on every `'ready'` transition, so reconnects don't require application-level re-subscribe logic.

## A two-service example

Say you have a **coordinator** that hands out jobs and a **worker** that does them. Both use the same `LinkClient`; the only difference is what they *do* with it.

### Worker

```js
const { LinkClient } = require('@presenc3/link-core');

const link = new LinkClient({
  url:    process.env.LINK_URL,
  secret: process.env.LINK_SECRET,
  kind:   'worker',
  name:   'worker-1',

  // Pushed to the hub on connect and every 10s.
  makeStatus: () => ({
    status: 'idle',
    at:     Date.now(),
  }),

  // Handlers for incoming RPC requests, keyed by rpcType.
  rpcHandlers: {
    'job.run': async ({ jobId, payload }) => {
      const result = await doTheWork(payload);
      return { jobId, result };
    },
  },
});

link.start();
```

### Coordinator

```js
const { LinkClient } = require('@presenc3/link-core');

const link = new LinkClient({
  url:    process.env.LINK_URL,
  secret: process.env.LINK_SECRET,
  kind:   'coordinator',
});

link.start();

async function dispatch(job) {
  // Send an RPC to any peer with kind 'worker' and await its response.
  const result = await link.rpc('worker', 'job.run', {
    jobId:   job.id,
    payload: job.payload,
  });
  console.log('Job done:', result);
}
```

Both sides are symmetric - the coordinator could just as easily expose its own `rpcHandlers`, and the worker could call `link.rpc(...)` back.

## Custom server-side RPCs

Any `rpc.request` with `to: 'server'` is handled by the hub itself, using the `rpcHandlers` you pass to `createHub`. The shape is identical to a client's `rpcHandlers`:

```js
const hub = createHub({
  secret: process.env.LINK_SECRET,
  rpcHandlers: {
    'ping': async () => ({ pong: true, now: Date.now() }),

    'time': async () => ({ now: Date.now() }),
  },
});
```

Clients then call them just like any other RPC:

```js
const { pong, now } = await link.rpc('server', 'ping', {});
```

### Example: a small KV store

The plug-in model makes it easy to layer features onto the hub without forking it. Here's a persisted JSON key-value store exposed as `kv.get` / `kv.set` / `kv.del` / `kv.list`:

```js
const fs = require('fs');
const path = require('path');

function createKvHandlers(filePath) {
  const kv = new Map(Object.entries(
    fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : {}
  ));

  let saveTimer = null;
  const scheduleSave = () => {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      const tmp = `${filePath}.${process.pid}.tmp`;
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(kv), null, 2));
      fs.renameSync(tmp, filePath);
    }, 250);
  };

  return {
    'kv.get':  async ({ key })        => ({ key, value: kv.get(key) ?? null }),
    'kv.set':  async ({ key, value }) => { kv.set(key, value); scheduleSave(); return { ok: true }; },
    'kv.del':  async ({ key })        => { kv.delete(key);    scheduleSave(); return { ok: true }; },
    'kv.list': async ({ prefix = '' }) => ({ keys: [...kv.keys()].filter(k => k.startsWith(prefix)) }),
  };
}

const hub = createHub({
  secret: process.env.LINK_SECRET,
  rpcHandlers: createKvHandlers('./data/kv.json'),
});
```

## Pub/sub topics

Beyond peer-routed RPC, link-core has a generic publish/subscribe channel for fan-out events. Any client can `subscribe` to a topic and `publish` to one; the hub maintains the topic→subscriber map and fans out each publish to every subscriber. Status broadcasts are a separate, narrower mechanism - pub/sub is for everything else.

```js
// Subscribe - handler fires for every publish on that topic.
link.subscribe('events.user.signup', (payload, msg) => {
  console.log('new user from', msg.from, '-', payload);
});

// Publish - fan-out to all current subscribers (excluding self).
link.publish('events.user.signup', { userId: 123, email: 'a@b.c' });

// Multiple handlers per topic share one hub-side subscription.
link.subscribe('events.user.signup', metricsHandler);

// Remove one handler, or all handlers for a topic.
link.unsubscribe('events.user.signup', metricsHandler);
link.unsubscribe('events.user.signup');
```

**Behavior notes:**

- **Topic names** must match `[a-zA-Z0-9._-]+`, length 1–256. Wildcards (`*`, `**`) are reserved for a future release and currently rejected. Invalid topics throw synchronously on `subscribe`/`publish`/`unsubscribe`.
- **No self-delivery in v0.4.** A peer that publishes to a topic does not receive its own message even if subscribed. (`worker-1` publishing `events.x` will not fire `worker-1`'s own `events.x` handler.)
- **At-most-once.** If a subscriber is offline at publish time, they miss the message - pub/sub does not queue or persist. If you need durability, use RPC against a hub-handled handler that writes to your own store.
- **Trusted `from`.** The hub overwrites `msg.from` with the publisher's authenticated kind before forwarding, same as RPC. Subscribers can rely on `msg.from` for routing/authorization.
- **Reconnect-safe.** Subscriptions are tracked client-side and replayed automatically on every `'ready'` transition. The hub forgets a peer's subscriptions on disconnect; the client re-establishes them on reconnect with no application-code involvement.
- **Backpressure-aware.** If a subscriber's send buffer is full (`bufferedAmount > maxBufferedBytes`), the hub drops the message *for that subscriber only*, not for the whole topic.
- **Hub feature flag.** The hub advertises `'topics'` in `hello.ack.data.features`; the client captures this as `link.hubFeatures`. `publish()` throws `FeatureUnsupportedError` if the hub doesn't advertise topic support - including against v0.3.x hubs that don't advertise any features at all (the client treats "no advertisement" as "feature absent" so a publish against a hub that won't act on it fails loud rather than silently dropping).

### Introspection: `link.topic.list`

The hub provides a built-in server RPC for listing subscribers:

```js
// Subscribers of a single topic.
const { subscribers } = await link.rpc('server', 'link.topic.list', {
  topic: 'events.user.signup',
});
// → { topic: 'events.user.signup', subscribers: ['analytics', 'mailer'] }

// All topics + subscribers (omit `topic`).
const { topics } = await link.rpc('server', 'link.topic.list', {});
// → { topics: [{ topic: '...', subscribers: [...] }, ...] }
```

The `link.` prefix is reserved for built-in server RPCs. You can override any built-in by registering your own handler with the same name (e.g. for permission-aware topic listing).

## Directed fire-and-forget

`link.send(to, type, data)` is the third primitive alongside `rpc()` and `publish()`:

|             | one recipient | many recipients |
|-------------|---------------|-----------------|
| **needs response**  | `link.rpc(to, type, data)` | - |
| **fire-and-forget** | `link.send(to, type, data)`  | `link.publish(topic, payload)` |

Use it for progress notifications, telemetry, signals, or anything where the sender doesn't need a reply and doesn't want the round-trip cost of an RPC.

```js
// Sender
link.send('coordinator', 'job.progress', { jobId: 123, pct: 50 });

// Receiver
link.on('direct', ({ from, type, data, msg }) => {
  if (from === 'worker' && type === 'job.progress') {
    console.log(`[${data.jobId}] ${data.pct}%`);
  }
});
```

**Behavior notes:**

- **At-most-once.** If the target peer is offline at delivery time, the message is dropped silently - there is no queueing. Use `rpc()` (with retries on `RpcDisconnectError`) when you need delivery feedback.
- **Trusted `from`.** The hub overwrites `msg.from` with the sender's authenticated `kind` before forwarding, same as RPC and pub/sub. Receivers can rely on `from` for routing/authorization.
- **Backpressure-aware.** Returns `false` if the local send buffer is over `maxBufferedBytes` (a `'backpressure'` event was emitted). Returns `true` on success.
- **Hub feature flag.** The hub advertises `'direct'` in `hello.ack.data.features`. `send()` throws `FeatureUnsupportedError` if the hub doesn't advertise it (including against v0.3.x hubs that don't advertise any features), so you fail loud rather than silently dropping.
- **Validation.** Throws synchronously on a missing/non-string `to` or `type`, or if the link is not ready.

## Dynamic RPC handlers

The constructor's `rpcHandlers` is the right place for handlers that exist for the lifetime of the client. For plugins or features that come and go - or for "register on every link-up" patterns - use `handle()` / `unhandle()`:

```js
// Register
const previous = link.handle('auth.refresh', async ({ token }) => {
  return { newToken: await refreshToken(token) };
});

// previous is the previous handler for that rpcType, or undefined.
// Re-registering the same handler on every 'ready' is safe and idempotent.
link.on('verified', () => {
  link.handle('auth.refresh', refreshHandler);
});

// Remove
link.unhandle('auth.refresh');  // → true if a handler was removed, false otherwise
```

`handle()` replaces silently - no warning on collision - because the intended use case is plugins that re-register on every reconnect. If you want collision detection, check `link.rpcHandlers[rpcType]` before calling.

## Waiting for events

`link.waitFor(event, opts)` replaces the verbose `await new Promise(r => link.once('ready', r))` pattern with a one-liner that supports a real timeout and an `AbortSignal`:

```js
// Block until ready, with a hard cap. (For ready specifically, link.ready({ timeoutMs })
// is even tidier - it also calls start() if needed.)
await link.waitFor('ready', { timeoutMs: 5000 });

// Wait for the next peer connect.
const peer = await link.waitFor('peer.connect');
console.log('joined:', peer.kind);

// Cancellable wait.
const ac = new AbortController();
setTimeout(() => ac.abort(), 1000);
try {
  await link.waitFor('peer.disconnect', { signal: ac.signal });
} catch (e) {
  if (e.name === 'AbortError') console.log('cancelled');
}
```

`waitFor` always waits for the *next* occurrence - it does not check current state. For "now or wait" semantics on `'ready'`, prefer `link.ready({ timeoutMs })` which already does the check; for other events, check first:

```js
async function ensurePeer(link, kind, timeoutMs = 5000) {
  if (link.getPeers().some((p) => p.kind === kind)) return;
  while (true) {
    const p = await link.waitFor('peer.connect', { timeoutMs });
    if (p.kind === kind) return;
  }
}
```

## Health snapshot

`link.health()` returns a synchronous, allocation-light snapshot suitable for `/health` integrations and dashboards:

```js
const h = link.health();
// {
//   connected:         true,
//   verified:          true,
//   ready:             true,
//   lastVerifiedAt:    1730000000000,  // ms since epoch, or null if never
//   peerCount:         3,
//   pendingRpcCount:   0,
//   subscriptionCount: 2,
//   bufferedAmount:    0,
//   reconnectAttempt:  0,
//   stopped:           false,
// }
```

Three fields are worth highlighting:

- **`ready`** is the "hub has accepted us, safe to publish/send/rpc" gate. `verified` only tells you crypto checks pass; `ready` adds "and the hub said yes". With per-peer-keys hubs, the two can differ briefly.
- **`lastVerifiedAt`** is updated on *every* verified message, not just the first. That makes it useful for "we connected but haven't heard from the hub in a while" alerts - a bare `connected` check would happily report green during a one-way ws read failure.
- **`reconnectAttempt`** is non-zero when we're stuck in the reconnect loop. Surface it as a warning in dashboards.

A typical `/health` integration:

```js
app.get('/health', (req, res) => {
  const h = link.health();
  const stale = h.lastVerifiedAt && (Date.now() - h.lastVerifiedAt) > 60_000;
  const ok = h.connected && h.ready && !stale && h.reconnectAttempt === 0;
  res.status(ok ? 200 : 503).json({ ok, ...h });
});
```

## Errors

`rpc()` rejects with one of these typed errors. They all extend `Error` and carry a stable `code` string, so existing `catch (e) { e.message }` paths keep working - but `instanceof` and `err.code` are the recommended checks for new code:

| Class                     | `code`                | Thrown when                                                                                              |
|---------------------------|-----------------------|----------------------------------------------------------------------------------------------------------|
| `RpcTimeoutError`         | `RPC_TIMEOUT`         | The RPC didn't get a response within `timeoutMs`.                                                        |
| `RpcDisconnectError`      | `RPC_DISCONNECT`      | The link disconnected (or was stopped) while the RPC was in flight.                                      |
| `RpcAbortError`           | `RPC_ABORT`           | The caller-supplied `AbortSignal` fired before the response arrived.                                     |
| `RpcRemoteError`          | `RPC_REMOTE`          | The remote handler threw, or the hub returned an error response (e.g. target offline, unknown rpcType).  |
| `BackpressureError`       | `BACKPRESSURE`        | The local send buffer was over `maxBufferedBytes` (synchronous reject for `rpc()`).                      |
| `LinkNotReadyError`       | `LINK_NOT_READY`      | `publish()` / `send()` / `rpc()` / `ready()` called before the link is `'ready'` (no socket, hello not yet acked, or after `stop()`). Synchronous reject. |
| `FeatureUnsupportedError` | `FEATURE_UNSUPPORTED` | `publish()` / `send()` called against a hub that doesn't advertise the required feature.                 |
| `ProtocolError`           | `PROTOCOL_ERROR`      | Available for callers that need to throw rather than emit; mostly emitted via `'protocol-error'` events today. |
| `HelloRejectedError`      | `HELLO_REJECTED`      | The hub rejected the client's hello (`hello.ack ok:false`). What `link.ready()` rejects with.            |
| `RpcError` *(base)*       | `RPC_ERROR`           | Common base for the RPC errors above.                                                                    |
| `LinkError` *(base)*      | `LINK_ERROR`          | Common base for everything in this table.                                                                |

Each error carries call-site context - `to`, `rpcType`, `id` on the RPC ones; `timeoutMs` on `RpcTimeoutError`; `bufferedAmount` and `maxBufferedBytes` on `BackpressureError`; `op` on `LinkNotReadyError`; `op` and `feature` on `FeatureUnsupportedError`; `reason` on `ProtocolError` and `HelloRejectedError`. Useful when wiring up retries:

```js
const {
  RpcTimeoutError, RpcDisconnectError, RpcAbortError, RpcRemoteError,
} = require('@presenc3/link-core');

async function rpcWithRetry(link, to, type, data, { tries = 3 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await link.rpc(to, type, data);
    } catch (e) {
      lastErr = e;
      if (e instanceof RpcAbortError)      throw e;       // user wants out
      if (e instanceof RpcRemoteError)     throw e;       // remote said no - don't retry
      if (e instanceof RpcTimeoutError)    continue;      // retry
      if (e instanceof RpcDisconnectError) continue;      // retry
      throw e;                                            // unknown - don't retry
    }
  }
  throw lastErr;
}
```

> **Note on `RpcRemoteError`.** The wire format only carries an error string, so `RpcRemoteError.message` is the remote-supplied string verbatim. The class exists primarily for `instanceof` discrimination against transport-level failures - your retry policy almost certainly should not retry on `RpcRemoteError`, because the failure is the remote's, not the link's.

## Aborting an in-flight RPC

`link.rpc()` accepts an options object with `{ timeoutMs, signal }` as the fourth argument:

```js
const ac = new AbortController();
setTimeout(() => ac.abort(), 30_000);

try {
  const result = await link.rpc('worker', 'job.run', payload, {
    timeoutMs: 60_000,
    signal:    ac.signal,
  });
} catch (e) {
  if (e.code === 'RPC_ABORT')   console.log('user cancelled');
  if (e.code === 'RPC_TIMEOUT') console.log('took too long');
}
```

The legacy positional form `link.rpc(to, type, data, timeoutMs)` is still accepted - pass a `number` for the old behavior.

> **Note.** Aborting only releases the *caller* side: the local pending entry is removed and the promise rejects with `RpcAbortError`. The wire request is *not* cancelled - the remote handler may still complete and the response will be logged-and-dropped on arrival. A `rpc.cancel` wire message is planned for a later release.

## Security & threat model

`link-core` is designed for **trusted-network, single-trust-zone** deployments - services you run, talking to services you run, on infrastructure you control. Read this section before exposing a hub on a network you don't fully control.

**What the protocol gives you**

- **Wire integrity.** Every message carries an HMAC-SHA256 signature over its envelope. Tampering with any field breaks the signature and the message is dropped. Verification is constant-time.
- **Anti-impersonation between authenticated peers.** Once a socket completes the `hello` handshake, the hub binds it to that `kind` and overwrites the `from` field on every forwarded message. A peer cannot forge messages claiming to come from another peer.
- **Replay protection (since v0.4.0).** Both client and hub drop messages whose `ts` is outside the configured `replayWindowMs` (default ±5 minutes), and remember message `id`s for that duration to drop duplicates. An attacker who captures a signed message on the wire and re-sends it within the window will see it dropped on the second arrival; outside the window, dropped on the first. Window and id-cache size are configurable; set `replayWindowMs: 0` to disable. **Caveat:** this defends against passive eavesdroppers replaying captured frames. It does *not* defend against an active attacker who has the shared secret - they can sign their own fresh messages.
- **Bounded incoming payload size (since v0.4.0).** Default cap of 1 MiB on incoming WebSocket frames, enforced both at the transport and in-handler. Configurable via `maxMessageBytes`.
- **Backpressure cap (since v0.4.0).** Every outgoing send checks `ws.bufferedAmount` against `maxBufferedBytes` (default 4 MiB) and drops or rejects rather than buffering unboundedly. A single slow or stuck peer cannot OOM the hub by refusing to drain its socket.
- **Bounded retained hello (since v0.4.0).** The hub sanitizes each peer's hello payload to a small whitelist (`kind`, `name`, `pid`, `startedAt`) before persisting it in memory, dropping unknown fields and capping string lengths. A peer that puts a 50 MB string in `name` no longer pins hub memory until restart.

**What the protocol does *not* give you**

- **No rate limiting.** A client with a valid secret can flood the hub (within the per-message size cap).
- **No transport encryption built-in.** Run behind `wss://` (terminated at a reverse proxy or directly) if the network isn't trusted. The HMAC protects against tampering, not eavesdropping.
- **In shared-secret mode, no per-peer credentials.** The shared secret is all-powerful: anyone with it can connect *as any `kind`* of their choosing. They cannot impersonate per-message after handshake (see above), but they can hello-bomb to displace a legitimate peer. Use [per-peer keys](#per-peer-keys) (since v0.4.0) to remove this concern.

**Deployment recommendations**

- Run the hub on `localhost` or a private network. If you must cross a network boundary, terminate `wss://` at a reverse proxy (nginx, Caddy, Cloudflare) - don't expose `ws://` over the public internet.
- Treat secrets like database passwords. Don't commit them. With per-peer keys, you can rotate one peer's key without restarting everyone.
- The `/state` route on `createHubServer` exposes peer kinds, hello payloads, and last-known status. **In v0.5 the default is `enableStateRoute: false`**; opt in explicitly for internal dashboards / dev (`createHubServer({ enableStateRoute: true })`). If you opt in *and* bind to `0.0.0.0`, the hub also emits an informational warning at startup.
- When embedding the hub inside an existing HTTP server (`server: yourServer`), **always pass a `path`** unless you're certain no other code on that server uses WebSocket upgrades. Without it, the hub intercepts every upgrade.

## Per-peer keys

By default, `createHub({ secret: 'sometext' })` runs in **shared-secret mode** - every peer signs and verifies with the same key. This is fine for tightly-scoped, fully-trusted deployments (a coordinator and three workers in the same VPC), but it has a downside: the secret is all-powerful. Anyone holding it can authenticate as any `kind`. Rotating it requires a coordinated restart of every peer.

Per-peer keys (since v0.4.0) lets you give each peer its own HMAC key. Pass an object or a function as `secret`:

```js
// Static map. Hellos for unknown kinds are silently dropped
const hub = createHub({
  secret: {
    coordinator: process.env.LINK_KEY_COORD,
    'worker-a':  process.env.LINK_KEY_WORKER_A,
    'worker-b':  process.env.LINK_KEY_WORKER_B,
  },
});
```

```js
// Dynamic resolver. Async permitted; returning null means "no key for that kind"
const hub = createHub({
  secret: async (kind) => {
    const v = await vault.get(`link/${kind}`);
    return v ? v.value : null;
  },
});
```

Under the hood, the hub becomes a **re-signing relay**: it verifies each incoming message with the sender's key, then re-signs each outgoing forward (peers.update, status broadcasts, RPC requests/responses, topic messages, direct messages) with the recipient's key. The `from` field is still stamped from the authenticated socket, so the trust property "a peer cannot forge messages from another peer" is preserved. The wire format does not change - only the key used for HMAC differs.

Each `LinkClient` only ever needs its own key:

```js
// On worker-a
const link = new LinkClient({
  url:    'ws://hub:8080',
  secret: process.env.LINK_KEY_WORKER_A,   // its own key only
  kind:   'worker-a',
});
```

**What this gives you, vs shared-secret:**

- **Revocation per peer.** Drop a kind from the map, or have the resolver return null, and that peer can no longer authenticate. Other peers keep working without restart.
- **Compromise containment.** A leaked `worker-a` key cannot be used to authenticate as `coordinator` (the hub will look up `coordinator`'s key and fail to verify the leaked-key signature).
- **Auditable identity.** Operators can see exactly which peers exist by the registered kinds. (In dynamic-resolver mode, by querying the backing vault/DB.)

**What it doesn't change:**

- The wire envelope (still HMAC over JSON; clients running v0.3.x can connect to v0.4 hubs in shared-secret mode without changes).
- The hub trust model in general - the hub still sees plaintext, still controls fan-out, still trusts the bound `kind` after hello. End-to-end encryption is not in scope.
- Rate limiting (still none). A peer with a valid key can still flood within the per-message size cap.

**Hello rejection behavior.** When a hello cannot be verified - wrong key, unknown kind, or malformed - the hub drops the message silently and lets the [pre-hello timeout](#api) (default 10 s) reap the socket. The hub does not return `hello.ack ok:false` for these cases, on purpose: it would confirm to an attacker that a particular kind exists. The client sees the diagnostic `protocol-error` reason `'no-ack'` after `helloAckDiagnosticMs` and reconnects with growing backoff.

If your application *does* want explicit rejection feedback (e.g. for an internal admin tool), surface it via your own RPC after `'ready'` rather than embedding it in the auth handshake.

## Helpers

Since v0.5.0, `link-core` ships a collection of helper functions covering the patterns that kept showing up in my own use in services - a leveled logger, env coercion, observability listener bundles, RPC retries and safe-publish wrappers, graceful shutdown, a secrets loader for secrets vault client, and a dashboard-friendly event recorder.

Everything is also reachable via the `./helpers` subpath if you'd rather keep the helper namespace separate from the protocol/client/hub surface at the package root:

```js
// flat from the root
const { createLogger, attachClientObservability, loadSecrets } = require('@presenc3/link-core');

// namespaced via the subpath
const helpers = require('@presenc3/link-core/helpers');
helpers.createLogger();
```

Both forms point at the same functions. Pick whichever fits the call site.

### Logger - `createLogger`

A four-level logger (DEBUG/INFO/WARN/ERROR) with a structured `[HH:MM:SS.mmm] [context] message` prefix and an optional `errorSink` for mirroring errors to a webhook, Sentry, etc.

```js
const { createLogger, LEVELS } = require('@presenc3/link-core');

const log = createLogger({
  minLevel: LEVELS.INFO,                 // or 'INFO' / 'DEBUG' / etc
  errorSink: async (ctx, msg, err) => {  // optional; receives Error instances passed to lE()
    await postToDiscord({ ctx, msg, err });
  },
});

log.l ('boot', 'starting up');            // info
log.lD('boot', 'verbose detail');         // debug (suppressed at minLevel=INFO)
log.lW('link', 'unexpected, but recoverable');
log.lE('link', 'init failed', err);       // also fires errorSink
```

All four methods take `(context, message, ...args)`. The `errorSink` is fire-and-forget - sink failures are logged via `console.error` and never propagate.

The default `minLevel` is `INFO` when `NODE_ENV === 'production'` and `DEBUG` otherwise. Override via `setMinLevel(...)` at runtime if you need to switch on the fly.

### Env - `num`, `bool`, `requireEnv`, `linkClientOptionsFromEnv`

Coercion helpers that return `undefined` for missing/empty inputs (so callers can `?? defaultValue` without sentinel collisions on `0` / `false`), plus a one-shot assembler for the standard LinkClient option bag.

```js
const { LinkClient } = require('@presenc3/link-core');
const { requireEnv, linkClientOptionsFromEnv } = require('@presenc3/link-core');

requireEnv(['LINK_URL', 'LINK_KIND', 'LINK_SECRET']);   // throws listing every missing key

const link = new LinkClient({
  /* reads
   * LINK_URL,    LINK_KIND,
   * LINK_SECRET, LINK_HASH_ALGO,
   * LINK_PERMESSAGE_DEFLATE, LINK_RECONNECT_ON_REJECTION,
   * LINK_RECONNECT_JITTER,   LINK_REPLAY_WINDOW_MS,
   * LINK_MAX_RECENT_IDS,     LINK_MAX_MESSAGE_BYTES,
   * LINK_MAX_BUFFERED_BYTES
  **/
  ...linkClientOptionsFromEnv(),
  name: 'My Service',
  makeStatus,
  rpcHandlers,
  // A LeveledLogger from createLogger() satisfies the two-method
  // Logger shape directly - no adapter required. Pre-v0.5 code used
  // `{ log: log.l, warn: log.lW }`; that still works for back-compat.
  logger: log,
});
```

Pass `linkClientOptionsFromEnv(env, { envPrefix: 'FOO_' })` to read `FOO_URL` / `FOO_KIND` / etc. instead.

### Observability - `attachClientObservability`, `attachHubObservability`

Wire the standard listener bundles onto a `LinkClient` or hub `EventEmitter`. Membership churn at info, security-relevant drops at warn, per-RPC trace at debug (or info when `verbose: true`); `protocol-error` reasons are classified into "concerning" (worth surfacing) vs "noisy" (clock drift, dedupe) and routed accordingly.

```js
const { attachClientObservability, attachHubObservability } = require('@presenc3/link-core');

attachClientObservability(link, { logger: log, context: 'link' });
attachHubObservability(server.hub, { logger: log, context: 'hub' });
```

To extend the default reason classification without losing the built-ins, pass `extraConcerningReasons: ['my-custom-reason']`. To replace it outright, pass `concerningReasons: [...]`. The defaults are also exported (`DEFAULT_CLIENT_CONCERNING_REASONS`, `DEFAULT_HUB_CONCERNING_REASONS`) if you want to inspect or build atop them.

### RPC + topic helpers - `waitForPeer`, `rpcWithRetry`, `createSafePublisher`, `createSafeSend`

`waitForPeer(link, kind, { timeoutMs, requireConnected })` blocks until a peer of the given kind appears (and, by default, is connected). Event-driven - uses `link.waitFor('peer.connect', ...)` internally, no polling.

```js
await waitForPeer(link, 'vault', { timeoutMs: 30_000 });
```

`rpcWithRetry(link, to, type, data, { tries, timeoutMs, baseDelayMs, signal })` retries on transient failures (`RpcTimeoutError`, `RpcDisconnectError`) but never on `RpcAbortError` (caller cancelled) or `RpcRemoteError` (handler said no). Linear backoff with jitter.

```js
const result = await rpcWithRetry(link, 'worker', 'job.run', payload, { tries: 3 });
```

`createSafePublisher(link, { logger })` and `createSafeSend(link, { logger })` wrap `link.publish` / `link.send` so they never throw on the common transient conditions (mid-reconnect, hub doesn't advertise topics/direct). The first feature-unsupported skip logs at warn, subsequent skips at debug - useful when running against a v0.3-era hub that doesn't advertise capabilities and you'd otherwise drown in identical warnings.

```js
const publish = createSafePublisher(link, { logger: log, context: 'handlers' });
publish('user.changed', { id: 42 });   // returns boolean - false on any drop

const send = createSafeSend(link, { logger: log, context: 'fanout' });
send('worker', 'job.queued', { id: 42 });
```

Pass `featureCheck: true` to short-circuit the publish/send entirely when `link.hubFeatures` doesn't include the feature - avoids one wasted throw-per-call on v0.3 hubs.

### Lifecycle - `installProcessHandlers`, `createGracefulShutdown`

Kept separate so the shutdown procedure can be unit-tested without touching `process.on(...)`.

```js
const { installProcessHandlers, createGracefulShutdown } = require('@presenc3/link-core');

const shutdown = createGracefulShutdown({
  logger: log,
  timeoutMs: 30_000,
  steps: [
    () => link.stop(),
    async () => { await closeDBs(); },
  ],
});

installProcessHandlers({ shutdown, logger: log });
```

`installProcessHandlers` wires up `SIGINT`, `SIGTERM`, `uncaughtException`, and `unhandledRejection`. Returns an `uninstall()` function that removes everything it added (useful in tests).

`createGracefulShutdown` runs its steps sequentially and is bounded by a watchdog timer that force-exits if anything hangs. A throwing step is logged via `lE` but does not stop subsequent steps from running. Calling the returned `shutdown()` while one is already in progress is a no-op.

### Secrets - `loadSecrets`

Fetch a `{ envName: 'sec/<ns>/<rest>' }` mapping from the `link_secs` vault peer at boot, optionally subscribing to `secs.changed.<ns>` for hot-reload on rotation.

```js
const { loadSecrets, LOADED_SECRETS_UNWATCH } = require('@presenc3/link-core');

const cfg = await loadSecrets(link, {
  OPENAI_API_KEY: 'sec/shared/openai',
  SENTRY_DSN:     'sec/datastore/sentry-dsn',
}, {
  watch: true,                        // requires a v0.4+ hub
  logger,                             // optional LeveledLogger; uses console.warn otherwise
  onChange: ({ name, action, newValue }) => {
    // rebuild your frozen cfg snapshot, re-init clients, etc.
  },
});

// later, on shutdown / test teardown:
cfg[LOADED_SECRETS_UNWATCH]?.();
```

`loadSecrets` waits for `link.ready()` *and* for a vault peer to be present before fetching, both bounded by a single cumulative `timeoutMs` budget (default 30 s; every individual `secs.get` RPC shares the same deadline). It throws if any secret is missing on the initial load or returned with the wrong type - fail-fast at boot is much better than silently running with `undefined` keys.

The returned object is **mutated in-place** when watched secrets change, so a frozen snapshot held by the caller will go stale. Use `onChange` to rebuild your own snapshot.

When `watch: true`, the returned object also carries a non-enumerable `[LOADED_SECRETS_UNWATCH]` method (Symbol-keyed so it can't collide with a secret env name) that removes the rotation subscriptions. Idempotent and only removes the helper's own subscriptions; caller-installed handlers on the same topic are untouched.

**Rotation event schema.** When `watch: true`, the helper subscribes to `secs.changed.<ns>` for every namespace referenced in the mapping. The vault is expected to publish payloads of shape:

```ts
{
  path: string,                // e.g. 'sec/shared/openai'
  action: 'set' | 'del'        // 'set' triggers a refetch via secs.get; 'del' clears the key locally
}
```

Paths the helper doesn't care about are silently ignored, so it's safe for the vault to broadcast a single `secs.changed.<ns>` event covering all paths in that namespace.

### Event recorder - `createEventRecorder`

A dashboard-friendly observer that wraps a `LinkClient` with a bounded ring buffer of recorded events plus a snapshot of current bus state. Designed for SSE consumers (or any "what's happening right now" panel) that want a single subscribe call and don't want to assemble peer / status / health / event-log themselves on every frame.

```js
const { createEventRecorder } = require('@presenc3/link-core');

const recorder = createEventRecorder(link, {
  ringSize:            30,    // default; max events kept
  heartbeatIntervalMs: 1000,  // default; periodic snapshot emit. 0 disables
  startedAt:           Date.now(),
});

// SSE consumer: gets the current snapshot immediately, then every
// time something interesting happens on the bus (peer joins/leaves,
// hub ready/disconnect, peer status), plus a heartbeat tick
const unsub = recorder.onSnapshot((snap) => {
  res.write(`data: ${JSON.stringify(snap)}\n\n`);
});

// ... later
unsub();
recorder.close();   // detach all listeners, clear heartbeat
```

The snapshot shape is:

```js
{
  connected, ready,
  self: { kind, name, features },
  peers,         // link.getPeers()
  statuses,      // { [peerKind]: link.getPeerStatus(kind) } for every peer with a status
  startedAt,     // the option you passed in
  health,        // link.health() snapshot, or null
  eventLog,      // copy of the ring buffer
  at,            // Date.now() at snapshot build time
  _reason,       // 'tick' | 'ready' | 'peer.connect' | ... - present on auto-emits
}
```

Recorded event shape is `{ kind, from, ...detail, t }`. The `kind` taxonomy normalizes hub-side events into a dashboard-friendly vocabulary:

| `kind`            | trigger                                  | snapshot? |
|-------------------|------------------------------------------|-----------|
| `hub-up`          | `link` event `'ready'`                   | yes       |
| `rejected`        | `link` event `'rejected'`                | yes       |
| `hub-down`        | `link` event `'disconnect'`              | yes       |
| `join`            | `link` event `'peer.connect'`            | yes       |
| `leave`           | `link` event `'peer.disconnect'`         | yes       |
| `status`          | `link` event `'peer.status'` (non-self)  | yes       |
| `protocol-error`  | `link` event `'protocol-error'`          | no        |
| `backpressure`    | `link` event `'backpressure'`            | no        |
| `rpc-fail`        | `link` event `'rpc.complete'` with `ok:false` | no   |
| `direct`          | `link` event `'direct'`                  | no        |

Membership-and-lifecycle events also fire a snapshot emit, so a subscriber doesn't wait up to one heartbeat for the first frame after a peer joins. The heartbeat is the floor - it guarantees a frame even on a fully idle network so the dashboard's "last beat" age label keeps moving. Set `heartbeatIntervalMs: 0` to disable if your transport doesn't need it.

The recorder is observation-only: it doesn't call `publish` / `send` / `rpc` and doesn't depend on hub features. It works against any v0.4+ `LinkClient`. Combine with `attachClientObservability` if you also want log lines for these events - they're independent.

For per-event subscribers (e.g. a live log panel that wants every event individually, not a full snapshot), use `recorder.onEvent(fn)`. That one does **not** replay history on subscribe; call `recorder.getRecent()` first if you need the ring buffer too.

`close()` is idempotent and detaches every listener the recorder added to the underlying `LinkClient`. Always call it before discarding the recorder, or you'll leak listeners across reconnects.

## API

### `new LinkClient(options)`

| Option                  | Type       | Required | Default       | Description                                                                                    |
|-------------------------|------------|----------|---------------|------------------------------------------------------------------------------------------------|
| `url`                   | `string`   | yes      |               | WebSocket URL of the hub (e.g. `ws://localhost:8080`).                                         |
| `secret`                | `string`   | yes      |               | HMAC secret. In shared-secret hub mode, must match every peer; in per-peer-keys mode, only this peer's key (the hub looks up the right key by `kind`). |
| `kind`                  | `string`   | yes      |               | Service type identifier (e.g. `'worker'`). Used for routing and peer lookup.                   |
| `name`                  | `string`   | no       | `kind`        | Human-readable instance name.                                                                  |
| `makeStatus`            | `function` | no       |               | Called on connect and every `statusIntervalMs`; return value is sent as a `status.update`.     |
| `rpcHandlers`           | `object`   | no       | `{}`          | Map of `rpcType → async (rpcData, msg) => result`. Thrown errors become RPC error responses.   |
| `logger`                | `object\|null` | no   | console       | Custom logger with `log` and `warn` methods, or `null` to silence.                             |
| `defaultRpcTimeoutMs`   | `number`   | no       | `5000`        | Default per-call RPC timeout. Per-call `timeoutMs` overrides.                                  |
| `statusIntervalMs`      | `number`   | no       | `10000`       | Cadence for automatic `status.update` pushes when `makeStatus` is set.                         |
| `reconnectInitialMs`    | `number`   | no       | `1000`        | Initial reconnect delay.                                                                       |
| `reconnectMaxMs`        | `number`   | no       | `10000`       | Maximum reconnect delay (cap).                                                                 |
| `reconnectGrowth`       | `number`   | no       | `1.5`         | Multiplicative backoff factor between failed reconnect attempts.                               |
| `helloAckDiagnosticMs`  | `number`   | no       | `5000`        | If no verified message arrives within this many ms of `open`, warn (likely secret mismatch). Set to `0` to disable. |
| `replayWindowMs`        | `number`   | no       | `300000`      | Replay-protection window. Messages with `ts` outside ±this from now are dropped, and message ids are remembered for this duration. Set to `0` to disable. |
| `maxRecentIds`          | `number`   | no       | `10000`       | Cap on remembered message ids (LRU).                                                           |
| `maxMessageBytes`       | `number`   | no       | `1048576`     | Maximum incoming WebSocket frame size, in bytes (1 MiB).                                       |
| `maxBufferedBytes`      | `number`   | no       | `4194304`     | Cap on `ws.bufferedAmount` before sends are dropped (4 MiB). Status updates, `publish()`, and `send()` silently drop with a `'backpressure'` event; `rpc()` rejects synchronously with `BackpressureError` (`err.code === 'BACKPRESSURE'`). |
| `hashAlgo`              | `string`   | no       | `'sha256'`    | HMAC hash algorithm. Must match the hub.                                                       |
| `perMessageDeflate`     | `boolean \| object` | no | `false`     | Pass-through to the underlying `ws` client. `false` disables compression. `true` accepts library defaults; pass an options object for fine control. Off by default - see notes below. |
| `reconnectOnRejection`  | `boolean`  | no       | `false`       | Behavior on `hello.ack ok:false`. Default `false` calls `stop()` to avoid hot-looping. Set `true` to keep retrying with backoff (only useful if you expect the hub's key registry to admit your kind at runtime). |

Methods:

- **`start()`** - Connect to the hub. No-op if `url`, `secret`, or `kind` is missing (just logs a warning), or if a connection is already open or in flight. If a previous socket is in `CLOSING`/`CLOSED` state, its listeners are detached so its eventual close can't interfere with the new connection.
- **`stop()`** - Close the connection, cancel timers, and reject any pending RPCs with `RpcDisconnectError` ("Link stopped before RPC completed"). The client will not auto-reconnect after `stop()`.
- **`isConnected()`** - `true` if the WebSocket is open. Note that "open" doesn't imply "ready" - the hub may still reject the hello. Use `isReady()` or the `'ready'` event for the gate.
- **`isReady()`** - `true` if the hub has accepted the hello (the `'ready'` event has fired since the last connect). This is the safe-to-publish/send/rpc gate.
- **`ready(opts?)`** - Returns a Promise that resolves with `{ kind, features }` when the link is ready. Calls `start()` if not already running. Resolves immediately if already ready. Rejects with `HelloRejectedError` on `hello.ack ok:false`, with a timeout `Error` if `opts.timeoutMs` elapses, or with `AbortError` if `opts.signal` aborts. See [Connection lifecycle](#connection-lifecycle).
- **`rpc(to, rpcType, rpcData, optsOrTimeoutMs?)`** - Send an RPC to a peer of kind `to` (or `'server'` for hub-handled RPCs) and return a Promise that resolves with the result or rejects with a typed error. The fourth argument can be a `number` (legacy positional `timeoutMs`) or an object `{ timeoutMs?, signal? }` - see [Aborting an in-flight RPC](#aborting-an-in-flight-rpc). Rejection types: `LinkNotReadyError` (called before the link is ready - synchronous), `RpcTimeoutError`, `RpcDisconnectError`, `RpcAbortError`, `RpcRemoteError` (remote handler threw or hub returned an error), or `BackpressureError`.
- **`send(to, type, data)`** - Directed fire-and-forget. Returns `true` if sent, `false` if dropped due to local backpressure. Throws `LinkNotReadyError` if not ready or `FeatureUnsupportedError` if the hub doesn't advertise the `'direct'` feature. See [Directed fire-and-forget](#directed-fire-and-forget). At-most-once: not queued if the target is offline.
- **`handle(rpcType, fn)`** - Register or replace the handler for `rpcType` at runtime. Returns the previous handler, or `undefined`. Designed for "register on every `'ready'`" plugin patterns; replaces silently. See [Dynamic RPC handlers](#dynamic-rpc-handlers).
- **`unhandle(rpcType)`** - Remove the handler for `rpcType`. Returns `true` if a handler was removed, `false` if there was none.
- **`waitFor(event, opts?)`** - Wait for the next occurrence of `event` and resolve with its payload. `opts` is `{ timeoutMs?, signal? }`. With `timeoutMs > 0`, rejects on timeout; with an aborted `signal`, rejects with an `AbortError`-named error. See [Waiting for events](#waiting-for-events).
- **`health()`** - Synchronous snapshot of `{ connected, verified, ready, lastVerifiedAt, peerCount, pendingRpcCount, subscriptionCount, bufferedAmount, reconnectAttempt, stopped }`. See [Health snapshot](#health-snapshot).
- **`subscribe(topic, handler)`** - Register `handler(payload, msg)` for a topic. Multiple handlers per topic are allowed and share one hub-side subscription. Throws on invalid topic. Subscribing while disconnected is fine - the subscription is replayed automatically after each reconnect.
- **`unsubscribe(topic, handler?)`** - Remove `handler` from `topic`, or all handlers if omitted. Returns `true` if anything was removed locally. The hub-side subscription is dropped only when the last handler for the topic is removed.
- **`publish(topic, payload)`** - Publish to a topic. Throws `LinkNotReadyError` if not ready or `FeatureUnsupportedError` if the hub doesn't support topics. Returns `true` if sent, `false` if dropped due to local backpressure (in which case `'backpressure'` was emitted). At-most-once: not queued for offline subscribers.
- **`getPeers()`** - Returns the latest peer list from the hub: `[{ kind, hello, connectedAt, connected }, ...]`.
- **`getPeerStatus(kind)`** - Returns the last known status for a peer of that kind, or `null`.

Properties:

- **`hubFeatures`** - The capability list announced by the hub in `hello.ack`, e.g. `['topics', 'direct']` for a v0.4.0+ hub. `null` until the first verified message arrives. An empty array means the hub didn't advertise any features (likely a v0.3.x hub). Use `link.hubFeatures?.includes('topics')` to pre-flight feature availability.
- **`rpcHandlers`** - The current map of `rpcType` → handler. Initially populated from the constructor; mutated by `handle()` / `unhandle()`. Treat as read-only - go through `handle()` for runtime changes.

#### Events

`LinkClient` extends `EventEmitter`. All events are additive - existing code that doesn't subscribe to anything continues to work.

| Event              | Payload                                                              | Fired when                                                                |
|--------------------|----------------------------------------------------------------------|---------------------------------------------------------------------------|
| `'connect'`        | `{ url, kind }`                                                      | Underlying WebSocket has opened and `hello` has been sent.                |
| `'verified'`       | `{ kind }`                                                           | First signed-and-verified message arrived. Crypto checks pass. Not yet a "safe to publish" gate - see `'ready'`. |
| `'ready'`          | `{ kind, features }`                                                 | Hub accepted the hello (`hello.ack.ok !== false`). The "really connected, safe to use" event. `features` is the hub's capability list (`['topics','direct']` for v0.4); `null` for hubs that don't advertise. |
| `'rejected'`       | `{ reason, error }`                                                  | Hub rejected the hello (`hello.ack.ok === false`). Default behavior: client `stop()`s itself - set `reconnectOnRejection: true` to keep retrying. |
| `'disconnect'`     | `{ code?, reason, willReconnect, wasReady }`                         | WebSocket closed. `willReconnect` is `false` after `stop()` or after a hello rejection (default). `wasReady` indicates whether `'ready'` had fired during this connection. |
| `'reconnecting'`   | `{ delayMs, attempt }`                                               | A reconnect attempt is scheduled.                                         |
| `'ws-error'`       | `Error`                                                              | Underlying WebSocket error.                                               |
| `'protocol-error'` | `{ reason, type?, msg?, size?, skew?, error? }`                      | A message was rejected. `reason` is one of `'parse-error'`, `'bad-signature'`, `'bad-version'`, `'replay-window'`, `'replay-id'`, `'missing-id'`, `'oversize'`, `'no-ack'`. |
| `'backpressure'`   | `{ type, to?, rpcType?, bufferedAmount }`                            | A send was dropped (or an RPC rejected) because `ws.bufferedAmount` exceeded `maxBufferedBytes`. |
| `'message'`        | `{ msg, raw }`                                                       | Power-user firehose: every verified message post-checks.                  |
| `'peer.connect'`   | `peer` (PeerInfo)                                                    | A new peer kind appeared in the latest `peers.update`.                    |
| `'peer.disconnect'`| `peer` (PeerInfo)                                                    | A peer kind disappeared from the latest `peers.update`.                   |
| `'peer.replaced'`  | `{ kind, prevPeer, peer }`                                           | A peer of the same `kind` reconnected with a fresh socket (different `connectedAt`). Both `prevPeer` and `peer` are `PeerInfo` objects, so `peer.connectedAt` and `prevPeer.connectedAt` give you the old and new stamps. Fires *after* internal `peers` state has been updated, so `link.getPeers()` from inside the handler reflects the new connection. Useful for tearing down per-connection state without inferring it from the `disconnect`/`connect` pair (which doesn't fire on same-kind replacement). (since v0.5) |
| `'peer.status'`    | `{ from, status, at }`                                               | A peer broadcast a status update.                                         |
| `'rpc.request'`    | `{ from, rpcType, rpcData, msg }`                                    | An incoming RPC request was received (fires before the handler runs).     |
| `'rpc.timeout'`    | `{ id, to, rpcType, timeoutMs }`                                     | A pending outbound RPC timed out.                                         |
| `'rpc.abort'`      | `{ id, to, rpcType }`                                                | An outbound RPC was aborted via its `AbortSignal`.                        |
| `'rpc.disconnect'` | `{ id, to, rpcType }`                                                | An outbound RPC was orphaned by a disconnect (fires before the rejection). |
| `'rpc.complete'`   | `{ id, to, rpcType, ok, reason, durationMs, error }`                 | Unified outbound-RPC lifecycle event. Fires exactly once per `rpc()` call. `reason` is `null` on success, or one of `'timeout' \| 'abort' \| 'disconnect' \| 'not-ready' \| 'remote-error' \| 'send-error' \| 'backpressure'` on failure. `id` and `durationMs` are always populated, including for synchronous pre-send rejections. |
| `'direct'`         | `{ from, type, data, msg }`                                          | A directed fire-and-forget message arrived (sent via `link.send`). `from` is the sender's authenticated kind (hub-stamped), `type` is the application-level message type. |

Note: socket and protocol failures are emitted as `'ws-error'` and `'protocol-error'`, not as the bare `'error'` event. This means an unhandled emit doesn't crash the process - appropriate for a long-lived background client.

```js
link.on('ready',          ({ features }) => console.log('hub link is up; supports', features));
link.on('rejected',       ({ reason })   => console.error('hub rejected:', reason));
link.on('peer.connect',   (p)            => console.log(`${p.kind} joined`));
link.on('protocol-error', (e)            => alerting.warn(`link protocol-error: ${e.reason}`));
link.on('rpc.complete',   (i)            => metrics.rpc.observe(i.durationMs, { ok: i.ok, reason: i.reason }));
```

> **`perMessageDeflate`.** Off by default. permessage-deflate has had memory-amplification CVEs against malicious peers; the safe default is to leave it off and only enable on trusted networks where you control both ends. When enabling, prefer the options-object form so you control the trade-offs - e.g. `perMessageDeflate: { threshold: 1024, serverMaxWindowBits: 10 }` to set a minimum compressible size and constrain the decompression buffer.

### `createHub(options)`

```js
const { createHub } = require('@presenc3/link-core');
```

Returns an `EventEmitter` with `attach`, `getState`, `health`, and `stop` methods.

| Option                | Type           | Required | Default       | Description                                                                                   |
|-----------------------|----------------|----------|---------------|-----------------------------------------------------------------------------------------------|
| `secret`              | `string \| Record<string,string> \| (kind) => string \| Promise<string>` | yes |  | HMAC secret. `string` = shared mode (back-compat). Object = per-peer keys map. Function = dynamic resolver. See [Per-peer keys](#per-peer-keys). |
| `rpcHandlers`         | `object`       | no       | `{}`          | Map of `rpcType → async (rpcData, msg) => result` for RPCs addressed to `'server'`.           |
| `logger`              | `object\|null` | no       | console       | Custom logger with `log` and `warn` methods, or `null` to silence.                            |
| `keepaliveIntervalMs` | `number`       | no       | `15000`       | Ping cadence for liveness detection (post-hello sockets only).                                |
| `helloTimeoutMs`      | `number`       | no       | `10000`       | Time after socket open to wait for a successful `hello`. Closes the socket if missed. Set to `0` to disable. |
| `maxPendingSockets`   | `number`       | no       | `1024`        | Cap on concurrent un-authenticated sockets. When exceeded, the oldest pending socket is force-closed (FIFO eviction) and emits `peer.timeout` with `reason: 'pending-cap'`. Defends against attackers opening many TCP connections and never speaking. (since v0.5) |
| `replayWindowMs`      | `number`       | no       | `300000`      | Replay-protection window (matching the client). Set to `0` to disable.                        |
| `maxRecentIds`        | `number`       | no       | `10000`       | Cap on remembered message ids.                                                                |
| `maxMessageBytes`     | `number`       | no       | `1048576`     | Defensive in-handler size check. `createHub` is transport-agnostic; set `maxPayload` on your `WebSocketServer` separately. (`createHubServer` does this for you.) |
| `maxBufferedBytes`    | `number`       | no       | `4194304`     | Per-peer cap on `ws.bufferedAmount` before sends to that peer are dropped (4 MiB). Drops are logged. RPC forwards to a backpressured peer return an error response to the original caller. |
| `hashAlgo`            | `string`       | no       | `'sha256'`    | HMAC hash algorithm. Must match every client.                                                 |

Methods:

- **`attach(ws, req)`** - Wire up an incoming WebSocket. Call this from your `WebSocketServer`'s `'connection'` handler. The hub takes care of hello handshake, message verification, routing, keep-alive, and cleanup.
- **`getState()`** - Returns `{ peers, lastStatus }` for introspection (e.g. health endpoints).
- **`health()`** - Returns `{ peerCount, pendingSocketCount, topicCount, totalSubscribers, recentIdsSize, statusCount }`. Cheap synchronous snapshot for `/health` integrations.
- **`stop()`** - Cancel timers, close all sockets, remove all event listeners. Call on shutdown.

#### Hub events

The returned `EventEmitter` emits the following events. All are observability-only - dropping all listeners cannot break message delivery. The hub never emits the bare EventEmitter `'error'` event; listeners that throw are caught and logged.

| Event                     | Payload                                                                  | When                                                       |
|---------------------------|--------------------------------------------------------------------------|------------------------------------------------------------|
| `peer.connect`            | `{ kind, hello, connectedAt, replaced }`                                 | A peer completed the hello handshake.                      |
| `peer.disconnect`         | `{ kind, hello, connectedAt, code?, reason }`                            | A peer's socket closed (or hub force-closed it).           |
| `peer.replaced`           | `{ kind, prevHello, newHello }`                                          | A new socket completed hello with the same `kind`.         |
| `peer.timeout`            | `{ remoteAddress, helloTimeoutMs, reason? }`                             | Pre-hello socket reaped (no hello within `helloTimeoutMs`) or evicted due to `maxPendingSockets` cap. `reason: 'pending-cap'` when capped; absent for natural timeouts. |
| `protocol-error`          | `{ reason, kind, type?, detail? }`                                       | A message was dropped at the hub.                          |
| `topic.subscribe`         | `{ kind, topic }`                                                        | First subscriber for that kind on that topic.              |
| `topic.unsubscribe`       | `{ kind, topic }`                                                        | Last unsubscribe by that kind on that topic.               |
| `topic.publish`           | `{ from, topic, payload, subscriberCount, delivered }`                   | A peer published, regardless of subscriber count.          |
| `rpc.forwarded`           | `{ id, from, to, rpcType }`                                              | An rpc.request was forwarded.                              |
| `rpc.response.forwarded`  | `{ id, from, to, ok }`                                                   | An rpc.response was forwarded back.                        |
| `rpc.server`              | `{ id, from, rpcType, ok, error?, durationMs }`                          | A `to: 'server'` RPC was handled.                          |
| `direct`                  | `{ from, to, type, data }`                                               | A directed message was forwarded.                          |
| `backpressure`            | `{ kind, type, to?, bufferedAmount, maxBufferedBytes }`                  | A send was dropped due to per-peer buffer cap.             |
| `message`                 | `{ from, msg }`                                                          | Power-user firehose: every verified message.               |

`protocol-error` reasons include: `parse-error`, `bad-signature`, `bad-version`, `replay-window`, `replay-id`, `missing-id`, `oversize`, `bad-hello`, `duplicate-hello`, `unknown-kind`, `pre-hello-message`, `invalid-topic`.

Example use: a connection-counter for Prometheus, a Slack alert when a particular kind drops, an audit log of every RPC:

```js
hub.on('peer.connect',    ({ kind })          => metrics.connected.inc({ kind }));
hub.on('peer.disconnect', ({ kind, reason })  => metrics.connected.dec({ kind }));
hub.on('rpc.server',      ({ rpcType, ok })   => metrics.rpcs.inc({ rpcType, ok }));
hub.on('protocol-error',  ({ reason, kind })  => log.warn(`drop: ${reason} (${kind})`));
```

### `createHubServer(options)`

```js
const { createHubServer } = require('@presenc3/link-core');
```

A batteries-included wrapper around `createHub`. Creates and manages the HTTP server, WebSocket server, default routes, signal handling, and graceful shutdown so you don't have to. Internally delegates to `createHub`, so wire-level behavior is identical.

| Option              | Type                  | Default       | Description                                                                                       |
|---------------------|-----------------------|---------------|---------------------------------------------------------------------------------------------------|
| `secret`            | `string \| Record<string,string> \| (kind) => string \| Promise<string>` | - | **Required.** HMAC secret. Forwarded to `createHub` - see [Per-peer keys](#per-peer-keys) for the non-string shapes. |
| `rpcHandlers` | `object`              | `{}`          | Map of `rpcType → async (rpcData, msg) => result`. Forwarded to `createHub`.                      |
| `host`              | `string`              | `'0.0.0.0'`   | Interface to bind. Ignored when `server` is provided.                                             |
| `port`              | `number`              | `8080`        | Port to listen on. Ignored when `server` is provided.                                             |
| `server`            | `http.Server`         | -             | BYO HTTP server. If passed, `host`/`port`/routes are ignored - the hub just attaches a `WebSocketServer` to it. Useful for embedding inside an existing app. |
| `path`              | `string`              | -             | If set, only handle WebSocket upgrades at this path (e.g. `'/link'`). Otherwise all upgrades are handled. |
| `routes`            | `object`              | `{}`          | Map of `pathname → (req, res) => void \| Promise<void>`. User routes win over the defaults below. |
| `enableHealthRoute` | `boolean`             | `true`        | Adds `GET /health` returning `{ ok, now, hub: hub.health() }`. Ignored when `server` is provided. |
| `enableStateRoute`  | `boolean`             | `false` (since v0.5) | Adds `GET /state` returning `{ ...hub.getState(), ...extraState() }` pretty-printed. Ignored when `server` is provided. The route exposes peer kinds, hello payloads, `connectedAt`, and last-known statuses; opt in explicitly for internal dashboards / dev. Binding `0.0.0.0` with `/state` enabled still emits an informational startup warning. (Default was `true` in v0.4 - see the v0.5 changelog.) |
| `extraState`        | `function`            | -             | `() => object \| Promise<object>`. Merged into `/state` after `hub.getState()`. Use this for app-specific state like `{ kvKeys: 42 }`. |
| `handleSignals`     | `boolean`             | `true`        | Install `SIGINT`/`SIGTERM` handlers that call `stop()`. Set to `false` if you already manage signals **or** if you create multiple `createHubServer` instances in one process (each instance would otherwise install its own handler and they'd all fire on a signal). |
| `signals`           | `string[]`            | `['SIGINT','SIGTERM']` | Which signals to handle when `handleSignals` is `true`.                                  |
| `shutdownTimeoutMs` | `number`              | `30000`       | Hard cap on how long graceful shutdown is allowed to take before it errors out.                   |
| `drainDelayMs`      | `number`              | `250`         | Time to wait between asking clients to close and force-terminating stragglers.                    |
| `onShutdown`        | `function`            | -             | `async () => void`. Runs at the **end** of shutdown, after sockets and the HTTP server are closed. Perfect for flushing files or closing DB connections. |
| `keepaliveIntervalMs` | `number`            | `15000`       | Forwarded to `createHub`. Ping cadence for liveness detection.                                    |
| `helloTimeoutMs`    | `number`              | `10000`       | Forwarded to `createHub`. Pre-hello socket timeout. Set to `0` to disable.                        |
| `maxPendingSockets` | `number`              | `1024`        | Forwarded to `createHub`. Cap on concurrent un-authenticated sockets (FIFO eviction). (since v0.5) |
| `replayWindowMs`    | `number`              | `300000`      | Forwarded to `createHub`. Replay-protection window. Set to `0` to disable.                       |
| `maxRecentIds`      | `number`              | `10000`       | Forwarded to `createHub`. Cap on remembered message ids.                                          |
| `maxMessageBytes`   | `number`              | `1048576`     | Maximum incoming WebSocket frame size (1 MiB). Set as `maxPayload` on the `WebSocketServer` and as a defensive in-handler check. |
| `maxBufferedBytes`  | `number`              | `4194304`     | Forwarded to `createHub`. Per-peer cap on `ws.bufferedAmount` before sends are dropped (4 MiB).                  |
| `hashAlgo`          | `string`              | `'sha256'`    | Forwarded to `createHub`. HMAC hash algorithm.                                                    |
| `perMessageDeflate` | `boolean \| object`   | `false`       | Pass-through to the underlying `WebSocketServer`. Off by default - see notes on `LinkClient`'s same option. |
| `logger`            | `object \| null`      | console       | Same shape as `createHub`'s logger. Used for both server-level and hub-level logs.                |

Returns:

```js
{
  hub,           // the underlying createHub() instance
  httpServer,    // the http.Server (yours if you passed one, otherwise ours)
  wss,           // the WebSocketServer attached to httpServer
  start,         // async () => void; binds the http server (no-op if BYO) and installs signal handlers
  stop,          // async (reason?) => void; idempotent graceful shutdown
  getState,      // () => hub.getState() - note: does NOT merge extraState (that's only for /state)
  health,        // () => hub.health() - synchronous snapshot for /health integrations
  isOwnHttpServer, // true if we created the http server, false if BYO
  isStarted,     // boolean
  isStopping,    // boolean
}
```

A more complete example combining everything:

```js
const { createHubServer } = require('@presenc3/link-core');
const { createKvHandlers } = require('./kv.js');

const kv = createKvHandlers('./data/kv.json');

const server = createHubServer({
  secret: process.env.LINK_SECRET,
  port:   8080,

  // hub-handled RPCs (to: 'server')
  rpcHandlers: kv.handlers,

  // opt /state in (v0.5+ default is false) so we can publish a dashboard
  enableStateRoute: true,

  // expose the kv size on /state alongside { peers, lastStatus }
  extraState: () => ({ kvKeys: kv.size }),

  // flush pending writes before the process exits
  onShutdown: () => kv.flushSync(),

  // a custom HTTP route alongside /health (and /state, since we opted in above)
  routes: {
    '/version': (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version: require('./package.json').version }));
    },
  },
});

server.start();
```

#### Embedding inside an existing HTTP server

If you already have an Express app, just pass it through. The hub will only attach the WebSocket server - your routes, your shutdown, your rules:

```js
const express = require('express');
const http = require('http');
const { createHubServer } = require('@presenc3/link-core');

const app = express();
app.get('/', (_req, res) => res.send('hello'));

const httpServer = http.createServer(app);

const linkServer = createHubServer({
  secret: process.env.LINK_SECRET,
  server: httpServer,        // BYO - no /health, no /state, no listen
  path:   '/link',           // strongly recommended: scope WS upgrades to one path
  handleSignals: false,      // your app probably already does this
});

await linkServer.start();    // no-op for the http server, but installs the WS handler

httpServer.listen(8080);
```

### Protocol helpers

For writing tools, tests, or alternative hub implementations, the signing utilities are exported from the main entry:

```js
const { sign, verify, makeMsg, stableStringify, PROTOCOL_VERSION } = require('@presenc3/link-core');
```

- **`makeMsg(secret, { v?, id, ts?, type, from?, to?, data })`** - Build a fully-formed, signed message envelope. `v` defaults to `PROTOCOL_VERSION` (currently `1`), `ts` defaults to `Date.now()`, `from` and `to` default to `null`. `data` is deep-cloned via `structuredClone`, so you can freely mutate your original after the call without affecting the envelope or the bytes that go on the wire.
- **`sign(secret, msg)`** - Return the hex HMAC-SHA256 signature of a message (excluding its `sig` field).
- **`verify(secret, msg)`** - Constant-time verify a signed message. Returns `true`/`false`.
- **`stableStringify(obj)`** - Deterministic JSON stringifier with sorted keys. Used internally so signatures are stable regardless of key order.
- **`PROTOCOL_VERSION`** - The current protocol version (`1`). Messages with a different `v` are dropped on receipt by both client and hub.

## Message envelope

Every message on the wire is a JSON object of this shape:

```js
{
  v:    1,                  // protocol version
  id:   '...uuid...',       // message id (also used to correlate RPC responses)
  ts:   1713700000000,      // timestamp (ms since epoch)
  type: 'rpc.request',      // message type
  from: 'coordinator',      // sender kind (or null)
  to:   'worker',           // recipient kind, or 'server' for hub-handled, or null
  data: { /* payload */ },  // type-specific payload
  sig:  '...hex...'         // HMAC-SHA256 over the envelope minus `sig`
}
```

Messages with a missing or invalid `sig` are silently dropped on both sides. The hub trusts the authenticated socket's kind over whatever `from` field a client sends, so peers can't spoof each other.

### Message types

| Direction      | Type              | Purpose                                                                 |
|----------------|-------------------|-------------------------------------------------------------------------|
| client → hub   | `hello`           | Sent on connect with `{ kind, name, pid, startedAt }`. The hub sanitizes this to a small whitelist before storing. |
| hub → client   | `hello.ack`       | `{ ok, serverTime, kind, features }` on success (since v0.4: `features` is the hub's capability list, e.g. `['topics', 'direct']`), or `{ ok: false, error }`. |
| client → hub   | `status.update`   | Whatever `makeStatus()` returns; re-broadcast by the hub.               |
| hub → client   | `peers.update`    | `{ peers: [{ kind, hello, connectedAt, connected }, ...] }`.            |
| hub → client   | `status.snapshot` | `{ kind: { status, at }, ... }` - sent once after `hello`.              |
| hub → client   | `status.update`   | `{ from, status, at }` - broadcast whenever a peer updates its status.  |
| either → either| `rpc.request`     | `{ rpcType, rpcData }`. The hub handles `to: 'server'`, else forwards.  |
| either → either| `rpc.response`    | `{ ok: true, result }` or `{ ok: false, error }`, correlated by `id`.   |
| client → hub   | `topic.subscribe` | `{ topic }` - register the client's `kind` for fan-out on this topic.   |
| client → hub   | `topic.unsubscribe` | `{ topic? }` - unregister. Omitting `topic` removes from all topics.  |
| either → either| `topic.message`   | `{ topic, payload }`. Client → hub: publish. Hub → client: delivery to a subscriber, with `from` set to the publisher's authenticated kind. |
| either → either| `direct`          | `{ directType, directData }` *(since v0.4.0)*. Client → hub: directed fire-and-forget. Hub → client: delivery to the target, with `from` set to the sender's authenticated kind. Dropped silently if the target is offline. |

## Behavior notes

### Client

- **Reconnection:** exponential backoff starting at `reconnectInitialMs` (default 1 s), growing by `reconnectGrowth` (default 1.5×) per attempt, capped at `reconnectMaxMs` (default 10 s), with `reconnectJitter` (default 0.5 = ±25%) applied to each scheduled delay so synchronized drops (e.g. after a hub restart) don't all retry at the same instant. Set `reconnectJitter: 0` to disable. Backoff resets only on the `'ready'` transition - connections that open but never reach `ready` (e.g. secret mismatch leading to a hub-side close) keep growing the backoff across attempts.
- **`start()`/`stop()` race:** `start()` recognizes `OPEN`, `CONNECTING`, *and* `CLOSING`/`CLOSED` socket states; if there's an old closing socket, its listeners are detached so its eventual close can't interfere with the new connection. `stop()` does the same up front. *(since v0.4.0)*
- **Status cadence:** `makeStatus()` (if provided) fires once on connect and then every `statusIntervalMs` (default 10 s).
- **RPC timeouts:** default `defaultRpcTimeoutMs` (5 s). Timed-out RPCs reject with `RpcTimeoutError` (`err.code === 'RPC_TIMEOUT'`, message `RPC timeout after <ms>ms: <to>:<rpcType>`) and emit `'rpc.timeout'`. Late responses are logged and discarded.
- **RPC disconnects:** if the socket closes while an RPC is in flight, the call rejects immediately with `RpcDisconnectError` (`err.code === 'RPC_DISCONNECT'`) rather than waiting out its timeout.
- **RPC abort:** if a caller-supplied `AbortSignal` fires while the RPC is in flight (or before `rpc()` even sends), the call rejects with `RpcAbortError` (`err.code === 'RPC_ABORT'`). The wire request is not cancelled - the remote handler may still complete and the response will be logged-and-dropped on arrival.
- **Replay & sizing:** messages outside the `replayWindowMs` window or duplicating a recently-seen `id` are dropped and emit `'protocol-error'`. Messages larger than `maxMessageBytes` are rejected at both the transport (`maxPayload`) and in-handler.
- **Backpressure:** every outgoing send checks `ws.bufferedAmount` against `maxBufferedBytes` (default 4 MiB). Status updates, `publish()`, and `send()` silently drop with a `'backpressure'` event. `rpc()` rejects synchronously with `BackpressureError` (`err.code === 'BACKPRESSURE'`) rather than letting the caller wait out its timeout.
- **Pub/sub subscriptions** are tracked client-side and replayed automatically on every `'ready'` transition, so reconnects don't require any application code to re-subscribe. See [Pub/sub topics](#pubsub-topics).
- **Direct messages** are at-most-once; if the target is offline at send time the message is dropped silently. The hub stamps `from` with the sender's authenticated kind. See [Directed fire-and-forget](#directed-fire-and-forget).
- **Dynamic RPC handlers:** the constructor's `rpcHandlers` is the canonical place; `handle()` / `unhandle()` mutate the same map at runtime. Re-registering the same handler is idempotent. See [Dynamic RPC handlers](#dynamic-rpc-handlers).
- **EventEmitter:** `LinkClient` is an `EventEmitter`. See the [Events](#events) section for the full list. Errors emit as `'ws-error'` and `'protocol-error'` rather than the bare `'error'` event, so an unhandled emit doesn't crash the process.
- **Logging:** pass `logger: null` to silence, or an object with `log(tag, ...args)` and `warn(tag, ...args)` to integrate with your own logger.

### Hub

- **Keep-alive:** WebSocket-level ping every `keepaliveIntervalMs` (default 15 s). Any socket that didn't pong back since the last ping is terminated.
- **Single connection per kind:** when a new `hello` arrives for a kind that's already connected, the old socket is closed. This prevents zombie connections after a hard crash + restart.
- **Trusted routing:** once a socket has completed the `hello` handshake, the hub always stamps outgoing messages with the socket's bound kind, ignoring whatever `from` a client writes. This applies to peer-routed forwards (`rpc.request`, `direct`), pub/sub fan-out, *and* server RPC handlers - `rpcHandlers` receive `msg.from` set to the authenticated kind, not whatever the client put on the wire. Peers can't impersonate each other.
- **Replay & sizing:** the hub applies the same `replayWindowMs` / `maxRecentIds` / `maxMessageBytes` checks as the client. `createHubServer` additionally sets `maxPayload` on the underlying `WebSocketServer` to enforce the size cap at the transport layer.
- **Backpressure:** every send to a peer checks that peer's `ws.bufferedAmount` against `maxBufferedBytes` (default 4 MiB) and drops with a warning if exceeded. Drops are per-peer, so one slow consumer doesn't block fan-out (broadcasts, pub/sub) to fast peers. RPC requests forwarded to a backpressured peer turn into an immediate error response to the original caller - no silent timeout. `direct` messages forwarded to a backpressured peer drop silently (no error response, since they are fire-and-forget).
- **Bounded hello:** the hub stores a *sanitized* whitelist (`kind`, `name`, `pid`, `startedAt`) of each peer's hello payload, dropping unknown fields and capping string lengths. This bounds per-peer hub memory and `/state` response size against buggy or hostile peers. Oversized `kind` strings are rejected and the hello is refused; `name` is truncated.
- **Pub/sub fan-out:** the hub keeps a `topic → Set<kind>` map. On peer disconnect (graceful or keepalive-terminate), every subscription belonging to that peer is dropped. The publisher does not receive its own message. See [Pub/sub topics](#pubsub-topics).
- **Status retention:** the hub keeps each peer's last `status.update` in a `kind → status` map and ships a `status.snapshot` to fresh peers right after their hello. On peer disconnect (graceful or keepalive), the hub drops that peer's last-known status - fresh peers won't see stale statuses for kinds that aren't currently connected.
- **Direct routing:** `direct` messages are forwarded to `msg.to`'s socket if that peer is connected. If the target is missing or disconnected, the message is dropped silently - fire-and-forget contract. *(since v0.4.0)*

### Protocol

- **Signatures:** HMAC-SHA256 over the `stableStringify` of the envelope with `sig` removed. Verification is constant-time.
- **Version:** `PROTOCOL_VERSION` is currently `1`. Both ends drop messages with a different `v` after signature verification.

## TypeScript

`@presenc3/link-core` ships hand-written declarations at `src/index.d.ts`. No build step is required - TypeScript picks them up via the `types` field in `package.json`.

For full types on `HubServer.wss` (the underlying `WebSocketServer`), TypeScript users should also install `@types/ws` as a dev dependency:

```bash
npm install --save-dev @types/ws
```

`LinkClient`'s event payloads are fully typed via overloaded `on`/`once`/`off`/`emit` signatures, so `link.on('peer.connect', (peer) => ...)` will infer `peer: PeerInfo`.

Two logger types are exported: `Logger` (the two-method `{ log, warn }` shim that `LinkClient`/`createHub`/`createHubServer` accept as their `logger` option) and `LeveledLogger` (the richer `{ l, lD, lW, lE, ... }` object returned by [`createLogger()`](#logger---createlogger) in the helpers). Since v0.5.0, `LeveledLogger extends Logger` - a `createLogger()` result satisfies `Logger` directly, so you can pass it without an adapter: `new LinkClient({ ..., logger: createLogger() })`. The historical `{ log: leveled.l, warn: leveled.lW }` adapter form still works for back-compat (note `warn: lW`, not `lE` - `LinkClient` uses `logger.warn` for routine drops like backpressure and replayed messages, which should not flood an error sink).

## What's new in v0.5

This release is wire-compatible with v0.4.x (`PROTOCOL_VERSION` is still `1`).

### Highlights

- **Helpers**. A logger, env coercion utilities, observability listener bundles, RPC patterns, lifecycle helpers, a secrets loader, and a dashboard-friendly event recorder - twenty-one symbols in total, all exported flat from the package root and also reachable via a new `./helpers` subpath. See [Helpers](#helpers).
- **`LinkBusClient` alias removed.** The deprecated alias announced in v0.4.0 ("kept as an alias in v0.4.x for backwards compatibility and will be removed in v0.5.0") is gone, along with its `LinkBusClientOptions` / `LinkBusClientEvents` type aliases. Rename to `LinkClient` / `LinkClientOptions` / `LinkClientEvents` - the underlying class and types are unchanged.
- **`LeveledLogger` TypeScript type added.** Describes the rich object returned by `createLogger()`. Distinct from the existing two-method `Logger` type that `LinkClient` accepts as its `logger` option.
- **Line endings normalized.** The source tree is now all LF, matching what `.gitattributes` had declared as intent in v0.4.1. (Previous tarballs shipped CRLF for some files due to a packaging quirk.)

### Safer defaults & fail-fast (potentially breaking)

- **`createHubServer({ enableStateRoute })` defaults to `false`.** Previously `true`. The `/state` route exposes peer kinds, hello payloads, `connectedAt`, and last-known statuses, which is fine for an internal dashboard but undesirable on a public bind. Opt in explicitly for dashboards / dev: `createHubServer({ enableStateRoute: true })`. If you do opt in *and* bind to `0.0.0.0`, an informational warning still fires.
- **`createHubServer` is single-shot.** Calling `start()` after `stop()` now throws `Error('createHubServer is single-shot…')`. Previously the second `start()` appeared to succeed and produced an undefined-state server. If you need restart, call `createHubServer()` again. A new `isStopped` getter reports whether the server has been torn down.
- **`createHubServer.stop()` before `start()` now closes `wss`.** Previously left the eagerly-constructed `WebSocketServer` dangling.
- **`link.rpc()` validates `to` / `rpcType` synchronously.** Invalid arguments now throw `TypeError` at the call site, matching `send()` / `subscribe()` / `publish()`. Previously an invalid `to` produced a delayed `RpcTimeoutError`, indistinguishable from a "peer not reachable" condition.
- **Numeric options validated up-front.** `LinkClient`, `createHub`, and `createHubServer` reject `NaN`, `Infinity`, negatives, and wrong types with a `TypeError` naming the offending option. Previously `Number(process.env.X) // → NaN` silently turned timers into 0-ms tight loops.

### New capabilities

- **`peer.replaced` client-side event.** Fires when a same-kind peer reconnects (a new `connectedAt` for the same `kind`). Useful for tearing down per-connection state. Was previously a hub-only event; client listeners had to infer replacement from the `peer.connect`/`peer.disconnect` sequence.
- **Pre-hello DoS cap: `maxPendingSockets`** (default `1024`). The hub now caps concurrent un-authenticated sockets. When over the cap, the oldest pending socket is force-closed (FIFO eviction) and emits `peer.timeout` with `reason: 'pending-cap'` so operators can distinguish capacity pressure from stragglers.
- **`loadSecrets({ watch })` cleanup handle.** When `watch: true`, the returned object carries a non-enumerable `[LOADED_SECRETS_UNWATCH]` method that tears down the rotation-event subscriptions. Idempotent, safe to call multiple times, and only removes the helper's own subscriptions (caller-installed handlers on the same topic are untouched). Import the symbol from the package root or `./helpers`.
- **`rpcWithRetry` honors `signal` during backoff.** An abort that fires between retry attempts now surfaces as `RpcAbortError` immediately instead of waiting out the full backoff delay.
- **`loadSecrets({ logger })` accepts an injectable warn-logger** (`LeveledLogger.lW`-shaped). Used for transient watch-reload failures. Defaults to a `console.warn` wrapper when not provided.
- **`loadSecrets`'s budget is now actually honored.** Previously the cumulative `timeoutMs` covered `ready()` + `waitForPeer()` but each `secs.get` RPC silently fell back to the client's `defaultRpcTimeoutMs` (5s). Now all RPCs share a single deadline.

### Smaller fixes

- **`getPeers()` / `getPeerStatus()` return defensive copies.** Callers cannot poison internal state by mutating the returned arrays/objects.
- **`rpc.abort` / `rpc.disconnect` event symmetry.** `rpc.abort` now fires for pre-aborted signals (was missing on the pre-send path). `rpc.disconnect` now fires when `link.stop()` orphans a pending RPC (was missing in the explicit-stop path).
- **`unhandle()` uses `Object.hasOwn`.** No more false positives for inherited prototype keys (`'constructor'`, `'toString'`, …).
- **`topic.publish` hub event always carries `delivered`.** Previously omitted on no-subscriber topics, tripping subscriber arithmetic on `undefined`.
- **Hub `send()` returns boolean.** Previously returned the generated UUID on success (technically truthy, but unclear contract).
- **`EventRecorder.close()` contract clarified.** After `close()`, `onSnapshot`/`onEvent` return a no-op unsubscribe (previously delivered one initial frame then went silent forever). `getSnapshot()`/`getRecent()` continue working and reflect current state. Docs match code.
- **TypeScript surface tightened.** `stableStringify` is typed `string | undefined` (it follows `JSON.stringify` semantics for top-level non-serializable values). `LinkClientOptions.url` / `secret` / `kind` are now optional in the type, matching the runtime "disabled if missing" behavior - a `start()` with any of them missing logs a warning and becomes a no-op, and `ready()` rejects synchronously with `LinkNotReadyError` (instead of hanging on the default `timeoutMs: 0`). Useful for service templates that share a code path between a real run and a "no link bus" local-dev mode.
- **Single-logger ergonomics.** `LeveledLogger` (returned by `createLogger()`) now extends `Logger`, so `new LinkClient({ ..., logger: createLogger() })` works without an `{ log: l, warn: lW }` adapter. The adapter form still works for back-compat.

## What's new in v0.4

This release is wire-compatible with v0.3.x (`PROTOCOL_VERSION` is still `1`) but adds a number of features and one minor surface rename. Most upgrades are drop-in. Highlights:

- **`LinkBusClient` is now `LinkClient`.** The old name remains as a deprecated alias for the v0.4.x line and will be removed in v0.5.0. Existing code keeps working without changes; new code should prefer `LinkClient`.
- **Per-peer keys auth.** The hub's `secret` option now accepts `string` (shared mode, v0.3.x-compatible), `Record<kind, string>` (static map), or `(kind) => string | Promise<string>` (dynamic resolver). The hub becomes a re-signing relay: each peer signs and verifies with its own key, and the hub re-signs each fan-out per recipient. Wire-compatible - clients see no API change, only operators see the new shape. See [Per-peer keys](#per-peer-keys).
- **Hub `EventEmitter` surface.** `createHub` now returns an `EventEmitter`. New events for `peer.connect`, `peer.disconnect`, `peer.replaced`, `peer.timeout`, `protocol-error`, `topic.subscribe`/`unsubscribe`/`publish`, `rpc.forwarded`/`response.forwarded`/`server`, `direct`, `backpressure`, `message`. Plus `hub.health()` returning a snapshot of peer/socket/topic counts. See [Hub events](#hub-events).
- **`link.ready()` and the `'ready'` event.** A new connection-lifecycle gate distinct from `'verified'`. `'verified'` fires when crypto checks pass; `'ready'` fires when the hub *accepts* the hello. `link.ready({ timeoutMs })` returns a promise that resolves on `'ready'` and rejects with `HelloRejectedError` on `'rejected'`. This is now the recommended startup pattern. See [Connection lifecycle](#connection-lifecycle).
- **Pub/sub topics.** `link.subscribe(topic, handler)`, `link.unsubscribe(topic, handler?)`, `link.publish(topic, payload)`. See [Pub/sub topics](#pubsub-topics) for full semantics. Subscriptions automatically replay across reconnects.
- **Directed fire-and-forget - `link.send(to, type, data)`.** The third primitive alongside `rpc()` (directed with response) and `publish()` (broadcast no response). The hub forwards with trusted `from`-stamping; receivers subscribe to the `'direct'` event. See [Directed fire-and-forget](#directed-fire-and-forget). *(since v0.4.0)*
- **Dynamic RPC handler registration.** `link.handle(rpcType, fn)` and `link.unhandle(rpcType)` for adding/removing handlers at runtime, e.g. on every `'ready'` from a plugin. Constructor-time `rpcHandlers` still works. *(since v0.4.0)*
- **`link.waitFor(event, { timeoutMs?, signal? })`.** Replaces `await new Promise(r => link.once('ready', r))` with a one-liner that has a real timeout. *(since v0.4.0)*
- **`link.health()`.** Synchronous snapshot of `{ connected, verified, ready, lastVerifiedAt, peerCount, pendingRpcCount, subscriptionCount, bufferedAmount, reconnectAttempt, stopped }` for `/health` integrations. *(since v0.4.0)*
- **Typed error classes.** `RpcTimeoutError`, `RpcDisconnectError`, `RpcAbortError`, `RpcRemoteError`, `BackpressureError`, `LinkNotReadyError`, `FeatureUnsupportedError`, `ProtocolError`, `HelloRejectedError`, plus the bases `RpcError` and `LinkError`. Each carries a stable `code` string and call-site context (`to`, `rpcType`, `id`, `timeoutMs`, `bufferedAmount`, `op`, `feature`, …). All extend `Error`, so existing catch-all paths still work. *(since v0.4.0)*
- **`AbortSignal` for RPC.** `link.rpc(to, type, data, { timeoutMs, signal })`. Compose with whatever cancellation the caller already has. The legacy positional `timeoutMs: number` form is still accepted. *(since v0.4.0)*
- **`'rpc.complete'` lifecycle event.** Unified single hook for outbound-RPC outcomes - fires exactly once per `rpc()` call with `{ id, to, rpcType, ok, reason, durationMs, error }`. Convenient for metrics/tracing. `'rpc.abort'` and `'rpc.disconnect'` were also added for symmetry with the existing `'rpc.timeout'`.
- **Hub capability advertisement.** The hub now announces `features` in `hello.ack`, captured client-side as `link.hubFeatures` - `['topics', 'direct']` for a v0.4.0+ hub. `publish()` and `send()` throw `FeatureUnsupportedError` against any hub that doesn't advertise the corresponding feature, including v0.3.x hubs that don't advertise anything at all (treated as "no features" so the call fails loud rather than silently dropping at the hub).
- **Pre-hello socket timeout.** New `helloTimeoutMs` option on the hub (default 10 s). Closes a DoS surface where the keep-alive ping interval iterated only authenticated peers, so a TCP client could open a socket and never speak.
- **Pluggable hash algorithm.** New `hashAlgo` option on both client and hub (default `'sha256'`). Useful for FIPS-mode deployments. Both ends must agree; the wire envelope is unchanged.
- **Permessage-deflate.** `perMessageDeflate` pass-through on `LinkClient` and `createHubServer`. Off by default - enable on trusted networks if you want compression.
- **Backpressure.** New `maxBufferedBytes` option (default 4 MiB) on both client and hub. When `ws.bufferedAmount` exceeds the cap, status updates and fire-and-forget messages (`publish()`, `send()`) drop with a `'backpressure'` event; `rpc()` rejects synchronously with `BackpressureError` (`err.code === 'BACKPRESSURE'`); hub-side RPC forwards return an error response to the original caller.
- **Bounded `hello` payload.** The hub now sanitizes each peer's hello to a whitelist of `kind` / `name` / `pid` / `startedAt`, dropping unknown fields and capping string lengths.
- **`makeMsg` deep-clones `data`.** Reverts the v0.3.2 reference-passing behavior. Callers may now freely mutate the input after calling `makeMsg` without affecting the signed envelope. Internally uses `structuredClone`, which is faster than the old JSON round-trip. Note: `data` must remain `structuredClone`-compatible (functions, class instances with methods, and DOM nodes will throw) **and** JSON-round-trippable for the wire to carry it correctly. `Date` becomes its ISO string on the wire (via `toJSON`); `Map`/`Set`/`Uint8Array` lose their identity to plain `{}`/`[]` after JSON. Serialize exotic types yourself if the receiver needs to reconstruct them.
- **`link.topic.list` and `link.health` server RPCs.** Built-in introspection: `await link.rpc('server', 'link.topic.list', { topic })` returns subscribers; `link.health` returns the hub-side snapshot.
- **Bug fix: peer-routed RPC.** `rpc.response` is now exempt from the id-replay check on both client and hub. The old behavior caused responses to be dropped because they carry the same `id` as the request that was already added to the recent-id cache; peer-routed RPCs (e.g. `cli → secs`) silently timed out as a result. The timestamp-window check still applies - only the id check changes for response messages.
- **Bug fix: `hello.ack ok:false` reconnect-backoff.** Reconnect backoff used to reset on the first verified message - *including* a `hello.ack` with `ok: false`. A client with a wrong secret could therefore hammer the hub at the initial reconnect interval indefinitely. The reset is now driven by the new `'ready'` transition (i.e. the hub *accepting* the hello). On rejection, the client by default also `stop()`s itself.
- **Bug fix: `start()`/`stop()` race.** `start()` now also recognizes `CLOSING`/`CLOSED` socket states and detaches the orphan socket's listeners before opening a new connection; `stop()` does the same up front. Without this, racing `stop()` then `start()` could leave a stale closing socket whose `close` handler fired *after* the new connection was up, scheduling a duplicate reconnect timer or clearing timers belonging to the new socket. *(since v0.4.0)*

**Behavior changes worth flagging on upgrade:**

1. The hub stores only the sanitized hello, not the raw `msg.data`. Code that read non-whitelisted fields off `peer.hello` in `/state` or `getState()` will now see them missing. If you need extra hello fields, raise an issue - they were never part of the documented surface.
2. `makeMsg(secret, { data })` no longer references `data` directly. Code that called `makeMsg` and then mutated the original to alter the envelope (which always violated the docs) needs to mutate the *returned* `msg.data` instead.
3. The `'verified'` event payload no longer includes `features` - `features` moved to the new `'ready'` event (which is the connection-acceptance gate). Existing handlers that destructured only `kind` are unaffected. `link.hubFeatures` continues to work.
4. `subscribe()` / `publish()` / `send()` now require `'ready'` rather than just `'verified'`. With shared-secret hubs (which always accept correctly-signed hellos) there is no observable difference; with per-peer-keys hubs, the new gate prevents publishing into a connection that's about to be rejected. The recommended pattern is `await link.ready()` after `start()`.
5. `hello.ack ok:false` now triggers a client-side `stop()` by default rather than reconnecting forever. Set `reconnectOnRejection: true` to keep retrying with growing backoff.
6. `rpc()` rejections are now typed-error instances rather than plain `Error` - including remote-handler errors, which produce `RpcRemoteError`. Existing `Error.message` strings are unchanged, so `e.message.includes('timeout')` keeps working - but `e instanceof RpcTimeoutError` (or `e.code === 'RPC_TIMEOUT'`) is the recommended pattern going forward.
7. `publish()` and `send()` now throw `LinkNotReadyError` / `FeatureUnsupportedError` (both extend `LinkError`) instead of plain `Error`. The error messages are unchanged, so substring-matching catches keep working; `instanceof` is the recommended new-code pattern.

## Examples

The repo's [`examples/`](https://github.com/Presenc3/link-core/tree/main/examples) directory has two layers:

1. **A runnable four-service deployment** (`01-hub`, `02-vault`, `03-worker`, `04-coordinator`) that exercises every protocol primitive end-to-end: a hub with per-peer keys, a secrets vault, a worker that bootstraps its credentials from the vault using `waitForPeer` + `rpcWithRetry`, and a coordinator that dispatches jobs and listens for progress.
2. **Standalone single-file showcases** that each isolate one v0.5 helper:
   - `05-disabled-mode` - the "no link bus" local-dev pattern, with `link.ready()` rejecting fast and `createSafePublisher` no-op'ing on a disabled link.
   - `06-dashboard` - `createEventRecorder` + SSE for a live bus-state dashboard, with `createLogger` passed directly as `logger`.
   - `07-loadsecrets-vault` + `08-loadsecrets-consumer` - the `loadSecrets({ watch: true })` wire convention end-to-end, with rotation events visible.
   - `09-graceful-shutdown` - `createGracefulShutdown` + `installProcessHandlers` orchestrating a multi-resource cleanup.

See [`examples/README.md`](https://github.com/Presenc3/link-core/tree/main/examples/README.md) for the topology and how to run them.

## License

MIT © Presenc3