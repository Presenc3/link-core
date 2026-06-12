'use strict';

const errors = require('./internal/errors.js');

module.exports = {
  RpcError:                errors.RpcError,
  LinkError:               errors.LinkError,
  RpcAbortError:           errors.RpcAbortError,
  ProtocolError:           errors.ProtocolError,
  RpcRemoteError:          errors.RpcRemoteError,
  RpcHandlerError:         errors.RpcHandlerError,
  RpcTimeoutError:         errors.RpcTimeoutError,
  BackpressureError:       errors.BackpressureError,
  LinkNotReadyError:       errors.LinkNotReadyError,
  RpcDisconnectError:      errors.RpcDisconnectError,
  HelloRejectedError:      errors.HelloRejectedError,
  FeatureUnsupportedError: errors.FeatureUnsupportedError,
};