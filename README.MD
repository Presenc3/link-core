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
  - [Cancellable RPC handlers](#cancellable-rpc-handlers)
- [ACL hooks](#acl-hooks)
- [Security & threat model](#security--threat-model)
- [Per-peer keys](#per-peer-keys)
- [Helpers (moved to `@presenc3/link-helpers`)](#helpers)
- [API](#api)
  - [`new LinkClient(options)`](#new-linkclientoptions)
  - [`createHub(options)`](#createhuboptions)
  - [`createHubServer(options)`](#createhubserveroptions)
  - [Protocol helpers](#protocol-helpers)
  - [Message types](#message-types)
- [Message envelope](#message-envelope)
- [Behavior notes](#behavior-notes)
- [TypeScript](#typescript)
- [What's new in v0.6](#whats-new-in-v06)
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

The package is marked `"sideEffects": false`, and the [focused subpaths](#subpath-imports) (`./protocol`, `./errors`, `./primitives`, ...) let a bundler include only the modules a build actually touches. Note the realistic limit: the source is CommonJS, so most bundlers prune at *module* granularity rather than per-export - importing from a subpath is what keeps `ws` and the hub out of a browser or tool bundle, not tree-shaking magic on the package root.

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
- `SIGINT`/`SIGTERM` handlers that run a graceful shutdown (close WSS > close client sockets > terminate stragglers > close HTTP > stop hub).

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

Beyond peer-routed RPC, link-core has a generic publish/subscribe channel for fan-out events. Any client can `subscribe` to a topic and `publish` to one; the hub maintains the topic>subscriber map and fans out each publish to every subscriber. Status broadcasts are a separate, narrower mechanism - pub/sub is for everything else.

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
- **`topic.publish` metrics.** The hub's `topic.publish` event reports `subscriberCount` (eligible recipients - subscribers *other than* the publisher, since self-delivery is off) and `delivered` (recipients actually sent to). Because the publisher is excluded from both, `delivered <= subscriberCount` always holds, with equality on a fully successful fan-out; `delivered` is lower only when a subscriber's socket was unavailable at send time.
- **At-most-once.** If a subscriber is offline at publish time, they miss the message - pub/sub does not queue or persist. If you need durability, use RPC against a hub-handled handler that writes to your own store.
- **Trusted `from`.** The hub overwrites `msg.from` with the publisher's authenticated kind before forwarding, same as RPC. Subscribers can rely on `msg.from` for routing/authorization.
- **Reconnect-safe.** Subscriptions are tracked client-side and replayed automatically on every `'ready'` transition. The hub forgets a peer's subscriptions on disconnect; the client re-establishes them on reconnect with no application-code involvement.
- **Backpressure-aware.** If a subscriber's send buffer is full (`bufferedAmount > maxBufferedBytes`), the hub drops the message *for that subscriber only*, not for the whole topic.
- **Hub feature flag.** The hub advertises `'topics'` in `hello.ack.data.features`; the client captures this as `link.hubFeatures` when the ack arrives (readiness and the feature list arrive together - see [Connection lifecycle](#connection-lifecycle)). Once ready, `publish()` throws `FeatureUnsupportedError` if the acking hub didn't advertise topic support - including an ack with no feature list at all, which the client treats as "no features" so a publish against a hub that won't act on it fails loud rather than silently dropping. Before the ack (features still unknown), `publish()` queues.

### Introspection: `link.topic.list`

The hub provides a built-in server RPC for listing subscribers:

```js
// Subscribers of a single topic.
const { subscribers } = await link.rpc('server', 'link.topic.list', {
  topic: 'events.user.signup',
});
// > { topic: 'events.user.signup', subscribers: ['analytics', 'mailer'] }

// All topics + subscribers (omit `topic`).
const { topics } = await link.rpc('server', 'link.topic.list', {});
// > { topics: [{ topic: '...', subscribers: [...] }, ...] }
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
- **Hub feature flag.** The hub advertises `'direct'` in `hello.ack.data.features`. Once ready, `send()` throws `FeatureUnsupportedError` if the acking hub didn't advertise it (including an ack with no feature list, treated as "no features"), so you fail loud rather than silently dropping; before the ack it queues.
- **Validation.** Throws synchronously on a missing/non-string `to` or `type`, or if the link is *disabled* (missing url/secret/kind) or *stopped*. A merely disconnected/reconnecting link does not throw - the message is queued and drains on reconnect.

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
link.unhandle('auth.refresh');  // > true if a handler was removed, false otherwise
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
| `RpcRemoteError`          | *remote-supplied, else* `RPC_REMOTE` | The remote handler threw, or the hub returned an error response. Carries the remote `code` and optional `data` (see below). |
| `RpcHandlerError`         | `RPC_HANDLER_ERROR` *(or your code)* | Thrown *inside* your own RPC handler to send a structured, caller-visible error on purpose. |
| `BackpressureError`       | `BACKPRESSURE`        | The outbound queue (outbox) is full - `rpc()` rejects when a message can't even be queued (see *Backpressure*). |
| `LinkNotReadyError`       | `LINK_NOT_READY`      | `rpc()` / `ready()` on a link that isn't connected; `publish()` / `send()` on a *disabled* or *stopped* link. Synchronous. |
| `FeatureUnsupportedError` | `FEATURE_UNSUPPORTED` | `publish()` / `send()` called against a hub that doesn't advertise the required feature.                 |
| `ProtocolError`           | `PROTOCOL_ERROR`      | Available for callers that need to throw rather than emit; mostly emitted via `'protocol-error'` events today. |
| `HelloRejectedError`      | `HELLO_REJECTED`      | The hub rejected the client's hello (`hello.ack ok:false`). What `link.ready()` rejects with.            |
| `RpcError` *(base)*       | `RPC_ERROR`           | Common base for the RPC errors above.                                                                    |
| `LinkError` *(base)*      | `LINK_ERROR`          | Common base for everything in this table.                                                                |

Each error carries call-site context - `to`, `rpcType`, `id` on the RPC ones; `timeoutMs` on `RpcTimeoutError`; `op` on `LinkNotReadyError`; `op` and `feature` on `FeatureUnsupportedError`; `reason` on `ProtocolError` and `HelloRejectedError`.

### RPC handler errors are sanitized by default

When one of *your* RPC handlers throws, the error is **not** sent verbatim to the caller - that would leak internal detail (stack traces, connection strings, file paths). Instead:

- A plain `Error` (or anything that isn't an `RpcHandlerError`) reaches the caller only as a generic `RpcRemoteError` with message `"Internal handler error"`. The real error is logged locally and emitted on the `'rpc.handler-error'` event so your own observability still sees it.
- To deliberately send a structured error to the caller, **throw an `RpcHandlerError`** - its `message`, `code`, and optional `data` are forwarded as-is and arrive on the caller side as an `RpcRemoteError` carrying the same `code` and `data`:

```js
const { RpcHandlerError } = require('@presenc3/link-core');

link.handle('order.get', async ({ id }) => {
  const order = await db.find(id);
  if (!order) throw new RpcHandlerError('Order not found', { code: 'NOT_FOUND', data: { id } });
  return order;
});

// caller side:
try {
  await link.rpc('orders', 'order.get', { id: 7 });
} catch (e) {
  if (e.code === 'NOT_FOUND') console.log('missing order', e.data.id);
}
```

Set `exposeRpcErrors: true` on the `LinkClient` / `createHub` / `createHubServer` to forward *every* handler error message verbatim instead - convenient for fully-trusted internal deployments.

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

> **Note on `RpcRemoteError`.** It is raised for any failed RPC the remote side reports. By default the `message` is sanitized (see above) - use `instanceof RpcRemoteError` to discriminate against transport-level failures, and `err.code` / `err.data` for application-level branching. Your retry policy almost certainly should not retry on `RpcRemoteError`, because the failure is the remote's, not the link's.

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

> **Note.** Aborting (or hitting the `timeoutMs` deadline) rejects the *caller* side immediately: the local pending entry is removed and the promise rejects with `RpcAbortError` / `RpcTimeoutError`.
>
> Since v0.6 the client also sends a best-effort `rpc.cancel` to the hub. If the request is still queued for a congested target, the hub drops it before the target ever sees it (and fires `rpc.cancelled` with `found: true`). Otherwise the hub relays the `rpc.cancel` on to the target peer, where the in-flight handler's `AbortSignal` fires (`rpc.cancelled` reports `forwarded: true`). A handler that reads that signal can stop work early; a handler that ignores it runs to completion as before, and its response is simply suppressed on arrival - the local rejection is unaffected either way. The cancel is skipped when the link is not ready. Hubs that predate this message type ignore it harmlessly. See [RPC handlers](#cancellable-rpc-handlers) for handling the signal on the receiving side.

### Cancellable RPC handlers

On the *receiving* side, an RPC handler is `(rpcData, msg, ctx) => result`. The third argument, `ctx`, carries an `AbortSignal` that fires when the original caller cancels the RPC (the hub relays the `rpc.cancel`) or when the handling link is torn down. Reading it is entirely optional - a handler written as `(rpcData, msg) => ...` keeps working unchanged - but a long-running handler can honour it to stop work whose response can no longer be delivered:

```js
const link = new LinkClient({
  url, secret, kind: 'worker',
  rpcHandlers: {
    'report.build': async ({ range }, _msg, { signal }) => {
      // Pass the signal straight to AbortSignal-aware APIs.
      const rows = await db.query(buildSql(range), { signal });

      // ...or check it between expensive steps.
      for (const row of rows) {
        if (signal.aborted) throw new Error('cancelled');
        await renderRow(row);
      }
      return { ok: true, rows: rows.length };
    },
  },
});
```

If a handler ignores its signal it simply runs to completion as before; the client notices the RPC was cancelled and suppresses the outgoing `rpc.response` (the caller has already rejected locally). A handler that *does* abort will usually throw - that rejection is sanitized and sent like any other handler error, but the caller, having already given up, never sees it. The client also emits a `'rpc.cancel'` event (`{ id, from, rpcType }`) when an inbound RPC it is handling gets cancelled, which is handy for metrics.

> The hub stamps `from` on the relayed `rpc.cancel` from the authenticated socket, so a peer can only cancel an RPC it originated - it cannot abort another peer's in-flight work.


`createHub` and `createHubServer` accept four optional authorization callbacks. Each runs at the hub's dispatch choke-point for one operation - *after* a message is verified and the sender's `from` identity is established, *before* the hub acts on it:

| Callback       | Gates                 | Context object passed                |
|----------------|-----------------------|--------------------------------------|
| `canRpc`       | `link.rpc(...)`       | `{ from, to, rpcType, rpcData }`      |
| `canPublish`   | `link.publish(...)`   | `{ from, topic, payload }`            |
| `canSubscribe` | `link.subscribe(...)` | `{ from, topic }`                     |
| `canSend`      | `link.send(...)`      | `{ from, to, type, data }`            |

Each callback is sync or async and returns one of:

- `true` - allow
- `false` - deny (generic `Forbidden`)
- `{ ok: true }` - allow
- `{ ok: false, code, error }` - deny; `code` and `error` are surfaced to the caller (for RPC) and on the `acl-denied` event

```js
const hub = createHubServer({
  secret,
  canRpc: (ctx) => ctx.from === 'admin'
    ? true
    : { ok: false, code: 'NOT_ADMIN', error: 'admin only' },
  canPublish: async (ctx) => isAllowedTopic(ctx.from, ctx.topic),
});

hub.hub.on('acl-denied', (info) => {
  // { op: 'rpc'|'publish'|'subscribe'|'send', from, code, error, ... }
  metrics.increment('acl.denied', { op: info.op });
});
```

The gate **fails closed**: a callback that throws, or returns anything that is not an explicit allow (`undefined`, `null`, ...), denies the operation and logs a warning - a buggy ACL never silently authorizes traffic.

An RPC denial replies to the caller with a structured `rpc.response` error, which surfaces as an `RpcRemoteError` whose `code` is the verdict's `code` (default `'RPC_FORBIDDEN'`). Publish, subscribe, and send are fire-and-forget, so a denial there simply drops the message. All four denials emit the `acl-denied` hub event for observability.

A hub configured with no ACL callbacks pays zero overhead - the checks are skipped entirely. A non-function ACL option throws `TypeError` at construction.

> ACL hooks are an *application-level* authorization layer on top of link-core's transport authentication (which already establishes a trusted `from`). They are the natural place to enforce per-tenant isolation, role checks, or topic namespacing.

## Security & threat model

`link-core` is designed for **trusted-network, single-trust-zone** deployments - services you run, talking to services you run, on infrastructure you control. Read this section before exposing a hub on a network you don't fully control.

**What the protocol gives you**

- **Wire integrity.** Every message carries an HMAC-SHA256 signature over its envelope. Tampering with any field breaks the signature and the message is dropped. Verification is constant-time.
- **Per-peer identity (in per-peer-keys mode).** With [per-peer keys](#per-peer-keys), the hub looks up the key for the `kind` a socket claims at `hello`, so the handshake only succeeds if the peer holds *that kind's* key; the hub then stamps `from` from the authenticated socket on every forwarded message. A peer cannot forge messages claiming to come from another peer. **In shared-secret mode this binding does not hold** - every peer holds the same key, so any peer can `hello` as any `kind`. See *What the protocol does not give you* below, and `SECURITY.md` for the full discussion.
- **Replay protection (since v0.4.0).** Both client and hub drop messages whose `ts` is outside the configured `replayWindowMs` (default ±5 minutes), and remember message `id`s for that duration to drop duplicates. An attacker who captures a signed message on the wire and re-sends it within the window will see it dropped on the second arrival; outside the window, dropped on the first. Window and id-cache size are configurable; set `replayWindowMs: 0` to disable. **Caveat:** this defends against passive eavesdroppers replaying captured frames. It does *not* defend against an active attacker who has the shared secret - they can sign their own fresh messages.
- **Bounded incoming payload size (since v0.4.0).** Default cap of 1 MiB on incoming WebSocket frames, enforced both at the transport and in-handler. Configurable via `maxMessageBytes`.
- **Bounded outbound queue (backpressure).** When a peer's socket buffer (`ws.bufferedAmount`) exceeds `maxBufferedBytes` (default 4 MiB), outgoing messages are held in a bounded per-socket outbox (`maxOutboxBytes`, default 16 MiB) and drained as the socket catches up - rather than dropped, or buffered without limit. A single slow peer cannot OOM the hub; if it stays stuck long enough to fill its own outbox, further messages to *that* peer are dropped (with a loud `outbox-overflow` event) without affecting fan-out to any other peer. The client has the same per-link outbox.
- **Bounded retained hello (since v0.4.0).** The hub sanitizes each peer's hello payload to a small whitelist (`kind`, `name`, `pid`, `startedAt`) before persisting it in memory, dropping unknown fields and capping string lengths. A peer that puts a 50 MB string in `name` no longer pins hub memory until restart.

**What the protocol does *not* give you**

- **No rate limiting.** A client with a valid secret can flood the hub (within the per-message size cap).
- **No transport encryption built-in.** Run behind `wss://` (terminated at a reverse proxy or directly) if the network isn't trusted. The HMAC protects against tampering, not eavesdropping.
- **In shared-secret mode, `from` is not a trustworthy identity.** The shared secret is all-powerful: anyone holding it can connect *as any `kind`* of their choosing, and the hub will then stamp that `kind` as `from` on every message it forwards for them. Shared-secret mode authenticates *membership* of the bus, not the *identity* of individual peers - and the replay cache and most consumer code key on `from`, so it is easy to over-trust. Use [per-peer keys](#per-peer-keys) (since v0.4.0) if peers must not be able to impersonate one another.

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

> **Moved in v0.6.0:** the helper collection now lives in its own package, [`@presenc3/link-helpers`](https://www.npmjs.com/package/@presenc3/link-helpers).

Through v0.5.x, `link-core` bundled the service-pattern helpers that kept showing up around the bus - the leveled logger (`createLogger`), env coercion (`num` / `bool` / `requireEnv` / `linkClientOptionsFromEnv`), observability listener bundles (`attachClientObservability` / `attachHubObservability`), RPC + topic patterns (`waitForPeer` / `rpcWithRetry` / `createSafePublisher` / `createSafeSend`), lifecycle helpers (`installProcessHandlers` / `createGracefulShutdown`), the `loadSecrets` vault loader, and `createEventRecorder`.

In v0.6.0 they moved wholesale to `@presenc3/link-helpers`, and the `./helpers` subpath and the flat root re-exports are gone from this package. `link-core` keeps everything protocol-level: the client, hub, envelope, errors, and the [`./primitives` subpath](#subpath-imports) the helpers themselves build on.

Migration is an install plus an import change:

```bash
npm install @presenc3/link-helpers
```

```js
// before (v0.5.x)
const { createLogger, loadSecrets } = require('@presenc3/link-core');
const helpers = require('@presenc3/link-core/helpers');

// after (v0.6.0)
const { createLogger, loadSecrets } = require('@presenc3/link-helpers');
```

Helper behavior, options, and the wire conventions they implement (the `secs.*` RPC shapes, rotation topics, shutdown ordering) are documented in that package's README.

## API

### `new LinkClient(options)`

| Option                  | Type       | Required | Default       | Description                                                                                    |
|-------------------------|------------|----------|---------------|------------------------------------------------------------------------------------------------|
| `url`                   | `string`   | yes      |               | WebSocket URL of the hub (e.g. `ws://localhost:8080`).                                         |
| `secret`                | `string`   | yes      |               | HMAC secret. In shared-secret hub mode, must match every peer; in per-peer-keys mode, only this peer's key (the hub looks up the right key by `kind`). |
| `kind`                  | `string`   | yes      |               | Service type identifier (e.g. `'worker'`). Used for routing and peer lookup.                   |
| `name`                  | `string`   | no       | `kind`        | Human-readable instance name.                                                                  |
| `makeStatus`            | `function` | no       |               | Called on connect and every `statusIntervalMs`; return value is sent as a `status.update`.     |
| `rpcHandlers`           | `object`   | no       | `{}`          | Map of `rpcType > async (rpcData, msg, ctx?) => result`. `ctx.signal` is an `AbortSignal` fired on caller cancellation - see [Cancellable RPC handlers](#cancellable-rpc-handlers). Thrown errors become RPC error responses.   |
| `logger`                | `object\|null` | no   | console       | Custom logger with `log` and `warn` methods, or `null` to silence.                             |
| `defaultRpcTimeoutMs`   | `number`   | no       | `5000`        | Default per-call RPC timeout. Per-call `timeoutMs` overrides.                                  |
| `statusIntervalMs`      | `number`   | no       | `10000`       | Cadence for automatic `status.update` pushes when `makeStatus` is set.                         |
| `reconnectInitialMs`    | `number`   | no       | `1000`        | Initial reconnect delay.                                                                       |
| `reconnectMaxMs`        | `number`   | no       | `10000`       | Maximum reconnect delay (cap).                                                                 |
| `reconnectGrowth`       | `number`   | no       | `1.5`         | Multiplicative backoff factor between failed reconnect attempts.                               |
| `helloAckDiagnosticMs`  | `number`   | no       | `5000`        | If the link is not ready (no `hello.ack`) within this many ms of `open`, emit a diagnostic `protocol-error` naming the likely cause: secret/`hashAlgo` mismatch, clock skew, or a hub that verifies but never acks. Set to `0` to disable. |
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
- **`send(to, type, data)`** - Directed fire-and-forget. Returns `true` if sent, `false` if dropped due to local backpressure. Throws `LinkNotReadyError` only if the link is *disabled* (missing url/secret/kind) or *stopped* (a transient not-ready link queues instead), or `FeatureUnsupportedError` if the hub doesn't advertise the `'direct'` feature. See [Directed fire-and-forget](#directed-fire-and-forget). At-most-once: not queued if the target is offline.
- **`handle(rpcType, fn)`** - Register or replace the handler for `rpcType` at runtime. Returns the previous handler, or `undefined`. Designed for "register on every `'ready'`" plugin patterns; replaces silently. See [Dynamic RPC handlers](#dynamic-rpc-handlers).
- **`unhandle(rpcType)`** - Remove the handler for `rpcType`. Returns `true` if a handler was removed, `false` if there was none.
- **`waitFor(event, opts?)`** - Wait for the next occurrence of `event` and resolve with its payload. `opts` is `{ timeoutMs?, signal? }`. With `timeoutMs > 0`, rejects on timeout; with an aborted `signal`, rejects with an `AbortError`-named error. See [Waiting for events](#waiting-for-events).
- **`health()`** - Synchronous snapshot of `{ connected, verified, ready, lastVerifiedAt, peerCount, pendingRpcCount, subscriptionCount, bufferedAmount, reconnectAttempt, stopped }`. See [Health snapshot](#health-snapshot).
- **`subscribe(topic, handler)`** - Register `handler(payload, msg)` for a topic. Multiple handlers per topic are allowed and share one hub-side subscription. Throws on invalid topic. Subscribing while disconnected is fine - the subscription is replayed automatically after each reconnect.
- **`unsubscribe(topic, handler?)`** - Remove `handler` from `topic`, or all handlers if omitted. Returns `true` if anything was removed locally. The hub-side subscription is dropped only when the last handler for the topic is removed. Throws synchronously on an invalid topic name (like `subscribe` / `publish`).
- **`publish(topic, payload)`** - Publish to a topic. Throws `LinkNotReadyError` only if the link is *disabled* (missing url/secret/kind) or *stopped* (a transient not-ready link queues instead), or `FeatureUnsupportedError` if the hub doesn't support topics. Returns `true` if sent, `false` if dropped due to local backpressure (in which case `'backpressure'` was emitted). At-most-once: not queued for offline subscribers.
- **`getPeers()`** - Returns the latest peer list from the hub: `[{ kind, hello, connectedAt, connected }, ...]`.
- **`getPeerStatus(kind)`** - Returns the last known status for a peer of that kind, or `null`.

Properties:

- **`hubFeatures`** - The capability list announced by the hub in `hello.ack`, e.g. `['topics', 'direct']` for a v0.4.0+ hub. `null` while features are unknown - until the ack arrives and the link becomes ready (while `null`, feature-dependent sends queue rather than throw). An empty array means the acking hub advertised none. Use `link.hubFeatures?.includes('topics')` to pre-flight feature availability.
- **`rpcHandlers`** - The current map of `rpcType` > handler. Initially populated from the constructor; mutated by `handle()` / `unhandle()`. Treat as read-only - go through `handle()` for runtime changes.

#### Events

`LinkClient` extends `EventEmitter`. All events are additive - existing code that doesn't subscribe to anything continues to work.

| Event              | Payload                                                              | Fired when                                                                |
|--------------------|----------------------------------------------------------------------|---------------------------------------------------------------------------|
| `'connect'`        | `{ url, kind }`                                                      | Underlying WebSocket has opened and `hello` has been sent.                |
| `'verified'`       | `{ kind }`                                                           | First signed-and-verified message arrived. Crypto checks pass. Not yet a "safe to publish" gate - see `'ready'`. |
| `'ready'`          | `{ kind, features }`                                                 | Hub accepted the hello (`hello.ack.ok !== false`). The "really connected, safe to use" event. `features` is the hub's capability list (`['topics','direct']` for v0.4); `null` for hubs that don't advertise. |
| `'rejected'`       | `{ reason, error }`                                                  | Hub rejected the hello (`hello.ack.ok === false`). Default behavior: client `stop()`s itself - set `reconnectOnRejection: true` to keep retrying. |
| `'disconnect'`     | `{ code?, reason, willReconnect, wasReady, displaced? }`             | WebSocket closed. `willReconnect` is `false` after `stop()`, after a hello rejection (default), and when `displaced`. `wasReady` indicates whether `'ready'` had fired during this connection. `displaced: true` means the hub closed this socket because another connection authenticated as the same `kind` (close code `4000`); a displaced link never auto-reconnects - it almost always means two processes are sharing one kind. |
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
| `rpcHandlers`         | `object`       | no       | `{}`          | Map of `rpcType > async (rpcData, msg) => result` for RPCs addressed to `'server'`.           |
| `logger`              | `object\|null` | no       | console       | Custom logger with `log` and `warn` methods, or `null` to silence.                            |
| `keepaliveIntervalMs` | `number`       | no       | `15000`       | Ping cadence for liveness detection (post-hello sockets only).                                |
| `helloTimeoutMs`      | `number`       | no       | `10000`       | Time after socket open to wait for a successful `hello`. Closes the socket if missed. Set to `0` to disable. |
| `maxPendingSockets`   | `number`       | no       | `1024`        | Cap on concurrent un-authenticated sockets. When exceeded, the oldest pending socket is force-closed (FIFO eviction) and emits `peer.timeout` with `reason: 'pending-cap'`. Defends against attackers opening many TCP connections and never speaking. (since v0.5) |
| `replayWindowMs`      | `number`       | no       | `300000`      | Replay-protection window (matching the client). Set to `0` to disable.                        |
| `maxRecentIds`        | `number`       | no       | `10000`       | Cap on remembered message ids.                                                                |
| `maxMessageBytes`     | `number`       | no       | `1048576`     | Defensive in-handler size check. `createHub` is transport-agnostic; set `maxPayload` on your `WebSocketServer` separately. (`createHubServer` does this for you.) |
| `maxBufferedBytes`    | `number`       | no       | `4194304`     | Per-peer cap on `ws.bufferedAmount` before sends to that peer are dropped (4 MiB). Drops are logged. RPC forwards to a backpressured peer return an error response to the original caller. |
| `hashAlgo`            | `string`       | no       | `'sha256'`    | HMAC hash algorithm. Must match every client.                                                 |
| `canRpc`              | `function`     | no       | -             | Authorization callback for `rpc.request` (peer-routed and `to:'server'`). See [ACL hooks](#acl-hooks). |
| `canPublish`          | `function`     | no       | -             | Authorization callback for `topic.message` publishes. See [ACL hooks](#acl-hooks).            |
| `canSubscribe`        | `function`     | no       | -             | Authorization callback for `topic.subscribe`. See [ACL hooks](#acl-hooks).                    |
| `canSend`             | `function`     | no       | -             | Authorization callback for directed (`link.send`) messages. See [ACL hooks](#acl-hooks).      |

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
| `topic.publish`           | `{ from, topic, payload, subscriberCount, delivered }`                   | A peer published, regardless of subscriber count. `subscriberCount` excludes the publisher; `delivered <= subscriberCount`. |
| `rpc.forwarded`           | `{ id, from, to, rpcType }`                                              | An rpc.request was forwarded.                              |
| `rpc.response.forwarded`  | `{ id, from, to, ok }`                                                   | An rpc.response was forwarded back.                        |
| `rpc.server`              | `{ id, from, rpcType, ok, error?, durationMs }`                          | A `to: 'server'` RPC was handled.                          |
| `rpc.cancelled`           | `{ id, from, to, found, forwarded }`                                     | An `rpc.cancel` was processed. `found: true` only if a still-queued request was dropped; `forwarded: true` if the cancel was relayed on to a connected target so an in-flight handler can abort. |
| `acl-denied`              | `{ op, from, code, error, to?, rpcType?, topic?, type? }`                | An operation was rejected by an ACL callback. `op` is `'rpc' \| 'publish' \| 'subscribe' \| 'send'`. |
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
| `rpcHandlers` | `object`              | `{}`          | Map of `rpcType > async (rpcData, msg) => result`. Forwarded to `createHub`.                      |
| `host`              | `string`              | `'0.0.0.0'`   | Interface to bind. Ignored when `server` is provided.                                             |
| `port`              | `number`              | `8080`        | Port to listen on. Ignored when `server` is provided.                                             |
| `server`            | `http.Server`         | -             | BYO HTTP server. If passed, `host`/`port`/routes are ignored - the hub just attaches a `WebSocketServer` to it. Useful for embedding inside an existing app. |
| `path`              | `string`              | -             | If set, only handle WebSocket upgrades at this path (e.g. `'/link'`). Otherwise all upgrades are handled. |
| `routes`            | `object`              | `{}`          | Map of `pathname > (req, res) => void \| Promise<void>`. User routes win over the defaults below. |
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

#### Subpath imports

Beyond the package root, five focused subpaths are exported:

```js
const { sign, verify, makeMsg }  = require('@presenc3/link-core/protocol');   // ws-free
const { RpcTimeoutError }        = require('@presenc3/link-core/errors');     // ws-free
const { applyOptions, settleOnEvents } = require('@presenc3/link-core/primitives'); // ws-free
const { LinkClient }             = require('@presenc3/link-core/client');
const { createHub }              = require('@presenc3/link-core/hub');
```

`./primitives` is the stable low-level surface (option validators, logger normalization, `settleOnEvents`) promoted so sibling packages - notably `@presenc3/link-helpers` - build on the exact same building blocks link-core uses internally, semver-protected like the rest of the public API. `./protocol` (signing/envelope helpers), `./errors` (the typed error classes), and `./primitives` load **without pulling in `ws`** - handy for a tool, test, or consumer that only needs to verify a signature or `instanceof`-discriminate an error and does not want the WebSocket dependency in its graph. Every symbol on these subpaths is also exported flat from the package root, so both styles work. The same CJS modules back the `import` and `require` routes, so `instanceof` holds across the boundary.

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
| client > hub   | `hello`           | Sent on connect with `{ kind, name, pid, startedAt }`. The hub sanitizes this to a small whitelist before storing. |
| hub > client   | `hello.ack`       | `{ ok, serverTime, kind, features }` on success (since v0.4: `features` is the hub's capability list, e.g. `['topics', 'direct']`), or `{ ok: false, error }`. |
| client > hub   | `status.update`   | Whatever `makeStatus()` returns; re-broadcast by the hub.               |
| hub > client   | `peers.update`    | `{ peers: [{ kind, hello, connectedAt, connected }, ...] }`.            |
| hub > client   | `status.snapshot` | `{ kind: { status, at }, ... }` - sent once after `hello`.              |
| hub > client   | `status.update`   | `{ from, status, at }` - broadcast whenever a peer updates its status.  |
| either > either| `rpc.request`     | `{ rpcType, rpcData }`. The hub handles `to: 'server'`, else forwards.  |
| either > either| `rpc.response`    | `{ ok: true, result }` or `{ ok: false, error }`, correlated by `id`.   |
| either > either| `rpc.cancel`      | `{ id }` *(since v0.6.0)*. Caller > hub: best-effort cancel of an in-flight RPC. The hub drops the request if still queued, else relays it on to the target peer so an `AbortSignal`-aware handler can bail. |
| client > hub   | `topic.subscribe` | `{ topic }` - register the client's `kind` for fan-out on this topic.   |
| client > hub   | `topic.unsubscribe` | `{ topic? }` - unregister. Omitting `topic` removes from all topics.  |
| either > either| `topic.message`   | `{ topic, payload }`. Client > hub: publish. Hub > client: delivery to a subscriber, with `from` set to the publisher's authenticated kind. |
| either > either| `direct`          | `{ directType, directData }` *(since v0.4.0)*. Client > hub: directed fire-and-forget. Hub > client: delivery to the target, with `from` set to the sender's authenticated kind. Dropped silently if the target is offline. |

## Behavior notes

### Client

- **Reconnection:** exponential backoff starting at `reconnectInitialMs` (default 1 s), growing by `reconnectGrowth` (default 1.5×) per attempt, capped at `reconnectMaxMs` (default 10 s), with `reconnectJitter` (default 0.5 = ±25%) applied to each scheduled delay so synchronized drops (e.g. after a hub restart) don't all retry at the same instant. Set `reconnectJitter: 0` to disable. Backoff resets only on the `'ready'` transition - connections that open but never reach `ready` (e.g. secret mismatch leading to a hub-side close) keep growing the backoff across attempts.
- **`start()`/`stop()` race:** `start()` recognizes `OPEN`, `CONNECTING`, *and* `CLOSING`/`CLOSED` socket states; if there's an old closing socket, its listeners are detached so its eventual close can't interfere with the new connection. `stop()` does the same up front. *(since v0.4.0)*
- **Status cadence:** `makeStatus()` (if provided) fires once on connect and then every `statusIntervalMs` (default 10 s).
- **RPC timeouts:** default `defaultRpcTimeoutMs` (5 s). Timed-out RPCs reject with `RpcTimeoutError` (`err.code === 'RPC_TIMEOUT'`, message `RPC timeout after <ms>ms: <to>:<rpcType>`) and emit `'rpc.timeout'`. Late responses are logged and discarded.
- **RPC disconnects:** if the socket closes while an RPC is in flight, the call rejects immediately with `RpcDisconnectError` (`err.code === 'RPC_DISCONNECT'`) rather than waiting out its timeout.
- **RPC abort:** if a caller-supplied `AbortSignal` fires while the RPC is in flight (or before `rpc()` even sends), the call rejects with `RpcAbortError` (`err.code === 'RPC_ABORT'`). The local rejection is immediate either way; what happens on the wire is best-effort. The client also sends a best-effort `rpc.cancel` to the hub: if the request is still queued for a congested target the hub drops it before the target ever sees it; otherwise the hub relays the `rpc.cancel` on to the target peer, where a handler that read the `AbortSignal` it was handed (the third `rpc()`-handler argument) can bail out early. A handler that ignores its signal still runs to completion - its response is simply suppressed on arrival, since the caller has already given up. See [Aborting an in-flight RPC](#aborting-an-in-flight-rpc).
- **Replay & sizing:** messages outside the `replayWindowMs` window or duplicating a recently-seen `id` are dropped and emit `'protocol-error'`. Messages larger than `maxMessageBytes` are rejected at both the transport (`maxPayload`) and in-handler.
- **Backpressure never drops *(since v0.6.0)*:** when the socket is congested (`ws.bufferedAmount` over `maxBufferedBytes`) or the link is mid-reconnect, outbound messages are held in a bounded in-memory **outbox** and drained automatically once the link is healthy. Queued messages are signed at flush time, so a message that waited through a reconnect gets a fresh timestamp and isn't rejected by the hub's replay window. The *only* time an outbound message is refused is when the outbox byte cap (`maxOutboxBytes`, default 16 MiB) is hit - a loud `'outbox-overflow'` event, and `send()`/`publish()` return `false` / `rpc()` rejects `BackpressureError`. `send()`/`publish()` no longer throw `LinkNotReadyError` for a transient not-ready link - they queue. They still throw it for a *disabled* link (missing url/secret/kind) or a *stopped* one. **The outbox is in-memory only and is not persisted:** anything still queued when the process exits (a crash, an unhandled rejection, `SIGKILL`, or a non-graceful `stop({ drain: false })`) is lost. The outbox is a smoothing buffer for transient congestion, not a durable queue - if you need delivery to survive a process restart, build it from an RPC against a hub-handled handler that writes to your own store.
- **Graceful stop *(since v0.6.0)*:** `stop()` is now `async` and graceful by default - it flushes the outbox, lets in-flight RPCs settle, and waits for the socket buffer to drain (bounded by `stopDrainMs`, default 5 s) before closing. Pass `stop({ drain: false })` for the old immediate close. It always resolves, never rejects; when there is nothing in flight it still closes synchronously.
- **Reconnect ceiling *(since v0.6.0)*:** `maxReconnectAttempts` (default `Infinity` - reconnect forever) caps consecutive failed reconnects; a finite value emits `'reconnect-exhausted'` and stops. The counter resets on every `'ready'`.
- **Pub/sub subscriptions** are tracked client-side and replayed automatically on every `'ready'` transition, so reconnects don't require any application code to re-subscribe. See [Pub/sub topics](#pubsub-topics).
- **Direct messages** are at-most-once; if the target is offline at send time the message is dropped silently. The hub stamps `from` with the sender's authenticated kind. See [Directed fire-and-forget](#directed-fire-and-forget).
- **Dynamic RPC handlers:** the constructor's `rpcHandlers` is the canonical place; `handle()` / `unhandle()` mutate the same map at runtime. Re-registering the same handler is idempotent. See [Dynamic RPC handlers](#dynamic-rpc-handlers).
- **EventEmitter:** `LinkClient` is an `EventEmitter`. The listener cap is raised to 100 by default (`maxListeners` option) since the helpers attach many listeners. See the [Events](#events) section for the full list. Errors emit as `'ws-error'` and `'protocol-error'` rather than the bare `'error'` event, so an unhandled emit doesn't crash the process.
- **Logging:** pass `logger: null` to silence, or any logger with `debug` / `info` / `warn` / `error` methods (each `(context, message, ...args)`). A bare `console`, a minimal `{ log, warn }` object, or a pre-v0.6.0 `{ l, lD, lW, lE }` logger are all adapted automatically. `createLogger()` from `@presenc3/link-helpers` returns a logger in the canonical shape.

### Hub

- **Keep-alive:** WebSocket-level ping every `keepaliveIntervalMs` (default 15 s). Any socket that didn't pong back since the last ping is terminated.
- **Single connection per kind:** when a new `hello` arrives for a kind that's already connected, the old socket is closed. This prevents zombie connections after a hard crash + restart.
- **Trusted routing:** once a socket has completed the `hello` handshake, the hub always stamps outgoing messages with the socket's bound kind, ignoring whatever `from` a client writes. This applies to peer-routed forwards (`rpc.request`, `direct`), pub/sub fan-out, *and* server RPC handlers - `rpcHandlers` receive `msg.from` set to the authenticated kind, not whatever the client put on the wire. Peers can't impersonate each other.
- **Replay & sizing:** the hub applies the same `replayWindowMs` / `maxRecentIds` / `maxMessageBytes` checks as the client. `createHubServer` additionally sets `maxPayload` on the underlying `WebSocketServer` to enforce the size cap at the transport layer.
- **Backpressure never drops *(since v0.6.0)*:** when a peer's `ws.bufferedAmount` exceeds `maxBufferedBytes` (default 4 MiB), messages for that peer are held in a bounded **per-socket outbox** (`maxOutboxBytes`, default 16 MiB) and drained as the socket catches up. Per-peer, so one slow consumer never blocks fan-out (broadcasts, pub/sub) to fast peers. An RPC request forwarded to a congested peer is queued (and bounded by the caller's RPC timeout) rather than failed outright. A peer that stays stuck long enough to fill its own outbox starts dropping further messages *to that peer* with a loud `'outbox-overflow'` event; `hub.health()` reports `outboxBytes` and `queuedSockets`.
- **Trusted routing:** once a socket has completed the `hello` handshake, the hub always stamps outgoing messages with the socket's bound kind, ignoring whatever `from` a client writes. This applies to peer-routed forwards (`rpc.request`, `direct`), pub/sub fan-out, *and* server RPC handlers. **Note:** in shared-secret mode the bound kind is whatever the peer *claimed* at `hello` - see [Security & threat model](#security--threat-model).
- **RPC handler errors are sanitized:** an error thrown by a hub-side `rpcHandlers` entry reaches the caller as a generic `"Internal handler error"` unless it is an `RpcHandlerError` (or `exposeRpcErrors: true` is set). See [Errors](#errors).
- **Bounded hello:** the hub stores a *sanitized* whitelist (`kind`, `name`, `pid`, `startedAt`) of each peer's hello payload, dropping unknown fields and capping string lengths. This bounds per-peer hub memory and `/state` response size against buggy or hostile peers. Oversized `kind` strings are rejected and the hello is refused; `name` is truncated.
- **Pub/sub fan-out:** the hub keeps a `topic > Set<kind>` map. On peer disconnect (graceful or keepalive-terminate), every subscription belonging to that peer is dropped. The publisher does not receive its own message. See [Pub/sub topics](#pubsub-topics).
- **Status retention:** the hub keeps each peer's last `status.update` in a `kind > status` map and ships a `status.snapshot` to fresh peers right after their hello. On peer disconnect (graceful or keepalive), the hub drops that peer's last-known status - fresh peers won't see stale statuses for kinds that aren't currently connected.
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

One logger type is exported: `Logger`, the canonical four-method `{ debug, info, warn, error }` contract that `LinkClient` / `createHub` / `createHubServer` accept as their `logger` option (each method is `(context, message, ...args)`). At runtime, a bare `console`, a minimal `{ log, warn }` object, or a pre-v0.6 `{ l, lD, lW, lE }` logger are adapted automatically. The `createLogger()` in `@presenc3/link-helpers` returns an object that satisfies `Logger` directly - `new LinkClient({ ..., logger: createLogger() })` type-checks with no adapter (the richer `LeveledLogger` type ships with that package).

## What's new in v0.6.0

### Highlights

- **Helpers split into [`@presenc3/link-helpers`](https://www.npmjs.com/package/@presenc3/link-helpers).** (BREAKING) The helper collection (`createLogger`, env coercion, observability bundles, RPC/topic patterns, lifecycle, `loadSecrets`, `createEventRecorder`) moved to its own package; the `./helpers` subpath and the flat root re-exports are gone. Migration is `npm install @presenc3/link-helpers` plus an import change - see [Helpers](#helpers).
- **Readiness is strictly `hello.ack`-gated.** (BREAKING against pre-v0.4 hubs) `'ready'` now fires only when the hub's successful `hello.ack` arrives, never on an arbitrary verified frame - so readiness and the hub's *real* feature list always arrive together, and a hub that interleaves traffic ahead of its ack can no longer trigger an early ready that purged queued feature-dependent messages against an assumed-empty feature list. While features are still unknown (connected, no ack yet), `send()`/`publish()` queue instead of throwing. A hub that never acks (pre-v0.4) now leaves the client not-ready, with a loud diagnostic `protocol-error` (`reason: 'no-ack', verified: true`) explaining why.
- **`./primitives` subpath.** The stable low-level building blocks (option validators, logger normalization, `settleOnEvents`) are now a public, semver-protected, `ws`-free subpath - the shared foundation `@presenc3/link-helpers` builds on. See [Subpath imports](#subpath-imports).
- **Backpressure never drops.** Both the client and the hub now hold outbound messages in a bounded **outbox** when a socket is congested (or, on the client, mid-reconnect), and drain automatically. Queued messages are signed at flush time, so they survive a reconnect without tripping the replay window. The only refusal path is the hard outbox byte cap (`maxOutboxBytes`, default 16 MiB), which is a loud `'outbox-overflow'` event - never a silent drop. New options: `maxOutboxBytes` on the client, hub, and `createHubServer`.
- **Graceful `stop()`.** `link.stop()` is now `async` and graceful by default - it flushes the outbox, lets in-flight RPCs settle, and waits for the socket buffer to drain (bounded by `stopDrainMs`) before closing. `stop({ drain: false })` is the old immediate close. It always resolves, never rejects.
- **Reconnect ceiling.** New `maxReconnectAttempts` option (default `Infinity`). A finite value emits `'reconnect-exhausted'` and stops after that many consecutive failed reconnects.
- **RPC handler errors are sanitized.** A plain `Error` thrown by one of your RPC handlers no longer reaches the caller verbatim (which leaked stack traces / internal detail) - it arrives as a generic `"Internal handler error"`, while the real error is logged and emitted on `'rpc.handler-error'`. To send a deliberate, structured error, throw the new **`RpcHandlerError`** (`message` + `code` + optional `data`, all forwarded). Opt back into verbatim forwarding with `exposeRpcErrors: true`.
- **One logger interface.** The whole library now speaks one logger contract: `{ debug, info, warn, error }`. Any logger you pass in (a bare `console`, a `{ log, warn }` object, or a pre-v0.6.0 `{ l, lD, lW, lE }` logger) is adapted automatically. `createLogger()` (now in `@presenc3/link-helpers`) returns the canonical shape; `l`/`lD`/`lW`/`lE`/`log` remain as deprecated aliases on its result.
- **Failure-mode consistency.** `send()` / `publish()` no longer throw `LinkNotReadyError` for a *transient* not-ready link - they queue. They still throw it for a *disabled* link (missing url/secret/kind) or one that has been `stop()`ed; programmer errors (bad arguments) still throw synchronously everywhere.
- **`maxListeners` option** (default raised to 100), so observability listener bundles (e.g. `@presenc3/link-helpers`'s `attachClientObservability`) don't trip Node's listener-leak warning.

### Reliability hardening

A second pass over the message path closed a set of edge cases:

- **Liveness watchdog.** The client now pings the hub every `keepaliveIntervalMs` (default 30 s) and force-reconnects if a ping goes unanswered - so a wedged hub or a half-open connection is detected in seconds instead of waiting hours for the OS-level TCP keepalive. `0` disables it.
- **Non-serializable payloads fail fast.** `send()` / `publish()` / `rpc()` validate that the payload is both structured-cloneable *and* JSON-wire-serializable, and throw a `TypeError` at the call site. The two checks don't overlap: a `BigInt` (or a circular structure) clones happily but cannot be signed onto the wire, so a clone-only check would let it through to fail later. Previously such a value was accepted, then failed at flush time and was retried forever, head-of-line-blocking the whole outbox. Symmetrically, an RPC *handler* that returns a non-serializable value now replies with a structured `RPC_RESULT_NOT_SERIALIZABLE` error instead of leaving the caller to time out.
- **Bounded inbound RPC concurrency.** New `maxConcurrentRpc` option (default 256) on the client and hub caps how many RPC handlers run at once; further requests are shed immediately with `code: 'RPC_OVERLOADED'` instead of spawning unbounded work.
- **Status conflation.** A `status.update` already queued in the outbox is replaced in place rather than appended, so a congestion episode doesn't drain a backlog of stale snapshots.
- **Per-peer replay cache.** The replay-protection cache is now keyed per peer, so a single chatty peer can no longer LRU-evict (and silently shrink) other peers' replay windows. `maxRecentIds` is now a *per-peer* cap.
- **Clearer clock-skew diagnostics.** When signature-valid messages are dropped for being outside the replay window, the client now emits a distinct `'protocol-error'` with `reason: 'clock-skew'` (carrying the observed `skew`) instead of a generic "no ack" warning - pointing straight at unsynced clocks.
- **`rpc.response` correlation check.** A response whose `from` does not match the peer the RPC was sent to is dropped (`reason: 'rpc-response-mismatch'`).
- **Handler payload isolation.** Each local topic/`direct` subscriber receives its own copy of the payload, so one handler mutating it cannot corrupt what siblings see.

### Release-audit hardening

A pre-release adversarial review (with an external reviewer's findings, every item reproduced before fixing) closed a final set of correctness and robustness gaps:

- **Canonical signing is JSON-faithful.** The signing serializer now implements `JSON.stringify`'s semantics exactly - `toJSON(key)` receives the property key, and boxed primitives (`new Number(1)`, `new String('x')`, `new Boolean(true)`) are unwrapped after the `toJSON` step, the way native JSON does. Previously a boxed primitive signed one byte-sequence and shipped another, producing a guaranteed `bad-signature` on receipt; a key-sensitive `toJSON` did the same. The invariant is now fuzz-tested: `stableStringify(x) === stableStringify(JSON.parse(JSON.stringify(x)))` for every `x` JSON accepts. Wire-safety validation unwraps the same way, so `new Number(NaN)` and boxed BigInts are rejected at the call site.
- **`RpcHandlerError.data` is wire-validated** on both the client and hub handler paths, exactly like a success result: lossy data (a `Map`, a `Set`) is stripped with a loud local log while the deliberate `error`/`code` still reach the caller, and unserializable data (a BigInt) can no longer convert your intentional application error into a phantom `RpcTimeoutError` on the caller's side.
- **One socket, one identity.** Two hellos racing a slow async secret resolver could authenticate a single socket as two kinds, leaving a ghost peer behind on close. The first hello now wins; the loser is rejected with `reason: 'duplicate-hello', detail: 'concurrent-hello'`.
- **`createHubServer` lifecycle is concurrency-safe.** `start()` is single-flight (concurrent calls share one `listen()`), `stop()` interlocks with an in-flight `start()` (a stop during a pending listen can no longer leave a live, unreachable-to-teardown server), signal handlers are installed once and removed on every stop path, a failed bind is retryable, and `isStarted` now reads cleanly as "up and not yet stopped".
- **`makeStatus()` output is validated** like every other app-supplied payload before it ships - a lossy status is warned about locally instead of arriving at the hub as `{}` or silently failing at flush.
- **`/state` can no longer hang.** The response is serialized *before* headers are written, so an unserializable `extraState` yields a clean HTTP 500; a handler throwing mid-stream now ends the response instead of leaving the request to dangle.
- **Graceful `stop()` quiesces timers first.** The status interval, keepalive, and hello-ack diagnostic are cleared the moment a graceful stop begins, so the drain window flushes what was queued without fresh frames or spurious diagnostics being generated mid-shutdown.
- **Outbox accounting is honest.** Byte estimates now measure `id`/`type`/`to`/`from` (an `rpc.response` echoing a caller's id previously under-counted by the id's whole length), and inbound envelope ids are capped at 256 chars (`reason: 'oversized-id'`) so a peer cannot inflate your retained memory through giant echoed ids.
- **Construction-time validation.** A `kind` with surrounding whitespace is rejected up front (previously the hub registered the trimmed name while the client reported the padded one - a split identity), and `name` must be a non-empty string when provided.

### New events

- Client: `'reconnect-exhausted'`, `'outbox-overflow'`, `'outbox-drained'`, `'outbox-error'`, `'rpc.handler-error'`.
- Hub: `'outbox-overflow'`, `'outbox-error'`. The `'backpressure'` event is now edge-triggered and carries `queued: true` (the message was queued, not dropped).

### Housekeeping

- All source files normalized to LF line endings, with a `.gitattributes` to keep them that way.
- `hub.health()` / `link.health()` now report outbox depth.

## What's new in v0.5

This release is wire-compatible with v0.4.x (`PROTOCOL_VERSION` is still `1`).

### Highlights

- **Helpers**. A logger, env coercion utilities, observability listener bundles, RPC patterns, lifecycle helpers, a secrets loader, and a dashboard-friendly event recorder - twenty-one symbols in total, all exported flat from the package root and also reachable via a new `./helpers` subpath. *(Moved to `@presenc3/link-helpers` in v0.6.0 - see [Helpers](#helpers).)*
- **`LinkBusClient` alias removed.** The deprecated alias announced in v0.4.0 ("kept as an alias in v0.4.x for backwards compatibility and will be removed in v0.5.0") is gone, along with its `LinkBusClientOptions` / `LinkBusClientEvents` type aliases. Rename to `LinkClient` / `LinkClientOptions` / `LinkClientEvents` - the underlying class and types are unchanged.
- **`LeveledLogger` TypeScript type added.** Describes the rich object returned by `createLogger()`. Distinct from the existing two-method `Logger` type that `LinkClient` accepts as its `logger` option.
- **Line endings normalized.** The source tree is now all LF, matching what `.gitattributes` had declared as intent in v0.4.1. (Previous tarballs shipped CRLF for some files due to a packaging quirk.)

### Safer defaults & fail-fast (potentially breaking)

- **`createHubServer({ enableStateRoute })` defaults to `false`.** Previously `true`. The `/state` route exposes peer kinds, hello payloads, `connectedAt`, and last-known statuses, which is fine for an internal dashboard but undesirable on a public bind. Opt in explicitly for dashboards / dev: `createHubServer({ enableStateRoute: true })`. If you do opt in *and* bind to `0.0.0.0`, an informational warning still fires.
- **`createHubServer` is single-shot.** Calling `start()` after `stop()` now throws `Error('createHubServer is single-shot…')`. Previously the second `start()` appeared to succeed and produced an undefined-state server. If you need restart, call `createHubServer()` again. A new `isStopped` getter reports whether the server has been torn down.
- **`createHubServer.stop()` before `start()` now closes `wss`.** Previously left the eagerly-constructed `WebSocketServer` dangling.
- **`link.rpc()` validates `to` / `rpcType` synchronously.** Invalid arguments now throw `TypeError` at the call site, matching `send()` / `subscribe()` / `publish()`. Previously an invalid `to` produced a delayed `RpcTimeoutError`, indistinguishable from a "peer not reachable" condition.
- **Numeric options validated up-front.** `LinkClient`, `createHub`, and `createHubServer` reject `NaN`, `Infinity`, negatives, and wrong types with a `TypeError` naming the offending option. Previously `Number(process.env.X) // > NaN` silently turned timers into 0-ms tight loops.

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
- **`topic.publish` hub event always carries `delivered`.** Previously omitted on no-subscriber topics, tripping subscriber arithmetic on `undefined`. `subscriberCount` now excludes the publisher, so `delivered <= subscriberCount` always holds.
- **Displaced same-kind clients stop instead of fighting.** If a second connection authenticates as an already-connected `kind`, the hub closes the older socket with close code `4000`; that client now emits `disconnect { displaced: true, willReconnect: false }` and stays down, instead of the two processes replacing-and-reconnecting each other forever.
- **`reconnectOnRejection: true` actually retries now.** It was previously a no-op (socket left open, never-ready, no reconnect scheduled); it now closes and reconnects with the normal backoff.
- **Graceful `stop()` no longer re-enters `ready`.** An in-flight RPC response arriving during the drain could re-set `_ready` and emit a spurious `'ready'`; `isReady()` is now reliably `false` after `await stop()`. In-flight RPCs still settle during the drain.
- **Explicit `stop()` clears the whole outbox.** A deliberate teardown now drops all queued outbound messages (not just queued RPC requests); automatic reconnects still preserve them across the blip.
- **Hub `status.update` conflation is per originating peer.** A congested recipient now retains the latest status from *each* peer; the conflation key previously collapsed all peers' statuses into one.
- **Hub ignores stale replaced sockets.** During the close race after a replacement, the old socket's in-flight messages are no longer processed as authoritative for the kind.
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
- **Bug fix: peer-routed RPC.** `rpc.response` is now exempt from the id-replay check on both client and hub. The old behavior caused responses to be dropped because they carry the same `id` as the request that was already added to the recent-id cache; peer-routed RPCs (e.g. `cli > secs`) silently timed out as a result. The timestamp-window check still applies - only the id check changes for response messages.
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
2. **Standalone single-file showcases** that each isolate one helper (the helpers live in `@presenc3/link-helpers` since v0.6.0; these examples import them from there):
   - `05-disabled-mode` - the "no link bus" local-dev pattern, with `link.ready()` rejecting fast and `createSafePublisher` no-op'ing on a disabled link.
   - `06-dashboard` - `createEventRecorder` + SSE for a live bus-state dashboard, with `createLogger` passed directly as `logger`.
   - `07-loadsecrets-vault` + `08-loadsecrets-consumer` - the `loadSecrets({ watch: true })` wire convention end-to-end, with rotation events visible.
   - `09-graceful-shutdown` - `createGracefulShutdown` + `installProcessHandlers` orchestrating a multi-resource cleanup.

See [`examples/README.md`](https://github.com/Presenc3/link-core/tree/main/examples/README.md) for the topology and how to run them.

## License

MIT © Presenc3