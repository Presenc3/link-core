# `link-core` examples

A small four-service deployment that exercises every primitive `link-core` ships:

```
                     ┌──────────────┐
                     │     hub      │  per-peer keys, routes everything
                     │  (port 8080) │
                     └──┬───┬───┬───┘
                        │   │   │
              ┌─────────┘   │   └─────────┐
              ▼             ▼             ▼
        ┌─────────┐   ┌──────────┐   ┌─────────────┐
        │  vault  │   │  worker  │   │ coordinator │
        └─────────┘   └──────────┘   └─────────────┘
        secrets.get      job.run        rpc('worker', ...)
        secrets.list     job.progress→  on('direct', ...)
                         (status push)
```

What each service demonstrates:

| Service       | Primitive                                                                 |
|---------------|---------------------------------------------------------------------------|
| `hub`         | `createHubServer` with **per-peer keys** + hub-side event observability.  |
| `vault`       | RPC handler registration on a peer (`secrets.get`, `secrets.list`).       |
| `worker`      | RPC outbound (bootstrap from vault), RPC handler (`job.run`), `send()` for progress, `makeStatus` push. |
| `coordinator` | `waitFor('peer.connect')`, `rpc()` with typed-error retry classification, `on('direct')` receiver, `peer.status` events. |

## Running

The examples `require('../src/index.js')` directly so you can run them without `npm install`-ing the published package - just clone the repo and go:

```bash
# In four separate terminals, from the repo root:
node examples/01-hub.js
node examples/02-vault.js
node examples/03-worker.js
node examples/04-coordinator.js
```

You'll see output like:

```
[hub]  listening on http://0.0.0.0:8080
[hub]  + vault
[vault] ready
[hub]  + worker
[worker] got db-password from vault (length=24)
[worker] ready for work
[hub]  + coordinator
[coord] peer connect: vault
[coord] peer connect: worker
[coord] dispatching job #1
[coord] worker #1: 20%
[coord] worker #1: 40%
[coord] worker #1: 60%
[coord] worker #1: 80%
[coord] worker #1: 100%
[coord] job #1 complete: { jobId: 1, ok: true }
```

Stop any service with `Ctrl-C`. The hub does graceful shutdown (close WSS → close client sockets → terminate stragglers → close HTTP); the clients reject pending RPCs with `RpcDisconnectError` and exit.

## Configuration

Each service reads its config from environment variables. Defaults are baked in for development so the examples just work; for anything beyond local play you should set real values:

| Variable                   | Default              | Used by                      |
|----------------------------|----------------------|------------------------------|
| `LINK_PORT`                | `8080`               | hub                          |
| `LINK_URL`                 | `ws://localhost:8080` | vault, worker, coordinator   |
| `LINK_KEY_VAULT`           | `dev-vault-key`      | hub, vault                   |
| `LINK_KEY_WORKER`          | `dev-worker-key`     | hub, worker                  |
| `LINK_KEY_COORDINATOR`     | `dev-coord-key`      | hub, coordinator             |

Copy `examples/.env.example` to `.env` (or export the variables in your shell) if you want to override the defaults.

## Adapting to your own project

To use any example as a template in a project of your own, replace the relative require with the package import:

```js
// In the example:
const { LinkClient } = require('../src/index.js');

// In your project:
const { LinkClient } = require('@presenc3/link-core');
// or, for ESM:
import { LinkClient } from '@presenc3/link-core';
```

Everything else is portable as-is.