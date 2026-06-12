import protocol from './protocol.js';

export const {
  sign,
  verify,
  makeMsg,
  isValidTopic,
  stableStringify,
  assertValidTopic,
  PROTOCOL_VERSION,
  TOPIC_MAX_LENGTH,
  DEFAULT_HASH_ALGO,
  assertJsonSerializable,
} = protocol;

export default protocol;