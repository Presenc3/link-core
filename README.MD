# @presenc3/link-core

Shared WebSocket link protocol and client for inter-service communication.

`link-core` gives you a small, opinionated WebSocket client for tying multiple Node.js services together through a central bus. It handles reconnection, HMAC-signed messages, periodic status pushes, peer discovery, and request/response RPC — so your services can just talk to each other.

> **Note:** This package ships only the *client*. You need a WebSocket bus server that speaks the same envelope format (see [Message envelope](#message-envelope)) and re-broadcasts messages to connected peers. The library is unopinionated about roles — every service uses the same `LinkBusClient`, and the meaning of "coordinator", "worker", "publisher", etc. is up to you.

## Install

```bash
npm install @presenc3/link-core
```

## Quick start

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

That's enough to connect, authenticate with the shared secret, and stay connected (it'll reconnect with exponential backoff if the server goes away).

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

  // Pushed to the bus on connect and every 10s.
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

## API

### `new LinkBusClient(options)`

| Option        | Type       | Required | Description                                                                                        |
|---------------|------------|----------|----------------------------------------------------------------------------------------------------|
| `url`         | `string`   | yes      | WebSocket URL of the bus server (e.g. `ws://localhost:8080`).                                      |
| `secret`      | `string`   | yes      | Shared HMAC-SHA256 secret. Must match the server and all peers.                                    |
| `kind`        | `string`   | yes      | Service type identifier (e.g. `'worker'`, `'coordinator'`). Used for routing and peer lookup.      |
| `name`        | `string`   | no       | Human-readable instance name. Defaults to `kind`.                                                  |
| `makeStatus`  | `function` | no       | Called on connect and every 10s; return value is sent as a `status.update` message.                |
| `rpcHandlers` | `object`   | no       | Map of `rpcType → async (rpcData, msg) => result`. Thrown errors become RPC error responses.       |
| `logger`      | `object\|null` | no   | Custom logger with `log` and `warn` methods, or `null` to silence. Defaults to a console logger.   |

### Methods

- **`start()`** — Connect to the bus. No-op if `url`, `secret`, or `kind` is missing (just logs a warning).
- **`stop()`** — Close the connection, cancel timers, and reject any pending RPCs. The client will not auto-reconnect after `stop()`.
- **`isConnected()`** — `true` if the WebSocket is open.
- **`rpc(to, rpcType, rpcData, timeoutMs = 5000)`** — Send an RPC to a peer of kind `to` and return a Promise that resolves with the result or rejects on error/timeout.
- **`getPeers()`** — Returns the latest peer list received from the bus (array — format depends on your server).
- **`getPeerStatus(kind)`** — Returns the last known status for a peer of that kind, or `null`.

### Protocol helpers

For building tools, tests, or your bus server, the signing utilities are exported directly:

```js
const { sign, verify, makeMsg, stableStringify } = require('@presenc3/link-core');
```

- **`makeMsg(secret, { v?, id, ts?, type, from?, to?, data })`** — Build a fully-formed, signed message envelope. `v` defaults to `1`, `ts` defaults to `Date.now()`, `from` and `to` default to `null`.
- **`sign(secret, msg)`** — Return the hex HMAC-SHA256 signature of a message (excluding its `sig` field).
- **`verify(secret, msg)`** — Constant-time verify a signed message. Returns `true`/`false`.
- **`stableStringify(obj)`** — Deterministic JSON stringifier with sorted keys. Used internally so signatures are stable regardless of key order.

## Message envelope

Every message over the wire is a JSON object of this shape:

```js
{
  v:    1,                  // protocol version
  id:   '...uuid...',       // message id (also used to correlate RPC responses)
  ts:   1713700000000,      // timestamp (ms since epoch)
  type: 'rpc.request',      // message type
  from: 'coordinator',      // sender kind (or null)
  to:   'worker',           // recipient kind (or null)
  data: { /* payload */ },  // type-specific payload
  sig:  '...hex...'         // HMAC-SHA256 over the envelope minus `sig`
}
```

Messages with a missing or invalid `sig` are silently dropped. Routing semantics for `to` (broadcast when null, kind-based fan-out, etc.) are the bus server's responsibility.

### Message types the client speaks

| Direction | Type             | Purpose                                                       |
|-----------|------------------|---------------------------------------------------------------|
| sent      | `hello`          | Sent on connect with `{ kind, name, pid, startedAt }`.        |
| sent      | `status.update`  | The value returned by `makeStatus()`, sent every 10s.         |
| sent      | `rpc.request`    | Outgoing RPC call; `data` is `{ rpcType, rpcData }`.          |
| sent      | `rpc.response`   | Reply to an incoming RPC; `data` is `{ ok, result }` or `{ ok: false, error }`. |
| received  | `peers.update`   | Latest peer list; `data.peers` is stored on the client.       |
| received  | `status.snapshot`| Map of `kind → status`, merged into peer status cache.        |
| received  | `status.update`  | `{ from, status, at }`, cached per-peer.                      |
| received  | `rpc.request`    | Dispatched to the matching `rpcHandlers[rpcType]`.            |
| received  | `rpc.response`   | Resolves the pending promise with matching `id`.              |

## Behavior notes

- **Reconnection:** exponential backoff starting at 1 s, growing 1.5× per attempt, capped at 10 s. Resets to 1 s on a successful connection.
- **Status cadence:** `makeStatus()` (if provided) fires once on connect and then every 10 s.
- **RPC timeouts:** default 5 s. Timed-out RPCs reject with `RPC timeout after <ms>ms: <to>:<rpcType>`. Late responses are logged and discarded.
- **Signatures:** HMAC-SHA256 over the `stableStringify` of the envelope with `sig` removed. Verification is constant-time.
- **Logging:** pass `logger: null` to silence, or an object with `log(tag, ...args)` and `warn(tag, ...args)` to integrate with your own logger.

## License

MIT © Presenc3