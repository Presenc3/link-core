/**
 * Type declarations for @presenc3/link-core
 */

import { EventEmitter } from 'events';
import { Server as HttpServer, IncomingMessage, ServerResponse } from 'http';
import { WebSocket as WsWebSocket, WebSocketServer, ServerOptions as WsServerOptions } from 'ws';

/** Current wire-protocol version. Messages with a different `v` are dropped. */
export const PROTOCOL_VERSION: number;

/**
 * Default HMAC hash algorithm. Both client and hub default to this; both
 * sides must use the same algorithm or every signature will fail to verify.
 */
export const DEFAULT_HASH_ALGO: 'sha256';

/** A signed message envelope as it appears on the wire. */
export interface MessageEnvelope<TData = unknown> {
  v:    number;
  id:   string;
  ts:   number;
  type: string;
  from: string | null;
  to:   string | null;
  data: TData;
  sig:  string;
}

/**
 * Two-method logger. Pass `null` to silence; omit to use the default
 * console-based logger.
 */
export interface Logger {
  log(tag:  string, ...args: unknown[]): void;
  warn(tag: string, ...args: unknown[]): void;
}

/** A peer description as it appears in `peers.update` and `getState()`. */
export interface PeerInfo {
  kind:        string;
  hello:       unknown | null;
  connectedAt: number  | null;
  connected:   boolean;
}

/** A peer's last-known status as remembered by the hub. */
export interface PeerStatus {
  status: unknown;
  at:     number;
}

/**
 * RPC handler signature. The hub-side `rpcHandlers` and client-side
 * `rpcHandlers` use the same shape: `(rpcData, msg) => result`.
 *
 * For server-side handlers, `msg.from` is guaranteed to be the authenticated
 * socket's bound `kind` (since v0.3.2) - safe to use for authorization.
 */
export type RpcHandler<TIn = any, TOut = any> = (
  data: TIn,
  msg:  MessageEnvelope<{ rpcType: string; rpcData: TIn }>,
) => Promise<TOut> | TOut;

/**
 * Build a fully-formed signed envelope. `v` defaults to PROTOCOL_VERSION,
 * `ts` defaults to Date.now(), `from` and `to` default to null. `data` is
 * deep-cloned via `structuredClone` so the caller may freely mutate the input
 * after the call without affecting the returned envelope or the bytes that
 * eventually go on the wire.
 *
 * `data` must be `structuredClone`-compatible: plain objects/arrays, primitives,
 * `Date`, `Map`, `Set`, `Uint8Array`, etc. Functions, class instances with
 * methods, and DOM nodes will throw. If you need to send something exotic,
 * serialize it yourself (e.g. to a base64 string) before calling.
 *
 * `algo` selects the HMAC hash algorithm; defaults to `DEFAULT_HASH_ALGO`
 * (`'sha256'`). The same algorithm must be configured on both ends.
 */
export function makeMsg<T = unknown>(
  secret: string,
  parts: {
    v?:    number;
    id:    string;
    ts?:   number;
    type:  string;
    from?: string | null;
    to?:   string | null;
    data:  T;
  },
  algo?: string,
): MessageEnvelope<T>;

/**
 * Compute the hex HMAC signature of an envelope (excluding `sig`). Defaults
 * to HMAC-SHA256; pass `algo` to use a different algorithm (must match
 * the `verify` and `makeMsg` calls on the other side).
 */
export function sign(secret: string, msg: object, algo?: string): string;

/**
 * Constant-time verify a signed envelope. Returns true if the signature
 * matches under the given `algo` (default HMAC-SHA256). An algorithm
 * mismatch fails verification gracefully - never throws on bad input.
 */
export function verify(secret: string, msg: unknown, algo?: string): boolean;

/** Deterministic JSON stringifier with sorted keys. Used for stable signing. */
export function stableStringify(obj: unknown): string;

/** Maximum permitted topic length, in characters. */
export const TOPIC_MAX_LENGTH: number;

/** Returns true if `topic` is a syntactically valid topic name (non-empty,
 *  ≤ TOPIC_MAX_LENGTH chars, matches `/^[a-zA-Z0-9._-]+$/`, no wildcards). */
export function isValidTopic(topic: unknown): topic is string;

/** Like `isValidTopic` but throws a descriptive error on rejection. */
export function assertValidTopic(topic: unknown): asserts topic is string;

/**
 * A topic subscription handler. The `payload` is whatever the publisher
 * passed; `msg.from` is the publisher's authenticated kind. The hub
 * overwrites `from` with the trusted value before forwarding, so it is
 * safe to use for routing/authorization decisions.
 */
export type TopicHandler<TPayload = unknown> = (
  payload: TPayload,
  msg:     MessageEnvelope<{ topic: string; payload: TPayload }>,
) => void | Promise<void>;

/**
 * Reasons that may appear on a `'protocol-error'` event payload's `reason`
 * field. Also used as `reason` on `ProtocolError` instances. Unioned across
 * client-side and hub-side emissions; see the more specific
 * `ClientProtocolErrorReason` / `HubProtocolErrorReason` for narrowing.
 *
 *   - `parse-error`        - JSON.parse failed.
 *   - `bad-signature`      - HMAC didn't match.
 *   - `bad-version`        - message `v` differs from PROTOCOL_VERSION.
 *   - `replay-window`      - `ts` outside the configured replay window.
 *   - `replay-id`          - message `id` already seen recently.
 *   - `missing-id`         - envelope `id` was missing or empty.
 *   - `oversize`           - message exceeded `maxMessageBytes`.
 *   - `no-ack`             - client-only: saw no verified message within
 *                            `helloAckDiagnosticMs` (likely secret mismatch).
 *   - `bad-hello`          - hub-only: hello arrived with a missing,
 *                            oversized, or pattern-failing `kind`. The
 *                            `detail` field disambiguates: `'missing-kind'`,
 *                            `'oversized-kind'`, or `'invalid-kind'`.
 *   - `duplicate-hello`    - hub-only: a second hello arrived on a socket
 *                            that was already authenticated by a prior
 *                            (concurrent) hello.
 *   - `unknown-kind`       - hub-only: per-peer mode resolver returned no
 *                            key for the claimed kind.
 *   - `pre-hello-message`  - hub-only: a non-hello message arrived from an
 *                            unauthenticated socket.
 *   - `invalid-topic`      - hub-only: subscribe/unsubscribe/publish on a
 *                            topic that fails `isValidTopic`.
 */
export type ProtocolErrorReason =
  | 'parse-error'
  | 'bad-signature'
  | 'bad-version'
  | 'replay-window'
  | 'replay-id'
  | 'missing-id'
  | 'oversize'
  | 'no-ack'
  | 'bad-hello'
  | 'duplicate-hello'
  | 'unknown-kind'
  | 'pre-hello-message'
  | 'invalid-topic';

/** Subset of `ProtocolErrorReason` that the `LinkClient` may emit. */
export type ClientProtocolErrorReason =
  | 'parse-error'
  | 'bad-signature'
  | 'bad-version'
  | 'replay-window'
  | 'replay-id'
  | 'missing-id'
  | 'oversize'
  | 'no-ack';

/** Subset of `ProtocolErrorReason` that the `Hub` may emit. */
export type HubProtocolErrorReason =
  | 'parse-error'
  | 'bad-signature'
  | 'bad-version'
  | 'replay-window'
  | 'replay-id'
  | 'missing-id'
  | 'oversize'
  | 'bad-hello'
  | 'duplicate-hello'
  | 'unknown-kind'
  | 'pre-hello-message'
  | 'invalid-topic';

/** Common payload shape for `'protocol-error'` events. */
export interface ProtocolErrorInfoBase {
  reason: ProtocolErrorReason;
  type?: string;
  msg?: MessageEnvelope;
  size?: number;
  skew?: number;
  detail?: string;
  error?: Error;
}

/** Client-emitted `'protocol-error'` payload. `kind` is never present. */
export interface ClientProtocolErrorInfo extends ProtocolErrorInfoBase {
  reason: ClientProtocolErrorReason;
}

/** Hub-emitted `'protocol-error'` payload. `kind` is the authenticated
 *  kind on the offending socket, or `null` if the socket hadn't completed
 *  hello yet. */
export interface HubProtocolErrorInfo extends ProtocolErrorInfoBase {
  reason: HubProtocolErrorReason;
  kind: string | null;
}

/** @deprecated Use `ClientProtocolErrorInfo` or `HubProtocolErrorInfo`
 *  for narrowed payloads, or `ProtocolErrorInfoBase` for the common
 *  fields. Preserved as the union of both for back-compat. */
export type ProtocolErrorInfo =
  | ClientProtocolErrorInfo
  | HubProtocolErrorInfo;

/**
 * Stable error codes. Prefer `instanceof` against the typed classes below for
 * new code, but `err.code === 'RPC_TIMEOUT'` etc. is also stable across minor
 * versions and may be more convenient when you need duck-typing across
 * package boundaries.
 */
export type LinkErrorCode =
  | 'LINK_ERROR'
  | 'RPC_ERROR'
  | 'RPC_TIMEOUT'
  | 'RPC_DISCONNECT'
  | 'RPC_ABORT'
  | 'RPC_REMOTE'
  | 'BACKPRESSURE'
  | 'PROTOCOL_ERROR'
  | 'HELLO_REJECTED'
  | 'LINK_NOT_READY'
  | 'FEATURE_UNSUPPORTED';

/**
 * Base class for every error link-core throws or rejects with locally.
 * As of v0.4.x, errors that come back over the wire from a remote handler
 * are wrapped in `RpcRemoteError` (the wire format still only carries an
 * error string; the `RpcRemoteError` instance surfaces it as `.message`
 * and exposes `to`/`rpcType`/`id` for context).
 */
export class LinkError extends Error {
  code: LinkErrorCode;
  constructor(message: string, opts?: { code?: LinkErrorCode });
}

/** Common base for everything `rpc()` rejects with locally. */
export class RpcError extends LinkError {
  to?: string;
  rpcType?: string;
  id?: string;
  constructor(message: string, opts?: {
    code?: LinkErrorCode;
    to?: string;
    rpcType?: string;
    id?: string;
  });
}

/** `rpc()` did not receive a response within `timeoutMs`. */
export class RpcTimeoutError extends RpcError {
  code: 'RPC_TIMEOUT';
  timeoutMs?: number;
  constructor(message: string, opts?: {
    to?: string;
    rpcType?: string;
    id?: string;
    timeoutMs?: number;
  });
}

/**
 * Link disconnected (or `stop()` was called) while the RPC was in flight.
 * Distinct from `RpcTimeoutError` so retry policy can branch on it
 * (immediate retry on disconnect, exponential on timeout).
 */
export class RpcDisconnectError extends RpcError {
  code: 'RPC_DISCONNECT';
}

/**
 * Caller-supplied `AbortSignal` fired before the response arrived. Has
 * `name === 'RpcAbortError'` and `code === 'RPC_ABORT'`. Note that this is
 * **distinct from the DOM-style `AbortError`** that `fetch()` and other
 * AbortSignal-aware Node APIs reject with: a `try/catch` that pattern-matches
 * on `err.name === 'AbortError'` will *not* match this class. Branch on
 * `instanceof RpcAbortError` or `err.code === 'RPC_ABORT'` instead.
 *
 * Note: `link.ready({ signal })` and `link.waitFor(event, { signal })` are
 * pre-RPC lifecycle waits and reject with a plain `Error` whose
 * `name === 'AbortError'` (no `code`), not with this class.
 */
export class RpcAbortError extends RpcError {
  code: 'RPC_ABORT';
}

/**
 * The remote handler threw, or the hub returned an error response (e.g.
 * `"Target not connected: foo"` when the destination peer is offline,
 * or `"Unknown rpcType: bar"` when no handler is registered).
 *
 * The wire format only carries an error string, so `.message` is the
 * remote-supplied string verbatim. Useful primarily for `instanceof`
 * discrimination against transport-level errors - code that retries on
 * `RpcTimeoutError`/`RpcDisconnectError` should generally NOT retry on
 * `RpcRemoteError` because the failure is the remote's, not the link's.
 */
export class RpcRemoteError extends RpcError {
  code: 'RPC_REMOTE';
}

/**
 * Local `ws.bufferedAmount` exceeded the configured cap; the message was
 * dropped (or the RPC rejected synchronously). Carries `err.code === 'BACKPRESSURE'`
 * for stable duck-typing across package boundaries.
 */
export class BackpressureError extends LinkError {
  code: 'BACKPRESSURE';
  type?: string;
  to?: string;
  rpcType?: string;
  id?: string;
  bufferedAmount?: number;
  maxBufferedBytes?: number;
  constructor(message: string, opts?: {
    type?: string;
    to?: string;
    rpcType?: string;
    id?: string;
    bufferedAmount?: number;
    maxBufferedBytes?: number;
  });
}

/**
 * Thrown synchronously by `publish()`, `send()`, `rpc()`, and `ready()`
 * when the link is not in the `'ready'` state (no socket, not yet verified,
 * hello rejected, or `stop()` called). For `rpc()` this is a synchronous
 * pre-send rejection; the in-flight equivalents are `RpcDisconnectError`
 * (link dropped mid-flight) and `RpcTimeoutError` (no response in time).
 * `op` is `'publish' | 'send' | 'rpc' | 'ready'`.
 */
export class LinkNotReadyError extends LinkError {
  code: 'LINK_NOT_READY';
  op?: string;
  constructor(message: string, opts?: { op?: string });
}

/**
 * Thrown synchronously by feature-gated methods (`publish()` requires
 * `'topics'`, `send()` requires `'direct'`) when the connected hub does
 * not advertise the required capability. `feature` is the missing
 * feature name; `op` is the caller-side operation that needed it.
 *
 * Notably fires loud against v0.3.x hubs (which don't advertise any
 * features at all): the v0.4 client treats "no advertisement" as
 * "feature absent" so a publish/send call doesn't silently disappear
 * into a hub that won't act on it.
 */
export class FeatureUnsupportedError extends LinkError {
  code: 'FEATURE_UNSUPPORTED';
  feature?: string;
  op?: string;
  constructor(message: string, opts?: { feature?: string; op?: string });
}

/**
 * A message was rejected by signature, version, replay, or size checks.
 * Mostly emitted via the `'protocol-error'` event today; this class is
 * available for callers that need to throw rather than emit.
 */
export class ProtocolError extends LinkError {
  code: 'PROTOCOL_ERROR';
  reason?: ProtocolErrorReason;
  constructor(message: string, opts?: {
    reason?: ProtocolErrorReason;
  });
}

/**
 * The hub explicitly rejected the client's `hello` (e.g. `hello.ack`
 * with `ok: false`). Used as the rejection reason from `link.ready()`
 * and as the basis for the `'rejected'` event.
 *
 * Distinct from a transport-level disconnect so the client can decide
 * not to retry blindly. By default, a `LinkClient` that receives this
 * stops itself rather than hot-looping; opt out with
 * `LinkClientOptions.reconnectOnRejection: true`.
 */
export class HelloRejectedError extends LinkError {
  code: 'HELLO_REJECTED';
  reason?: string | null;
  constructor(message: string, opts?: { reason?: string | null });
}

export interface LinkClientOptions {
  /** Hub WebSocket URL, e.g. `ws://localhost:8080`. */
  url:    string;
  /**
   * The HMAC secret this client signs with and verifies the hub's messages
   * against. In shared-secret deployments this is the same string for every
   * peer. In per-peer-keys deployments this is THIS peer's key only - the
   * client never sees other peers' keys; the hub re-signs each fan-out
   * with the recipient's key.
   */
  secret: string;
  /**
   * Service-type identifier; e.g. `'worker'`. Singleton per hub. Must
   * match `[a-zA-Z0-9._-]+`, length 1–256 (same character class as topics);
   * the hub will reject the hello as `'bad-hello'` (`detail: 'invalid-kind'`)
   * otherwise.
   */
  kind:   string;
  /** Human-readable instance name. Defaults to `kind`. */
  name?:  string;

  /** Called on connect and every `statusIntervalMs`; return is sent as `status.update`. */
  makeStatus?: () => unknown;

  /** Map of `rpcType` → handler for incoming RPC requests. */
  rpcHandlers?: Record<string, RpcHandler>;

  /** Custom logger, or `null` to silence. Defaults to a console-based logger. */
  logger?: Logger | null;

  /** Default per-call RPC timeout in ms. Default: 5000. */
  defaultRpcTimeoutMs?: number;

  /** Status push cadence in ms. Default: 10000. */
  statusIntervalMs?:    number;

  /** Initial reconnect delay in ms. Default: 1000. */
  reconnectInitialMs?:  number;

  /** Maximum reconnect delay in ms. Default: 10000. */
  reconnectMaxMs?:      number;

  /** Reconnect backoff growth factor. Default: 1.5. */
  reconnectGrowth?:     number;

  /**
   * Reconnect-delay jitter factor in `[0, 1]`. The actual scheduled delay is
   * `reconnectMs * (1 - jitter/2 + Math.random() * jitter)`, so the default
   * `0.5` produces a uniform spread of `[reconnectMs * 0.75, reconnectMs * 1.25]`,
   * `0` disables jitter (deterministic exponential backoff), and `1` produces
   * the widest spread `[reconnectMs * 0.5, reconnectMs * 1.5]`. Useful to
   * avoid thundering-herd reconnects when many peers drop together (e.g. on
   * hub restart). Default: 0.5.
   */
  reconnectJitter?:     number;

  /**
   * Time after `open` to wait for any verified message before warning about a
   * likely secret mismatch. Set to 0 to disable. Default: 5000.
   */
  helloAckDiagnosticMs?: number;

  /**
   * Replay-protection window in ms. Messages with a `ts` further than this
   * from now are dropped, and message `id`s are remembered for this duration
   * to detect replays. Set to 0 to disable. Default: 300000 (5 minutes).
   */
  replayWindowMs?: number;

  /** Maximum number of recent message ids to remember. Default: 10000. */
  maxRecentIds?: number;

  /**
   * Maximum incoming WebSocket frame size in bytes. Enforced both at the
   * transport (`ws` library `maxPayload`) and in the message handler.
   * Default: 1048576 (1 MiB).
   */
  maxMessageBytes?: number;

  /**
   * Cap on `ws.bufferedAmount` before sends are dropped. Status updates and
   * fire-and-forget messages (`publish()`, `send()`) are silently dropped
   * (with a `'backpressure'` event); `rpc()` rejects synchronously with a
   * `BackpressureError` (`err.code === 'BACKPRESSURE'`).
   * Default: 4194304 (4 MiB).
   */
  maxBufferedBytes?: number;

  /**
   * HMAC hash algorithm. Must match the hub. Default: `'sha256'`.
   * Pluggable to support FIPS-mode deployments that require sha384/sha512
   * or future migrations to faster algorithms (e.g. blake3 via a custom
   * Node provider). The wire envelope is unchanged - `sig` is just hex bytes.
   */
  hashAlgo?: string;

  /**
   * Pass-through to the underlying `ws` WebSocket client. `false` (default)
   * disables compression. `true` accepts `ws`'s defaults; pass an options
   * object to control window bits, threshold, etc.
   *
   * Off by default because permessage-deflate has a history of
   * memory-amplification CVEs against malicious peers; enable it only on
   * trusted networks (or after configuring the trade-offs you want).
   */
  perMessageDeflate?: boolean | object;

  /**
   * Behavior on `hello.ack` with `ok: false`:
   *   - `false` (default) - call `stop()` and stay down. Prevents a hot
   *     reconnect loop when the secret/key registry is misconfigured.
   *     The promise from `ready()` rejects with `HelloRejectedError`.
   *   - `true`  - keep reconnecting. Useful only if the hub's key
   *     registry is expected to change while the client is running
   *     (e.g. the operator hot-rotates a key into the resolver).
   */
  reconnectOnRejection?: boolean;
}

/**
 * Typed event payloads emitted by `LinkClient`.
 *
 * Note: the bare `'error'` event from EventEmitter is *not* used - socket
 * errors emit as `'ws-error'` and protocol-level rejections emit as
 * `'protocol-error'`. This means an unhandled error doesn't crash the
 * process, which is the safer default for a long-lived background client.
 */
export interface LinkClientEvents {
  /** Underlying WebSocket has opened and `hello` has been sent. Not yet verified. */
  'connect':         (info: { url: string; kind: string }) => void;

  /**
   * The first signed-and-verified message has arrived from the hub -
   * cryptographically the channel is now trusted. NOTE: this fires even
   * if the very next message is a `hello.ack` with `ok: false`. For the
   * "the hub has accepted us and it's safe to publish/send/RPC" gate,
   * use `'ready'` (or `link.ready()` / `link.isReady()`).
   */
  'verified':        (info: { kind: string }) => void;

  /**
   * The hub accepted our hello (`hello.ack.ok !== false`, OR - for
   * back-compat with v0.3.x hubs that didn't send hello.ack at all - any
   * non-rejecting verified message). At this point the reconnect backoff
   * is reset, locally-tracked subscriptions have been replayed to the
   * hub, and the status-push timer is armed. This is the gate for
   * `publish()` / `send()` / `rpc()`.
   *
   * `features` is the capability list announced by the hub in
   * `hello.ack` (e.g. `['topics','direct']`); `null` if the hub didn't
   * advertise them; an empty array if it advertised none.
   */
  'ready':           (info: { kind: string; features: string[] | null }) => void;

  /**
   * The hub rejected the hello (`hello.ack` with `ok: false`). By default
   * the client then `stop()`s itself; because the link never reached the
   * `'ready'` state, **no follow-up `'disconnect'` event fires** (it's gated
   * on `wasReady`). React to this case by listening for `'rejected'`
   * directly, or set `reconnectOnRejection: true` to keep retrying instead
   * of stopping.
   */
  'rejected':        (info: { reason: string; error: string | null }) => void;

  /**
   * WebSocket has closed. `willReconnect` is false after `stop()` or
   * after a hello rejection (when `reconnectOnRejection` is the default
   * `false`). `wasReady` indicates whether the link reached the `'ready'`
   * state during this connection.
   */
  'disconnect':      (info: { code?: number; reason: string; willReconnect: boolean; wasReady: boolean }) => void;

  /** A reconnect attempt is scheduled. `attempt` is 1-indexed since last `'ready'`. */
  'reconnecting':    (info: { delayMs: number; attempt: number }) => void;

  /** Underlying WebSocket emitted an error. */
  'ws-error':        (err: Error) => void;

  /** A message was rejected by signature, version, replay, or size checks. */
  'protocol-error':  (info: ClientProtocolErrorInfo) => void;

  /** Power-user firehose: every verified message, post-replay-check. */
  'message':         (info: { msg: MessageEnvelope; raw: Buffer | string }) => void;

  /** A new peer kind appeared in the latest `peers.update`. */
  'peer.connect':    (peer: PeerInfo) => void;

  /** A peer kind disappeared from the latest `peers.update`. */
  'peer.disconnect': (peer: PeerInfo) => void;

  /** A peer broadcast a status update. */
  'peer.status':     (info: { from: string; status: unknown; at: number }) => void;

  /** An incoming RPC request was received (fires before the handler runs). */
  'rpc.request': (info: {
    from    : string | null;
    rpcType : string;
    rpcData : unknown;
    msg     : MessageEnvelope;
  }) => void;

  /** A pending outbound RPC timed out. */
  'rpc.timeout': (info: {
    id        : string;
    to        : string;
    rpcType   : string;
    timeoutMs : number;
  }) => void;

  /** A pending outbound RPC was aborted via its `AbortSignal`. */
  'rpc.abort': (info: {
    id        : string;
    to        : string;
    rpcType   : string;
  }) => void;

  /** A pending outbound RPC was orphaned by a disconnect. Fires before its rejection. */
  'rpc.disconnect': (info: {
    id        : string;
    to        : string;
    rpcType   : string;
  }) => void;

  /**
   * Unified outbound-RPC lifecycle event. Fires exactly once per `rpc()`
   * call, regardless of outcome. `reason` is `null` on success and one of
   * `'timeout' | 'abort' | 'disconnect' | 'not-ready' | 'remote-error' |
   * 'send-error' | 'backpressure'` on failure. `id` and `durationMs` are
   * always populated, including for synchronous pre-send rejections (those
   * report `durationMs` as the time spent inside `rpc()` itself, typically
   * 0).
   *
   * The specific events (`rpc.timeout`, `rpc.abort`, `rpc.disconnect`)
   * still fire on their respective failure modes; this event is for
   * listeners that want a single "the RPC ended" hook for metrics/tracing.
   */
  'rpc.complete': (info: {
    id        : string;
    to        : string;
    rpcType   : string;
    ok        : boolean;
    reason    : 'timeout' | 'abort' | 'disconnect' | 'not-ready' | 'remote-error' | 'send-error' | 'backpressure' | null;
    durationMs: number;
    error     : string | null;
  }) => void;

  /**
   * The local WebSocket's `bufferedAmount` exceeded `maxBufferedBytes` and a
   * send was dropped. For status updates, `publish()`, and `send()` the
   * message is silently dropped (after this event fires); for `rpc()` the
   * call rejects synchronously with a `BackpressureError`
   * (`err.code === 'BACKPRESSURE'`).
   */
  'backpressure': (info: {
    type: string;
    to?: string | null;
    rpcType?: string;
    bufferedAmount: number;
  }) => void;

  /**
   * A directed fire-and-forget message arrived from a peer (sent via
   * `link.send(to, type, data)`). `from` is the sender's authenticated
   * `kind`, stamped by the hub. `type` is the application-level message
   * type the sender supplied; switch on it to dispatch handlers.
   */
  'direct': (info: {
    from : string | null;
    type : string;
    data : unknown;
    msg  : MessageEnvelope<{ directType: string; directData: unknown }>;
  }) => void;
}

/**
 * Options for `link.rpc(...)` when using the object form. The legacy
 * positional `timeoutMs: number` is still accepted for backwards compat
 * with v0.4.0 callers; new code should prefer this object.
 */
export interface RpcOptions {
  /** Per-call timeout in ms. Falls back to `defaultRpcTimeoutMs`. */
  timeoutMs?: number;
  /**
   * Optional `AbortSignal`. Aborting it rejects the pending RPC with an
   * `RpcAbortError` and removes the pending entry. The wire request is
   * not cancelled - the remote handler may still complete and the
   * response will be logged-and-dropped on arrival.
   */
  signal?: AbortSignal;
}

/**
 * Options for `link.waitFor(event, opts)`.
 */
export interface WaitForOptions {
  /** Reject with an `Error` after this many ms. 0 (default) = no timeout. */
  timeoutMs?: number;
  /**
   * Optional `AbortSignal`. Aborting it rejects with an error whose
   * `name` is `'AbortError'`.
   */
  signal?: AbortSignal;
}

/**
 * Options for `link.ready(opts)`. Same shape as `WaitForOptions` - the
 * separation is just for documentation clarity and future divergence.
 */
export interface ReadyOptions {
  /**
   * Reject with an `Error` after this many ms if the hub hasn't accepted
   * the hello by then. 0 (default) = no timeout.
   */
  timeoutMs?: number;
  /**
   * Optional `AbortSignal`. Aborting it rejects with an `'AbortError'`.
   */
  signal?: AbortSignal;
}

/**
 * Snapshot returned by `link.health()`. Designed for `/health` endpoints
 * and dashboards.
 */
export interface HealthSnapshot {
  /** WebSocket is OPEN. */
  connected: boolean;
  /** First signed message has arrived since last connect. */
  verified: boolean;
  /**
   * Hub has accepted our hello - the gate for publish/send/rpc. Resets
   * to `false` on disconnect; flips to `true` on the next `'ready'`.
   */
  ready: boolean;
  /**
   * `Date.now()` of the most recent verified message, or `null` if there
   * has never been one. Updated on *every* verified message, so this is
   * useful for "connected but silent" alerts that a bare `connected`
   * check would miss.
   */
  lastVerifiedAt: number | null;
  /** Length of the latest `peers.update` snapshot from the hub. */
  peerCount: number;
  /** Outbound RPCs currently awaiting a response. */
  pendingRpcCount: number;
  /** Number of distinct local topic subscriptions. */
  subscriptionCount: number;
  /** `ws.bufferedAmount`, or 0 if there is no socket. */
  bufferedAmount: number;
  /** Reconnect attempts since the last `'ready'`. 0 when healthy. */
  reconnectAttempt: number;
  /** `stop()` has been called. */
  stopped: boolean;
}

export class LinkClient extends EventEmitter {
  readonly url    : string;
  readonly secret : string;
  readonly kind   : string;
  readonly name   : string;
  peers           : PeerInfo[];

  /**
   * Capability list announced by the hub in its `hello.ack`. `null` until
   * the first verified message arrives; an empty array if the hub didn't
   * advertise any features (i.e. a v0.3.x hub). Use to pre-flight feature
   * availability before invoking it: `link.hubFeatures?.includes('topics')`.
   */
  hubFeatures: string[] | null;

  /**
   * Map of `rpcType` → handler. Initially populated from
   * `LinkClientOptions.rpcHandlers`; mutate it via `handle()` / `unhandle()`
   * rather than direct assignment so plugin-style "register on link-up"
   * patterns are tidy.
   */
  rpcHandlers: Record<string, RpcHandler>;

  constructor(options: LinkClientOptions);

  /**
   * Connect to the hub. No-op if `url`/`secret`/`kind` is missing or a
   * connection is already open or in flight. If a previous socket is in
   * `CLOSING`/`CLOSED` state, its listeners are detached so its eventual
   * close cannot interfere with the new connection (since v0.4.0).
   */
  start(): void;

  /**
   * Close, cancel timers, reject pending RPCs with `RpcDisconnectError`.
   * The client will not auto-reconnect after `stop()`.
   */
  stop(): void;

  /** True if the WebSocket is open. (Not necessarily verified - see `'verified'` event.) */
  isConnected(): boolean;

  /** True if the hub has accepted our hello. Mirrors the `'ready'` event. */
  isReady(): boolean;

  /**
   * `start()` if not already running, then resolve when the hub accepts the
   * hello (the `'ready'` event). Resolves immediately if already ready.
   *
   * Rejects with `HelloRejectedError` on `hello.ack ok:false`,
   * with a timeout `Error` if `opts.timeoutMs` elapses first, or with
   * an `AbortError` if `opts.signal` aborts.
   */
  ready(opts?: ReadyOptions): Promise<{ kind: string; features: string[] | null }>;

  /**
   * Send an RPC and await the response. Pass `to: 'server'` for hub-handled
   * RPCs. The fourth argument accepts either a number (legacy positional
   * `timeoutMs`) or an `RpcOptions` object with `{ timeoutMs, signal }`.
   *
   * Rejection types:
   *   - `LinkNotReadyError`   - called before `'ready'` (synchronous). Match
   *                             on `err.op === 'rpc'` if you also handle
   *                             `publish()`/`send()` rejections.
   *   - `RpcTimeoutError`     - `timeoutMs` elapsed without a response.
   *   - `RpcDisconnectError`  - link disconnected (or stopped) mid-flight.
   *   - `RpcAbortError`       - `opts.signal` fired.
   *   - `RpcRemoteError`      - remote handler threw, or hub returned an
   *                             error response (e.g. target offline).
   *   - `BackpressureError`   - local send buffer over cap (synchronous).
   *   - plain `Error`         - `ws.send()` itself threw (very rare).
   */
  rpc<TOut = any, TIn = any>(
    to      : string,
    rpcType : string,
    rpcData?: TIn,
    optsOrTimeoutMs?: number | RpcOptions,
  ): Promise<TOut>;

  /**
   * Directed fire-and-forget. The third primitive alongside `rpc()` and
   * `publish()`. Returns `true` if the message was sent, `false` if it was
   * dropped due to local backpressure (in which case `'backpressure'` was
   * emitted). Throws synchronously if the link is not connected/ready
   * or the hub doesn't advertise the `'direct'` feature.
   *
   * Receiver subscribes to the `'direct'` event for `{ from, type, data, msg }`.
   */
  send<TData = unknown>(to: string, type: string, data?: TData): boolean;

  /**
   * Register an RPC handler at runtime. Replaces any existing handler for
   * the same `rpcType`; returns the previous handler (or `undefined`).
   * Designed for "register on every `'ready'`" plugin patterns where
   * idempotent re-registration is the norm.
   */
  handle<TIn = any, TOut = any>(
    rpcType : string,
    fn      : RpcHandler<TIn, TOut>,
  ): RpcHandler | undefined;

  /**
   * Remove the RPC handler for `rpcType`. Returns `true` if a handler was
   * removed, `false` if there was none.
   */
  unhandle(rpcType: string): boolean;

  /**
   * Wait for the next occurrence of `event` and resolve with its payload
   * (the first listener argument when there is one; the full argument
   * array otherwise). Always waits for the *next* occurrence - does not
   * check current state. With `opts.timeoutMs > 0`, rejects on timeout;
   * with `opts.signal` aborted, rejects with an `'AbortError'`.
   */
  waitFor<K extends keyof LinkClientEvents>(
    event: K,
    opts?: WaitForOptions,
  ): Promise<Parameters<LinkClientEvents[K]>[0]>;
  waitFor(event: string | symbol, opts?: WaitForOptions): Promise<any>;

  /**
   * Lightweight synchronous snapshot for `/health` endpoints and dashboards.
   * Cheap to call and safe before `start()`.
   */
  health(): HealthSnapshot;

  /** Latest peer list as broadcast by the hub. */
  getPeers(): PeerInfo[];

  /** Latest known status for a peer of the given kind, or null. */
  getPeerStatus(kind: string): PeerStatus | null;

  /**
   * Subscribe a handler to a topic. Multiple handlers per topic are allowed
   * and share a single hub-side subscription. Subscribing while disconnected
   * is fine - the subscription is tracked locally and replayed automatically
   * on every `'ready'` transition.
   *
   * Self-delivery is OFF in v0.4: the publisher does not receive its own
   * message even if subscribed.
   *
   * Throws synchronously if the topic name is invalid.
   */
  subscribe<TPayload = unknown>(topic: string, handler: TopicHandler<TPayload>): void;

  /**
   * Remove a handler from a topic. With `handler` omitted, removes all
   * handlers for the topic. Returns true if anything was removed locally.
   * The hub-side subscription is dropped only when the last handler for the
   * topic is removed.
   */
  unsubscribe(topic: string, handler?: TopicHandler<any>): boolean;

  /**
   * Publish to a topic. At-most-once: throws synchronously if the link is
   * disconnected/not-ready or the hub doesn't support topics. Returns
   * `false` if the message was dropped due to local backpressure (in which
   * case `'backpressure'` was emitted), `true` if it was sent.
   */
  publish<TPayload = unknown>(topic: string, payload: TPayload): boolean;

  on<K             extends keyof LinkClientEvents>(event: K, listener: LinkClientEvents[K])             : this;
  once<K           extends keyof LinkClientEvents>(event: K, listener: LinkClientEvents[K])             : this;
  off<K            extends keyof LinkClientEvents>(event: K, listener: LinkClientEvents[K])             : this;
  addListener<K    extends keyof LinkClientEvents>(event: K, listener: LinkClientEvents[K])             : this;
  removeListener<K extends keyof LinkClientEvents>(event: K, listener: LinkClientEvents[K])             : this;
  emit<K           extends keyof LinkClientEvents>(event: K,  ...args: Parameters<LinkClientEvents[K]>) : boolean;

  on(            event: string | symbol, listener: (...args: any[]) => void) : this;
  once(          event: string | symbol, listener: (...args: any[]) => void) : this;
  off(           event: string | symbol, listener: (...args: any[]) => void) : this;
  addListener(   event: string | symbol, listener: (...args: any[]) => void) : this;
  removeListener(event: string | symbol, listener: (...args: any[]) => void) : this;
  emit(          event: string | symbol,  ...args: any[])                    : boolean;
}

/** @deprecated Use `LinkClient`. The `LinkBusClient` name is kept as an alias in v0.4.x and will be removed in v0.5.0. */
export const LinkBusClient: typeof LinkClient;

/** @deprecated Use `LinkClientOptions`. */
export type LinkBusClientOptions = LinkClientOptions;

/** @deprecated Use `LinkClientEvents`. */
export type LinkBusClientEvents = LinkClientEvents;

/**
 * The hub's `secret` option accepts three shapes:
 *
 *   - `string`              - shared-secret mode. Every peer signs and
 *                             verifies with the same key. Back-compat
 *                             with v0.3.x.
 *   - `Record<kind, string>` - per-peer keys via static map. The hub
 *                             rejects helloes from any kind not in the
 *                             map (silent drop; pre-hello timeout reaps
 *                             the socket).
 *   - `(kind) => string`    - per-peer keys via dynamic resolver. Async
 *                             allowed; returning `null`/`undefined`/empty
 *                             string is "no key for that kind".
 *
 * In per-peer modes, the hub becomes a re-signing relay: incoming messages
 * are verified with the sender's key, outgoing forwards are re-signed with
 * each recipient's key.
 */
export type HubSecretResolver =
  | string
  | Record<string, string>
  | ((kind: string) => string | null | undefined | Promise<string | null | undefined>);

/** Snapshot returned by `hub.health()`. */
export interface HubHealthSnapshot {
  /** Authenticated peers (post-hello). */
  peerCount: number;
  /** Sockets connected but not yet through the hello handshake. */
  pendingSocketCount: number;
  /** Distinct topics with at least one subscriber. */
  topicCount: number;
  /** Sum of subscribers across all topics (counts the same kind once per topic). */
  totalSubscribers: number;
  /** Size of the recent-id replay-protection cache. */
  recentIdsSize: number;
  /** Number of peers with a remembered last-status. */
  statusCount: number;
}

export interface CreateHubOptions {
  /** See `HubSecretResolver`. Required. */
  secret: HubSecretResolver;
  rpcHandlers?: Record<string, RpcHandler>;
  logger?: Logger | null;

  /** Keep-alive ping interval in ms (post-hello sockets only). Default: 15000. */
  keepaliveIntervalMs?: number;

  /** Replay-protection window in ms. Set to 0 to disable. Default: 300000. */
  replayWindowMs?: number;

  /** Max recent message ids to remember. Default: 10000. */
  maxRecentIds?: number;

  /**
   * Defensive in-handler size check. Note: `createHub` is transport-agnostic
   * and cannot configure the WebSocket transport's `maxPayload` itself - set
   * that on your `WebSocketServer` directly. (`createHubServer` does this for
   * you.)
   */
  maxMessageBytes?: number;

  /**
   * Cap on a peer's `ws.bufferedAmount` before sends to that peer are dropped.
   * Per-peer, so a single slow consumer doesn't block fan-out to others.
   * Drops are logged. RPC forwards return an error response to the original
   * caller. Default: 4194304 (4 MiB).
   */
  maxBufferedBytes?: number;

  /**
   * Time after a socket connects to wait for a successful `hello` before
   * closing it. Defends against pre-hello DoS (a TCP client that opens a
   * socket and never speaks). Set to 0 to disable. Default: 10000.
   */
  helloTimeoutMs?: number;

  /**
   * HMAC hash algorithm for sign/verify. Must match the clients.
   * Default: `'sha256'`.
   */
  hashAlgo?: string;
}

export interface HubState {
  peers      : PeerInfo[];
  lastStatus : Record<string, { status: unknown; at: number }>;
}

/**
 * Typed event payloads emitted by `Hub`. All are observability-only -
 * dropping all listeners cannot break message delivery.
 *
 * The hub never emits the bare EventEmitter `'error'` event (which would
 * crash the process if unhandled). Use `'protocol-error'` for dropped
 * messages and the typed payloads for everything else.
 */
export interface HubEvents {
  /** A peer completed the hello handshake and joined the hub. */
  'peer.connect': (info: {
    kind:        string;
    hello:       unknown | null;
    connectedAt: number;
    replaced:    boolean;
  }) => void;

  /** A peer's WebSocket closed (or the hub force-closed it). */
  'peer.disconnect': (info: {
    kind:        string;
    hello:       unknown | null;
    connectedAt: number | null;
    code?:       number;
    reason:      string;
  }) => void;

  /** A new socket completed hello with the same kind as an existing peer; the old socket was closed. */
  'peer.replaced': (info: {
    kind:      string;
    prevHello: unknown | null;
    newHello:  unknown | null;
  }) => void;

  /** A pre-hello socket exceeded `helloTimeoutMs` and was force-closed. */
  'peer.timeout': (info: {
    remoteAddress: string | null;
    helloTimeoutMs: number;
  }) => void;

  /** A message was dropped at the hub. See `HubProtocolErrorReason` for the catalog. */
  'protocol-error': (info: HubProtocolErrorInfo) => void;

  /** A peer subscribed to a topic for the first time. */
  'topic.subscribe': (info: { kind: string; topic: string }) => void;

  /** A peer unsubscribed from a topic. */
  'topic.unsubscribe': (info: { kind: string; topic: string }) => void;

  /** A peer published to a topic. Fires regardless of subscriber count. */
  'topic.publish': (info: {
    from:            string;
    topic:           string;
    payload:         unknown;
    subscriberCount: number;
    delivered?:      number;
  }) => void;

  /** An rpc.request was forwarded to its target peer. */
  'rpc.forwarded': (info: {
    id:      string;
    from:    string;
    to:      string;
    rpcType: string;
  }) => void;

  /** An rpc.response was forwarded back to the caller. */
  'rpc.response.forwarded': (info: {
    id:   string;
    from: string;
    to:   string;
    ok:   boolean;
  }) => void;

  /** A `to: 'server'` RPC was handled directly by the hub. */
  'rpc.server': (info: {
    id:        string;
    from:      string;
    rpcType:   string;
    ok:        boolean;
    error?:    string;
    durationMs: number;
  }) => void;

  /** A directed message was forwarded to its target peer. */
  'direct': (info: {
    from: string;
    to:   string;
    type: string;
    data: unknown;
  }) => void;

  /** A send to a peer was dropped due to backpressure on that peer's socket. */
  'backpressure': (info: {
    kind:             string;
    type:             string;
    to?:              string | null;
    bufferedAmount:   number;
    maxBufferedBytes: number;
  }) => void;

  /** Power-user firehose: every verified message that reached the hub. */
  'message': (info: { from: string | null; msg: MessageEnvelope }) => void;
}

export interface Hub extends EventEmitter {
  attach(ws: WsWebSocket, req?: IncomingMessage) : void;
  getState()                                     : HubState;
  health()                                       : HubHealthSnapshot;
  stop()                                         : void;

  on<K             extends keyof HubEvents>(event: K, listener: HubEvents[K])             : this;
  once<K           extends keyof HubEvents>(event: K, listener: HubEvents[K])             : this;
  off<K            extends keyof HubEvents>(event: K, listener: HubEvents[K])             : this;
  addListener<K    extends keyof HubEvents>(event: K, listener: HubEvents[K])             : this;
  removeListener<K extends keyof HubEvents>(event: K, listener: HubEvents[K])             : this;
  emit<K           extends keyof HubEvents>(event: K,  ...args: Parameters<HubEvents[K]>) : boolean;

  on(            event: string | symbol, listener: (...args: any[]) => void) : this;
  once(          event: string | symbol, listener: (...args: any[]) => void) : this;
  off(           event: string | symbol, listener: (...args: any[]) => void) : this;
  addListener(   event: string | symbol, listener: (...args: any[]) => void) : this;
  removeListener(event: string | symbol, listener: (...args: any[]) => void) : this;
  emit(          event: string | symbol,  ...args: any[])                    : boolean;
}

export function createHub(options: CreateHubOptions): Hub;

export type HttpRouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => void | Promise<void>;

export interface CreateHubServerOptions extends CreateHubOptions {
  /** Bind interface. Default: '0.0.0.0'. Ignored if `server` is provided. */
  host?: string;

  /** Bind port. Default: 8080. Ignored if `server` is provided. */
  port?: number;

  /**
   * Restrict WebSocket upgrades to this path. Strongly recommended when
   * passing your own `server`.
   */
  path?: string;

  /** Bring your own HTTP server. Disables internal listen + default routes. */
  server?: HttpServer;

  /** Custom HTTP routes by pathname. Wins over /health and /state defaults. */
  routes?: Record<string, HttpRouteHandler>;

  /**
   * Adds GET /health → `{ ok, now, hub: hub.health() }`. Default: true.
   * Ignored when `server` is provided. The `hub` field was added in v0.4.x
   * (see `HubHealthSnapshot`).
   */
  enableHealthRoute?: boolean;

  /** Adds GET /state → `getState()` + extraState(). Default: true. Ignored when `server` is provided. */
  enableStateRoute?: boolean;

  /**
   * Function returning extra fields for /state. Keys colliding with
   * `peers`/`lastStatus` are dropped with a warning (since v0.3.2).
   */
  extraState?: () => unknown | Promise<unknown>;

  /** Install SIGINT/SIGTERM handlers. Default: true. */
  handleSignals?: boolean;

  /** Which signals to handle. Default: ['SIGINT', 'SIGTERM']. */
  signals?: NodeJS.Signals[];

  /** Hard cap on shutdown duration in ms. Default: 30000. */
  shutdownTimeoutMs?: number;

  /** Time between asking clients to close and force-terminating. Default: 250. */
  drainDelayMs?: number;

  /** Async callback run at the end of shutdown, after sockets and HTTP are closed. */
  onShutdown?: () => void | Promise<void>;

  /**
   * Pass-through to the underlying `ws` `WebSocketServer`. `false` (default)
   * disables compression. `true` accepts the library defaults; pass an
   * options object to control window bits, threshold, etc.
   *
   * Off by default because permessage-deflate has a history of
   * memory-amplification CVEs against malicious clients; enable only on
   * trusted networks.
   */
  perMessageDeflate?: WsServerOptions['perMessageDeflate'];
}

export interface HubServer {
  hub                      : Hub;
  httpServer               : HttpServer;
  wss                      : WebSocketServer;
  start()                  : Promise<void>;
  stop(reason?: string)    : Promise<void>;
  getState()               : HubState;
  /** Convenience pass-through to `hub.health()`. */
  health()                 : HubHealthSnapshot;
  readonly isStarted       : boolean;
  readonly isStopping      : boolean;
  readonly isOwnHttpServer : boolean;
}

export function createHubServer(options: CreateHubServerOptions): HubServer;