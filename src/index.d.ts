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
  v    : number;
  id   : string;
  ts   : number;
  type : string;
  from : string | null;
  to   : string | null;
  data : TData;
  sig  : string;
}

/**
 * The link-core logger contract: four level methods, each called as
 * `(context, message, ...args)`.
 *
 * Anything passed as a `logger` option is adapted internally, so you may
 * also pass a bare `console`, a minimal `{ log, warn }` object, or a
 * pre-v0.5 `{ l, lD, lW, lE }` logger. Pass `null` to silence all output;
 * omit the option to use the default console-based logger.
 *
 * `createLogger()` from `@presenc3/link-helpers` returns an object that
 * already satisfies this interface.
 */
export interface Logger {
  debug(context: string, message?: unknown, ...args: unknown[]): void;
  info(context:  string, message?: unknown, ...args: unknown[]): void;
  warn(context:  string, message?: unknown, ...args: unknown[]): void;
  error(context: string, message?: unknown, ...args: unknown[]): void;
}

/** A peer description as it appears in `peers.update` and `getState()`. */
export interface PeerInfo {
  kind        : string;
  hello       : unknown | null;
  connectedAt : number  | null;
  connected   : boolean;
}

/** A peer's last-known status as remembered by the hub. */
export interface PeerStatus {
  status : unknown;
  at     : number;
}

/**
 * RPC handler signature. The hub-side `rpcHandlers` and client-side
 * `rpcHandlers` use the same shape: `(rpcData, msg, ctx) => result`.
 *
 * For server-side handlers, `msg.from` is guaranteed to be the authenticated
 * socket's bound `kind` (since v0.3.2) - safe to use for authorization.
 *
 * Client-side handlers also receive a third argument `ctx` carrying an
 * `AbortSignal` (since v0.6). The signal fires if the original caller
 * cancels the RPC - the hub relays a best-effort `rpc.cancel` - or if the
 * handling link is torn down. Reading it is optional: a handler that
 * ignores `ctx` behaves exactly as before. A handler that honours it can
 * pass `ctx.signal` to AbortSignal-aware APIs (`fetch`, timers, streams)
 * to bail out of work whose response can no longer be delivered. The hub's
 * own server-side handlers are not currently passed a `ctx`.
 */
export type RpcHandler<TIn = any, TOut = any> = (
  data : TIn,
  msg  : MessageEnvelope<{ rpcType: string; rpcData: TIn }>,
  ctx ?: { signal: AbortSignal },
) => Promise<TOut> | TOut;

/**
 * Build a fully-formed signed envelope. `v` defaults to PROTOCOL_VERSION,
 * `ts` defaults to Date.now(), `from` and `to` default to null. `data` is
 * deep-cloned via `structuredClone` so the caller may freely mutate the input
 * after the call without affecting the returned envelope or the bytes that
 * eventually go on the wire (so it must at minimum be cloneable: functions
 * and DOM nodes throw here).
 *
 * The envelope travels as JSON, and the signature covers exactly the JSON
 * projection of `data` (`toJSON()` honored, boxed primitives unwrapped) -
 * so signing and verification are always consistent, but `data` should be
 * JSON-representable if you want it to *arrive* meaning what you sent.
 * Values with lossy JSON projections - `Map`/`Set` (become `{}`),
 * `Uint8Array` (becomes an index-keyed object), `NaN`/`Infinity` (become
 * `null`) - ship as that projection. `makeMsg` is the low-level primitive
 * and does not reject them; the high-level `send()`/`publish()`/`rpc()`
 * APIs validate payloads and throw on lossy values instead. If you need
 * to send something exotic, serialize it yourself (e.g. binary to a
 * base64 string) before calling.
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
    /**
     * When `false`, `makeMsg` does NOT take a defensive `structuredClone`
     * of `data` and stores the reference directly in the envelope.
     * Defaults to `true`. Pass `false` only when the caller already owns
     * an exclusive snapshot of `data` (nothing else can mutate it) - it
     * is an internal hot-path optimisation, not something most callers
     * need.
     */
    clone?: boolean;
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

/**
 * Deterministic JSON stringifier with sorted keys. Used for stable signing.
 *
 * Mirrors `JSON.stringify` for top-level values: returns `undefined` (not
 * the string `"undefined"`) when the value can't be represented in JSON -
 * i.e. when the input is itself `undefined`, a function, or a symbol.
 * Recursive non-serializable values throw `TypeError`. Same `toJSON()`
 * support, sorted-keys for objects, `null` for non-serializable array
 * slots.
 */
export function stableStringify(obj: unknown): string | undefined;

/**
 * Throw a `TypeError` if `value` cannot be placed on the JSON wire *with
 * its meaning intact*.
 *
 * Rejects, with a path-bearing message:
 *   - `BigInt` and circular structures (JSON.stringify throws at send time)
 *   - non-finite numbers (`NaN` / `Infinity` serialize to `null`)
 *   - `Map`, `Set`, `RegExp`, `Error`, `Promise` (serialize to `{}`)
 *   - `ArrayBuffer`, typed arrays, `DataView` (binary does not survive JSON)
 *
 * An object with `toJSON()` is validated through its `toJSON()` output,
 * exactly as `JSON.stringify` will use it - so a `Date` passes (it ships
 * as a meaningful ISO string). `undefined`, functions, and symbols are
 * NOT rejected: JSON omits them from objects (nulls them in arrays),
 * the long-standing convention for optional fields.
 */
export function assertJsonSerializable(value: unknown, label?: string): void;

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
  payload : TPayload,
  msg     : MessageEnvelope<{ topic: string; payload: TPayload }>,
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
 *   - `clock-skew`         - client-only: signature-valid messages were
 *                            dropped for being outside the replay window;
 *                            the `skew` field carries the last observed
 *                            skew in ms. Almost always an unsynced clock.
 *   - `keepalive-timeout`  - client-only: the hub did not answer a
 *                            liveness ping within `keepaliveIntervalMs`;
 *                            the socket is being terminated to reconnect.
 *   - `rpc-response-mismatch` - client-only: an `rpc.response` arrived
 *                            whose `from` did not match the peer the RPC
 *                            was sent to; the response was dropped.
 *   - `bad-hello`          - hub-only: hello arrived with a missing,
 *                            oversized, pattern-failing, or reserved
 *                            `kind`. The `detail` field disambiguates:
 *                            `'missing-kind'`, `'oversized-kind'`,
 *                            `'invalid-kind'`, or `'reserved-kind'`
 *                            (`__proto__` / `constructor` / `prototype` /
 *                            `server`).
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
  | 'clock-skew'
  | 'keepalive-timeout'
  | 'rpc-response-mismatch'
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
  | 'no-ack'
  | 'clock-skew'
  | 'keepalive-timeout'
  | 'rpc-response-mismatch';

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
  reason:  ProtocolErrorReason;
  type?:   string;
  msg?:    MessageEnvelope;
  size?:   number;
  skew?:   number;
  detail?: string;
  error?:  Error;
}

/** Client-emitted `'protocol-error'` payload. `kind` is never present. */
export interface ClientProtocolErrorInfo extends ProtocolErrorInfoBase {
  reason: ClientProtocolErrorReason;
}

/** Hub-emitted `'protocol-error'` payload. `kind` is the authenticated
 *  kind on the offending socket, or `null` if the socket hadn't completed
 *  hello yet.
 *
 *  When `reason === 'bad-hello'`, `detail` narrows to one of
 *  `'missing-kind' | 'oversized-kind' | 'invalid-kind' | 'reserved-kind'`.
 *  For all other reasons, `detail` is absent. */
export interface HubProtocolErrorInfo extends ProtocolErrorInfoBase {
  reason : HubProtocolErrorReason;
  kind   : string | null;
  detail?: 'missing-kind' | 'oversized-kind' | 'invalid-kind' | 'reserved-kind';
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
  | 'RPC_HANDLER_ERROR'
  | 'RPC_UNKNOWN_TYPE'
  | 'RPC_BAD_REQUEST'
  | 'RPC_NO_TARGET'
  | 'RPC_TARGET_UNAVAILABLE'
  | 'RPC_RESULT_NOT_SERIALIZABLE'
  | 'RPC_FORBIDDEN'
  | 'PUBLISH_FORBIDDEN'
  | 'SUBSCRIBE_FORBIDDEN'
  | 'SEND_FORBIDDEN'
  | 'BACKPRESSURE'
  | 'PROTOCOL_ERROR'
  | 'HELLO_REJECTED'
  | 'LINK_NOT_READY'
  | 'FEATURE_UNSUPPORTED'
  | (string & {});

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
  to?:      string;
  rpcType?: string;
  id?:      string;
  constructor(message: string, opts?: {
    code?:    LinkErrorCode;
    to?:      string;
    rpcType?: string;
    id?:      string;
  });
}

/** `rpc()` did not receive a response within `timeoutMs`. */
export class RpcTimeoutError extends RpcError {
  code:       'RPC_TIMEOUT';
  timeoutMs?: number;
  constructor(message: string, opts?: {
    to?:        string;
    rpcType?:   string;
    id?:        string;
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
 * a missing destination peer, or an unknown rpcType).
 *
 * By default remote handler errors are *sanitized*: a plain `Error` thrown
 * by a handler arrives here only as a generic `"Internal handler error"`
 * with `code === 'RPC_HANDLER_ERROR'`. When the remote handler throws an
 * `RpcHandlerError` (its deliberate, caller-facing channel), the original
 * `message`, `code`, and `data` are forwarded and surfaced here verbatim.
 * Hub-generated failures carry their own codes (`RPC_NO_TARGET`,
 * `RPC_BAD_REQUEST`, `RPC_TARGET_UNAVAILABLE`).
 *
 * Useful primarily for `instanceof` discrimination against transport-level
 * errors - code that retries on `RpcTimeoutError`/`RpcDisconnectError`
 * should generally NOT retry on `RpcRemoteError`, since the failure is the
 * remote's, not the link's.
 */
export class RpcRemoteError extends RpcError {
  /** The remote-supplied code when present, otherwise `'RPC_REMOTE'`. */
  code: LinkErrorCode;
  /** Structured detail forwarded by a remote `RpcHandlerError`, if any. */
  data?: unknown;
}

/**
 * Thrown *inside* an RPC handler to deliberately send a structured,
 * caller-visible error. Unlike a plain `Error` (which is sanitized to a
 * generic message before it leaves the process), an `RpcHandlerError` is
 * forwarded verbatim: its `message`, `code`, and `data` arrive on the
 * caller side as a matching `RpcRemoteError`.
 *
 * Works in both `LinkClient` `rpcHandlers` and hub `rpcHandlers`.
 */
export class RpcHandlerError extends RpcError {
  /** Always `true` - marks the error as intentionally caller-facing. */
  readonly expose: true;
  /** Application-defined code; defaults to `'RPC_HANDLER_ERROR'`. */
  code: LinkErrorCode;
  /** Optional structured detail forwarded to the caller alongside `message`. */
  data?: unknown;
  constructor(message: string, opts?: {
    code?:    LinkErrorCode;
    data?:    unknown;
    to?:      string;
    rpcType?: string;
    id?:      string;
  });
}

/**
 * Local `ws.bufferedAmount` exceeded the configured cap; the message was
 * dropped (or the RPC rejected synchronously). Carries `err.code === 'BACKPRESSURE'`
 * for stable duck-typing across package boundaries.
 */
export class BackpressureError extends LinkError {
  code:             'BACKPRESSURE';
  type?:             string;
  to?:               string;
  rpcType?:          string;
  id?:               string;
  bufferedAmount?:   number;
  maxBufferedBytes?: number;
  constructor(message: string, opts?: {
    type?:             string;
    to?:               string;
    rpcType?:          string;
    id?:               string;
    bufferedAmount?:   number;
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
  op?:   string;
  constructor(message: string, opts?: { op?: string });
}

/**
 * Thrown synchronously by feature-gated methods (`publish()` requires
 * `'topics'`, `send()` requires `'direct'`) when the connected hub does
 * not advertise the required capability. `feature` is the missing
 * feature name; `op` is the caller-side operation that needed it.
 *
 * Fires loud against a hub whose `hello.ack` did not advertise the
 * capability (including an ack with no feature list at all, which the
 * client treats as "no features"): a publish/send call must not silently
 * disappear into a hub that won't act on it. While features are still
 * *unknown* - connected but no ack yet - feature-dependent sends queue
 * rather than throw; readiness (and with it the feature list) arrives
 * with the ack.
 */
export class FeatureUnsupportedError extends LinkError {
  code:     'FEATURE_UNSUPPORTED';
  feature?:  string;
  op?:       string;
  constructor(message: string, opts?: { feature?: string; op?: string });
}

/**
 * A message was rejected by signature, version, replay, or size checks.
 * Mostly emitted via the `'protocol-error'` event today; this class is
 * available for callers that need to throw rather than emit.
 */
export class ProtocolError extends LinkError {
  code:    'PROTOCOL_ERROR';
  reason?:  ProtocolErrorReason;
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
  code:    'HELLO_REJECTED';
  reason?:  string | null;
  constructor(message: string, opts?: { reason?: string | null });
}

export interface LinkClientOptions {
  /**
   * Hub WebSocket URL, e.g. `ws://localhost:8080`. Optional: if omitted
   * (or `secret`/`kind` are omitted), `start()` becomes a no-op and logs
   * a `disabled (missing url/secret/kind)` warning. This is useful in
   * service templates that share a code path between a "real" run and a
   * "no link bus" local dev mode driven by env vars.
   */
  url?:    string;
  /**
   * The HMAC secret this client signs with and verifies the hub's messages
   * against. In shared-secret deployments this is the same string for every
   * peer. In per-peer-keys deployments this is THIS peer's key only - the
   * client never sees other peers' keys; the hub re-signs each fan-out
   * with the recipient's key. Optional - see the `url` note above for the
   * "disabled if missing" behavior.
   */
  secret?: string;
  /**
   * Service-type identifier; e.g. `'worker'`. Singleton per hub. Must
   * match `[a-zA-Z0-9._-]+`, length 1–256 (same character class as
   * topics), and must not be a reserved kind (`server`, `__proto__`,
   * `constructor`, `prototype`). The constructor throws a `TypeError` on
   * violation - the same rules the hub enforces at hello time, applied at
   * boot so a bad configured kind fails loudly instead of reconnect-looping
   * against the hub's `'bad-hello'` rejection forever. Optional - see the
   * `url` note above for the "disabled if missing" behavior.
   */
  kind?:   string;
  /** Human-readable instance name. Defaults to `kind`. */
  name?:  string;

  /** Called on connect and every `statusIntervalMs`; return is sent as `status.update`. */
  makeStatus?: () => unknown;

  /**
   * Map of `rpcType` > handler for incoming RPC requests. Every value
   * must be a function; the constructor throws a `TypeError` otherwise
   * (the same contract `handle()` enforces at runtime).
   */
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
   * Time after `open` to wait for readiness (the hub's `hello.ack`) before
   * emitting a diagnostic `protocol-error`. The warning distinguishes the
   * three "connected but never ready" causes: nothing verified (likely a
   * secret/hashAlgo mismatch), signature-valid traffic dropped by the
   * replay window (clock skew), or traffic verified but no `hello.ack`
   * ever sent (a pre-v0.4 or non-conforming hub - the client only becomes
   * ready on the ack). Set to 0 to disable. Default: 5000.
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
   * Soft cap on `ws.bufferedAmount`. At or below this, outbound messages are
   * written to the socket immediately; above it, they are queued in the
   * outbox (see `maxOutboxBytes`) and drained as the socket catches up.
   * Messages are never dropped for crossing this cap - it only decides
   * "write now" vs "queue and drain". Default: 4194304 (4 MiB).
   */
  maxBufferedBytes?: number;

  /**
   * Hard cap, in bytes, on the outbound queue (outbox) - the buffer that
   * holds messages while the socket is congested or the link is
   * reconnecting. Queued messages drain automatically once the link is
   * healthy again. Reaching this cap is the *only* condition under which an
   * outbound message is refused: `send()`/`publish()` return `false` and an
   * `'outbox-overflow'` event fires (a loud signal, never a silent drop);
   * `rpc()` rejects with `BackpressureError`. Default: 16777216 (16 MiB).
   */
  maxOutboxBytes?: number;

  /**
   * Default budget, in ms, for `stop()`'s graceful drain (flush the outbox,
   * let in-flight RPCs settle, wait for the socket buffer to empty) before
   * the socket is force-closed. Overridable per call via
   * `stop({ timeoutMs })`. Default: 5000.
   */
  stopDrainMs?: number;

  /**
   * Maximum number of consecutive failed reconnection attempts before the
   * client gives up, emits `'reconnect-exhausted'`, and stops. `Infinity`
   * (the default) means reconnect forever - usually correct for a service
   * mesh, where the hub may be briefly down for a deploy. The counter
   * resets to 0 every time the link reaches `'ready'`. Default: `Infinity`.
   */
  maxReconnectAttempts?: number;

  /**
   * `EventEmitter` max-listeners cap for this client. Raised from Node's
   * default of 10 because the observability and event-recorder helpers each
   * attach several listeners before any application code does. `0` disables
   * the cap (per Node's convention). Default: 100.
   */
  maxListeners?: number;

  /**
   * Maximum number of inbound RPC handlers (`rpcHandlers`) allowed to run
   * concurrently. Once this many are in flight, further `rpc.request`
   * messages are rejected immediately - the caller receives an
   * `RpcRemoteError` with `code: 'RPC_OVERLOADED'` - instead of spawning
   * unbounded handler work. `0` disables the cap. Default: 256.
   */
  maxConcurrentRpc?: number;

  /**
   * Application-level liveness watchdog interval, in milliseconds. The
   * client pings the hub every `keepaliveIntervalMs`; if a ping goes
   * unanswered for a full interval the connection is treated as dead and
   * the socket is terminated, triggering the normal reconnect path. This
   * detects a wedged hub or a half-open connection that the OS-level TCP
   * keepalive would otherwise take hours to notice. `0` disables the
   * watchdog. Default: 30000.
   */
  keepaliveIntervalMs?: number;

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
   *   - `true`  - close the socket and keep reconnecting with the normal
   *     backoff (and subject to `maxReconnectAttempts`). Each `rejected`
   *     event fires per attempt. Useful only if the hub's key registry is
   *     expected to change while the client is running (e.g. the operator
   *     hot-rotates a key into the resolver).
   */
  reconnectOnRejection?: boolean;

  /**
   * Controls how errors thrown by this client's `rpcHandlers` are reported
   * to the remote caller.
   *   - `false` (default) - sanitize. A plain `Error` from a handler reaches
   *     the caller only as a generic "Internal handler error"; the real
   *     error is logged and emitted on `'rpc.handler-error'`. Throw an
   *     `RpcHandlerError` to deliberately forward a message/code/data.
   *   - `true` - forward every handler error's message verbatim. Convenient in trusted/internal deployments;
   *     avoid it where an RPC caller is not fully trusted, since handler
   *     error messages can leak internal detail.
   */
  exposeRpcErrors?: boolean;
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
   * The hub accepted our hello: a successful `hello.ack` arrived. Since
   * v0.6.0 this is strictly the *only* trigger - a verified non-ack frame
   * no longer marks the client ready (the previous v0.3.x-hub
   * compatibility behavior could flip readiness before the hub's feature
   * list was known and destroy queued feature-dependent messages). At
   * this point the reconnect backoff is reset, locally-tracked
   * subscriptions have been replayed to the hub, and the status-push
   * timer is armed. This is the gate for `publish()` / `send()` / `rpc()`.
   *
   * `features` is the capability list announced by the hub in the
   * `hello.ack` (e.g. `['topics','direct']`); an empty array if the ack
   * advertised none. It is always a real array here - readiness and the
   * feature list arrive together.
   */
  'ready':           (info: { kind: string; features: string[] }) => void;

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
   * WebSocket has closed. `willReconnect` is false after `stop()`, after a
   * hello rejection when `reconnectOnRejection` is the default `false`, and
   * when the link was *displaced* (see `displaced`). `wasReady` indicates
   * whether the link reached the `'ready'` state during this connection.
   *
   * `displaced` is `true` when the hub closed this socket because another
   * connection authenticated as the same `kind`. A displaced link does NOT
   * auto-reconnect (regardless of `reconnectOnRejection` / reconnect
   * settings), since reconnecting would just restart a replacement war
   * between two processes sharing a kind. It almost always indicates a
   * misconfiguration (two instances using one kind).
   */
  'disconnect':      (info: { code?: number; reason: string; willReconnect: boolean; wasReady: boolean; displaced?: boolean }) => void;

  /** A reconnect attempt is scheduled. `attempt` is 1-indexed since last `'ready'`. */
  'reconnecting':    (info: { delayMs: number; attempt: number }) => void;

  /** Underlying WebSocket emitted an error. */
  'ws-error':        (err: Error) => void;

  /** A message was rejected by signature, version, replay, or size checks. */
  'protocol-error':  (info: ClientProtocolErrorInfo) => void;

  /**
   * Power-user firehose: every verified message, post-replay-check.
   * `msg` is a *snapshot* - mutating it cannot alter how the client
   * dispatches the message (RPC settlement, topic fan-in, directs). The
   * snapshot is only taken when at least one listener is attached.
   */
  'message':         (info: { msg: MessageEnvelope; raw: Buffer | string }) => void;

  /** A new peer kind appeared in the latest `peers.update`. */
  'peer.connect':    (peer: PeerInfo) => void;

  /** A peer kind disappeared from the latest `peers.update`. */
  'peer.disconnect': (peer: PeerInfo) => void;

  /**
   * A peer of the same `kind` reconnected with a fresh socket (the hub
   * replaced the old binding mid-flight). Fires *after* the internal
   * `peers` state has been updated, so `link.getPeers()` from inside
   * the handler reflects the new connectedAt. Useful for tearing down
   * per-connection state (cached capabilities probed via hello, etc.)
   * without having to infer replacement from a `disconnect`/`connect`
   * pair that never fires (the kind never leaves the set). Since v0.5.
   */
  'peer.replaced':   (info: { kind: string; prevPeer: PeerInfo; peer: PeerInfo }) => void;

  /** A peer broadcast a status update. */
  'peer.status':     (info: { from: string; status: unknown; at: number }) => void;

  /** An incoming RPC request was received (fires before the handler runs). */
  'rpc.request': (info: {
    from    : string | null;
    rpcType : string;
    rpcData : unknown;
    msg     : MessageEnvelope;
  }) => void;

  /**
   * An inbound RPC this client is *handling* was cancelled by its original
   * caller: the hub relayed a best-effort `rpc.cancel` and the matching
   * in-flight handler's `AbortSignal` has just been fired. Observability
   * only - the handler may still run to completion if it ignores the
   * signal, but its eventual response is suppressed (the caller has
   * already given up). Since v0.6.
   */
  'rpc.cancel': (info: {
    /** The id of the `rpc.request` being cancelled. */
    id      : string;
    /** The peer that issued the original request (and the cancel). */
    from    : string | null;
    /** The cancelled RPC's `rpcType`. */
    rpcType : string;
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
   * 'backpressure'` on failure. `id` and `durationMs` are
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
    reason    : 'timeout' | 'abort' | 'disconnect' | 'not-ready' | 'remote-error' | 'backpressure' | null;
    durationMs: number;
    error     : string | null;
  }) => void;

  /**
   * The socket became congested and an outbound message was queued in the
   * outbox rather than written immediately. Edge-triggered: fires once when
   * the outbox transitions from empty to non-empty, not once per message.
   * The message is *not* dropped (`queued: true`) - it drains automatically
   * and an `'outbox-drained'` event fires when the queue empties again.
   */
  'backpressure': (info: {
    type: string;
    to?: string | null;
    rpcType?: string;
    bufferedAmount: number;
    queued?: boolean;
    outboxSize?: number;
  }) => void;

  /**
   * The outbound queue hit its `maxOutboxBytes` cap and a message was
   * refused. This is the only condition under which an outbound message is
   * not delivered: the corresponding `send()`/`publish()` returned `false`,
   * or `rpc()` rejected with `BackpressureError`.
   */
  'outbox-overflow': (info: {
    type: string;
    to: string | null;
    outboxBytes: number;
    maxOutboxBytes: number;
  }) => void;

  /** The outbound queue finished draining (emptied) after a congestion episode. */
  'outbox-drained': (info: {}) => void;

  /**
   * A queued outbound message could not be serialized (its payload is not
   * structured-cloneable) and was dropped rather than retried forever.
   * Programmer payloads passed to `send` / `publish` / `rpc` are validated
   * up front and throw synchronously instead; this event therefore only
   * fires for internally-generated messages (e.g. a non-cloneable RPC
   * handler result or `makeStatus()` return value).
   */
  'outbox-error': (info: {
    type: string;
    to: string | null;
    id: string;
    error: string;
  }) => void;

  /**
   * The reconnect ceiling (`maxReconnectAttempts`) was reached: the client
   * has given up and stopped, and will not attempt to reconnect again.
   * Only fires when `maxReconnectAttempts` is finite.
   */
  'reconnect-exhausted': (info: {
    attempts: number;
    maxReconnectAttempts: number;
  }) => void;

  /**
   * A local RPC handler (registered via `rpcHandlers` or `handle()`) threw
   * an error that was *not* an `RpcHandlerError` - i.e. an unintended fault.
   * The remote caller received a sanitized "Internal handler error"; this
   * event carries the real error for local logging/metrics. Does not fire
   * when `exposeRpcErrors` is `true`, nor for deliberate `RpcHandlerError`s.
   */
  'rpc.handler-error': (info: {
    rpcType: string;
    from:    string | null;
    id:      string;
    error:   unknown;
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
   * `RpcAbortError` and removes the pending entry.
   *
   * As of v0.6, the client also sends a best-effort `rpc.cancel` to the
   * hub on abort (and on a `timeoutMs` deadline). If the request is still
   * queued for a congested target, the hub drops it before the target
   * ever sees it (the hub fires `'rpc.cancelled'` with `found: true`). If
   * the request was already forwarded, the remote handler still runs to
   * completion as before and its response is logged-and-dropped on
   * arrival - the local rejection is unaffected either way.
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
  /** Messages currently waiting in the outbound queue (outbox). */
  outboxSize: number;
  /** Approximate total bytes held in the outbound queue. */
  outboxBytes: number;
  /** Inbound RPC handlers currently executing (see `maxConcurrentRpc`). */
  inFlightRpc: number;
  /** `stop()` has been called. */
  stopped: boolean;
}

export class LinkClient extends EventEmitter {
  /**
   * The hub URL the client was constructed with, or `undefined` if none
   * was supplied (in which case `start()` is a logged no-op). See
   * `LinkClientOptions.url`.
   */
  readonly url    : string | undefined;
  /** The HMAC secret, or `undefined`. See `LinkClientOptions.secret`. */
  readonly secret : string | undefined;
  /** The peer kind, or `undefined`. See `LinkClientOptions.kind`. */
  readonly kind   : string | undefined;
  readonly name   : string;
  peers           : PeerInfo[];

  /**
   * Capability list announced by the hub in its `hello.ack`. `null` while
   * features are unknown - i.e. until the ack arrives and the client
   * becomes ready (while `null`, feature-dependent sends queue rather
   * than throw). An empty array if the acking hub advertised none. Use to
   * pre-flight feature availability: `link.hubFeatures?.includes('topics')`.
   */
  hubFeatures: string[] | null;

  /**
   * Map of `rpcType` > handler. Initially populated from
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
   * Stop the link. By default this is a *graceful* stop: it flushes the
   * outbound queue, lets in-flight RPCs settle, and waits for the socket's
   * send buffer to empty - all bounded by `opts.timeoutMs` (default: the
   * `stopDrainMs` constructor option) - before closing. Pass
   * `{ drain: false }` for an immediate close that rejects pending RPCs
   * with `RpcDisconnectError` without draining.
   *
   * Always resolves and never rejects: a drain timeout is logged and the
   * socket force-closed anyway. When there is nothing in flight to drain,
   * the close happens synchronously before the returned promise settles,
   * so callers that do not `await` still see an immediate teardown.
   *
   * The client will not auto-reconnect after `stop()`; call `start()` to
   * bring it back up.
   */
  stop(opts?: { drain?: boolean; timeoutMs?: number }): Promise<void>;

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
   *   - `BackpressureError`   - the outbound queue is full (`maxOutboxBytes`).
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
   * `publish()`. Returns `true` if the message was sent or queued in the
   * outbox, `false` only if the outbox is full (an `'outbox-overflow'`
   * event also fires). A not-yet-connected or reconnecting link queues the
   * message rather than failing - it drains once the link is ready. Throws
   * synchronously only for invalid arguments, a disabled or stopped link,
   * or a hub that does not advertise the `'direct'` feature.
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

  /**
   * Latest peer list as broadcast by the hub. The returned array is a
   * defensive deep copy and is safe to mutate.
   *
   * The list **includes the calling client itself**: the hub's
   * `peers.update` is the full membership snapshot, so a v0.5 link with
   * `kind: 'coordinator'` will see a `'coordinator'` entry alongside
   * every other peer. Filter it out client-side
   * (`getPeers().filter((p) => p.kind !== link.kind)`) if you only want
   * "everyone else".
   */
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
   *
   * Throws synchronously if the topic name is invalid (matching
   * `subscribe()` / `publish()`); an invalid topic is a programmer error,
   * not a silent no-op.
   */
  unsubscribe(topic: string, handler?: TopicHandler<any>): boolean;

  /**
   * Publish to a topic. Returns `true` if the message was sent or queued in
   * the outbox, `false` only on outbox overflow (an `'outbox-overflow'`
   * event also fires). A not-yet-connected or reconnecting link queues the
   * message rather than failing. Throws synchronously only for an invalid
   * topic, a disabled or stopped link, or a hub without the `'topics'`
   * feature.
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
 *
 * Call frequency: the resolver runs once per inbound `hello` attempt,
 * including unauthenticated and spoofed ones - the hub must look up the
 * key before it can verify the hello signature. Implementations should
 * cache lookups aggressively (including negative results, with a short
 * TTL) and avoid expensive cache-miss paths; see `SECURITY.md` for the
 * threat-model context.
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
  /** Total bytes currently queued across all per-socket outboxes. */
  outboxBytes: number;
  /** Number of peer sockets with a non-empty outbox (congested consumers). */
  queuedSockets: number;
  /** Hub-handled (`to: 'server'`) RPCs currently executing (see `maxConcurrentRpc`). */
  serverRpcInFlight: number;
}

/**
 * The verdict an ACL callback (`canRpc` / `canPublish` / `canSubscribe` /
 * `canSend`) returns to authorize or reject a hub operation:
 *
 *   - `true`                       - allow
 *   - `false`                      - deny (generic `Forbidden`)
 *   - `{ ok: true }`               - allow
 *   - `{ ok: false, code?, error? }` - deny; `code` / `error` are surfaced
 *                                      to the caller (for RPC) and on the
 *                                      `'acl-denied'` hub event
 *
 * An ACL callback may return the verdict synchronously or as a `Promise`.
 * The gate fails *closed*: any other return value (`undefined`, `null`,
 * ...), or a thrown error, is treated as a denial and logged.
 */
export type HubAclVerdict =
  | boolean
  | { ok: true }
  | { ok: false; code?: string; error?: string };

/** Context passed to {@link CreateHubOptions.canRpc}. */
export interface CanRpcContext {
  /** Authenticated kind of the calling peer. */
  from: string;
  /** RPC destination - a peer kind, or `'server'` for a hub-handled RPC. */
  to: string | null;
  /** The application-defined RPC type. */
  rpcType: string | undefined;
  /** The RPC request payload. */
  rpcData: unknown;
}

/** Context passed to {@link CreateHubOptions.canPublish}. */
export interface CanPublishContext {
  /** Authenticated kind of the publishing peer. */
  from: string;
  /** Topic being published to. */
  topic: string;
  /** The published payload. */
  payload: unknown;
}

/** Context passed to {@link CreateHubOptions.canSubscribe}. */
export interface CanSubscribeContext {
  /** Authenticated kind of the subscribing peer. */
  from: string;
  /** Topic being subscribed to. */
  topic: string;
}

/** Context passed to {@link CreateHubOptions.canSend}. */
export interface CanSendContext {
  /** Authenticated kind of the sending peer. */
  from: string;
  /** Destination peer kind. */
  to: string;
  /** The application-defined directed-message type. */
  type: string;
  /** The directed-message payload. */
  data: unknown;
}

export interface CreateHubOptions {
  /** See `HubSecretResolver`. Required. */
  secret: HubSecretResolver;
  rpcHandlers?: Record<string, RpcHandler>;
  logger?: Logger | null;

  /**
   * Optional authorization gate for peer-to-peer (and `to: 'server'`)
   * RPCs. Runs after the `rpc.request` is verified and the caller's
   * `from` identity is established, before the hub forwards it or hands
   * it to a server handler. A denial sends the caller a structured
   * `rpc.response` error (surfacing as an `RpcRemoteError` whose `code`
   * is the verdict's `code`, defaulting to `'RPC_FORBIDDEN'`) and fires
   * the `'acl-denied'` hub event. Omit for no RPC authorization.
   */
  canRpc?: (ctx: CanRpcContext) => HubAclVerdict | Promise<HubAclVerdict>;

  /**
   * Optional authorization gate for topic publishes. Runs after the
   * `topic.message` is verified and the topic validated, before fan-out.
   * A denial drops the message and fires `'acl-denied'` (publish is
   * fire-and-forget, so there is no caller-facing error). Omit for no
   * publish authorization.
   */
  canPublish?: (ctx: CanPublishContext) => HubAclVerdict | Promise<HubAclVerdict>;

  /**
   * Optional authorization gate for topic subscriptions. Runs after the
   * `topic.subscribe` is verified and the topic validated, before the
   * subscription is recorded. A denial drops the subscribe and fires
   * `'acl-denied'`. Omit for no subscribe authorization.
   */
  canSubscribe?: (ctx: CanSubscribeContext) => HubAclVerdict | Promise<HubAclVerdict>;

  /**
   * Optional authorization gate for directed (`link.send`) messages.
   * Runs after the `direct` message is verified, before it is forwarded
   * to its target. A denial drops the message and fires `'acl-denied'`.
   * Omit for no directed-send authorization.
   */
  canSend?: (ctx: CanSendContext) => HubAclVerdict | Promise<HubAclVerdict>;

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
   * Cap on a peer's `ws.bufferedAmount` before sends to that peer switch
   * from immediate writes to being queued in that peer's outbox. Per-peer,
   * so a single slow consumer doesn't block fan-out to others.
   * Default: 4194304 (4 MiB).
   */
  maxBufferedBytes?: number;

  /**
   * Hard cap, in bytes, on each peer's outbound queue (outbox) - the buffer
   * that holds messages while that peer's socket is congested. Messages
   * drain automatically as the socket catches up; reaching this cap is the
   * only condition under which the hub drops a message (a loud
   * `outbox-overflow` event fires). Default: 16777216 (16 MiB) per socket.
   */
  maxOutboxBytes?: number;

  /**
   * Time after a socket connects to wait for a successful `hello` before
   * closing it. Defends against pre-hello DoS (a TCP client that opens a
   * socket and never speaks). Set to 0 to disable. Default: 10000.
   */
  helloTimeoutMs?: number;

  /**
   * Cap on the number of concurrent un-authenticated (pre-hello) sockets.
   * When exceeded, the oldest pending socket is force-closed (FIFO
   * eviction) and emits `peer.timeout` with `reason: 'pending-cap'`.
   * Defends against attackers opening many TCP connections and never
   * speaking, which would otherwise pin one hello-timeout timer per
   * socket until `helloTimeoutMs` elapsed. Default: 1024. Since v0.5.
   */
  maxPendingSockets?: number;

  /**
   * Maximum number of hub-handled (`to: 'server'`) RPC handlers allowed to
   * run concurrently. Past this many in flight, further server RPCs are
   * rejected with an `RpcHandlerError` carrying `code: 'RPC_OVERLOADED'`.
   * `0` disables the cap. Default: 256.
   */
  maxConcurrentRpc?: number;

  /**
   * HMAC hash algorithm for sign/verify. Must match the clients.
   * Default: `'sha256'`.
   */
  hashAlgo?: string;

  /**
   * Controls how errors thrown by hub-side `rpcHandlers` (server RPCs) are
   * reported to the calling peer. `false` (default) sanitizes: a plain
   * `Error` reaches the caller as a generic "Internal handler error" and
   * the real error stays in the hub log. `true` forwards handler error
   * messages verbatim. Either way, a deliberately-thrown `RpcHandlerError`
   * is always forwarded with its message/code/data intact.
   */
  exposeRpcErrors?: boolean;
}

/**
 * The `getState()` snapshot. Deep-cloned: mutating it (or anything inside
 * it) cannot affect hub state, later broadcasts, or later snapshots.
 */
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

  /**
   * A pre-hello socket was force-closed. Either it exceeded
   * `helloTimeoutMs` without sending a valid `hello`
   * (`reason: 'hello-timeout'`), or it was evicted because the pre-hello
   * pool was already at `maxPendingSockets` when a new connection
   * arrived (`reason: 'pending-cap'`).
   */
  'peer.timeout': (info: {
    remoteAddress: string | null;
    helloTimeoutMs: number;
    reason: 'hello-timeout' | 'pending-cap';
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
    /**
     * Number of *eligible recipients* for the fan-out: peers subscribed to
     * the topic, excluding the publisher itself (self-delivery is off, so
     * the publisher is never a recipient even if it is subscribed).
     *
     * Because of this, `delivered <= subscriberCount` always holds, and
     * `delivered === subscriberCount` on a fully successful fan-out.
     * `delivered` is lower only when a subscriber's socket was unavailable
     * (closed or backpressured to overflow) at send time.
     */
    subscriberCount: number;
    /** Recipients the message was actually queued/sent to. Always present. */
    delivered:       number;
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

  /**
   * An `rpc.cancel` from a caller was processed. Fires whether or not a
   * queued request was actually found: `found` is `true` only when a
   * still-queued `rpc.request` (one sitting in a congested target's
   * outbox) was located and removed. `found: false` is the common case -
   * the request had already been written to the wire, or never queued,
   * or `to` was `'server'` (server RPCs are never queued).
   *
   * When `found` is `false` and the target is still connected, the hub
   * relays the `rpc.cancel` to the target peer so an in-flight handler
   * honouring its `AbortSignal` can bail early; `forwarded` is `true` in
   * that case. `forwarded` is always `false` when the cancel was already
   * satisfied by dropping a queued request, when `to` was `'server'`, or
   * when the target was no longer connected.
   */
  'rpc.cancelled': (info: {
    /** The id of the cancelled `rpc.request`. */
    id:    string;
    /** The peer that issued the cancel (the original caller). */
    from:  string;
    /** The cancelled RPC's destination. */
    to:    string;
    /** True iff a queued request was found and dropped. */
    found: boolean;
    /** True iff the cancel was relayed on to a still-connected target. */
    forwarded: boolean;
  }) => void;

  /**
   * An operation was rejected by one of the ACL callbacks (`canRpc`,
   * `canPublish`, `canSubscribe`, `canSend`). Observability-only - the
   * hub has already dropped the operation (and, for RPC, already replied
   * to the caller with a structured error).
   */
  'acl-denied': (info: {
    /** Which gate denied the operation. */
    op:       'rpc' | 'publish' | 'subscribe' | 'send';
    /** Authenticated kind of the peer whose operation was denied. */
    from:     string;
    /** The verdict's code (e.g. `'RPC_FORBIDDEN'`). */
    code:     string;
    /** The verdict's human-readable reason. */
    error:    string;
    /** Present for `op: 'rpc'` and `op: 'send'`. */
    to?:      string | null;
    /** Present for `op: 'rpc'`. */
    rpcType?: string;
    /** Present for `op: 'publish'` and `op: 'subscribe'`. */
    topic?:   string;
    /** Present for `op: 'send'` (the directed-message type). */
    type?:    string;
  }) => void;

  /**
   * A send to a peer found that peer's socket congested, so the message was
   * queued in that socket's outbox rather than written immediately.
   * Edge-triggered: fires once when the socket's outbox goes from empty to
   * non-empty. The message is not dropped (`queued: true`) - it drains as
   * the socket catches up.
   */
  'backpressure': (info: {
    kind:             string | null;
    type:             string;
    to?:              string | null;
    bufferedAmount:   number;
    maxBufferedBytes: number;
    queued?:          boolean;
    outboxSize?:      number;
  }) => void;

  /**
   * A peer's per-socket outbox hit its `maxOutboxBytes` cap and a message
   * was dropped - the only condition under which the hub still drops. The
   * peer is effectively a dead-slow consumer.
   */
  'outbox-overflow': (info: {
    kind:           string | null;
    type:           string;
    to?:            string | null;
    outboxBytes:    number;
    maxOutboxBytes: number;
  }) => void;

  /**
   * A queued outbound message could not be serialized (non-cloneable
   * payload) and was dropped rather than retried forever. Typically a
   * non-cloneable hub `rpcHandlers` return value.
   */
  'outbox-error': (info: {
    kind:  string | null;
    type:  string;
    to?:   string | null;
    id:    string;
    error: string;
  }) => void;

  /**
   * Power-user firehose: every verified message that reached the hub.
   * `msg` is a *snapshot* - mutating it cannot alter routing or dispatch.
   * The snapshot is only taken when at least one listener is attached.
   */
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

  /**
   * Bind port: an integer in [0, 65535] (0 = pick an ephemeral port).
   * Default: 8080. Ignored if `server` is provided.
   */
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
   * Adds GET /health > `{ ok, now, hub: hub.health() }`. Default: true.
   * Ignored when `server` is provided. The `hub` field was added in v0.4.x
   * (see `HubHealthSnapshot`).
   */
  enableHealthRoute?: boolean;

  /**
   * Adds GET /state > `getState()` + extraState(). **Default: `false`** as
   * of v0.5.0** (previously `true`); /state exposes peer kinds, hello
   * payloads, and last-known statuses, which is fine for an internal
   * dashboard but undesirable on a public bind. Opt in explicitly when
   * you want it. If you opt in *and* bind to `0.0.0.0`, the hub also logs
   * a warning at startup. Ignored when `server` is provided.
   */
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
  /** True while the server is up: latched by `start()` once listening, cleared when `stop()` completes. */
  readonly isStarted       : boolean;
  readonly isStopping      : boolean;
  /** True after `stop()` has fully torn the server down. `createHubServer` is single-shot; once this latches `true`, `start()` will throw. */
  readonly isStopped       : boolean;
  readonly isOwnHttpServer : boolean;
}

export function createHubServer(options: CreateHubServerOptions): HubServer;