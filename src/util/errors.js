'use strict';

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
    super(message, { ...opts, code: 'RPC_REMOTE' });
    this.name = 'RpcRemoteError';
  }
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

class FeatureUnsupportedError extends LinkError {
  constructor(message, opts = {}) {
    super(message, { ...opts, code: 'FEATURE_UNSUPPORTED' });
    this.name = 'FeatureUnsupportedError';
    if (opts.feature != null) this.feature = opts.feature;
    if (opts.op      != null) this.op      = opts.op;
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

module.exports = {
  RpcError,
  LinkError,
  RpcAbortError,
  ProtocolError,
  RpcRemoteError,
  RpcTimeoutError,
  BackpressureError,
  LinkNotReadyError,
  RpcDisconnectError,
  HelloRejectedError,
  FeatureUnsupportedError,
};
