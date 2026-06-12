'use strict';

const { assertJsonSerializable } = require('../protocol.js');

class LinkError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'LinkError';
    this.code = opts.code || 'LINK_ERROR';
  }
}

class RpcError extends LinkError {
  constructor(message, opts = {}) {
    super(message, opts);
    this.name = 'RpcError';
    this.code = opts.code || 'RPC_ERROR';
    if (opts.to      != null) this.to      = opts.to;
    if (opts.rpcType != null) this.rpcType = opts.rpcType;
    if (opts.id      != null) this.id      = opts.id;
  }
}

class RpcTimeoutError extends RpcError {
  constructor(message, opts = {}) {
    super(message, { ...opts, code: 'RPC_TIMEOUT' });
    this.name = 'RpcTimeoutError';
    if (opts.timeoutMs != null) this.timeoutMs = opts.timeoutMs;
  }
}

class RpcDisconnectError extends RpcError {
  constructor(message, opts = {}) {
    super(message, { ...opts, code: 'RPC_DISCONNECT' });
    this.name = 'RpcDisconnectError';
  }
}

class RpcAbortError extends RpcError {
  constructor(message, opts = {}) {
    super(message, { ...opts, code: 'RPC_ABORT' });
    this.name = 'RpcAbortError';
  }
}

class RpcRemoteError extends RpcError {
  constructor(message, opts = {}) {
    super(message, { ...opts, code: opts.code || 'RPC_REMOTE' });
    this.name = 'RpcRemoteError';
    if (opts.data !== undefined) this.data = opts.data;
  }
}

/**
 * Thrown *inside* an RPC handler to send a structured, caller-visible error.
 *
 * Handler errors are sanitized by default: a plain `Error` thrown from a
 * handler reaches the caller only as a generic "Internal handler error", and
 * the real error is logged/emitted locally. Throwing an `RpcHandlerError`
 * (or setting `expose = true` on any error) is the explicit opt-in that says
 * "this message, code, and data are safe for the caller to see" - they are
 * forwarded verbatim and arrive on the caller side as an `RpcRemoteError`
 * carrying the same `code` and `data`.
 */
class RpcHandlerError extends RpcError {
  constructor(message, opts = {}) {
    super(message, { ...opts, code: opts.code || 'RPC_HANDLER_ERROR' });
    this.name   = 'RpcHandlerError';
    this.expose = true;
    if (opts.data !== undefined) this.data = opts.data;
  }
}

/**
 * Decide what a failed RPC handler should put on the wire.
 *
 * - An `RpcHandlerError`, or any error with `expose === true`, is intentional
 *   and caller-facing: its message, code, and (optional) data are forwarded.
 * - Anything else is treated as an internal fault: the caller receives a
 *   generic message/code and the real error is left for the local side to
 *   log. Pass `exposeAll: true` to forward every error verbatim (opt-out).
 *
 * @param {*} err
 * @param {{ exposeAll?: boolean }} [opts]
 * @returns {{ exposed: boolean, body: { error: string, code: string, data?: * } }}
 */
function rpcErrorResponse(err, opts = {}) {
  const exposed = opts.exposeAll === true
               || (err != null && err.expose === true)
               || err instanceof RpcHandlerError;

  if (exposed) {
    const body = {
      error: (err && err.message != null) ? String(err.message) : String(err),
      code:  (err && err.code != null)    ? String(err.code)    : 'RPC_HANDLER_ERROR',
    };
    if (err && err.data !== undefined) body.data = err.data;
    return { exposed: true, body };
  }

  return {
    exposed: false,
    body: { error: 'Internal handler error', code: 'RPC_HANDLER_ERROR' },
  };
}

/**
 * Take ownership of an exposed RPC error body's `data` for the wire,
 * mirroring exactly the validation a *successful* handler result gets:
 * probe with `structuredClone` *and* the strict JSON walker.
 *
 * Without this, `RpcHandlerError.data` was the one app-supplied value that
 * shipped unvalidated - a `Map` arrived as `{}` (silently changed), and a
 * `BigInt` made the response unserializable at flush time, so it was
 * dropped and the caller received an unrelated `RpcTimeoutError` instead
 * of the deliberate application error. A deliberate remote error must
 * never be transformed into an apparent transport failure.
 *
 * On failure the supplementary `data` is stripped (reported via `onDrop`
 * for a loud local log) while the intentional `error` message and `code`
 * still reach the caller - far better than masking the real failure
 * behind a serialization error, and infinitely better than a timeout.
 *
 * The validated clone is exclusively ours, so the caller can mark the
 * reply `owned`: the outbox skips its defensive clone, and a handler
 * retaining a reference to the thrown error can no longer mutate the
 * response after the fact.
 *
 * @param {{ error: string, code: string, data?: * }} body  mutated in place
 * @param {(err: Error) => void} [onDrop] called when `data` is stripped
 * @returns {{ error: string, code: string, data?: * }} the same body
 */
function ownRpcErrorData(body, onDrop) {
  if (body.data === undefined) return body;

  try {
    const owned = structuredClone(body.data);
    assertJsonSerializable(owned, 'RPC error data');
    body.data = owned;
  } catch (e) {
    delete body.data;
    if (onDrop) { try { onDrop(e); } catch {} }
  }

  return body;
}

class BackpressureError extends LinkError {
  constructor(message, opts = {}) {
    super(message, { ...opts, code: 'BACKPRESSURE' });
    this.name = 'BackpressureError';
    if (opts.bufferedAmount   != null) this.bufferedAmount   = opts.bufferedAmount;
    if (opts.maxBufferedBytes != null) this.maxBufferedBytes = opts.maxBufferedBytes;
    if (opts.type             != null) this.type             = opts.type;
    if (opts.to               != null) this.to               = opts.to;
    if (opts.rpcType          != null) this.rpcType          = opts.rpcType;
    if (opts.id               != null) this.id               = opts.id;
  }
}

class LinkNotReadyError extends LinkError {
  constructor(message, opts = {}) {
    super(message, { ...opts, code: 'LINK_NOT_READY' });
    this.name = 'LinkNotReadyError';
    if (opts.op != null) this.op = opts.op;
  }
}



class ProtocolError extends LinkError {
  constructor(message, opts = {}) {
    super(message, { ...opts, code: 'PROTOCOL_ERROR' });
    this.name = 'ProtocolError';
    if (opts.reason != null) this.reason = opts.reason;
  }
}

class HelloRejectedError extends LinkError {
  constructor(message, opts = {}) {
    super(message, { ...opts, code: 'HELLO_REJECTED' });
    this.name = 'HelloRejectedError';
    if (opts.reason != null) this.reason = opts.reason;
  }
}

class FeatureUnsupportedError extends LinkError {
  constructor(message, opts = {}) {
    super(message, { ...opts, code: 'FEATURE_UNSUPPORTED' });
    this.name = 'FeatureUnsupportedError';
    if (opts.feature != null) this.feature = opts.feature;
    if (opts.op      != null) this.op      = opts.op;
  }
}

module.exports = {
  RpcError,
  LinkError,
  RpcAbortError,
  ProtocolError,
  RpcRemoteError,
  RpcTimeoutError,
  RpcHandlerError,
  rpcErrorResponse,
  ownRpcErrorData,
  BackpressureError,
  LinkNotReadyError,
  RpcDisconnectError,
  HelloRejectedError,
  FeatureUnsupportedError,
};