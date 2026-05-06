import linkCore from './index.js';

export const {
  createHub,
  createHubServer,

  LinkClient,
  LinkBusClient,

  sign,
  verify,
  makeMsg,
  isValidTopic,
  stableStringify,
  assertValidTopic,

  PROTOCOL_VERSION,
  TOPIC_MAX_LENGTH,
  DEFAULT_HASH_ALGO,

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
} = linkCore;

export default linkCore;