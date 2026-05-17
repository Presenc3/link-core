# `link-core/src/helpers`

These were never part of the wire protocol or the `LinkClient`/`createHub`
core - they're patterns that emerged across multiple personal services
(loggers, env coercion, observability listener bundles, safe-publish
wrappers, graceful shutdown, secrets loading) and got packaged together
to stop the copy-paste; these have been folded into `link-core`.

## Contents

| File                | Exports                                                                                                    |
|---------------------|------------------------------------------------------------------------------------------------------------|
| `log.js`            | `createLogger`, `LEVELS`                                                                                   |
| `env.js`            | `num`, `bool`, `requireEnv`, `linkClientOptionsFromEnv`                                                    |
| `observability.js`  | `attachClientObservability`, `attachHubObservability`, `DEFAULT_CLIENT_CONCERNING_REASONS`, `DEFAULT_HUB_CONCERNING_REASONS` |
| `rpc.js`            | `waitForPeer`, `rpcWithRetry`, `createSafePublisher`, `createSafeSend`                                     |
| `lifecycle.js`      | `installProcessHandlers`, `createGracefulShutdown`                                                         |
| `secrets.js`        | `loadSecrets`, `LOADED_SECRETS_UNWATCH`                                                                    |
| `event-recorder.js` | `createEventRecorder`, `RECORDED_CLIENT_EVENTS`, `SNAPSHOT_TRIGGERS`                                       |

All twenty-one symbols are exported flat from the package root:

```js
const { createLogger, attachClientObservability, loadSecrets } = require('@presenc3/link-core');
```

…and are also reachable via the `./helpers` subpath if you'd rather
keep the helper namespace separate from the protocol/client/hub surface:

```js
const helpers = require('@presenc3/link-core/helpers');
helpers.createLogger();
helpers.loadSecrets(link, mapping);
```

Both forms point at the same functions; pick whichever fits the call site.

See the main `README.md` (the "Helpers" section) for usage and the
`index.d.ts` for the full type surface.

## Internal dependencies

Two helpers reach into `../internal/errors.js` for typed error classes:

- `rpc.js` - `RpcAbortError`, `RpcRemoteError`, `RpcTimeoutError`, `RpcDisconnectError`, `LinkNotReadyError`, `FeatureUnsupportedError`
- `secrets.js` - `HelloRejectedError`, `RpcRemoteError`, `RpcTimeoutError`, `RpcDisconnectError`

Everything else is stdlib-only. Note that we deliberately import from
`../internal/errors.js` rather than `../index.js` - going through the
package's barrel would create a require cycle (the barrel requires
these helpers right back).