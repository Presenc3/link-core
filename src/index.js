'use strict';

const protocol = require('./protocol.js');
const errors   = require('./internal/errors.js');

const { LinkClient } = require('./client/index.js');

const { createHub       } = require('./hub/index.js');
const { createHubServer } = require('./hub/server.js');

const { createLogger, LEVELS                 } = require('./helpers/log.js');
const { loadSecrets,  LOADED_SECRETS_UNWATCH } = require('./helpers/secrets.js');

const {
 num, bool, requireEnv,
 linkClientOptionsFromEnv
} = require('./helpers/env.js');

const {
  waitForPeer,         rpcWithRetry,
  createSafePublisher, createSafeSend,
} = require('./helpers/rpc.js');

const {
  installProcessHandlers, createGracefulShutdown,
} = require('./helpers/lifecycle.js');

const {
  attachClientObservability,         attachHubObservability,
  DEFAULT_CLIENT_CONCERNING_REASONS, DEFAULT_HUB_CONCERNING_REASONS,
} = require('./helpers/observability.js');

const {
  SNAPSHOT_TRIGGERS, createEventRecorder, RECORDED_CLIENT_EVENTS,
} = require('./helpers/event-recorder.js');


module.exports = {
  createHub,
  LinkClient,
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

  num,
  bool,
  LEVELS,
  requireEnv,
  loadSecrets,
  createLogger,
  waitForPeer,
  rpcWithRetry,
  createSafeSend,
  createSafePublisher,
  LOADED_SECRETS_UNWATCH,
  attachHubObservability,
  installProcessHandlers,
  createGracefulShutdown,
  linkClientOptionsFromEnv,
  attachClientObservability,
  DEFAULT_HUB_CONCERNING_REASONS,
  DEFAULT_CLIENT_CONCERNING_REASONS,

  SNAPSHOT_TRIGGERS,
  createEventRecorder,
  RECORDED_CLIENT_EVENTS
};