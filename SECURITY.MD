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
- **An authenticated peer subscribes to any topic.** The hub gates *connection* via the secret resolver but does not gate per-topic access. Topics are a fan-out primitive, not an authorization boundary; if you need topic-level access control, layer it at the application level (e.g. only publish on `secs.changed.<ns>` from a peer kind whose identity downstream consumers can verify - which is exactly what `loadSecrets({ watch: true })` does internally since v0.5.0).
- **One authenticated peer spoofs a response to another authenticated peer's RPC.** `link-core` authenticates peers and envelopes (the hub stamps `from` from the authenticated socket, never from `msg.from`), but it does not maintain a hub-side correlation table mapping `rpc.request` id → expected responder → original requester. A malicious authenticated peer that *knows or guesses* a pending RPC's id could send an `rpc.response` with that id and a forged `to`, and the hub will forward it. In practice ids are UUIDs and only the routed responder ever sees them, so this requires a collusion or a leak. The threat model is: **authenticated peers are trusted to participate in the bus, but `link-core` is not a full authorization layer between mutually hostile authenticated services.** If your deployment needs hostile-peer isolation, pair `link-core` with a stricter app-level check (e.g. validate responder identity inside the requester).
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