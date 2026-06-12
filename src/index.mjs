import linkCore from './index.js';

export const {
  createHub,
  createHubServer,

  LinkClient,

  sign,
  verify,
  makeMsg,
  isValidTopic,
  stableStringify,
  assertValidTopic,
  assertJsonSerializable,

  PROTOCOL_VERSION,
  TOPIC_MAX_LENGTH,
  DEFAULT_HASH_ALGO,

  RpcError,
  LinkError,
  RpcAbortError,
  ProtocolError,
  RpcRemoteError,
  RpcHandlerError,
  RpcTimeoutError,
  BackpressureError,
  LinkNotReadyError,
  RpcDisconnectError,
  HelloRejectedError,
  FeatureUnsupportedError,
} = linkCore;

export default linkCore;