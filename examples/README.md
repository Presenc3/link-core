# `link-core` examples

Two layers of examples. The **four-service deployment** (`01`–`04`) demonstrates the protocol's core primitives end-to-end. The **standalone showcases** (`05`–`09`) each isolate one v0.5 helper or pattern so you can grok it without the full topology around it.

## The four-service deployment

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

| Service          | Primitive                                                                                                                       |
|------------------|---------------------------------------------------------------------------------------------------------------------------------|
| `01-hub`         | `createHubServer` with **per-peer keys** + hub-side event observability.                                                        |
| `02-vault`       | RPC handler registration on a peer (`secrets.get`, `secrets.list`).                                                             |
| `03-worker`      | `waitForPeer` and `rpcWithRetry` helpers, RPC handler (`job.run`), `send()` for progress, `makeStatus` push.                    |
| `04-coordinator` | `waitForPeer` to gate dispatch, `rpcWithRetry` with typed-error retry classification, `on('direct')` receiver, `peer.status` events. |

## Standalone showcases

Each is a single-file demo of one pattern. Run alongside the hub (`01`) and any peers it depends on.

| Example                          | Showcases                                                                                                |
|----------------------------------|----------------------------------------------------------------------------------------------------------|
| `05-disabled-mode`               | `LinkClient` runs in "no link bus" local-dev mode when `LINK_URL` / `LINK_SECRET` / `LINK_KIND` are missing. `link.ready()` rejects synchronously with `LinkNotReadyError` (v0.5+) and the service continues standalone. `createSafePublisher` turns `link.publish()` into a no-op on a disabled link, so the application code path doesn't fork. |
| `06-dashboard`                   | `createEventRecorder` for a live snapshot+event-log view of the bus, streamed over SSE. Also: `createLogger` passed directly as `logger` (no adapter), `attachClientObservability` for one-line listener wiring. Open `http://localhost:9000`. |
| `07-loadsecrets-vault`           | A vault peer with the `loadSecrets()` wire convention: `kind: link_secs`, `secs.get` RPC, `sec/<ns>/<rest>` paths, `secs.changed.<ns>` topic for rotation announcements. Rotates `sec/shared/api-token` every 8s so you can watch hot-reload work. |
| `08-loadsecrets-consumer`        | `loadSecrets({ watch: true, onChange })` for one-line config bootstrap with hot-reload. `cfg[LOADED_SECRETS_UNWATCH]?.()` for clean teardown. Pair with `07`. |
| `09-graceful-shutdown`           | `createGracefulShutdown` (watchdog-bounded shutdown sequencer) + `installProcessHandlers` (SIGINT/SIGTERM/uncaughtException/unhandledRejection). Multi-step shutdown with a fake link, write buffer, and DB pool. Press Ctrl-C. |

## Running

The examples `require('../src/index.js')` directly so you can run them without `npm install`-ing the published package - just clone the repo and go:

```bash
# Four-service deployment, four separate terminals from the repo root:
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

For the standalone showcases:

```bash
# 05: disabled-mode (try with and without the env vars set)
LINK_URL= LINK_SECRET= LINK_KIND= node examples/05-disabled-mode.js

# 06: dashboard - needs the hub running (01) and ideally other peers
#     (02-04) to have something interesting to display. The hub
#     needs to know about kind: dashboard - see the note in 06.
node examples/06-dashboard.js
# then open http://localhost:9000

# 07+08: loadSecrets demo - needs the hub (01) running. The hub
#        needs a key for kind: link_secs - add `link_secs:
#        'dev-secs-key'` to 01-hub.js's KEYS map.
node examples/07-loadsecrets-vault.js
node examples/08-loadsecrets-consumer.js

# 09: graceful-shutdown is self-contained. Press Ctrl-C.
node examples/09-graceful-shutdown.js
```

Stop any service with `Ctrl-C`. The hub does graceful shutdown (close WSS → close client sockets → terminate stragglers → close HTTP); the clients reject pending RPCs with `RpcDisconnectError` and exit.

## Configuration

Each service reads its config from environment variables. Defaults are baked in for development so the examples just work; for anything beyond local play you should set real values:

| Variable                   | Default                | Used by                            |
|----------------------------|------------------------|------------------------------------|
| `LINK_PORT`                | `8080`                 | hub                                |
| `LINK_URL`                 | `ws://localhost:8080`  | all peers                          |
| `LINK_KEY_VAULT`           | `dev-vault-key`        | hub, vault                         |
| `LINK_KEY_WORKER`          | `dev-worker-key`       | hub, worker                        |
| `LINK_KEY_COORDINATOR`     | `dev-coord-key`        | hub, coordinator                   |
| `LINK_KEY_LINK_SECS`       | `dev-secs-key`         | hub, loadsecrets-vault             |
| `DASHBOARD_PORT`           | `9000`                 | dashboard                          |
| `LINK_KIND`, `LINK_SECRET` | _(unset)_              | 05-disabled-mode (intentional)     |

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

## Note on the secrets pattern

There are **two** vault patterns in here, side by side:

- **`02-vault.js`** - the **low-level RPC primitive**. The worker calls `link.rpc('vault', 'secrets.get', { name })` directly. Simplest possible vault contract - exactly what you'd want if you're rolling your own.
- **`07-loadsecrets-vault.js`** + **`08-loadsecrets-consumer.js`** - the **opinionated `loadSecrets()` helper**. Adds a naming convention (`kind: link_secs`, `secs.get`, `sec/<ns>/<rest>` paths) and a hot-reload topic (`secs.changed.<ns>`). The consumer is one `await loadSecrets(...)` call.

Either is fine for production. The helper is what `loadSecrets({ watch: true })` ships with by default since v0.5.0; the raw `02-vault.js` shape gives you full control over wire format if you have an existing convention to match.