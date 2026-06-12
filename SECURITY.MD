# Security Policy

## Reporting a vulnerability

If you've found a security issue in `@presenc3/link-core`, please use [GitHub's private vulnerability reporting](https://github.com/Presenc3/link-core/security/advisories/new) on the repository. This keeps the report private until a fix is available and avoids exposing the issue in the public issue tracker.

I aim to acknowledge reports within 7 days. Please do **not** file a public GitHub issue for security problems - they remain visible in the issue tracker even after the underlying bug is fixed.

## What I consider a vulnerability

`link-core`'s [Security & threat model](https://github.com/Presenc3/link-core#security--threat-model) section in the README documents what the protocol does and does not protect against. A bug report is "in scope" for a security advisory if it shows a way to violate one of those documented invariants - e.g.:

- A way to forge a message that passes signature verification without knowing the secret.
- A way to bypass the per-peer authentication binding (e.g., a peer authenticated as `worker` getting a message routed as if it came from `coordinator`).
- A way to crash, OOM, or starve the hub from a *single* peer within the documented per-message size cap.
- A way to make the replay window or recent-id cache fail open.
- A way to retrieve another peer's HMAC key from the hub in per-peer-keys mode.
- A way to cause `verify()` to leak timing information about the secret.

These are explicitly **not** vulnerabilities (they're documented limitations, not bugs):

- A peer with a valid secret floods the hub. There is no rate limiting; this is documented.
- An eavesdropper on the wire reads message contents. There is no transport encryption; deploy behind `wss://`.
- An attacker who has the shared secret signs their own fresh messages. The protocol assumes the secret is, well, secret.
- A peer crashes its own process by passing bad input to its own RPC handler.
- **An authenticated peer subscribes to any topic *when no ACL gate is configured*.** By default the hub gates *connection* via the secret resolver but does not gate per-topic access. Since v0.6.0 the hub accepts optional authorization callbacks - `canSubscribe`, `canPublish`, `canSend`, `canRpc` - that run after a message is verified and its `from` established but before the hub acts on it, so you *can* enforce topic- and RPC-level access at the hub. If you do not supply them, the default remains open fan-out: topics are a fan-out primitive, not an authorization boundary. Either configure the ACL hooks or layer access control at the application level (e.g. only publish on `secs.changed.<ns>` from a peer kind whose identity downstream consumers can verify - which is exactly what `loadSecrets({ watch: true })` does internally since v0.5.0).
- **In shared-secret mode, `from` is not cryptographically bound to a peer.** When every peer is configured with the *same* secret, the hub can verify that a `hello` was signed by *a* holder of the secret - but it cannot tell *which* holder, so it accepts whatever `kind` the peer claims in that `hello`. A peer that holds the shared secret can therefore connect as **any** `kind`, and the hub will then stamp that `kind` as `from` on every message it forwards. Because the replay-protection cache and most consumer code key on `from` and treat it as an identity, the practical consequence is: **shared-secret mode authenticates *membership* of the bus, not the *identity* of individual peers.** If peers must not be able to impersonate one another, use **per-peer-keys mode** - pass `secret` as a `{ kind > key }` map or a resolver function. There the hub looks up the key *for the claimed kind*, so the `hello` signature only verifies if the peer actually holds that kind's key, which binds `from` to a real per-peer credential. This is a deliberate design point rather than a bug, but it is easy to over-trust `from`, so it is called out here explicitly.
- **One authenticated peer spoofs a response to another authenticated peer's RPC.** `link-core` authenticates peers and envelopes (the hub stamps `from` from the authenticated socket, never from `msg.from`), but it does not maintain a hub-side correlation table mapping `rpc.request` id > expected responder > original requester. The hub will therefore forward any well-formed `rpc.response` a peer emits. Since v0.6.0 the *recipient client* closes most of this gap: it drops a response whose hub-stamped `from` is neither `server` nor the exact kind the request was routed `to` (emitted as a `rpc-response-mismatch` protocol-error). So a peer cannot forge a response *as another kind* - the residual surface is narrower: a peer can only return arbitrary results for RPCs genuinely routed *to it* (normal RPC trust), or replay/forge under its own identity. ids are UUIDs and only the routed responder ever sees them, so cross-peer spoofing additionally requires a collusion or a leak. The threat model is: **authenticated peers are trusted to participate in the bus, but `link-core` is not a full authorization layer between mutually hostile authenticated services.** If your deployment needs hostile-peer isolation, pair `link-core` with the hub ACL hooks and/or a stricter app-level check (e.g. validate responder identity inside the requester).
- **An attacker replays a captured `rpc.response` within the replay window.** Response messages share their request's `id` (they correlate that way), so the recent-id cache deliberately exempts them - otherwise every legitimate response would false-positive. A replayed response is dropped client-side because no `pending` entry matches the id, but the residual primitive does exist within `replayWindowMs` (default 5 minutes). Tighten the window if your deployment can't tolerate it.
- **An attacker floods the hub with spoofed `hello` envelopes to trigger expensive `resolveSecret` calls.** The hub *must* resolve the per-peer key before it can verify the hello's signature, so the resolver is called once per inbound hello attempt - including unauthenticated and spoofed ones. This is documented; if your resolver hits a remote vault, DB, or filesystem on every call, it amplifies pre-hello traffic into backend load. Mitigations are your responsibility and live in the resolver: cache lookups aggressively (including negative results, with a short TTL), and don't make the cache-miss path expensive. `helloTimeoutMs` and `maxPendingSockets` cap socket count but do not cap hello-message rate per socket.

If you're not sure whether something counts, please report it anyway - I'd rather decline a report as "by design" than miss a real issue.

## Supported versions

Active development is on the latest minor (`0.x`). Older minors do not receive security backports while the API surface is still stabilizing. Once `link-core` reaches `1.x`, this policy will be revised.

## Disclosure timeline

Once a vulnerability is confirmed, I aim to:

1. Acknowledge within 7 days.
2. Develop a fix and publish a patched version within 30 days for high-severity issues, longer for lower-severity ones.
3. Publish a GitHub Security Advisory (GHSA) describing the issue and the fix once the patch is available.
4. Credit the reporter in the advisory unless they request otherwise.