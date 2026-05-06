'use strict';

const   protocol     = require('./protocol.js');
const   errors       = require('./util/errors.js');
const { LinkClient } = require('./client/index.js');

const { createHub       } = require('./hub/index.js');
const { createHubServer } = require('./hub/server.js');

module.exports = {
  createHub,
  LinkClient,
  /**
   * @deprecated Use `LinkClient`. The `LinkBusClient` name is kept as an alias
   * in v0.4.x for backwards compatibility and will be removed in v0.5.0.
   */
  LinkBusClient: LinkClient,
  createHubServer,
  sign:             protocol.sign,
  verify:           protocol.verify,
  makeMsg:          protocol.makeMsg,
  isValidTopic:     protocol.isValidTopic,
  stableStringify:  protocol.stableStringify,
  assertValidTopic: protocol.assertValidTopic,
  PROTOCOL_VERSION: protocol.PROTOCOL_VERSION,
  TOPIC_MAX_LENGTH: protocol.TOPIC_MAX_LENGTH,
  DEFAULT_HASH_ALGO: protocol.DEFAULT_HASH_ALGO,

  RpcError:                errors.RpcError,
  LinkError:               errors.LinkError,
  RpcAbortError:           errors.RpcAbortError,
  ProtocolError:           errors.ProtocolError,
  RpcRemoteError:          errors.RpcRemoteError,
  RpcTimeoutError:         errors.RpcTimeoutError,
  BackpressureError:       errors.BackpressureError,
  LinkNotReadyError:       errors.LinkNotReadyError,
  RpcDisconnectError:      errors.RpcDisconnectError,
  HelloRejectedError:      errors.HelloRejectedError,
  FeatureUnsupportedError: errors.FeatureUnsupportedError,
};