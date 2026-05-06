# Changelog

All notable changes to `@presenc3/link-core` will be documented in this file.

This project uses semantic versioning. Early `0.x` releases may still change shape while the public API settles.

Note: Dates are formatted as day-month-year - eg. '04-05-2026' = 4th of May, 2026.

## [0.4.0] - 06-05-2026

This release is wire-compatible with v0.3.x (`PROTOCOL_VERSION` is still `1`) but adds a number of features. Most upgrades are drop-in. The major themes are: new pub/sub and directed-fire-and-forget primitives, hub capability advertisement, optional per-peer keys auth, a hub `EventEmitter` surface for observability, hardening (backpressure, replay protection, bounded hello, pre-hello timeout), and a typed-error surface that replaces error-message string-matching.

### Added

#### Surface rename

- `LinkBusClient` is now `LinkClient`. The old name remains as a deprecated alias for the v0.4.x line; it will be removed in v0.5.0. Existing code keeps working without changes.

#### New primitives

- Added pub/sub topic support: `link.subscribe(topic, handler)`, `link.unsubscribe(topic, handler?)`, `link.publish(topic, payload)`. Subscriptions are tracked client-side and replayed automatically on every `'ready'` transition, so reconnects don't require application code to re-subscribe.
- Added directed fire-and-forget: `link.send(to, type, data)`. Completes the primitive trio alongside `rpc()` (directed with response) and `publish()` (broadcast no response). Receivers subscribe to the new `'direct'` event for `{ from, type, data, msg }` payloads.
- Added wire message type `direct` with `data: { directType, directData }`. The hub forwards with trusted `from`-stamping, mirroring `topic.message` and `rpc.request` semantics.

#### Per-peer keys auth

- Added per-peer keys via an overloaded `secret` option on `createHub` and `createHubServer`. The option now accepts:
  - `string` - shared-secret mode (back-compat with v0.3.x; unchanged behavior).
  - `Record<kind, string>` - static map of `kind → secret`. Hellos for kinds not in the map are silently dropped.
  - `(kind: string) => string | null | Promise<string | null>` - dynamic resolver. Async permitted; returning `null`/empty string means "no key for that kind". Useful for backing the registry with a vault, KMS, or per-tenant database.
- In per-peer modes, the hub becomes a re-signing relay: incoming messages are verified with the sender's key, and outgoing forwards (peers.update, status.update, status.snapshot, rpc.request, rpc.response, topic.message, direct) are re-signed with each recipient's key. `from` is still stamped from the authenticated socket, so it remains trusted.
- The wire protocol is unchanged. Per-peer keys is a deployment-config feature only - v0.3.x clients connect to v0.4 hubs in shared-secret mode without modification.
- The client API does not change: a client knows only its own `secret`. Deployments can revoke a single peer without rotating everyone else, and a compromised peer's key cannot be used to authenticate as a different peer.

#### Hub `EventEmitter` surface

- `createHub` now returns an `EventEmitter`. All existing methods (`attach`, `getState`, `stop`) remain available; the emitter surface is purely additive.
- Added events:
  - `peer.connect` `{ kind, hello, connectedAt, replaced }`
  - `peer.disconnect` `{ kind, hello, connectedAt, code?, reason }`
  - `peer.replaced` `{ kind, prevHello, newHello }` - fires when a new socket completes hello with the same kind as an existing peer.
  - `peer.timeout` `{ remoteAddress, helloTimeoutMs }` - fires when a pre-hello socket is reaped.
  - `protocol-error` `{ reason, kind, type?, detail? }` - fires when the hub drops a message. Reasons include `bad-signature`, `bad-version`, `replay-window`, `replay-id`, `oversize`, `bad-hello`, `unknown-kind`, `pre-hello-message`, `invalid-topic`, `parse-error`.
  - `topic.subscribe` / `topic.unsubscribe` `{ kind, topic }`
  - `topic.publish` `{ from, topic, payload, subscriberCount, delivered }`
  - `rpc.forwarded` `{ id, from, to, rpcType }`
  - `rpc.response.forwarded` `{ id, from, to, ok }`
  - `rpc.server` `{ id, from, rpcType, ok, error?, durationMs }` - for `to: 'server'` RPCs handled by the hub.
  - `direct` `{ from, to, type, data }`
  - `backpressure` `{ kind, type, to?, bufferedAmount, maxBufferedBytes }`
  - `message` `{ from, msg }` - power-user firehose; fires for every verified message.
- The hub never emits the bare EventEmitter `'error'` event (which would crash the process if unhandled). Listeners that throw are caught and logged.
- Added `hub.health()` returning `{ peerCount, pendingSocketCount, topicCount, totalSubscribers, recentIdsSize, statusCount }`. Cheap to call; designed for `/health` integrations and dashboards.
- Added `link.health` as a built-in server RPC that returns the same snapshot. The `link.` prefix continues to be reserved.
- `createHubServer`'s `/health` endpoint now embeds the snapshot under the `hub` key: `{ ok, now, hub: { … } }`.
- Added `hubServer.health()` as a convenience pass-through to `hub.health()`.

#### Connection lifecycle

- Added `'ready'` event on `LinkClient`, fired when the hub accepts the hello (`hello.ack.ok !== false`, OR - for compatibility with v0.3.x hubs that don't send `hello.ack` at all - any non-rejecting verified message). This is the gate for `publish()` / `send()` / `rpc()` and the point at which reconnect backoff resets and locally-tracked subscriptions replay.
- Added `'rejected'` event on `LinkClient`, fired when the hub rejects the hello with `hello.ack.ok === false`. By default, the client then `stop()`s itself (no hot reconnect loop). Opt out via the new `reconnectOnRejection: true` option.
- Added `link.ready({ timeoutMs?, signal? })` returning a promise that resolves with `{ kind, features }` on `'ready'` and rejects with `HelloRejectedError` on `'rejected'`. If the link isn't started yet, `ready()` calls `start()` for you. Resolves immediately if already ready.
- Added `link.isReady()` synchronous accessor and `ready: boolean` on the `health()` snapshot.
- Added unified RPC lifecycle event `'rpc.complete'` `{ id, to, rpcType, ok, reason, durationMs, error }`. Fires exactly once per `rpc()` call, regardless of outcome. `reason` is one of `'timeout' | 'abort' | 'disconnect' | 'not-ready' | 'remote-error' | 'send-error' | 'backpressure' | null`. Designed as a single hook for metrics/tracing without subscribing to four separate events.
- Added `'rpc.abort'` `{ id, to, rpcType }` and `'rpc.disconnect'` `{ id, to, rpcType }` for symmetry with the existing `'rpc.timeout'`.

#### Dynamic registration / introspection

- Added `link.handle(rpcType, fn)` and `link.unhandle(rpcType)` for adding/removing RPC handlers at runtime. `handle()` replaces silently and returns the previous handler (or `undefined`), supporting plugin patterns that re-register on every `'ready'`.
- Added `link.waitFor(event, { timeoutMs?, signal? })` to replace the `await new Promise(r => link.once(event, r))` pattern with a one-liner that has a real timeout and `AbortSignal` support.
- Added `link.health()` returning a synchronous `{ connected, verified, lastVerifiedAt, peerCount, pendingRpcCount, subscriptionCount, bufferedAmount, reconnectAttempt, stopped }` snapshot for `/health` integrations.
- Added `_lastVerifiedAt` tracking - updated on every verified message (not just the first), so `health()` can power "connected but silent" alerts that a bare `connected` check would miss.
- Added the built-in `link.topic.list` server RPC: `await link.rpc('server', 'link.topic.list', { topic })` returns subscribers for one topic; omit `topic` for a full snapshot. The `link.` prefix is reserved for built-in server RPCs and may be overridden by user handlers.

#### Hub capability advertisement

- Added `features` array to `hello.ack.data`. The hub advertises `['topics', 'direct']` (a v0.3.x hub returns no array). Clients capture this as `link.hubFeatures` so feature-using methods can pre-flight: `publish()` and `send()` throw synchronously against a hub that doesn't advertise the corresponding feature, rather than silently dropping.
- Added `features` to the `'ready'` event payload alongside `kind`.

#### Typed errors

- Added a typed-error module exporting `LinkError`, `RpcError`, `RpcTimeoutError`, `RpcDisconnectError`, `RpcAbortError`, `RpcRemoteError`, `BackpressureError`, `LinkNotReadyError`, `FeatureUnsupportedError`, `ProtocolError`, and `HelloRejectedError`. Each carries a stable `code` string (e.g. `'RPC_TIMEOUT'`, `'LINK_NOT_READY'`, `'FEATURE_UNSUPPORTED'`) and call-site context fields (`to`, `rpcType`, `id`, `timeoutMs`, `bufferedAmount`, `maxBufferedBytes`, `op`, `feature`, `reason`).
- All typed errors extend `Error`, so existing catch-all paths keep working. `BackpressureError` and the other typed errors carry a stable `code` so duck-typing on `code` is supported.
- `RpcRemoteError` (`code: 'RPC_REMOTE'`) is thrown when the remote handler errors or the hub returns an error response (e.g. `"Target not connected"`). The `.message` is verbatim from the wire; `instanceof RpcRemoteError` is the recommended pattern for distinguishing peer-thrown errors from transport-level failures, since retry policies usually shouldn't retry the former.
- `LinkNotReadyError` (`code: 'LINK_NOT_READY'`) is thrown synchronously by `publish()` and `send()` when the link isn't `'ready'` yet. Replaces a plain `Error` in earlier internal builds. Carries `op` for the calling operation.
- `FeatureUnsupportedError` (`code: 'FEATURE_UNSUPPORTED'`) is thrown synchronously by `publish()` (requires `'topics'`) and `send()` (requires `'direct'`) when the hub does not advertise the required capability - including when connecting to a v0.3.x hub that doesn't advertise any features at all. Replaces a plain `Error` in earlier internal builds. Carries `op` and `feature`.
- `HelloRejectedError` (`code: 'HELLO_REJECTED'`) is what `link.ready()` rejects with on `hello.ack ok:false`.

#### RPC AbortSignal

- Added an options-object form to `link.rpc(to, type, data, opts)` accepting `{ timeoutMs, signal }`. The legacy positional form `link.rpc(to, type, data, timeoutMs)` (where the fourth arg is a `number`) continues to work unchanged.
- `signal` aborting (whether before send or while in flight) rejects with `RpcAbortError` (`err.code === 'RPC_ABORT'`) and removes the pending entry. The wire request is *not* cancelled - the remote handler may still complete and the response is logged-and-dropped on arrival. A `rpc.cancel` wire message is planned for a later release.

#### Hardening

- Added a `maxBufferedBytes` option (default 4 MiB) on both client and hub. When `ws.bufferedAmount` exceeds the cap, status updates and fire-and-forget messages (`publish()`, `send()`) drop with a `'backpressure'` event; `rpc()` rejects synchronously with `BackpressureError`; hub-side RPC forwards return an error response to the original caller rather than letting the request pile up at the hub.
- Added the `'backpressure'` event with `{ type, to?, rpcType?, bufferedAmount }` payload.
- Added a `replayWindowMs` option (default 5 minutes) on both client and hub. Messages whose `ts` is more than `replayWindowMs` from `Date.now()` are dropped, and message `id`s are remembered for that duration to drop duplicates.
- Added a `maxRecentIds` option (default 10,000) to cap remembered message ids (LRU).
- Added a `maxMessageBytes` option (default 1 MiB) enforced both at the transport (`ws` library `maxPayload`) and as a defensive in-handler check.
- Added `'protocol-error'` event with reasons `'parse-error'`, `'bad-signature'`, `'bad-version'`, `'replay-window'`, `'replay-id'`, `'oversize'`, `'no-ack'`, `'bad-hello'`, `'unknown-kind'`, `'pre-hello-message'`, `'invalid-topic'`.
- Added bounded retained `hello` payload: the hub now sanitizes each peer's hello to a whitelist (`kind`, `name`, `pid`, `startedAt`), dropping unknown fields and capping `kind` / `name` strings at 256 chars. Oversized `kind` strings refuse the hello; `name` is truncated.
- Added pre-hello socket timeout via the new `helloTimeoutMs` option on `createHub` (default 10 s; pass through `createHubServer`). A socket that connects but doesn't successfully complete `hello` within the window is force-closed and emits `'peer.timeout'`. Closes a DoS surface where the keep-alive ping interval (which iterates only authenticated peers) never reaped silent unauthenticated connections.
- Added `hashAlgo` option on both `LinkClient` and `createHub` (default `'sha256'`). The HMAC algorithm is now pluggable - `sign`, `verify`, and `makeMsg` accept an optional final argument. Both ends must agree. Useful for FIPS-mode deployments that require sha384/sha512 or future migration to faster algorithms (e.g. blake3 via a custom Node provider). The wire envelope is unchanged.
- Added `DEFAULT_HASH_ALGO` (`'sha256'`) export.
- Added `perMessageDeflate` pass-through on `LinkClient` and `createHubServer`. Off by default - permessage-deflate has a history of memory-amplification CVEs against malicious peers, so opt-in is the safer default. When enabling, pass the full options object (e.g. `{ threshold: 1024, serverMaxWindowBits: 10 }`) to control the memory/CPU trade-offs.

#### Packaging

- Added an ESM wrapper at `src/index.mjs` and dual `import`/`require` conditional exports. Node ESM consumers can now write `import { LinkClient, RpcTimeoutError, ... } from '@presenc3/link-core'` for any named export - previously Node's CJS-named-export lexer detected only a handful of names and ESM consumers had to use `import pkg from '...'; const { ... } = pkg`. CJS consumers are unaffected; the same singleton CJS module backs both routes, so `instanceof LinkClient` works across the boundary (no dual-package hazard).
- Added `"sideEffects": false` to `package.json`. The library has no top-level side effects on import, so bundlers (webpack, Rollup, esbuild, Vite) can tree-shake unused exports.
- Added `"publishConfig": { "access": "public" }` so first-time `npm publish` of the scoped package doesn't require `--access=public` on the CLI.

#### Documentation

- Added README sections covering: pub/sub topics, directed fire-and-forget, dynamic RPC handlers, waiting for events, health snapshot, errors, aborting an in-flight RPC.
- Added TypeScript declarations for: typed errors, `RpcOptions`, `WaitForOptions`, `HealthSnapshot`, `'direct'` event, `LinkErrorCode` union, and updated `rpc()` to accept `number | RpcOptions`.
- Added a `SECURITY.md` with the vulnerability-reporting policy, scope of what counts as a security issue, and disclosure timeline.
- Added an `examples/` directory with a runnable four-service deployment (hub with per-peer keys, secrets vault, worker, coordinator) that exercises every primitive end-to-end.
- Added a `node:test`-based test suite under `test/` and an `npm test` script.

### Changed

- Updated package version metadata from `0.3.2` to `0.4.0`.
- The reconnect backoff now resets on `'ready'` rather than on the first verified message. See the matching Fixed entry below.
- The status push timer now arms on `'ready'` rather than on the first verified message. Pre-acceptance status pushes are wasted bytes when the hub is about to reject the hello.
- `subscribe()` / `publish()` / `send()` now require `'ready'` rather than just verified. With shared-secret hubs (which always accept a correctly-signed hello), there is no observable difference; with per-peer-keys hubs, the new gate prevents publishing into a connection that is about to be rejected.
- `createHub`'s `secret` option is now a union (`string | Record<string, string> | (kind) => string | null | Promise<string | null>`). Passing a string keeps the v0.3.x shared-secret behavior unchanged.
- `createHub` now returns an `EventEmitter`. Existing destructuring `const { attach, getState, stop } = createHub(...)` patterns continue to work.
- The topic name regex no longer permits `*`. The character was already rejected by `assertValidTopic` and `isValidTopic`, so this is a cleanup, not a behavior change. Wildcards remain reserved for v0.5+ pattern matching.
- `makeMsg(secret, { data })` now deep-clones `data` via `structuredClone` instead of referencing it directly. Callers may freely mutate the input after calling `makeMsg` without affecting the signed envelope or the bytes that go on the wire. This reverts the v0.3.2 reference-passing behavior; faster than the v0.3.0 JSON round-trip. Note: the transport is still JSON, so even though `structuredClone` preserves `Date`/`Map`/`Set`/`ArrayBuffer` in memory, the wire only carries what `JSON.stringify` produces - `Date` becomes its ISO string (via `toJSON`), `Map`/`Set` collapse to `{}`/`[]`, etc. Payloads that need to round-trip these losslessly must be serialized by the caller. `data` must also remain `structuredClone`-compatible (functions, class instances with methods, and DOM nodes will throw).
- `rpc()` rejections are now typed-error instances rather than plain `Error`, including remote-handler errors (`RpcRemoteError`). The `Error.message` strings are unchanged, so `e.message.includes('timeout')` keeps working - but `e instanceof RpcTimeoutError` (or `e.code === 'RPC_TIMEOUT'`) is the recommended pattern going forward.
- `start()` now also recognizes `CLOSING`/`CLOSED` socket states and detaches the orphan socket's listeners before opening a new connection. `stop()` does the same up front.
- The `LinkClient` constructor now shallow-copies the `rpcHandlers` option so `handle()` / `unhandle()` don't mutate the caller's object.

### Fixed

- **Fixed `LinkClient.stop()` leaving `_ready` set.** Because `stop()` detaches the websocket listeners *before* closing the socket, the `'close'` handler never ran, which meant `_ready` and `_verifiedAny` were never cleared. As a result, `isReady()` and `health().ready` returned `true` after stop, and `await link.ready()` resolved immediately on a stopped link. `stop()` now clears these flags inline (mirroring what `handleClose` does on a natural disconnect) and emits a `'disconnect'` event with `{ reason: 'stopped', willReconnect: false, wasReady: true }` if the client was ready at the time of stop. `ready()` after `stop()` rejects synchronously with `LinkNotReadyError` (rather than hanging until timeout) - call `start()` explicitly to reconnect.
- **Fixed `stableStringify` not matching JSON wire bytes.** The signing canonicalizer included keys with `undefined` values (literally interpolating `"undefined"` into the output) and serialized objects with `toJSON()` (e.g. `Date`) as their own-property snapshot. `JSON.stringify` does the opposite: drops `undefined` values, calls `toJSON()`. The mismatch caused signatures to verify locally but fail after the JSON round-trip on the receiver. Concrete breakage: `link.rpc('worker', 'ping')` (no `rpcData`), `link.send('worker', 'event')` (no `data`), and any payload containing a `Date`. `stableStringify` now mirrors `JSON.stringify` semantics (drops `undefined`/function/symbol values, calls `toJSON()`, throws on cycles) while still sorting object keys.
- **Fixed `rpc()` not requiring `'ready'`.** `rpc()` previously gated on `isConnected()` only, while the documented behavior (and the gate on `send()`/`publish()`) was `'ready'`. With async per-peer secret resolution, an `rpc()` fired during the `'connect'` event could arrive at the hub before the hello completed verification, and would be dropped as a `pre-hello-message` protocol error - the caller then timed out. `rpc()` now rejects synchronously with `LinkNotReadyError` (`reason: 'not-ready'`) when called before `'ready'`. The `to`/`rpcType`/`id` fields are attached to the error for symmetry with `RpcError` consumers.
- **Fixed `createHubServer().stop()` hanging when called before `start()`.** The shutdown path waited on `wss.close`'s `'close'` event, which only fires after a successful listen. Calling `stop()` on a never-started server would block until `shutdownTimeoutMs` and then reject. `stop()` is now a fast-path no-op when the server is not started.
- **Fixed `start()` failure leaving `isStarted === true`.** The flag was set before awaiting `httpServer.listen()`, so an `EADDRINUSE` (or similar) failure left the server in a state where a subsequent `start()` would early-return without doing anything. The flag is now set only after a successful listen.
- Fixed reconnect backoff incorrectly resetting on rejected hello. Previously, the first verified message - including a `hello.ack` with `ok: false` - reset `reconnectMs` to `reconnectInitialMs`. A client whose secret didn't match the hub's expectation could therefore hammer the hub at the initial reconnect interval indefinitely. The reset is now driven by the `'ready'` transition (i.e. the hub explicitly *accepting* the hello). On rejection, the client by default also `stop()`s itself (set `reconnectOnRejection: true` to keep retrying with growing backoff).
- Fixed peer-routed RPC silently timing out. `rpc.response` is now exempt from the id-replay check on both client and hub. Responses carry the same `id` as the request that was already added to the recent-id cache, which previously caused them to be dropped on the way back. The timestamp-window check still applies - only the id check changes for response messages.
- Fixed a race between `stop()` and `start()` where a stale `CLOSING` socket's eventual `close` handler could fire after a new connection was up, scheduling a duplicate reconnect timer or clearing timers that belonged to the new socket.
- Fixed unhandled `error` events on detached websockets potentially crashing the process by installing a noop `error` handler when detaching.

### Security

- Added optional per-peer keys auth. When `secret` is configured as a map or resolver, each peer signs and verifies with its own key. Operators can revoke a single peer's key without rotating everyone, and a compromised peer's key cannot be used to authenticate as a different peer (the `from` field is still stamped from the authenticated socket, so `kind` claims at the wire level are unforgeable). Hellos for unknown kinds, or for known kinds with bad signatures, are silently dropped - the hub does not confirm whether a kind exists or not.
- Added pre-hello socket timeout (`helloTimeoutMs`, default 10 s). Defends against a TCP client that opens a socket and never speaks; the previous keep-alive ping iterated only authenticated peers, so unauthenticated sockets could linger indefinitely.
- Added replay protection on both client and hub (timestamp window + recent-id cache). Defends against passive eavesdroppers replaying captured frames; does not defend against an active attacker who has the shared secret.
- Added bounded incoming payload size (`maxMessageBytes`, default 1 MiB) enforced at both transport and handler levels.
- Added per-peer outgoing buffer cap (`maxBufferedBytes`, default 4 MiB). A single slow or stuck peer can no longer OOM the hub by refusing to drain its socket.
- Added bounded retained `hello` (whitelist + length caps). A peer that puts a 50 MB string in `name` no longer pins hub memory until restart.

### Compatibility

- Wire-compatible with v0.3.x. `PROTOCOL_VERSION` is unchanged at `1`. Per-peer keys is a config-level feature and does not change the on-wire envelope.
- Existing `LinkBusClient`, `createHub`, `createHubServer`, and protocol-helper imports keep working.
- The hub stores only the sanitized hello, not the raw `msg.data`. Code that read non-whitelisted fields off `peer.hello` in `/state` or `getState()` will now see them missing. The non-whitelist fields were never part of the documented surface.
- `makeMsg(secret, { data })` no longer references `data` directly. Code that called `makeMsg` and then mutated the original to alter the envelope (which always violated the docs) needs to mutate the *returned* `msg.data` instead.
- New clients publishing or sending to old (v0.3.x) hubs will throw synchronously rather than silently dropping, because the old hubs don't advertise the corresponding `features`.
- **Behavioral change:** `hello.ack` with `ok: false` now triggers a client-side `stop()` by default rather than reconnecting forever. Set `reconnectOnRejection: true` to keep the previous behavior. With reconnection enabled, the new growing backoff (driven by `'ready'`, not first-verified) keeps the retry rate reasonable.
- **Behavioral change:** `subscribe()` / `publish()` / `send()` / `rpc()` now require `'ready'` rather than just connection. Code that calls them between `'connect'` and `'ready'` will throw `LinkNotReadyError` synchronously - this only matters when using per-peer keys with hubs that may reject hellos, or when calling RPC on the `'connect'` event. Migrating to `await link.ready()` (or awaiting the `'ready'` event) is the recommended pattern.
- `createHub` returning an `EventEmitter` is purely additive; no existing call site needs to change.

## [0.3.2] - 04-05-2026

### Added

- Added `PROTOCOL_VERSION` as a named protocol helper export from `src/protocol.js`.
- Added `PROTOCOL_VERSION` to the package's public CommonJS exports.
- Added explicit protocol-version validation to both the client and hub. Incoming messages are now dropped with a warning when `msg.v` does not match the current protocol version.
- Added client-side first-verified-message tracking after WebSocket connection.
- Added a `5,000ms` hello/verification diagnostic timer. If a client connects but receives no verified message within that window, it logs a likely shared-secret mismatch warning.
- Added more specific bad-signature logging before the first verified message, helping distinguish ordinary bad messages from initial hub/client secret mismatches.
- Added client-side duplicate-start protection. Calling `start()` while the socket is already open or connecting now returns without opening another WebSocket.
- Added reconnect timer cleanup when `start()` is called manually, preventing stacked reconnect attempts.
- Added immediate rejection of in-flight RPCs when the client socket closes unexpectedly.
- Added README documentation for:
  - `PROTOCOL_VERSION`;
  - protocol-version rejection behavior;
  - `makeMsg()` data immutability expectations;
  - immediate RPC rejection on disconnect;
  - trusted routing behavior for server-handled RPCs.

### Fixed

- Fixed pending RPC calls waiting until timeout after an unexpected disconnect. They now reject immediately with `Error('Link disconnected before RPC completed')`.
- Fixed a possible repeated-`start()` lifecycle issue where repeated calls could create multiple socket attempts or overlap with a scheduled reconnect.
- Fixed server-handled RPC trust semantics. `rpcHandlers` now receive a trusted message copy where `msg.from` is stamped from the authenticated socket kind, instead of receiving the client-supplied `from` field.
- Fixed `/state` response merging so keys returned by `extraState()` can no longer overwrite core hub state keys such as `peers` or `lastStatus`. Collisions are now logged and ignored.
- Fixed hub-server shutdown state reset behavior so `started`, `stopping`, and `stopPromise` are reset from the shutdown wrapper `finally` path, including error and timeout cases.

### Changed

- Updated package version metadata from `0.3.1` to `0.3.2`.
- Changed `makeMsg()` to use the exported `PROTOCOL_VERSION` default instead of a hard-coded `1`.
- Changed `makeMsg()` so the returned envelope references `data` directly instead of deep-cloning the envelope through JSON serialization. Callers should treat `data` as immutable after signing.
- Changed client close handling so non-manual disconnects clear pending RPCs immediately before scheduling reconnect.
- Changed protocol helper exports from `makeMsg`, `verify`, `sign`, and `stableStringify` to include `PROTOCOL_VERSION` as well.
- Package metadata, dependency versions, keywords, `exports`, `files`, license metadata, and Node.js engine requirements are otherwise unchanged from `0.3.1`.

### Security

- Added protocol-version rejection on both sides of the connection, preventing clients or hubs from silently accepting signed envelopes for an unsupported protocol version.
- Hardened server RPC handler context by ensuring the `msg.from` value passed to server-side handlers reflects the authenticated peer identity assigned during `hello`.

### Compatibility

- No intended public API breakage for documented root-package imports.
- Existing imports of `LinkBusClient`, `createHub`, `createHubServer`, `sign`, `verify`, `makeMsg`, and `stableStringify` remain valid.
- `PROTOCOL_VERSION` is additive.
- Code that mutates a `data` object after passing it to `makeMsg()` may now invalidate the signature on the returned message object, because `data` is no longer deep-cloned.

## [0.3.1] - 30-04-2026

### Added

- Added a physical `LICENSE` file containing the MIT license text.
- Added `LICENSE` to the package `files` allowlist so it is included in published npm tarballs.
- Added a package `exports` map exposing:
  - `.` as `./src/index.js`;
  - `./package.json` as `./package.json`.
- Added npm package keywords:
  - `websocket`;
  - `ws`;
  - `rpc`;
  - `service-bus`;
  - `ipc`;
  - `hmac`;
  - `hub`;
  - `microservices`;
  - `protocol`.
- Added hub-side WebSocket error logging that includes the peer `kind` when known.
- Added `WebSocketServer` error logging in `createHubServer`.
- Added a warning when `createHubServer` is attached to a user-provided HTTP server without a WebSocket `path`, because that configuration routes every WebSocket upgrade on that server to the hub.
- Added README documentation for:
  - `kind` as a singleton service identity;
  - one-active-connection-per-kind behavior;
  - worker pools needing unique `kind` values;
  - security and threat model details;
  - deployment recommendations for trusted-network use, `wss://`, shared-secret handling, `/state`, and WebSocket path scoping.

### Fixed

- Fixed `LinkBusClient.stop()` leaving pending RPC promises unresolved. Pending RPCs are now rejected with `Error('Link stopped before RPC completed')` when the client is stopped.
- Fixed silent hub-side WebSocket errors by logging the error message and closing the affected socket.
- Fixed silent `WebSocketServer` errors by logging them through the hub-server logger.

### Changed

- Updated package version metadata from `0.3.0` to `0.3.1`.
- Normalized `main` from `src/index.js` to `./src/index.js`.
- Updated the `ws` dependency range from `^8.19.0` to `^8.20.0`.
- Expanded package metadata with discoverability keywords.
- Public CommonJS exports remain unchanged from `0.3.0`: `createHub`, `LinkBusClient`, `createHubServer`, `sign`, `verify`, `makeMsg`, and `stableStringify`.

### Package

- Published package contents now include:
  - `src`;
  - `package.json`;
  - `README.MD`;
  - `LICENSE`.
- Added an explicit package export surface, making the root package entry and `package.json` the supported import targets.

### Compatibility

- No intended public API breakage for consumers using the documented root package entry point.
- Consumers using undocumented deep imports such as `@presenc3/link-core/src/client.js` may be affected by the new `exports` map, which only exposes the package root and `./package.json`.
- Runtime behavior is otherwise mostly compatible with `0.3.0`, except `stop()` now correctly rejects pending RPC promises instead of leaving them unresolved.

## [0.3.0] - 25-04-2026

### Added

- Added `createHubServer`, a batteries-included HTTP/WebSocket hub server wrapper around `createHub`.
- Added `src/hub-server.js` for creating and managing a runnable link hub server without requiring consumers to manually wire `http.createServer()` and `WebSocketServer`.
- Added a new public CommonJS export: `createHubServer`.
- Added automatic HTTP server creation when no existing server is provided.
- Added support for embedding the hub server into a user-provided `http.Server` through the `server` option.
- Added optional WebSocket path scoping through the `path` option, allowing the hub to accept WebSocket upgrades only at a route such as `/link`.
- Added `start()` and `stop(reason)` lifecycle methods for the hub server wrapper.
- Added idempotent shutdown tracking through internal `started`, `stopping`, and `stopPromise` state.
- Added graceful shutdown behavior for the WebSocket server:
  - closes the `WebSocketServer`;
  - asks connected clients to close with code `1001` and reason `server shutdown`;
  - waits for a configurable drain delay;
  - force-terminates remaining sockets after the drain delay;
  - stops the underlying hub;
  - clears registered process signal handlers.
- Added configurable shutdown options:
  - `shutdownTimeoutMs`, defaulting to `30,000ms`;
  - `drainDelayMs`, defaulting to `250ms`;
  - `onShutdown`, called after WebSocket, HTTP, and hub cleanup.
- Added optional process signal handling for graceful shutdown:
  - enabled by default through `handleSignals: true`;
  - listens to `SIGINT` and `SIGTERM` by default;
  - configurable through the `signals` option.
- Added default HTTP routes when the wrapper owns the HTTP server:
  - `GET /health`, returning `{ ok: true, now }`;
  - `GET /state`, returning the current hub state as formatted JSON.
- Added custom HTTP route support through the `routes` option.
- Added `extraState()` support for merging application-specific state into the `/state` response.
- Added server-level logging under the `link-core:hub-server` tag.
- Added a `getState()` wrapper that exposes the underlying hub state.
- Added returned server metadata/accessors:
  - `hub`;
  - `wss`;
  - `httpServer`;
  - `isStarted`;
  - `isStopping`;
  - `isOwnHttpServer`.
- Added README documentation for:
  - the batteries-included `createHubServer` quick start;
  - the lower-level transport-agnostic `createHub` quick start;
  - `createHubServer(options)`;
  - graceful shutdown;
  - default health/state routes;
  - embedding inside an existing HTTP server.

### Changed

- Updated package version metadata from `0.2.0` to `0.3.0`.
- Expanded the README to present `createHubServer` as the easiest way to run a hub while keeping `createHub` available for transport-agnostic embedding.
- Public CommonJS exports changed from `createHub`, `LinkBusClient`, `sign`, `verify`, `makeMsg`, and `stableStringify` to include `createHubServer` as well.
- No changes were made to `src/client.js`, `src/hub.js`, or `src/protocol.js` in this release. The existing client, hub, and protocol behavior from `0.2.0` is unchanged.

### Package

- Added a package `files` allowlist so published npm tarballs include only:
  - `src`;
  - `package.json`;
  - `README.MD`.

### Compatibility

- No public API breakage from `0.2.0` for existing `LinkBusClient`, `createHub`, or protocol helper consumers.
- Existing consumers can continue using the lower-level `createHub` API.
- Consumers who want a complete runnable hub can now use `createHubServer` instead of manually wiring `http` and `ws`.

## [0.2.0] - 21-04-2026

### Added

- Added `createHub`, an embeddable signed-message WebSocket hub for routing `@presenc3/link-core` clients through a central bus.
- Added `src/hub.js`.
- Added a new public CommonJS export: `createHub`.
- Added hub-side client tracking by peer `kind`.
- Added hub-side peer snapshots through `getState()`.
- Added hub-side peer discovery broadcasting through `peers.update` messages.
- Added hub-side status tracking through received `status.update` messages.
- Added hub-side status snapshot support through `status.snapshot`, sent to clients after a successful `hello` handshake.
- Added hub-side HMAC signature verification for all received messages.
- Added hub-side signed message sending using the existing protocol helper layer.
- Added `hello` handshake handling on the hub:
  - validates that `data.kind` exists;
  - sends `hello.ack` on success or failure;
  - records service metadata from the connecting client;
  - publishes an updated peer list after connection.
- Added one-active-connection-per-kind behavior. If a new client connects with the same `kind`, the previous socket for that `kind` is closed and replaced.
- Added hub-routed peer-to-peer RPC support:
  - forwards `rpc.request` messages to the target peer;
  - forwards `rpc.response` messages back to the original recipient;
  - returns an RPC error if the target peer is missing or disconnected;
  - returns an RPC error if `rpc.request` is missing a `to` destination.
- Added server-handled RPC support through `rpcHandlers` for requests sent to `to: 'server'`.
- Added async server RPC handling with success and error response envelopes.
- Added hub keepalive handling:
  - tracks `pong` responses;
  - pings connected clients every `15,000ms`;
  - terminates dead sockets;
  - removes dead peers and republishes peer state.
- Added hub `stop()` cleanup for clearing keepalive timers, closing tracked client sockets, clearing clients, and clearing statuses.
- Added custom hub logging support using the same logger shape as the client, including `logger: null` to silence logs.
- Added README documentation for:
  - running a hub manually with `http` and `ws`;
  - connecting clients to the hub;
  - custom server-side RPCs;
  - a small server-side key-value store example;
  - `createHub(options)`;
  - hub behavior notes;
  - updated message types for hub-routed RPC.

### Changed

- Updated package version metadata from `0.1.1` to `0.2.0`.
- Updated package description from “Shared WebSocket link protocol and client for inter-service communication” to “Shared WebSocket link protocol, client, and hub for inter-service communication”.
- Reframed README language from client-only bus participation to a package that ships both a client and an embeddable hub.
- Public CommonJS exports changed from `LinkBusClient`, `sign`, `verify`, `makeMsg`, and `stableStringify` to include `createHub` as well.
- No changes were made to `src/client.js` or `src/protocol.js` in this release. Client and protocol behavior from `0.1.1` is unchanged.

### Security

- Added hub-side bad-signature rejection for received WebSocket messages.
- Added hub-side signed outbound messages using the same HMAC-SHA256 envelope protocol as the client.
- Added server RPC handling without bypassing message verification; server-handled RPCs still require valid signed envelopes.

### Compatibility

- No public API breakage from `0.1.1` for existing `LinkBusClient` or protocol helper consumers.
- Existing consumers can keep using the package as a client/protocol helper package.
- New consumers can run their own compatible hub directly from this package instead of implementing the bus separately.

## [0.1.1] - 21-04-2026

### Added

- Added a full `README.MD` covering installation, quick start usage, a two-service coordinator/worker example, constructor options, public methods, protocol helper exports, message envelope shape, supported message types, and behavior notes.
- Added an explicit runtime dependency on `ws` using `^8.19.0`.
- Added a Node.js engine requirement of `>=18`.

### Fixed

- Fixed package installation for fresh consumers by declaring `ws` as an actual dependency. `0.1.0` required `ws` from `src/client.js` but did not list it in `package.json`, so consumers without their own `ws` install could hit `Cannot find module 'ws'`.

### Changed

- Updated package version metadata from `0.1.0` to `0.1.1`.
- No runtime source files changed in this release. `src/client.js`, `src/index.js`, and `src/protocol.js` are byte-for-byte functionally unchanged from `0.1.0`.
- Public CommonJS exports remain unchanged: `LinkBusClient`, `sign`, `verify`, `makeMsg`, and `stableStringify`.

### Compatibility

- No public API breakage from `0.1.0`.
- Package metadata now communicates that Node.js 18 or newer is expected.

## [0.1.0] - 21-04-2026

### Added

- Initial release of `@presenc3/link-core`, a CommonJS WebSocket client and signed-message protocol helper package for inter-service communication through a central bus.
- Added `LinkBusClient`, a small service-to-service WebSocket client with:
  - configurable `url`, `secret`, `kind`, `name`, `makeStatus`, `rpcHandlers`, and `logger` options;
  - `start()` and `stop()` lifecycle methods;
  - `isConnected()` connection-state helper;
  - `getPeers()` peer-list accessor;
  - `getPeerStatus(kind)` status-cache accessor;
  - `rpc(to, rpcType, rpcData, timeoutMs)` request/response helper.
- Added automatic WebSocket reconnection with exponential backoff:
  - starts at `1,000ms`;
  - grows by `1.5x`;
  - caps at `10,000ms`;
  - resets after a successful connection.
- Added signed `hello` handshake on connection containing service metadata:
  - `kind`;
  - `name`;
  - `pid`;
  - `startedAt`.
- Added optional periodic status publishing through `makeStatus()`:
  - sends once immediately on connect;
  - repeats every `10,000ms` while connected.
- Added peer discovery cache support through received `peers.update` messages.
- Added peer status cache support through received `status.snapshot` and `status.update` messages.
- Added RPC request/response support:
  - outgoing requests use `rpc.request`;
  - responses are correlated by message `id`;
  - default timeout is `5,000ms`;
  - incoming requests dispatch to `rpcHandlers[rpcType]`;
  - async handlers are supported;
  - handler success returns `{ ok: true, result }`;
  - handler failure returns `{ ok: false, error }`.
- Added custom logging support:
  - defaults to console logging;
  - accepts a custom logger with `log()` and `warn()`;
  - accepts `logger: null` to silence logs.
- Added protocol helper exports:
  - `makeMsg(secret, envelope)` for building signed message envelopes;
  - `sign(secret, msg)` for generating HMAC-SHA256 signatures;
  - `verify(secret, msg)` for validating signatures with `crypto.timingSafeEqual`;
  - `stableStringify(obj)` for deterministic key-sorted serialization.
- Added a signed message envelope format with:
  - protocol version `v`;
  - message `id`;
  - millisecond timestamp `ts`;
  - message `type`;
  - sender `from`;
  - recipient `to`;
  - arbitrary `data` payload;
  - HMAC signature `sig`.

### Security

- Added HMAC-SHA256 signing over the message envelope with `sig` excluded from the signed payload.
- Added deterministic object serialization so signatures remain stable regardless of object key order.
- Added constant-time signature verification for valid-length hex signatures.
- Added bad-signature rejection for received WebSocket messages.

### Package

- Published with MIT license metadata.
- Published with repository, bugs, and homepage metadata pointing to the GitHub project.