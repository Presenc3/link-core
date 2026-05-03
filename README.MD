# @presenc3/link-core

Shared WebSocket link protocol, client, and hub for inter-service communication.

`link-core` gives you a small, opinionated way to tie multiple Node.js services together over WebSockets. It ships:

- **`LinkBusClient`** - a client that handles connection, reconnection, HMAC-signed messages, periodic status pushes, peer discovery, and request/response RPC.
- **`createHub`** - an embeddable hub that routes messages between peers, tracks status, enforces one connection per peer kind, and lets you expose your own server-side RPCs. Transport-agnostic - you bring the HTTP/WebSocket server.
- **`createHubServer`** - a batteries-included hub server that wraps `createHub` with an HTTP server, WebSocket server, default `/health` and `/state` routes, signal handling, and graceful shutdown. Use this when the hub *is* your service.

The library is unopinionated about roles - every service uses `LinkBusClient`, and the meaning of "coordinator", "worker", "publisher", etc. is up to you.

## Install

```bash
npm install @presenc3/link-core
```

## Quick start

There are two ways to run a hub:

- **`createHubServer`** - batteries-included. Spins up the HTTP server, WebSocket server, default `/health` + `/state` routes, signal handling, and graceful shutdown for you. Use this when the hub is the whole job.
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

- An HTTP server on `:8080` with `GET /health` and `GET /state` already wired.
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
const { LinkBusClient } = require('@presenc3/link-core');

const link = new LinkBusClient({
  url:    'ws://localhost:8080',
  secret: process.env.LINK_SECRET,
  kind:   'worker',
  name:   'worker-1',
});

link.start();
```

That's enough to connect, authenticate with the shared secret, and stay connected (it'll reconnect with exponential backoff if the hub goes away).

> **`kind` is a singleton service identity, not a worker-pool name.** The hub enforces one connection per `kind`: if a second client connects with the same `kind` as a connected one, the *old* socket is closed. This is intentional — it prevents zombie connections after a hard crash + restart. If you want to run multiple instances of the same service in parallel (`worker-1`, `worker-2`, ...), give each a unique `kind`.

## A two-service example

Say you have a **coordinator** that hands out jobs and a **worker** that does them. Both use the same `LinkBusClient`; the only difference is what they *do* with it.

### Worker

```js
const { LinkBusClient } = require('@presenc3/link-core');

const link = new LinkBusClient({
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
const { LinkBusClient } = require('@presenc3/link-core');

const link = new LinkBusClient({
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

Any `rpc.request` with `to: 'server'` is handled by the hub itself, using the `serverRpcHandlers` you pass to `createHub`. The shape is identical to a client's `rpcHandlers`:

```js
const hub = createHub({
  secret: process.env.LINK_SECRET,
  serverRpcHandlers: {
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
  serverRpcHandlers: createKvHandlers('./data/kv.json'),
});
```

## Security & threat model

`link-core` is designed for **trusted-network, single-trust-zone** deployments — services you run, talking to services you run, on infrastructure you control. Read this section before exposing a hub on a network you don't fully control.

**What the protocol gives you**

- **Wire integrity.** Every message carries an HMAC-SHA256 signature over its envelope. Tampering with any field breaks the signature and the message is dropped. Verification is constant-time.
- **Anti-impersonation between authenticated peers.** Once a socket completes the `hello` handshake, the hub binds it to that `kind` and overwrites the `from` field on every forwarded message. A peer cannot forge messages claiming to come from another peer.

**What the protocol does *not* give you (yet)**

- **No replay protection.** Messages have `ts` and `id` fields, but the hub doesn't enforce a clock-skew window or maintain a recent-id cache. An attacker who captures a signed message on the wire (e.g., on an unencrypted `ws://` link) can re-send it and the hub will accept it. Planned for future version.
- **No per-peer credentials.** The shared secret is all-powerful: anyone with it can connect *as any `kind`* of their choosing. They cannot impersonate per-message after handshake (see above), but they can hello-bomb to displace a legitimate peer (because the hub enforces one connection per kind, a new hello with an existing kind kicks the old socket off).
- **No payload size cap is exposed.** The underlying `ws` library accepts the default `maxPayload` (100 MB). A misbehaving or malicious client can send large frames.
- **No rate limiting.** A client with the secret can flood the hub.

**Deployment recommendations**

- Run the hub on `localhost` or a private network. If you must cross a network boundary, terminate `wss://` at a reverse proxy (nginx, Caddy, Cloudflare) — don't expose `ws://` over the public internet.
- Treat the shared secret like a database password. Don't commit it. Rotate it if a service is compromised — rotation requires a coordinated restart of every peer.
- The default `/state` route on `createHubServer` exposes peer kinds, hello payloads, and last-known status. Keep it on a non-public port, gate it behind your own auth, or set `enableStateRoute: false`.
- When embedding the hub inside an existing HTTP server (`server: yourServer`), **always pass a `path`** unless you're certain no other code on that server uses WebSocket upgrades. Without it, the hub intercepts every upgrade.

## API

### `new LinkBusClient(options)`

| Option        | Type       | Required | Description                                                                                    |
|---------------|------------|----------|------------------------------------------------------------------------------------------------|
| `url`         | `string`   | yes      | WebSocket URL of the hub (e.g. `ws://localhost:8080`).                                         |
| `secret`      | `string`   | yes      | Shared HMAC-SHA256 secret. Must match the hub and all peers.                                   |
| `kind`        | `string`   | yes      | Service type identifier (e.g. `'worker'`). Used for routing and peer lookup.                   |
| `name`        | `string`   | no       | Human-readable instance name. Defaults to `kind`.                                              |
| `makeStatus`  | `function` | no       | Called on connect and every 10s; return value is sent as a `status.update` message.            |
| `rpcHandlers` | `object`   | no       | Map of `rpcType → async (rpcData, msg) => result`. Thrown errors become RPC error responses.   |
| `logger`      | `object\|null` | no   | Custom logger with `log` and `warn` methods, or `null` to silence. Defaults to a console logger. |

Methods:

- **`start()`** - Connect to the hub. No-op if `url`, `secret`, or `kind` is missing (just logs a warning).
- **`stop()`** - Close the connection, cancel timers, and reject any pending RPCs with `Error('Link stopped before RPC completed')`. The client will not auto-reconnect after `stop()`.
- **`isConnected()`** - `true` if the WebSocket is open.
- **`rpc(to, rpcType, rpcData, timeoutMs = 5000)`** - Send an RPC to a peer of kind `to` (or `'server'` for hub-handled RPCs) and return a Promise that resolves with the result or rejects on error/timeout.
- **`getPeers()`** - Returns the latest peer list from the hub: `[{ kind, hello, connectedAt, connected }, ...]`.
- **`getPeerStatus(kind)`** - Returns the last known status for a peer of that kind, or `null`.

### `createHub(options)`

```js
const { createHub } = require('@presenc3/link-core');
```

| Option              | Type         | Required | Description                                                                                   |
|---------------------|--------------|----------|-----------------------------------------------------------------------------------------------|
| `secret`            | `string`     | yes      | Shared HMAC-SHA256 secret. Must match every connecting peer.                                  |
| `serverRpcHandlers` | `object`     | no       | Map of `rpcType → async (rpcData, msg) => result` for RPCs addressed to `'server'`.           |
| `logger`            | `object\|null` | no     | Custom logger with `log` and `warn` methods, or `null` to silence. Defaults to a console logger. |

Methods:

- **`attach(ws, req)`** - Wire up an incoming WebSocket. Call this from your `WebSocketServer`'s `'connection'` handler. The hub takes care of hello handshake, message verification, routing, keep-alive, and cleanup.
- **`getState()`** - Returns `{ peers, lastStatus }` for introspection (e.g. health endpoints).
- **`stop()`** - Cancel the keep-alive interval and close all tracked client sockets. Call on shutdown.

### `createHubServer(options)`

```js
const { createHubServer } = require('@presenc3/link-core');
```

A batteries-included wrapper around `createHub`. Creates and manages the HTTP server, WebSocket server, default routes, signal handling, and graceful shutdown so you don't have to. Internally delegates to `createHub`, so wire-level behavior is identical.

| Option              | Type                  | Default       | Description                                                                                       |
|---------------------|-----------------------|---------------|---------------------------------------------------------------------------------------------------|
| `secret`            | `string`              | -             | **Required.** Shared HMAC-SHA256 secret. Forwarded to `createHub`.                                |
| `serverRpcHandlers` | `object`              | `{}`          | Map of `rpcType → async (rpcData, msg) => result`. Forwarded to `createHub`.                      |
| `host`              | `string`              | `'0.0.0.0'`   | Interface to bind. Ignored when `server` is provided.                                             |
| `port`              | `number`              | `8080`        | Port to listen on. Ignored when `server` is provided.                                             |
| `server`            | `http.Server`         | -             | BYO HTTP server. If passed, `host`/`port`/routes are ignored - the hub just attaches a `WebSocketServer` to it. Useful for embedding inside an existing app. |
| `path`              | `string`              | -             | If set, only handle WebSocket upgrades at this path (e.g. `'/link'`). Otherwise all upgrades are handled. |
| `routes`            | `object`              | `{}`          | Map of `pathname → (req, res) => void \| Promise<void>`. User routes win over the defaults below. |
| `enableHealthRoute` | `boolean`             | `true`        | Adds `GET /health` returning `{ ok: true, now }`. Ignored when `server` is provided.              |
| `enableStateRoute`  | `boolean`             | `true`        | Adds `GET /state` returning `{ ...hub.getState(), ...extraState() }` pretty-printed. Ignored when `server` is provided. |
| `extraState`        | `function`            | -             | `() => object \| Promise<object>`. Merged into `/state` after `hub.getState()`. Use this for app-specific state like `{ kvKeys: 42 }`. |
| `handleSignals`     | `boolean`             | `true`        | Install `SIGINT`/`SIGTERM` handlers that call `stop()`. Set to `false` if you already manage signals. |
| `signals`           | `string[]`            | `['SIGINT','SIGTERM']` | Which signals to handle when `handleSignals` is `true`.                                  |
| `shutdownTimeoutMs` | `number`              | `30000`       | Hard cap on how long graceful shutdown is allowed to take before it errors out.                   |
| `drainDelayMs`      | `number`              | `250`         | Time to wait between asking clients to close and force-terminating stragglers.                    |
| `onShutdown`        | `function`            | -             | `async () => void`. Runs at the **end** of shutdown, after sockets and the HTTP server are closed. Perfect for flushing files or closing DB connections. |
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
  serverRpcHandlers: kv.handlers,

  // expose the kv size on /state alongside { peers, lastStatus }
  extraState: () => ({ kvKeys: kv.size }),

  // flush pending writes before the process exits
  onShutdown: () => kv.flushSync(),

  // a custom HTTP route alongside /health and /state
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

- **`makeMsg(secret, { v?, id, ts?, type, from?, to?, data })`** - Build a fully-formed, signed message envelope. `v` defaults to `PROTOCOL_VERSION` (currently `1`), `ts` defaults to `Date.now()`, `from` and `to` default to `null`. The returned object references your `data` directly — treat `data` as immutable after the call.
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
| client → hub   | `hello`           | Sent on connect with `{ kind, name, pid, startedAt }`.                  |
| hub → client   | `hello.ack`       | `{ ok, serverTime, kind }` on success, or `{ ok: false, error }`.       |
| client → hub   | `status.update`   | Whatever `makeStatus()` returns; re-broadcast by the hub.               |
| hub → client   | `peers.update`    | `{ peers: [{ kind, hello, connectedAt, connected }, ...] }`.            |
| hub → client   | `status.snapshot` | `{ kind: { status, at }, ... }` - sent once after `hello`.              |
| hub → client   | `status.update`   | `{ from, status, at }` - broadcast whenever a peer updates its status.  |
| either → either| `rpc.request`     | `{ rpcType, rpcData }`. The hub handles `to: 'server'`, else forwards.  |
| either → either| `rpc.response`    | `{ ok: true, result }` or `{ ok: false, error }`, correlated by `id`.   |

## Behavior notes

### Client

- **Reconnection:** exponential backoff starting at 1 s, growing 1.5× per attempt, capped at 10 s. Resets to 1 s on a successful connection.
- **Status cadence:** `makeStatus()` (if provided) fires once on connect and then every 10 s.
- **RPC timeouts:** default 5 s. Timed-out RPCs reject with `RPC timeout after <ms>ms: <to>:<rpcType>`. Late responses are logged and discarded.
- **RPC disconnects:** if the socket closes while an RPC is in flight, the call rejects immediately with `Link disconnected before RPC completed` rather than waiting out its timeout.
- **Logging:** pass `logger: null` to silence, or an object with `log(tag, ...args)` and `warn(tag, ...args)` to integrate with your own logger.

### Hub

- **Keep-alive:** WebSocket-level ping every 15 s. Any socket that didn't pong back since the last ping is terminated.
- **Single connection per kind:** when a new `hello` arrives for a kind that's already connected, the old socket is closed. This prevents zombie connections after a hard crash + restart.
- **Trusted routing:** once a socket has completed the `hello` handshake, the hub always stamps outgoing messages with the socket's bound kind, ignoring whatever `from` a client writes. This applies to both peer-routed forwards *and* server RPC handlers — `serverRpcHandlers` receive `msg.from` set to the authenticated kind, not whatever the client put on the wire. Peers can't impersonate each other.

### Protocol

- **Signatures:** HMAC-SHA256 over the `stableStringify` of the envelope with `sig` removed. Verification is constant-time.

## License

MIT © Presenc3