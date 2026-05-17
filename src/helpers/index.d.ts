/**
 * Type declarations for the `@presenc3/link-core/helpers` subpath.
 *
 * Note: helper signatures still reference `LinkClient` / `PeerInfo`
 * by name (e.g. `waitForPeer(link: LinkClient, ...)`); TypeScript
 * resolves those through the import below without re-exporting them,
 * which is the intended behaviour.
 */

export {
  LogFn,
  LEVELS,
  LogLevel,
  LogLevels,
  ErrorSink,
  createLogger,
  LogLevelName,
  LeveledLogger,
  CreateLoggerOptions,

  num,
  bool,
  requireEnv,
  LinkClientEnvOptions,
  linkClientOptionsFromEnv,
  LinkClientOptionsFromEnvOpts,

  attachHubObservability,
  attachClientObservability,
  AttachObservabilityOptions,
  DEFAULT_HUB_CONCERNING_REASONS,
  DEFAULT_CLIENT_CONCERNING_REASONS,

  waitForPeer,
  rpcWithRetry,
  createSafeSend,
  WaitForPeerOptions,
  createSafePublisher,
  RpcWithRetryOptions,
  CreateSafeSendOptions,
  CreateSafePublisherOptions,

  ShutdownFn,
  ShutdownStep,
  installProcessHandlers,
  createGracefulShutdown,
  InstallProcessHandlersOptions,
  CreateGracefulShutdownOptions,

  loadSecrets,
  LOADED_SECRETS_UNWATCH,
  SecretChangeEvent,
  LoadSecretsOptions,

  EventRecorder,
  RecorderSelf,
  RecordedEvent,
  SNAPSHOT_TRIGGERS,
  RecorderSnapshot,
  createEventRecorder,
  RecorderUnsubscribe,
  RECORDED_CLIENT_EVENTS,
  CreateEventRecorderOptions,
} from '../index';