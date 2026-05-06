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

If you're not sure whether something counts, please report it anyway - I'd rather decline a report as "by design" than miss a real issue.

## Supported versions

Active development is on the latest minor (`0.x`). Older minors do not receive security backports while the API surface is still stabilizing. Once `link-core` reaches `1.x`, this policy will be revised.

## Disclosure timeline

Once a vulnerability is confirmed, I aim to:

1. Acknowledge within 7 days.
2. Develop a fix and publish a patched version within 30 days for high-severity issues, longer for lower-severity ones.
3. Publish a GitHub Security Advisory (GHSA) describing the issue and the fix once the patch is available.
4. Credit the reporter in the advisory unless they request otherwise.