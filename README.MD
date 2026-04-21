# @presenc3/link-core

Shared WebSocket link protocol, client, and hub for inter-service communication.

`link-core` gives you a small, opinionated way to tie multiple Node.js services together over WebSockets. It ships:

- **`LinkBusClient`** - a client that handles connection, reconnection, HMAC-signed messages, periodic status pushes, peer discovery, and request/response RPC.
- **`createHub`** - an embeddable hub that routes messages between peers, tracks status, enforces one connection per peer kind, and lets you expose your own server-side RPCs.

The library is unopinionated about roles — every service uses `LinkBusClient`, and the meaning of "coordinator", "worker", "publisher", etc. is up to you.

## Install

```bash
npm install @presenc3/link-core
```

## Quick start

### Run a hub

The hub is transport-agnostic — you bring the HTTP/WebSocket server:

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

Both sides are symmetric — the coordinator could just as easily expose its own `rpcHandlers`, and the worker could call `link.rpc(...)` back.

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

- **`start()`** — Connect to the hub. No-op if `url`, `secret`, or `kind` is missing (just logs a warning).
- **`stop()`** — Close the connection, cancel timers, and reject any pending RPCs. The client will not auto-reconnect after `stop()`.
- **`isConnected()`** — `true` if the WebSocket is open.
- **`rpc(to, rpcType, rpcData, timeoutMs = 5000)`** — Send an RPC to a peer of kind `to` (or `'server'` for hub-handled RPCs) and return a Promise that resolves with the result or rejects on error/timeout.
- **`getPeers()`** — Returns the latest peer list from the hub: `[{ kind, hello, connectedAt, connected }, ...]`.
- **`getPeerStatus(kind)`** — Returns the last known status for a peer of that kind, or `null`.

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

- **`attach(ws, req)`** — Wire up an incoming WebSocket. Call this from your `WebSocketServer`'s `'connection'` handler. The hub takes care of hello handshake, message verification, routing, keep-alive, and cleanup.
- **`getState()`** — Returns `{ peers, lastStatus }` for introspection (e.g. health endpoints).
- **`stop()`** — Cancel the keep-alive interval and close all tracked client sockets. Call on shutdown.

### Protocol helpers

For writing tools, tests, or alternative hub implementations, the signing utilities are exported from the main entry:

```js
const { sign, verify, makeMsg, stableStringify } = require('@presenc3/link-core');
```

- **`makeMsg(secret, { v?, id, ts?, type, from?, to?, data })`** — Build a fully-formed, signed message envelope. `v` defaults to `1`, `ts` defaults to `Date.now()`, `from` and `to` default to `null`.
- **`sign(secret, msg)`** — Return the hex HMAC-SHA256 signature of a message (excluding its `sig` field).
- **`verify(secret, msg)`** — Constant-time verify a signed message. Returns `true`/`false`.
- **`stableStringify(obj)`** — Deterministic JSON stringifier with sorted keys. Used internally so signatures are stable regardless of key order.

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
| hub → client   | `status.snapshot` | `{ kind: { status, at }, ... }` — sent once after `hello`.              |
| hub → client   | `status.update`   | `{ from, status, at }` — broadcast whenever a peer updates its status.  |
| either → either| `rpc.request`     | `{ rpcType, rpcData }`. The hub handles `to: 'server'`, else forwards.  |
| either → either| `rpc.response`    | `{ ok: true, result }` or `{ ok: false, error }`, correlated by `id`.   |

## Behavior notes

### Client

- **Reconnection:** exponential backoff starting at 1 s, growing 1.5× per attempt, capped at 10 s. Resets to 1 s on a successful connection.
- **Status cadence:** `makeStatus()` (if provided) fires once on connect and then every 10 s.
- **RPC timeouts:** default 5 s. Timed-out RPCs reject with `RPC timeout after <ms>ms: <to>:<rpcType>`. Late responses are logged and discarded.
- **Logging:** pass `logger: null` to silence, or an object with `log(tag, ...args)` and `warn(tag, ...args)` to integrate with your own logger.

### Hub

- **Keep-alive:** WebSocket-level ping every 15 s. Any socket that didn't pong back since the last ping is terminated.
- **Single connection per kind:** when a new `hello` arrives for a kind that's already connected, the old socket is closed. This prevents zombie connections after a hard crash + restart.
- **Trusted routing:** once a socket has completed the `hello` handshake, the hub always stamps outgoing messages with the socket's bound kind, ignoring whatever `from` a client writes. Peers can't impersonate each other.

### Protocol

- **Signatures:** HMAC-SHA256 over the `stableStringify` of the envelope with `sig` removed. Verification is constant-time.

## License

MIT © Presenc3