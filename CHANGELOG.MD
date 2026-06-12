# Changelog

All notable changes to `@presenc3/link-core` will be documented in this file.

This project uses semantic versioning. Early `0.x` releases may still change shape while the public API settles.

Note: Dates are formatted as day-month-year - eg. '04-05-2026' = 4th of May, 2026.

## [0.6.0] - 13-06-2026

A reliability pass focused on library behavior, closed out by a pre-release adversarial audit (an external reviewer's findings plus internal review, every item reproduced before fixing). Several changes are potentially breaking - please read the "Changed" section.

> **The helper collection moved out.** `createLogger`, the env coercion utilities, the observability bundles, `waitForPeer` / `rpcWithRetry` / `createSafePublisher` / `createSafeSend`, `installProcessHandlers` / `createGracefulShutdown`, `loadSecrets`, and `createEventRecorder` now live in their own package, [`@presenc3/link-helpers`](https://www.npmjs.com/package/@presenc3/link-helpers). The `./helpers` subpath and the flat root re-exports are **gone from `@presenc3/link-core`**. Migration: `npm install @presenc3/link-helpers` and change the import - the full entry is under *Changed* below.

### Added

- **Outbound queue (outbox) on the client.** When the socket is congested (`ws.bufferedAmount` over `maxBufferedBytes`) or the link is mid-reconnect, outbound messages are held in a bounded in-memory queue and drained automatically once the link is healthy, instead of being dropped. Queued messages are signed at *flush* time, so a message that waits through a reconnect gets a fresh timestamp and is not rejected by the hub's replay window.
  - New option `maxOutboxBytes` (default 16 MiB) caps the queue; hitting the cap is the only condition under which an outbound message is refused.
  - New events `'outbox-overflow'` (a message was refused because the cap was hit) and `'outbox-drained'` (the queue emptied after a congestion episode).
  - `link.health()` now reports `outboxSize` and `outboxBytes`.
- **Per-socket outbound queue (outbox) on the hub.** Same mechanism, per peer socket: a congested consumer's messages are queued (bounded by `maxOutboxBytes`, default 16 MiB per socket) and drained as the socket catches up, rather than dropped. New `createHub` / `createHubServer` option `maxOutboxBytes`; new hub event `'outbox-overflow'`; `hub.health()` now reports `outboxBytes` and `queuedSockets`.
- **`maxReconnectAttempts` client option** (default `Infinity`). A finite value caps consecutive failed reconnect attempts; on exhaustion the client emits `'reconnect-exhausted'` (`{ attempts, maxReconnectAttempts }`) and stops. The counter resets on every `'ready'`.
- **`maxListeners` client option** (default 100). Raises the `EventEmitter` listener cap from Node's default of 10 - observability/event-recorder helpers (now in `@presenc3/link-helpers`) attach enough listeners to trip the leak warning otherwise. `0` disables the cap.
- **`RpcHandlerError`** - a new exported error class. Throw it inside an RPC handler (client- or hub-side) to send a deliberate, structured, caller-visible error: its `message`, `code`, and optional `data` are forwarded and arrive on the caller side as an `RpcRemoteError` carrying the same `code` / `data`.
- **`exposeRpcErrors` option** on `LinkClient`, `createHub`, and `createHubServer` (default `false`). When `true`, RPC handler error messages are forwarded verbatim (the pre-v0.6 behavior).
- **`'rpc.handler-error'` client event.** Fires when a local RPC handler throws a non-`RpcHandlerError` error - carries the real error for local logging/metrics even though the caller received a sanitized message.
- **`stopDrainMs` client option** (default 5000) - the default drain budget for graceful `stop()`.
- **Wire-safety validation on `send()` / `publish()` / `rpc()`.** Payloads are now checked against *two* failure modes at the call site: not structured-cloneable (functions, class instances, ...) **and** not JSON-serializable (`BigInt`, circular structures). The second check is new - those values clone happily but cannot be signed onto the wire, so a clone-only check let them through to fail later as an `outbox-error` or a confusing RPC timeout. Both now throw a `TypeError` immediately. The validation also produces the single owned snapshot used downstream (see *Changed*).
- **RPC handler result validation.** An RPC handler (client- or hub-side) that returns a value which cannot be serialized now replies with a structured error - `RpcRemoteError` with the new code `RPC_RESULT_NOT_SERIALIZABLE` - instead of producing an unserializable response that left the caller to time out.
- **`assertJsonSerializable(value, label?)`** - a new exported protocol helper. Throws a `TypeError` if `value` cannot be placed on the JSON wire; used internally by the wire-safety checks above and available for callers doing their own validation.
- **`peer.timeout` always carries a `reason`.** The hub event now always includes `reason: 'hello-timeout' | 'pending-cap'`; previously the hello-timeout case emitted no `reason` field at all, so the field could not be relied on.
- **Benchmark.** `npm run bench` runs `bench/throughput.js` - an in-process loopback bench measuring sequential RPC latency (mean/p50/p99/max), concurrent RPC throughput, and `send()` / `publish()` throughput. A regression signal for changes to the message hot path.
- **`.gitattributes`** enforcing LF line endings across the repository.
- **RPC cancellation (`rpc.cancel` / `rpc.cancelled`).** A new wire message type. When a pending `rpc()` is abandoned locally - aborted via its `AbortSignal`, or expired by its `timeoutMs` deadline - the client sends a best-effort `rpc.cancel` to the hub naming the original request id. If that request is still queued in a congested target's hub-side outbox, the hub drops it before the target ever sees it. Otherwise the hub relays the `rpc.cancel` on to the target peer: the matching in-flight RPC handler's `AbortSignal` fires, so a handler that opted into cancellation can bail out early instead of running to completion. RPC handlers now receive a third argument `ctx` carrying that `{ signal }` - reading it is optional and a two-argument handler is unchanged. The hub emits a `rpc.cancelled` event `{ id, from, to, found, forwarded }` - `found` is `true` when a queued request was located and removed, `forwarded` is `true` when the cancel was relayed on to a connected target. The client emits a `rpc.cancel` event `{ id, from, rpcType }` when an inbound RPC it is handling is cancelled. A `from`-match guard means a peer can only cancel requests it itself originated. The cancel is skipped when the link is not ready. Old hubs that predate this message type ignore it harmlessly, so no feature negotiation is required.
- **ACL hooks on the hub.** `createHub` / `createHubServer` accept four optional authorization callbacks - `canRpc`, `canPublish`, `canSubscribe`, `canSend` - that run at the hub's existing dispatch choke-points, after a message is verified and the sender's `from` identity established, before the hub acts on it. Each is sync or async and returns `true` (allow), `false` (generic forbidden), or `{ ok: false, code, error }` (explicit). The gate fails **closed**: a thrown callback, or any non-conforming return value, denies and logs - a buggy ACL must never silently authorize traffic. An RPC denial replies to the caller with a structured `rpc.response` error (surfacing as an `RpcRemoteError`, code `RPC_FORBIDDEN` by default); publish/subscribe/send denials drop the message. All four fire a new `acl-denied` hub event `{ op, from, code, error, ... }`. A non-function ACL option throws `TypeError` at construction. A hub configured with no ACL callbacks pays zero overhead and behaves exactly as before.
- **Subpath exports `./protocol`, `./errors`, `./primitives`, `./client`, `./hub`.** Five new entries in the package `exports` map, each with a `require` target, an `import` (`.mjs`) wrapper, and a `.d.ts`. `./primitives` is the stable low-level surface (option validators like `applyOptions` / `positiveInt`, logger normalization, `settleOnEvents`) promoted so sibling packages - notably `@presenc3/link-helpers` - build on the exact same building blocks link-core uses internally, semver-protected like the rest of the public API; it loads without `ws`. `require('@presenc3/link-core/protocol')` (sign/verify/envelope helpers) and `require('@presenc3/link-core/errors')` (the typed error classes) load **without pulling in `ws`** - useful for a consumer that only needs to verify a signature or `instanceof`-discriminate an error and does not want the WebSocket dependency in its graph. `./client` is just `LinkClient`; `./hub` is `createHub` + `createHubServer`. The same CJS modules back both the `require` and `import` routes, so `instanceof` works across the boundary. `./errors` is a curated re-export - the internal `rpcErrorResponse` helper stays unexported.
- **Type-check CI gate.** A new `tsconfig.json` and `npm run type-check` (`tsc --noEmit`) compile the hand-maintained declaration files plus a type-level usage suite under `test/types/`. The usage suite exercises the public API the way a consumer would - constructing clients and hubs, wiring typed event listeners, catching typed errors, reaching for each subpath - with `// @ts-expect-error` assertions for misuse. A declaration that drifts from the implementation's intent now fails in CI here instead of surfacing in a downstream project. A dedicated `type-check` job runs ahead of the test matrix, and `prepublishOnly` runs it before any publish. (`typescript` is already a devDependency.)

### Changed (potentially breaking - please read)

- **The helper collection moved to [`@presenc3/link-helpers`](https://www.npmjs.com/package/@presenc3/link-helpers).** The `./helpers` subpath and the twenty-one flat root re-exports (`createLogger`, `LEVELS`, `num`, `bool`, `requireEnv`, `linkClientOptionsFromEnv`, `attachClientObservability`, `attachHubObservability`, `waitForPeer`, `rpcWithRetry`, `createSafePublisher`, `createSafeSend`, `installProcessHandlers`, `createGracefulShutdown`, `loadSecrets`, `LOADED_SECRETS_UNWATCH`, `createEventRecorder`, and friends) are gone from this package. Migration is `npm install @presenc3/link-helpers` plus the import change (`require('@presenc3/link-core')` / `require('@presenc3/link-core/helpers')` > `require('@presenc3/link-helpers')`); helper APIs themselves are unchanged. The helpers discriminate link-core's error classes structurally (by `.name`), so a version-skewed install cannot create `instanceof` hazards, and the `loadSecrets` watch-handle symbol is still `Symbol.for('@presenc3/link-core:loadSecrets.unwatch')` for cross-package interop. `link-core` keeps everything protocol-level, including the new `./primitives` subpath the helpers build on.
- **Readiness is gated strictly on `hello.ack`.** `'ready'` now fires only when the hub's successful `hello.ack` arrives - never on an arbitrary verified frame. The previous compatibility behavior (any verified non-rejecting message could mark the client ready, for v0.3.x hubs that didn't ack) flipped readiness while `hubFeatures` was still unknown; the ready-time purge then ran against an assumed-empty feature list and destroyed queued feature-dependent messages a late ack could not restore. Now readiness and the hub's *real* feature list always arrive together; in the connected-but-unacked window `hubFeatures` stays `null` and `send()` / `publish()` queue instead of throwing `FeatureUnsupportedError`. **Breaking against pre-v0.4 hubs** (which never send `hello.ack`): the client no longer becomes ready against them, and instead emits a loud diagnostic `protocol-error` (`reason: 'no-ack', verified: true`) after `helloAckDiagnosticMs` explaining exactly that. Every v0.4.0+ hub - including every hub this package has ever shipped alongside its client features - acks first, and is unaffected.
- **`link.stop()` is now `async` and graceful by default.** It returns a `Promise<void>` (previously `void`), flushes the outbox, lets in-flight RPCs settle, and waits for the socket buffer to drain - bounded by `stopDrainMs` / `stop({ timeoutMs })` - before closing. It always resolves, never rejects. Pass `stop({ drain: false })` for the previous immediate close (which rejects pending RPCs with `RpcDisconnectError`). Callers that don't `await` still work: when nothing is in flight, `stop()` closes synchronously before the promise settles.
- **`send()` / `publish()` no longer throw `LinkNotReadyError` for a transient not-ready link.** A message sent while the link is connecting or reconnecting is now queued in the outbox and delivered once ready (the call returns `true`). They still throw `LinkNotReadyError` for a *disabled* link (missing `url`/`secret`/`kind`) or one that has been `stop()`ed, and still throw `FeatureUnsupportedError` / `TypeError` as before. `rpc()` still rejects `LinkNotReadyError` when not connected (an RPC needs a live round-trip).
- **RPC handler errors are sanitized by default.** When one of your `rpcHandlers` (client- or hub-side) throws a plain `Error`, the caller now receives a generic `RpcRemoteError` with message `"Internal handler error"` instead of the raw message - which previously leaked stack traces, connection strings, and other internal detail over the wire. The real error is logged locally and (client-side) emitted on `'rpc.handler-error'`. To send a structured error on purpose, throw the new `RpcHandlerError`. To restore verbatim forwarding, set `exposeRpcErrors: true`.
- **`RpcRemoteError.code` is no longer always `'RPC_REMOTE'`.** It now carries the remote-supplied code when the remote threw a structured `RpcHandlerError` (or the hub returned a coded failure such as `RPC_NO_TARGET`), falling back to `'RPC_REMOTE'`. `RpcRemoteError` also carries `data` when the remote supplied it. Use `instanceof RpcRemoteError` for transport-level discrimination.
- **One logger interface.** The library's logger contract is now `{ debug, info, warn, error }` (each `(context, message, ...args)`). `createLogger()` (now in `@presenc3/link-helpers`) returns objects with these methods; the pre-v0.6 `l` / `lD` / `lW` / `lE` / `log` members remain as **deprecated aliases** on its result. Loggers passed to `LinkClient` / `createHub` / `createHubServer` (and to the `@presenc3/link-helpers` helpers) are adapted automatically, so `{ log, warn }` and `{ l, lD, lW, lE }` loggers still work. The `Logger` type in `src/index.d.ts` changed shape accordingly.
- **Helper logger validation loosened.** `createSafePublisher` / `createSafeSend` / `attachClientObservability` / `attachHubObservability` / `installProcessHandlers` / `createGracefulShutdown` previously threw if the logger lacked specific `l`/`lD`/`lW`/`lE` methods; they now accept any logger object (adapted internally). The thrown `TypeError` message changed from "logger with { ... } is required" to "a logger is required".
- **The `'backpressure'` event changed meaning.** It is now edge-triggered (fires once when a socket's outbox goes from empty to non-empty) and carries `queued: true` - the message was queued, not dropped. Previously it fired per dropped message.
- **Stricter option validation.** Count- and byte-style caps (`maxRecentIds`, `maxMessageBytes`, `maxBufferedBytes`, `maxOutboxBytes`, `maxPendingSockets`) now reject non-integer values - a fractional cap like `maxRecentIds: 1024.5` previously passed silently. `hashAlgo` is now validated against `crypto.getHashes()` at construction on both `LinkClient` and `createHub` / `createHubServer`: a typo (`'sha-256'`, `'SHA256'`) is a clear boot-time `TypeError` instead of an unexplained "nothing verifies / nothing connects" much later.
- **`makeMsg` gained an optional `clone` field** in its `parts` argument (default `true`, unchanged behaviour). Passing `clone: false` skips the defensive `structuredClone` of the payload - an internal hot-path opt-out for callers that already hold an exclusive snapshot. Most callers should ignore it.
- **Single-snapshot send path (internal).** `send()` / `publish()` / `rpc()` previously took up to three `structuredClone`s of a payload on the way to the wire (validation, outbox storage, envelope build). They now take exactly one, at the call-site validation step, and carry that owned snapshot through. No API change; lower per-message overhead and allocation. The hub, which only ever sends data it owns outright, no longer clones outbound payloads at all.
- **`topic.publish` `subscriberCount` now excludes the publisher.** It counts *eligible recipients* (subscribers other than the publisher) rather than total subscribers. Because self-delivery is off the publisher was never a recipient, so this makes the relationship clean: `delivered <= subscriberCount` always holds, with equality on a fully successful fan-out. A dashboard reading `subscriberCount` will see it one lower than before on topics where the publishing peer is itself subscribed.
- **`reconnectOnRejection: true` now actually retries.** Previously it was a no-op: on a `hello.ack` with `ok: false` the client returned without closing the socket, leaving it open, never-ready, with no reconnect ever scheduled - so the documented "keep retrying with backoff" never happened. It now closes the socket so the normal backoff/reconnect path runs (subject to `maxReconnectAttempts`), firing `'rejected'` per attempt. The default (`false`) is unchanged.
- **Duplicate same-kind clients no longer fight.** When the hub replaces an older socket because a newer connection authenticated as the same `kind`, it now closes the old socket with a distinct application close code (`4000`) instead of `1000`. The displaced client recognizes this, emits `disconnect` with `displaced: true` and `willReconnect: false`, and does **not** auto-reconnect. Previously both processes replaced-and-reconnected each other in an infinite loop. (Displacement almost always means two processes are sharing one `kind` - a misconfiguration.)
- **Explicit `stop()` now clears the entire outbox.** A hard teardown - `stop()` (including after a graceful drain) and reconnect-exhaustion - now discards *all* queued outbound messages, not just queued `rpc.request`s. Automatic reconnects are unchanged: they still preserve non-RPC queued messages across the blip. This only affects code that called `stop()` then `start()` again expecting pre-stop queued `direct` / `topic.*` / `status.update` messages to flush; they no longer do.
- **Feature-gated messages queued before `ready` are dropped if the hub lacks the feature.** `send()` / `publish()` throw synchronously once the hub's capabilities are known. Messages optimistically queued *before* the hub's capabilities were known are now dropped at `ready` (with a warning) when the connected hub turns out not to advertise the required feature (`direct` / `topics`), instead of draining to a hub that would silently ignore them. Against any in-tree hub (which advertises both) this never triggers.
- **`RpcHandlerError.data` is validated for the wire** on both the client and hub handler paths, mirroring success-result validation (`structuredClone` probe + the strict JSON walker). Wire-safe `data` ships as before (now as an owned clone, so a handler retaining a reference to its thrown error can no longer mutate the response after the fact). Lossy or unserializable `data` is **stripped with a loud local `log.error`** while the deliberate `error` message and `code` still reach the caller - previously a `Map` arrived silently corrupted to `{}`, and a BigInt made the response unserializable so the caller received a phantom `RpcTimeoutError` instead of your intentional application error.
- **`makeStatus()` output is wire-validated** like every other app-supplied payload before it ships. A lossy or unserializable status is rejected with a local `warn` (and simply not sent) instead of arriving at the hub as `{}` or failing at flush time; a valid status now also ships as a single owned snapshot (one fewer clone per push).
- **Construction-time validation tightened further.** A `kind` with surrounding whitespace (`' worker '`) now throws a `TypeError` at construction on both `LinkClient` and the hub's hello path - previously the client kept the padded original while the hub registered the trimmed name, splitting the peer's identity between logs and routing. `LinkClient`'s `name` option must now be a non-empty string when provided (previously any value, including objects, was accepted and shipped in the hello).
- **Inbound envelope `id`s are capped at 256 characters** (`MAX_ID_LENGTH`, new drop reason `'oversized-id'`). Library-generated ids are 36-char UUIDs; the cap only constrains hand-rolled clients with exotic id schemes. Without it, a peer could send `rpc.request`s with megabyte-scale ids that the responder must echo verbatim, inflating retained outbox memory far past its accounting.
- **Outbox byte accounting measures `id` / `type` / `to` / `from`.** `estimateSize` previously charged a flat 96 bytes for the whole envelope scaffolding regardless of field sizes - an `rpc.response` echoing a large caller-supplied id under-counted by that id's entire length, so retained memory could exceed `maxOutboxBytes` by orders of magnitude. Estimates now slightly *over*-state actual envelope size, the safe direction for a cap.
- **`createHubServer().isStarted` semantics pinned:** `true` while the server is up - latched by `start()` once listening, cleared when `stop()` completes. Previously it stayed `true` after a stop, allowing the contradictory `isStarted && isStopped` reading.
- **`helloAckDiagnosticMs` now diagnoses "connected but never ready"** rather than only "nothing verified". The timer is settled only by an actual `hello.ack`; if it fires, the emitted `protocol-error` distinguishes the three causes - nothing verified (likely secret/`hashAlgo` mismatch), signature-valid traffic dropped by the replay window (`reason: 'clock-skew'`), or traffic verified but no ack ever sent (`reason: 'no-ack', verified: true` - a pre-v0.4 or non-conforming hub).

### Fixed

- **Userland event listeners can no longer mutate protocol behavior.** The `'message'` firehose (hub and client) previously handed listeners the *live* parsed envelope before dispatch read it - a listener could rewrite `msg.to` and redirect a direct to a different peer, or mutate an inbound `rpc.response`'s `result` before the pending RPC promise resolved. Both now emit a snapshot (taken only when a listener is attached, so an unobserved bus pays nothing), and routing fields are derived before any userland code runs. The same snapshot treatment now applies to every event payload that shared a reference with retained internal state or pending wire data: the client's `rpc.request` / `direct` / topic-handler `msg` argument and `peer.connect` / `peer.disconnect` / `peer.replaced` / `peer.status` payloads, and the hub's `peer.connect` / `peer.replaced` / `peer.disconnect` hello payloads.
- **`hub.getState()` returns a deep snapshot.** It previously cloned the containers but not the contents - `state.peers[0].hello` and the `lastStatus` values were live references, so mutating the "read-only" snapshot corrupted hub state and every later `peers.update` broadcast. The `HubState` doc now guarantees mutation-safety.
- **The hub's per-socket outbox snapshots queued payloads.** Queued items previously held live references (`snapshotUnowned: false`); anything reachable through events, `getState()`, or an ACL callback could mutate a message between enqueue and drain - and grow it past its byte estimate. The fast path serializes synchronously and never queues, so the clone is only paid for a congested socket's messages.
- **Wire validation is now JSON-value-*preserving*, not merely JSON-serializable.** `assertJsonSerializable` (and therefore `send()` / `publish()` / `rpc()` / RPC-result validation) previously only checked that `JSON.stringify` doesn't throw - so a `Map` or `Set` passed validation and arrived as `{}`, and `NaN` / `Infinity` arrived as `null`. It now walks the value the way JSON will serialize it and rejects `Map` / `Set` / `RegExp` / `Error` / `Promise` / binary buffers / non-finite numbers with a path-bearing `TypeError` at the call site. `Date` still passes (it ships as a meaningful ISO string via `toJSON`, which is honoured exactly as `JSON.stringify` does), and the documented `undefined` / function / symbol omission convention is unchanged.
- **Hub-handled server RPC results get the same validation as peer RPC results.** They were only JSON-probed - a result holding a function property shipped with the function silently dropped instead of replying `RPC_RESULT_NOT_SERIALIZABLE` (the client-side handler path already got this right). The hub now probes with `structuredClone` + the strict check, and the probe clone is what ships, so a handler retaining a reference to its returned object can no longer mutate the response after the fact.
- **`waitFor(symbol, { timeoutMs })` no longer crashes the process.** The declarations allow symbol events, but the timeout/abort error messages used template literals - and converting a `Symbol` in a template literal throws. Worse, the error builders run *inside* the timer/abort callbacks, so the `TypeError` escaped as an uncaught exception and brought the whole process down. Symbols are now stringified safely, and `settleOnEvents` additionally converts anything a throwing error-factory produces into a rejection rather than letting it escape a callback.
- **Construction-time validation tightened.** `createHubServer`'s `port` must be an integer in `[0, 65535]` (previously `8080.5` or `999999` passed construction and failed later inside `listen()`). Constructor-supplied `rpcHandlers` maps (client and hub) must hold only functions, matching the contract `handle()` already enforces. And `LinkClient`'s `kind` is now held to the hub's exact hello rules (charset, length \u2264 256, reserved names) at construction - a deterministically-bad configured kind previously produced a silent reconnect-forever loop against the hub's `'bad-hello'` close.
- **Flaky timing-based tests converted to causal waits.** `auth.test.js`'s no-ack diagnostic and both `forget.test.js` replay-window tests asserted after fixed sleeps, which intermittently failed under full-suite CPU load; they now wait on the actual state transition via the suite's `waitFor` predicate helper. The two invalid-kind hello tests now drive the hub with raw signed frames (the way a non-link-core client would), since `LinkClient` itself refuses to construct with an invalid kind.
- **A throwing userland event listener no longer starves later-registered listeners.** `LinkClient`'s emit wrapper (and the hub's `emitSafe`) previously caught a listener's throw at the *emit* level - which protected the dispatch path, but Node's emit loop had already aborted, silently skipping every listener registered after the throwing one. That included the library's own internal waiters: a throwing `'ready'` listener made `link.ready()` hang until its timeout even though the link came up. Listeners now run with per-listener isolation: a throwing listener is logged and skipped, and the rest (including `ready()` / `waitFor()` resolvers) still fire. The unhandled-`'error'` throw-by-default contract is preserved.
- **Async ACL callbacks no longer reorder a peer's gated messages.** With an async `canPublish` (or `canSubscribe` / `canSend`), two messages from the same socket raced their checks: if the first check resolved slower, the second message was acted on first - two publishes to the same topic could fan out in reverse order. Gated publish / direct / subscribe operations now run through a per-socket FIFO lane, so checks for one socket settle strictly in arrival order. The lane re-checks across the async gap that the socket is still the authoritative one for its kind. A hub with no ACL configured never enters the lane (the ungated path is now fully synchronous - previously even an unconfigured gate cost one microtask hop per gated message, which could let a `status.update` overtake an earlier publish in the same tick). RPCs deliberately stay concurrent: their responses correlate by id, and a slow handler must not head-of-line-block a peer's pub/sub traffic.
- **Readiness can no longer race ahead of the hub's feature list.** If a hub interleaved a verified message ahead of its `hello.ack`, the client flipped `_ready` on that first message with `hubFeatures = []` - the ready-time purge then discarded queued feature-dependent messages against that assumed-empty list, and `send()` / `publish()` threw `FeatureUnsupportedError` in the gap. An interim pre-release fix applied features from a late ack, but could not restore what the purge had already destroyed. Final resolution: readiness is gated strictly on the ack (see *Changed*), so features and readiness arrive together and the purge always sees the hub's real capabilities; while features are unknown, feature-dependent sends queue. A repair path remains for a non-conforming hub that *re*-acks with a different feature set mid-connection. (Not reachable against the in-tree hub, which always acks first; this hardens the client against other hub implementations.)
- **A queued `rpc.cancel` no longer survives a reconnect.** A cancel is only meaningful on the connection that carried the original request; one that was still queued when the link dropped is now discarded alongside queued `rpc.request`s instead of being flushed onto the next connection (where the hub would hunt for a request that no longer exists).
- **Line endings actually normalized.** Fifteen files (including `src/protocol.js`, `src/index.js`, `src/index.d.ts`, `src/internal/outbox.js`) still carried CRLF endings despite the `.gitattributes` added in this release; all are now LF.
- **One fewer deep clone per RPC response.** A handler's result was `structuredClone`d once to probe serializability (the clone was discarded) and then cloned again by the outbox snapshot. The probe clone is now carried through as the owned response snapshot. Behaviourally identical.
- **`test/integration/auth.test.js` was missing its `before` / `after` import** from `node:test`, which silently prevented three "per-peer keys" tests from running. Test-only; no library impact.
- **`linkClientOptionsFromEnv()` now maps the v0.6 knobs.** `LINK_MAX_OUTBOX_BYTES`, `LINK_STOP_DRAIN_MS`, `LINK_MAX_CONCURRENT_RPC`, `LINK_KEEPALIVE_INTERVAL_MS`, and `LINK_MAX_RECONNECT_ATTEMPTS` (which accepts `Infinity`) were added as options in v0.6 but were not readable from the environment.
- **`ws.send()` is now called with a completion callback** on both the client and the hub, so a *late* (asynchronous) send failure is surfaced - logged at `warn` (a late failure means a likely-lost message) - instead of being silently swallowed. The synchronous `try/catch` only ever caught an immediate throw.
- **`src/index.d.ts` accuracy.** Removed `'send-error'` from the `rpc.complete` event's `reason` union - no runtime path emits it. The `peer.timeout` event type now includes its `reason` field. Added the `RPC_RESULT_NOT_SERIALIZABLE` error code, the `assertJsonSerializable` export, the `makeMsg` `clone` field, and the new `LinkClientEnvOptions` keys. Documented that `unsubscribe()` throws on an invalid topic; added `displaced?: boolean` to the `disconnect` event; made `topic.publish`'s `delivered` a required `number` (it is always emitted) and rewrote the `subscriberCount` doc for the new semantics; clarified the `reconnectOnRejection` option doc.
- **Hub `status.update` conflation is keyed per originating peer.** The hub's per-socket outbox conflates `status.update`s so a backlog cannot pile up on a congested consumer. The conflation key was derived from the envelope `from`, which is always `'server'` on the fan-out path - so on a congested recipient every peer's status collapsed into one queued item and all but the newest were silently dropped (never delivered). It now keys on the originating peer (`data.from`), so a congested recipient retains the latest status from each peer. (The per-socket outbox is itself a v0.6 addition; this corrects it before release.)
- **Graceful `stop()` can no longer re-enter `ready`.** During a graceful drain the socket stays open, so an in-flight RPC response could arrive and drive the readiness-promotion path - which did not check `_stopped` - re-setting `_ready = true` and emitting a spurious `'ready'`, leaving `isReady()` returning `true` after `await stop()`. The promotion is now guarded on `!_stopped`; in-flight RPCs still settle during the drain.
- **The hub drops messages from stale, replaced sockets.** A socket replaced by a newer hello of the same kind keeps its `__kind` until its close fully lands; in that race window its in-flight messages were still processed as authoritative for the kind. The hub now ignores any message from a socket that is no longer the current socket for its `kind`, making the newest connection authoritative immediately.
- **`unsubscribe()` validates its topic.** It now throws synchronously on an invalid topic name, matching `subscribe()` / `publish()`, instead of treating it as a silent no-op.
- **Canonical signing is JSON-faithful.** The deterministic signing serializer (`stableStringify`) and the wire-safety walker (`assertJsonSerializable`) now implement `JSON.stringify`'s value-reduction exactly: `toJSON` receives the property key (native JSON passes `''` for the root, the object key, or the stringified array index - a key-sensitive `toJSON` previously signed one thing and shipped another), and boxed primitives are unwrapped *after* the `toJSON` step, per ECMA-262. Previously `new Number(1)` was signed as `{}` and `new String('x')` as `{"0":"x"}` while shipping as `1` / `"x"` - a guaranteed hub-side `bad-signature`, surfacing to the caller as an inexplicable RPC timeout; a boxed BigInt sailed through call-site validation and broke at flush. Boxed primitives now sign consistently and arrive value-intact; `Object(2n)` and `new Number(NaN)` are rejected up front like their primitive forms. The invariant is fuzz-tested: `stableStringify(x) === stableStringify(JSON.parse(JSON.stringify(x)))` for every `x` JSON accepts.
- **One socket can no longer authenticate as two kinds.** Two hellos sent on the same socket while a slow async secret resolver was pending both observed an unauthenticated socket and registered independently - the close handler only knew the final `__kind`, so the earlier registration survived as a ghost peer (listed, routable, an RPC target) until the keepalive sweep reaped it. The authentication state is now re-checked across the resolver await: the first hello to finish wins, and the loser is rejected with `reason: 'duplicate-hello', detail: 'concurrent-hello'` whether it claimed the same kind or a different one.
- **`createHubServer` `start()` / `stop()` are concurrency-safe.** `stop()` racing a pending `start()` previously tore down the wss/hub and declared the wrapper stopped while the in-flight `listen()` went on to succeed - leaving a live, reachable HTTP/WebSocket server with nothing left to close it (`isStarted: true, isStopped: true`, `/health` answering 200). Concurrent `start()` calls each installed a process signal handler but the bookkeeping recorded only one, permanently leaking the other past `stop()`. Now: `start()` is single-flight (concurrent calls share one `listen()`), `stop()` awaits any in-flight start before tearing down, signal handlers are removed on *every* stop path (including the shutdown-timeout path), and a failed bind clears the flight so a later `start()` can retry.
- **`/state` can no longer hang the request.** The response body is serialized *before* headers are written, so an app-supplied `extraState` producing a circular value, BigInt, or throwing getter yields a clean HTTP 500 - previously `JSON.stringify` threw after `writeHead(200)` had gone out, the catch could no longer send an error status, and the request dangled until an external timeout. The handler's outer catch additionally terminates any response whose headers were already sent (e.g. a user `routes` handler throwing mid-stream).
- **Graceful `stop()` quiesces activity timers before the drain.** The status-push interval kept enqueuing fresh `status.update`s into the very queue being drained (delaying shutdown and emitting after `stop()` had been called), the keepalive could terminate the socket mid-flush, and a still-armed hello-ack diagnostic could fire a spurious `no-ack` `protocol-error` mid-shutdown. All connection-activity timers are now cleared the moment a graceful stop begins; the drain still lets in-flight RPCs settle.
- **`createHubServer({ port: 0 })` logs the actually-bound port.** The startup lines previously printed the configured `:0` instead of the OS-assigned ephemeral port.
- **`./primitives` coverage restored.** `src/primitives.d.ts` was missing from the type-check program (`tsconfig.json` `include`), and the subpath export tests never covered `./primitives` - so its declarations could drift and its surface could break without CI noticing. Both now covered: the d.ts is compiled, and the export suite pins the exact 13-symbol surface, its ESM/CJS identity, and its `ws`-free module graph.

### Security

- **`SECURITY.md` now states explicitly** that in shared-secret mode the `from` identity is not cryptographically bound to a peer - any holder of the shared secret can connect as any `kind`. Use per-peer keys to bind `from` to a real credential. (Documentation only; no behavior change.)

### Housekeeping

- All source, test, README, and example files normalized to LF line endings (previously a CRLF/LF mix).
- `typescript`, `@types/node`, and `@types/ws` added as `devDependencies` for type-checking the declaration file. (npm does not surface `devDependencies` on the package page, so the published dependency count stays at one - `ws`.)
- Removed the inert `peerDependenciesMeta` block (it had no matching `peerDependencies` entry and did nothing).
- Added a committed `package-lock.json` and a `.gitignore` (ignoring `node_modules/`), so CI's `npm ci` has a lockfile to resolve against.
- CI installs are now strictly `npm ci` - the `|| npm install --no-audit --no-fund` fallback is gone. The fallback silently masked exactly the lockfile drift `npm ci` exists to catch, and could green-light a build whose dependency tree didn't match the lockfile.
- New `prepublishOnly` script runs `npm test && npm run check:pack` before any publish.
- The outbound-queue machinery (`writeNow` / `drain` / `enqueue` / drain scheduling) - previously duplicated, with subtle divergences, between the client and the per-socket hub path - was extracted into a single shared `src/internal/outbox.js` (`Outbox` class). Pure internal refactor: no API, wire, or behavior change; the client and hub configure the same class for their respective signing-source and readiness-gate differences.
- Client timer teardown was centralized into a single `_clearTimers()` helper used by every teardown path (`_hardStop`, the close/exhaustion path), so no path can forget a timer.
- Removed a dead `enabled` field from the hub's internal ACL gate (it was returned but never read).
- The hub's bad-hello detail classifier now uses the `HELLO_KIND_MAX` constant instead of a duplicated literal `256`.

## [0.5.0] - 17-05-2026

### Added

- **Helpers surface.** Twenty-one helpers are now exported flat from `@presenc3/link-core`, with their type signatures in `src/index.d.ts`:
  - `createLogger`, `LEVELS` - leveled logger with `{ l, lD, lW, lE }`, optional `errorSink`, and configurable `minLevel` / `timestamp`.
  - `num`, `bool`, `requireEnv`, `linkClientOptionsFromEnv` - env coercion and the standard LinkClient-from-env option assembler.
  - `attachClientObservability`, `attachHubObservability`, `DEFAULT_CLIENT_CONCERNING_REASONS`, `DEFAULT_HUB_CONCERNING_REASONS` - wire the standard listener bundles onto a `LinkClient` or a hub, with overridable reason classification.
  - `waitForPeer`, `rpcWithRetry`, `createSafePublisher`, `createSafeSend` - event-driven peer wait, bounded-retry RPC, and `LinkNotReadyError`/`FeatureUnsupportedError`-swallowing wrappers around `link.publish` / `link.send` with first-skip-warns-then-debug behaviour for v0.3-era hubs that don't advertise `topics` / `direct`.
  - `installProcessHandlers`, `createGracefulShutdown` - SIGINT/SIGTERM/uncaughtException/unhandledRejection hookup and a watchdog-bounded shutdown sequencer (kept separate so the shutdown procedure can be unit-tested without touching `process.on`).
  - `loadSecrets`, `LOADED_SECRETS_UNWATCH` - single-shot fetch of an `envName > sec/<ns>/<rest>` mapping from a secrets vault peer, with optional `watch: true` hot-reload via `secs.changed.<ns>` subscriptions. The symbol, when present on the returned object, tears down the rotation subscriptions.
  - `createEventRecorder`, `RECORDED_CLIENT_EVENTS`, `SNAPSHOT_TRIGGERS` - dashboard-friendly observer that maintains a bounded ring buffer of normalized hub events alongside a full snapshot of current bus state (peers, statuses, health, event log). Designed for SSE consumers and any "what's happening right now" panel: subscribe once, get the current snapshot immediately, then a fresh snapshot on every interesting hub event (peer join/leave, ready/disconnect, peer status) plus a configurable heartbeat tick.
- Sources live under `src/helpers/` and are tested under `test/helpers/`.
- **New `./helpers` subpath export.** `require('@presenc3/link-core/helpers')` (or `import` from the same path) returns just the helper symbols, namespaced - useful when a consumer wants the helpers as a bag without the protocol/client/hub surface mingled in.
- **New `LeveledLogger` type in `src/index.d.ts`** describes the rich object returned by `createLogger()`. Extends the two-method `Logger` type that `LinkClient` accepts as its `logger` option, so passing a `LeveledLogger` directly works: `new LinkClient({ ..., logger: createLogger() })`. The adapter form `{ log: l, warn: lW }` (note `lW`, not `lE`) still works for back-compat.
- **`peer.replaced` event on `LinkClient`.** Fires when a same-kind peer reconnects with a fresh socket. Payload: `{ kind, prevPeer, peer }` (each `PeerInfo`). Fires *after* the internal `peers` state has been updated, so `link.getPeers()` from inside the handler reflects the new connection. Previously consumers had to infer same-kind replacement by correlating `peer.disconnect`/`peer.connect` events that never fired (the kind never left the set).
- **`maxPendingSockets` hub option** (default `1024`). Caps concurrent un-authenticated (pre-hello) sockets; oldest is FIFO-evicted with `peer.timeout` carrying `reason: 'pending-cap'` when capacity is exceeded. Defends against attackers opening many TCP connections and never speaking.
- **`LOADED_SECRETS_UNWATCH` symbol.** Attached as a non-enumerable property on the object returned by `loadSecrets(…, { watch: true })`. Calling it removes the helper's rotation subscriptions (only its own; caller-installed handlers on the same topic are untouched). Idempotent.
- **`loadSecrets({ logger })` option.** Accepts a `LeveledLogger` for transient watch-reload failure messages and for sender-validation drops. Falls back to a `console.warn` wrapper.

### Removed

- **Removed the deprecated `LinkBusClient` alias** and its `LinkBusClientOptions` / `LinkBusClientEvents` type aliases. These were marked `@deprecated` in v0.4.x with a "will be removed in v0.5.0" note; the removal lands here as scheduled. Consumers still on the alias need to rename their imports to `LinkClient` / `LinkClientOptions` / `LinkClientEvents` - the underlying class and types are identical.

### Changed (potentially breaking - please read)

- **`createHubServer({ enableStateRoute })` default flipped from `true` > `false`.** `/state` is now opt-in. Pass `{ enableStateRoute: true }` to restore the previous behavior; if you also bind `0.0.0.0`, a warning fires at startup. The pre-existing "explicit-acknowledgement suppresses warning" mechanism is no longer needed and has been removed.
- **`createHubServer` is single-shot.** Calling `start()` after `stop()` now throws `Error('createHubServer is single-shot…')`. Previously the second `start()` returned without actually rearming the torn-down wss/httpServer/hub. To restart, call `createHubServer()` again.
- **`LinkClient`, `createHub`, `createHubServer` validate numeric options up front.** Passing `NaN`, `Infinity`, negatives, or wrong types for any numeric option (`defaultRpcTimeoutMs`, `maxBufferedBytes`, `keepaliveIntervalMs`, etc.) now throws `TypeError` at construction. The most common cause was `Number(process.env.X)` producing `NaN` when the env var was unset; previously this silently degenerated into 0-ms timers.
- **`link.rpc(to, rpcType, …)` throws `TypeError` synchronously on invalid `to` / `rpcType`.** Matches the existing behavior of `send` / `subscribe` / `publish`. Previously an invalid `to` produced a delayed `RpcTimeoutError`, indistinguishable from a "peer unreachable" condition.
- **Hub `send()` returns `boolean`** instead of the generated message UUID on success. Clearer contract; the previous return value was technically truthy but easy to misread as a meaningful id.

### Security

- **`loadSecrets({ watch: true })` now validates the sender of rotation events.** Previously the helper subscribed to `secs.changed.<ns>` and acted on `{ path, action }` from any authenticated peer that could publish on that topic - so any peer could trigger `delete out[name]` (for `action: 'del'`) or force vault RPC amplification (for `action: 'set'`) on every other consumer. The handler now drops events whose verified `msg.from` is not the configured `secretsKind`, with a warn-level log.
- **Hub no longer crashes on a re-hello from an authenticated socket.** Sending a second `hello` envelope on an already-authenticated socket used to bypass `sanitizeHello()` (the post-hello branch reused `ws.__secret` without ever populating `helloData`) and then dereference `helloData.kind` in the hello-handler branch, throwing a `TypeError` that surfaced as an `unhandledRejection`. The dispatcher now drops the re-hello as `duplicate-hello` (same diagnostic the existing concurrent-race guard uses), so a misbehaving or hostile peer can no longer flood the host's error sinks (or trip `--unhandled-rejections=strict` Node deployments) with one cheap packet.
- **`loadSecrets` watch-reload now type-checks rotated values.** The initial load already threw `TypeError` on non-string vault responses; the watch path silently mirrored them into `out[name]`, which violated the `Record<string, string>` contract and could surface as a downstream crash (`cfg.API.startsWith(…)`) after rotation. Watch-reload now drops non-string values with a warn-level log.
- **Hub rejects `__proto__`, `constructor`, `prototype`, and `server` as peer kinds at hello time.** Previously these passed `KIND_PATTERN` and could authenticate. Using one of those names as an object key (which the snapshot builders did) is a local prototype-pollution foothold: a peer with kind `__proto__` would silently disappear from `/state`'s `lastStatus` and from the `status.snapshot` pushed on hello, and would mutate the prototype of the snapshot object. Hellos with these kinds now drop as `bad-hello` with a new `reserved-kind` detail. The `server` kind is also rejected because the dispatcher's `to === 'server'` short-circuit would otherwise prevent any peer registered with that kind from receiving RPCs (silent-namespace-collision footgun).
- **Snapshot builders use null-prototype objects.** `createHub().getState()` (`lastStatus`), the hub's hello-path `status.snapshot` payload, and `createEventRecorder().getSnapshot()` (`statuses`) now use `Object.create(null)` instead of `{}`. Belt-and-braces alongside the reserved-kinds check - if the kind filter ever regresses or a future name slips through, the snapshot builders no longer have a writable prototype slot to be exploited.

### Fixed

- **`loadSecrets` cumulative `timeoutMs` is now actually honored.** Previously `ready()` and `waitForPeer()` shared a budget but each `secs.get` RPC silently used the client's `defaultRpcTimeoutMs` (5 s) instead. All RPCs now share a single deadline; `timeoutMs ≤ 0` / `NaN` / non-finite throws `TypeError` at the call site.
- **`getPeers()` / `getPeerStatus()` return defensive copies** (via `structuredClone`). A caller mutating the returned arrays/objects can no longer poison `LinkClient` internal state.
- **`peer.replaced` emits client-side AFTER the `peers` state update.** Listeners that called `link.getPeers()` from inside the handler previously saw the *old* connectedAt; now they see the new one consistently.
- **`rpc.abort` fires on pre-aborted signals.** Previously the event was only emitted for in-flight aborts; pre-send aborts went straight to `rpc.complete`, so consumers wiring up `link.on('rpc.abort', …)` silently missed them.
- **`rpc.disconnect` fires when `link.stop()` orphans a pending RPC.** Previously emitted only when an unexpected socket close orphaned an RPC; explicit `stop()` was asymmetric.
- **`rpcWithRetry` honors `signal` during backoff.** An abort fired between retry attempts now surfaces as `RpcAbortError` immediately, instead of waiting out the backoff delay only to fail on the next iteration.
- **`unhandle(rpcType)` uses `Object.hasOwn`.** No more false positives for inherited prototype keys (`'constructor'`, `'toString'`, …); the documented contract ("returns `true` if a handler was removed") now matches behavior.
- **Hub `topic.publish` event always carries `delivered`.** Previously omitted on no-subscriber topics, tripping subscriber arithmetic on `undefined`.
- **`createHubServer.stop()` before `start()` closes `wss`.** The `WebSocketServer` is constructed eagerly in `createHubServer()`, so destroying without starting used to dangle. It now closes both `wss` and the hub.
- **`EventRecorder.close()` contract corrected.** After `close()`, `onSnapshot`/`onEvent` return a no-op unsubscribe (previously they delivered one stale "initial" frame and went silent forever). `getSnapshot()`/`getRecent()` continue working and reflect *current* `LinkClient` state at call time - the d.ts no longer falsely claims "snapshot-at-close-time".
- **`loadSecrets` validates `value` type.** A vault returning a non-string `value` now throws `TypeError` instead of poisoning `out[name]`.
- **Topic-pattern error wording** updated; no longer references "v0.5+" now that we *are* v0.5.
- **Heartbeat test rewritten to be deterministic** (counts N ticks rather than waiting a clock window) and adds a "heartbeatIntervalMs=0 disables" sibling test.
- **CRLF>LF normalization** for the source tree is now actually true. v0.4.1 claimed this but a packaging quirk still shipped CRLF for seven files in `src/`. All `.js` / `.mjs` / `.ts` / `.md` files in the tarball are now LF.
- **`waitForPeer` no longer hangs forever in the final loop iteration.** When the per-iteration `remaining` budget evaluated to `0` or a slightly-negative number (`Date.now()` advancing between the loop check and the assignment), it was passed to `link.waitFor({ timeoutMs })`, which treats non-positive values as "no timeout" - so the call could wait for a `peer.connect` event that never arrived. The loop now breaks out early and the outer "timed out after Xms" throw fires as documented.
- **`num('   ')` returns `undefined`, not `0`.** `requireEnv` already trims, but `num` did not - so `LINK_REPLAY_WINDOW_MS=' '` silently produced `0` and disabled replay protection. The coercion now trims first, matching `requireEnv`.
- **Hub `status.update` no longer echoes back to the sender.** The previous `broadcast()` fan-out included the original publisher, so every peer paid an extra signed send/parse roundtrip per status push. The dispatcher now skips the sender; clients that were already filtering `info.from !== client.kind` (e.g. `event-recorder.onPeerStatus`) see no behavioural change.
- **Hub keepalive-timeout `peer.disconnect` carries `code: 1006`.** The unexpected-close path passes through `code`/`reason` from the WS event; the keepalive-reaper path used to omit `code` entirely, so metrics that bucketed disconnect events by code saw a synthetic `undefined`. It now reports `1006` (abnormal closure), matching what a network-level dead peer would produce.
- **`abortAwareSleep` `unref`s its non-signal timer.** Test processes (and any short-lived caller that didn't pass an `AbortSignal`) could stay alive an extra `baseDelayMs * attempt` per pending retry while the backoff wound down.
- **`pickPath` strips trailing slashes.** `GET /health/` now matches `GET /health` instead of 404ing. Affects `createHubServer`'s own routes and any user-supplied `routes` keyed without a trailing slash.
- **Removed an unreachable `duplicate-hello` check** in the hub dispatcher's resolve-secret branch. The live duplicate-hello path remains the one that fires when a re-hello arrives on an already-authenticated socket (the v0.5.0 security fix).
- **Lowercased the published markdown files.** `CHANGELOG.md` / `README.md` / `SECURITY.md` were on-disk as `.MD` while `package.json#files` referenced `.md` - safe on case-insensitive filesystems but inconsistent with the rest of the repo (`.gitattributes`, `.editorconfig`) and a footgun on Linux CI mirrors that copy-by-exact-name.
- **`link.rpc(..., { timeoutMs })` per-call validation.** Previously, `timeoutMs: 0` fired an immediate synthetic `RpcTimeoutError("RPC timeout after 0ms")` (instead of the documented "no timeout" semantics shared by `link.ready()` / `link.waitFor()`), `NaN` / `-1` produced equally-bogus immediate rejections, and `Infinity` triggered a Node `TimeoutOverflowWarning`. All four now throw `TypeError` synchronously when the value is non-finite or negative; `0` correctly means "no timeout" (the timer is simply not armed). Same `nonNegFinite` validation was extended to `ready({ timeoutMs })`, `waitFor(event, { timeoutMs })`, `rpcWithRetry({ timeoutMs, baseDelayMs })`, and `waitForPeer({ timeoutMs })` so all per-call timing knobs in the public surface fail loud on bad input instead of silently swallowing it.
- **`rpcWithRetry({ tries })` requires a positive integer.** Previously accepted `tries: 1.5` and ran 1-floor(tries) attempts; now throws `TypeError` for non-integers, matching the floor behavior of the for-loop.
- **`waitForPeer` wakes on `peer.replaced`.** Previously listened for `peer.connect` only - a same-kind peer reconnecting mid-wait fires `peer.replaced` (not `peer.connect`), so the helper could time out despite the peer being present. Both events now wake the wait, with single-listener cleanup so neither event leaks listeners when the other "wins".
- **Misleading `secrets.js` comment removed.** The header comment stated that `link.rpc(..., { timeoutMs: 0 })` meant "no timeout, wait forever inside the client" - true for `ready()` / `waitFor()`, but false for `rpc()` until the validation fix above landed. After the fix the claim is accurate, so the comment was left as documentation rather than rewritten.
- **`stableStringify` return type widened to `string | undefined`.** Matches `JSON.stringify` semantics for top-level non-serializable input (`undefined`, functions, symbols). Code that relied on the implementation behavior was already correct; only the TypeScript declaration was wrong.
- **`LinkClientOptions.url` / `secret` / `kind` typed as optional.** Matches the runtime "disabled if missing" behavior (a `start()` with any of them missing logs a warning and becomes a no-op). The type previously required them, so TypeScript callers reaching for the disabled-mode pattern had to cast or use `// @ts-expect-error`.
- **`LeveledLogger` JSDoc adapter recipe corrected** from `{ log: l, warn: lE }` to `{ log: l, warn: lW }`. `LinkClient` uses `logger.warn` for routine drops (backpressure, replayed messages, transient ws errors), and routing those into an error sink would flood it on every misconfigured-secret reconnect.
- **`getPeers()` JSDoc clarifies that it includes self.** The hub broadcasts the full membership snapshot, so a client of `kind: 'coordinator'` sees itself in the list. Filter on `p.kind !== link.kind` for "everyone else".
- **README v0.5 highlights helper count** corrected from "twenty" to "twenty-one" (matches CHANGELOG body and `src/helpers/README.md`).
- **README v0.5 highlights `@types/ws` bullet removed.** Stated that `@types/ws` was now a real dependency; it isn't and wasn't - v0.4.1 moved it the other way (to `peerDependenciesMeta.optional`). Replaced with an accurate "TypeScript surface tightened" line covering the type changes that actually landed.
- **Per-`rpc`-call `timeoutMs` validation has tests** for `0` / `NaN` / `Infinity` / negative / wrong-type inputs, in both the object and legacy-positional forms. Same coverage for `ready()` / `waitFor()` / `rpcWithRetry()` / `waitForPeer()`; plus a `peer.replaced`-wake test for `waitForPeer`.
- **`link.ready()` rejects synchronously with `LinkNotReadyError` when the link is disabled** (any of `url` / `secret` / `kind` missing). Previously `ready()` would call `start()` - which logs and no-ops in disabled mode - and then wait forever on `'ready'` / `'rejected'` events that can never fire. With the default `timeoutMs: 0` ("wait forever") this silently hung any boot path that shared between a real run and a "no-link local dev" run. The fix is fail-fast: a `LinkNotReadyError` with `op: 'ready'` and a message naming the offending fields.
- **`bool('   ')` returns `undefined`, matching `num('   ')`.** Previously `bool` short-circuited only on the exact empty string and so whitespace-only env values fell through to the truthy check and returned `false`, diverging from `num`. A blank `LINK_PERMESSAGE_DEFLATE='   '` now triggers the same library default that an unset env var would, not a forced `false`.
- **`waitForPeer({ signal })` honors the abort signal.** Previously the option was silently ignored - every other helper in `rpc.js` (`rpcWithRetry`, `abortAwareSleep`) accepted `signal` but `waitForPeer` didn't propagate it through to the underlying `waitForAnyEvent`. An already-aborted signal now rejects synchronously; a mid-wait abort rejects promptly with `AbortError` (name === `'AbortError'`).
- **`createHubServer({ extraState })` guards non-object returns.** A user-supplied `extraState()` that returns a string, number, array, or anything else non-object-shaped no longer leaks character indices / array indices / `typeof` junk into `/state`. Non-object returns are dropped with a warn-level log; the response still carries the core `peers` / `lastStatus` keys.
- **`createGracefulShutdown({ timeoutMs })` validated.** Now runs through the same `nonNegFinite` validator as every other public-surface timeout. `NaN`, negatives, non-finite numbers, and wrong types throw `TypeError` at construction time instead of becoming silent-bug `setTimeout` arguments.
- **`RecentIds.add()` LRU eviction termination.** The loop now checks the iterator's `done` flag rather than `value === undefined`, defending against the unreachable-but-real case where a literal-`undefined` first key would brick the eviction loop and freeze the cache at full size. Callers pre-validate ids upstream, so no observable behavior change - defense in depth only.
- **`rpc.complete.durationMs` is always a `number`.** The dead `: null` fallback was removed (`startedAt` is always set to `Date.now()` at `rpc()` call time, so the fallback was unreachable). Matches the `.d.ts` type and what every consumer was already assuming.
- **Single-logger ergonomics: `createLogger()` returns `{ log, warn }` aliases.** The result now satisfies the two-method `Logger` shape directly, so `new LinkClient({ ..., logger: createLogger() })` works without the historical `{ log: l, warn: lW }` adapter. `LeveledLogger extends Logger` in the types. The adapter form still works for back-compat. `LogFn`'s `message` parameter is now optional to keep the structural-subtyping clean (no callsite changes - runtime always allowed it).
- **Empty JSDoc block removed** from `src/internal/options.js`. Cosmetic only.

### Documentation

- **`HubSecretResolver` JSDoc** now explicitly states the resolver runs once per inbound hello attempt (including spoofed ones) and that implementations should cache lookups. The same caveat is mirrored in `SECURITY.md` under documented limitations.
- **`RecentIds`** has an inline comment documenting the monotonic-clock assumption in its sweep; a backward wall-clock jump under-evicts (harmless), never over-evicts.
- **`createEventRecorder`** header comment clarifies that snapshot `eventLog` entries are shallow-cloned from the ring - nested objects (`peer`, `prevPeer`, `status`) are shared references and should be treated as read-only.
- **`linkClientOptionsFromEnv`** JSDoc count is correct (eleven, not seven).
- **README `/state` route status is now consistent across all three intro sections.** Previously three places said `/health` and `/state` were both default; in v0.5 only `/health` is default and `/state` is opt-in (`enableStateRoute: true`). The "you get" quick-start bullet, the "two ways to run a hub" section, and the core-features intro all now reflect the v0.5 behavior. The worked example using `extraState` was also updated to set `enableStateRoute: true` explicitly (otherwise `extraState` would be a silent no-op under v0.5 defaults).
- **README install section** notes the runtime requirement explicitly: Node.js ≥ 20 (matches `package.json#engines`).
- **README single-logger pattern.** With v0.5's `LeveledLogger extends Logger`, the README now shows `logger: createLogger()` directly, no adapter required. The historical `{ log: l, warn: lW }` form is documented for back-compat only.
- **`SECURITY.md`** adds an authenticated-peer-isolation bullet under "not vulnerabilities." Documents that `link-core` authenticates peers and stamps trusted `from` from the socket, but does not maintain a hub-side `rpc.request` > expected-responder correlation table; deployments that need mutual isolation between authenticated peers should layer an app-level identity check (e.g. validate the responder's `kind` inside the requester's RPC handler).

## [0.4.1] - 10-05-2026

A patch release of bug fixes, hardening, and a few quality-of-life additions on top of v0.4.0. Wire-compatible (`PROTOCOL_VERSION` is still `1`); no breaking API changes.

### Added

- Added `reconnectJitter` option on `LinkClient` (default `0.5`, i.e. ±25% spread on each scheduled reconnect delay). Defends against thundering-herd reconnects when many peers drop together (e.g. on hub restart). Set `reconnectJitter: 0` to disable for deterministic backoff.
- Added `'duplicate-hello'` `protocol-error` reason on the hub. Fires when a second hello arrives on a socket that was already authenticated by a prior (concurrent) hello - see the matching Fixed entry below.
- Added `'missing-id'` `protocol-error` reason on both hub and client. Envelopes with a missing or empty `id` are now rejected at parse time, before signature verification - see the matching Fixed entry.
- Added a startup warning from `createHubServer` when `host: '0.0.0.0'` is combined with `enableStateRoute: true` without explicit opt-in. The `/state` route exposes peer kinds, hello payloads, and last-known statuses, which is convenient for local development but a topology leak when the hub is reachable beyond localhost. Set both options explicitly (or pass `enableStateRoute: false`, or `host: '127.0.0.1'`) to silence.
- Added `SECURITY.md` to the published npm tarball's `files` allowlist.
- Added `.gitattributes` (`* text=auto eol=lf`) and normalized all source files to LF. Eliminates CRLF/LF drift between contributors on different operating systems.
- Added a `'bad-hello'` `detail` distinguishing `'missing-kind'`, `'oversized-kind'`, and `'invalid-kind'` so operators can tell from `protocol-error` events why a hello was rejected.

### Fixed

- **Fixed concurrent-hello race on a single socket.** Because the message handler is `async` and `await`s `resolveSecret(...)` before binding the socket to a kind, two helloes arriving back-to-back on the same socket could both pass verification and both register in `clients` under different kinds, leaving a stale entry that broke the "one connection per kind" invariant until the next keepalive sweep. Post-await, the handler now drops a second hello as `'duplicate-hello'` if the socket is already authenticated. Same threat-level as a misbehaving authenticated peer (you need a valid key to send the first hello), but cleaner state.
- **Fixed replay-id cache being bypassable when `id` is missing.** The cache check at step 7 was guarded by `if (recentIds && msg.id && ...)`, so any envelope with a falsy `id` (omitted, empty string, `null`) would skip both the lookup *and* the add - the same signed bytes could be replayed indefinitely within `replayWindowMs`. Both hub and client now reject envelopes with a missing or empty `id` outright, with `'missing-id'` `protocol-error` reason. `makeMsg`'s docs already required `id` to be supplied; this is now enforced at receive.
- **Fixed replay-id cache key collisions across peers (hub *and* client).** The cache was keyed by `id` alone, so two peers happening to use the same id (legal under the protocol; UUIDs make this astronomically unlikely but not impossible) would have one of them dropped as a `'replay-id'`. Cache keys are now `kind|id` on the hub (using the authenticated socket's kind) and `from|id` on the client (using the trusted hub-stamped `from`, falling back to `'server'` for hub-originated messages such as `peers.update`, `status.snapshot`, and `hello.ack`). Different senders' ids never collide. Within a single sender, replay detection works exactly as before.
- **Fixed `LinkClient.hubFeatures` being stale across `stop()`/`start()` cycles.** `stop()` and `handleClose` now reset `hubFeatures` to `null`, so a subsequent reconnect (potentially against a different hub) starts fresh and `hubFeatures` repopulates from the next `hello.ack`. Previously, the field held the last-connected-hub's feature list until the new connection's first verified message, which could let `publish()`/`send()` pre-flight checks pass against the wrong feature set in that window.
- **Fixed `stableStringify` diverging from `JSON.stringify` on sparse arrays.** `JSON.stringify([1, , 3])` is `"[1,null,3]"`, but `stableStringify` used `Array.prototype.map` which skips holes, producing `"[1,3]"`. The mismatch would have caused signatures to verify locally but fail after the JSON round-trip on the receiver. Replaced with a plain `for` loop. Theoretical in practice (sparse arrays are rare in protocol payloads) but a real correctness bug.
- **Fixed pre-hello sockets leaking on `hub.stop()` for embedders using `createHub` directly.** `stop()` previously cleared the timeout on each pending socket but left the socket open; embedders without `createHubServer`'s `wss.close()` backstop had no other cleanup path. The sockets are now closed explicitly with code `1001 'hub stopped'`.
- **Fixed async-throwing topic handlers surfacing as `unhandledRejection`.** `LinkClient`'s topic-message dispatch wrapped subscriber invocations in a `try/catch`, but only sync throws were caught; a `Promise`-returning handler that rejected escaped the catch and bubbled up as an unhandled rejection (which kills the process under modern Node defaults). Both sync and async failures are now caught and logged. The `TopicHandler` type in `src/index.d.ts` is now `(payload, msg) => void | Promise<void>` to match.
- **Fixed broken regression test for the `stableStringify` sparse-array fix.** The new test referenced `arr` before defining it, throwing `ReferenceError` on every test run; the underlying `stableStringify` behavior was correct but the regression coverage was effectively a no-op. Test is now self-contained and passes.

### Changed

- Updated package version metadata from `0.4.0` to `0.4.1`.
- Moved `@types/ws` from `dependencies` to `peerDependenciesMeta.optional` so JS consumers no longer pull in the entire `@types/ws` tree on `npm install`. TypeScript users who want the underlying `ws` types on `HubServer.wss` should `npm install --save-dev @types/ws` (this matches what the README has always said). The package's own `src/index.d.ts` continues to reference `ws` types via a type-only import.
- Removed the redundant `"package.json"` entry from the package's `files` allowlist (npm always includes `package.json`).
- Added `'use strict';` to `src/util/log.js` for consistency with the rest of the codebase.
- `RecentIds.add()` now updates an entry's insertion order on re-add, making the eviction policy true LRU rather than FIFO. For the standard replay-id usage (where `add` is only called when `has` returned false) the two are equivalent; this is for correctness-of-name and any future caller that does re-add.
- **`kind` strings are now restricted to `[a-zA-Z0-9._-]+`** (same character class as topics), via a new `KIND_PATTERN` check in `sanitizeHello`. Hellos with whitespace, slashes, control characters, or non-ASCII characters in `kind` are rejected as `bad-hello` with `detail: 'invalid-kind'`. Existing deployments using conventional service names (`worker`, `vault`, `svc.api`, `tier-1`, etc.) are unaffected; this closes a log-injection / dashboard-encoding footgun where a misbehaving peer could embed newlines or control characters into the `kind` field that surfaces in `/state` output, log lines, and forwarded `peer.connect`/`peer.disconnect` event payloads.
- **`createHub`'s static-secret-map mode now ignores inherited properties.** The lookup at `map[kind]` in `secret-resolver.js` previously walked the prototype chain - so if some other module in the host process had set e.g. `Object.prototype.evilKind = 'pwn'` (host-side prototype pollution), the resolver would have happily authenticated `evilKind` against the polluted value. Now guarded with `Object.hasOwn(map, kind)`. Defensive hardening; not exploitable from inside link-core itself.

### Internal

- Cached the `sanitizeHello` result on the hello dispatch path so each hello message is sanitized once instead of twice (pre-resolve to extract `kind`, then again post-verify for the stored hello).
- Hub-side dispatch step ordering is now: size > parse > id-required > resolve secret > verify signature > version > replay-window > replay-id, with id-required moved to step 2.5 so we don't burn HMAC cycles on an obviously-malformed envelope.
- Removed unused `rpcHandlers`, `builtinRpcs`, and `dropSubscriptionsFor` from the `ctx` destructure in `src/hub/dispatch.js`. They were inherited from an earlier refactor and never referenced inside the message handler.

### Docs

- Corrected the `RpcAbortError` JSDoc in `src/index.d.ts`: the comment previously implied `name === 'AbortError'` ("Mirrors the AbortError name on DOMException…") but the constructor sets `name = 'RpcAbortError'`. The new doc spells out that this class is *distinct* from the DOM-style `AbortError` and that `link.ready({ signal })` / `link.waitFor(event, { signal })` reject with a plain `Error` (`name === 'AbortError'`, no `code`), not with `RpcAbortError`.
- Corrected the `'rejected'` event JSDoc: the previous wording promised a follow-up `'disconnect'` event, but `stop()` only emits `'disconnect'` when `wasReady === true`, and a rejected hello never reaches the `'ready'` state. Updated to reflect that listeners must subscribe to `'rejected'` directly.
- Corrected the description of the v0.4.0 ready-gate behavioral change: `publish()` and `send()` throw `LinkNotReadyError` synchronously, but `rpc()` returns a pre-rejected `Promise` (`await` surfaces the same error; an un-awaited call does not). `subscribe()` does not throw on not-ready - subscriptions are queued and replayed on every `'ready'` transition.
- Renamed integration test `'ready() rejects with HelloRejectedError on per-peer-keys mismatch'` to `'ready() times out on per-peer-keys mismatch (hub silently drops bad hello)'` to match what it actually asserts (the per-peer-keys design is for the hub to *not* confirm kind existence, so `ready()` times out rather than rejects). Removed the now-unused `HelloRejectedError` import from `test/integration.test.js`.

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
  - `Record<kind, string>` - static map of `kind > secret`. Hellos for kinds not in the map are silently dropped.
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
- **Behavioral change:** `publish()`, `send()`, and `rpc()` now require `'ready'` rather than just connection. `publish()` and `send()` throw `LinkNotReadyError` synchronously; `rpc()` returns a pre-rejected `Promise` carrying the same error (so `await link.rpc(...)` surfaces it identically, but a non-awaited call will not). `subscribe()` is unaffected - subscriptions are queued client-side regardless of ready state and replayed on every `'ready'` transition. This matters when using per-peer keys with hubs that may reject hellos, or when calling these methods on the `'connect'` event. Migrating to `await link.ready()` (or awaiting the `'ready'` event) is the recommended pattern.
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
  - `README.md`;
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
  - `README.md`.

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

- Added a full `README.md` covering installation, quick start usage, a two-service coordinator/worker example, constructor options, public methods, protocol helper exports, message envelope shape, supported message types, and behavior notes.
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