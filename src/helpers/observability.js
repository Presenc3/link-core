'use strict';

/**
 * Wire standard observability listeners onto a LinkClient or hub.
 *
 *   const log = createLogger();
 *
 *   // client side
 *   const link = new LinkClient({ ... });
 *   attachClientObservability(link, { logger: log, context: 'link', verbose: false });
 *
 *   // hub side
 *   const server = createHubServer({ ... });
 *   attachHubObservability(server.hub, { logger: log, context: 'hub-events' });
 *
 * Membership churn (peer.connect/disconnect) at info, security-relevant
 * drops at warn, per-RPC trace at debug (or info when verbose). The
 * `protocol-error` listener classifies reasons into "concerning"
 * (operator should look) vs "noisy" (clock drift, dedupe, etc.) and
 * routes them to warn vs debug accordingly.
 *
 * The default reason sets reflect what link-core 0.4.x emits today.
 * To extend without losing the defaults, pass `extraConcerningReasons`.
 * To replace entirely, pass `concerningReasons`.
 */

const DEFAULT_CLIENT_CONCERNING_REASONS = Object.freeze([
  'bad-signature',
  'parse-error',
  'oversize',
  'bad-version',
  'no-ack',
  'missing-id',
]);

const DEFAULT_HUB_CONCERNING_REASONS = Object.freeze([
  'bad-signature',
  'bad-hello',
  'unknown-kind',
  'pre-hello-message',
  'parse-error',
  'oversize',
  'bad-version',
  'missing-id',
  'duplicate-hello',
]);

function buildReasonSet(defaults, override, extras) {
  if (Array.isArray(override)) return new Set(override);
  const set = new Set(defaults);
  if (Array.isArray(extras)) for (const r of extras) set.add(r);
  return set;
}

function assertLogger(logger, fnName) {
  if (!logger
    || typeof logger.l  !== 'function'
    || typeof logger.lD !== 'function'
    || typeof logger.lW !== 'function'
    || typeof logger.lE !== 'function'
   ) throw new TypeError(`${fnName}: logger with { l, lD, lW, lE } is required`);
}

/**
 * Attach observability listeners to a LinkClient.
 *
 *   attachClientObservability(link, {
 *     logger,                    // required
 *     context: 'link',           // log context prefix
 *     verbose: false,            // promote per-RPC traces to info
 *     concerningReasons,         // override the default reason set
 *     extraConcerningReasons,    // add to the default reason set
 *   });
 */
function attachClientObservability(link, opts = {}) {
  assertLogger(opts.logger, 'attachClientObservability');

  const { l, lD, lW, lE } = opts.logger;
  const ctx = opts.context || 'link';
  const verbose = !!opts.verbose;
  const trace = verbose ? l : lD;

  const reasons = buildReasonSet(
    DEFAULT_CLIENT_CONCERNING_REASONS,
    opts.concerningReasons,
    opts.extraConcerningReasons,
  );

  link.on('disconnect', ({ code, reason, willReconnect, wasReady }) => {
    const tail = `code=${code ?? '?'} reason=${reason || '?'} ` +
      `wasReady=${wasReady} willReconnect=${willReconnect}`;
    (wasReady ? l : lW)(ctx, `disconnect ${tail}`);
  });

  link.on('reconnecting', ({ delayMs, attempt }) => {
    l(ctx, `reconnecting in ${delayMs}ms (attempt #${attempt})`);
  });

  link.on('rejected', ({ reason, error }) => {
    lE(ctx, `hub rejected hello: reason=${reason} error=${error || ''}`);
  });

  link.on('protocol-error', (info) => {
    const bits = [`reason=${info.reason}`];
    if (info.type)   bits.push(`type=${info.type}`);
    if (info.detail) bits.push(`detail=${info.detail}`);
    const logger = reasons.has(info.reason) ? lW : lD;
    logger(ctx, `protocol-error ${bits.join(' ')}`);
  });

  link.on('peer.connect',    (p) => l(ctx, `peer + ${p.kind}`));
  link.on('peer.disconnect', (p) => l(ctx, `peer - ${p.kind}`));
  link.on('peer.replaced',   (i) => l(ctx, `peer ~ ${i.kind} (replaced by fresh socket)`));

  link.on('rpc.complete', (info) => {
    const { to, rpcType, ok, reason, durationMs } = info;
    if (!ok) {
      lW(ctx, `rpc ${rpcType} -> ${to} FAIL reason=${reason} (${durationMs}ms)`);
    } else {
      trace(ctx, `rpc ${rpcType} -> ${to} OK (${durationMs}ms)`);
    }
  });

  link.on('backpressure', (info) => {
    lW(ctx, `outbound backpressure: type=${info.type} buffered=${info.bufferedAmount}` +
      `${info.to ? ` to=${info.to}` : ''}`);
  });

  if (verbose) {
    link.on('connect',  ({ kind: k }) => lD(ctx, `socket connect kind=${k}`));
    link.on('verified', ({ kind: k }) => lD(ctx, `socket verified kind=${k}`));
    link.on('ready',    ({ kind: k, features }) => {
      lD(ctx, `link ready kind=${k} features=${(features || []).join(',')}`);
    });
    link.on('peer.status', ({ from, status }) => {
      const knownShape = status && (status.status !== undefined || status.ready !== undefined);
      if (knownShape) {
        lD(ctx, `peer.status ${from}: status=${status?.status ?? '?'} ready=${status?.ready ?? '?'}`);
      } else {
        let dump = '<unprintable>';
        try {
          const s = JSON.stringify(status);
          if (typeof s === 'string') dump = s.length > 200 ? s.slice(0, 200) + '…' : s;
        } catch { }
        lD(ctx, `peer.status ${from}: ${dump}`);
      }
    });
  }
}

/**
 * Attach observability listeners to a hub (the EventEmitter returned
 * from createHub() / server.hub on createHubServer()).
 *
 *   attachHubObservability(server.hub, {
 *     logger,                    // required
 *     context: 'hub',            // log context prefix
 *     verbose: false,            // log every forwarded RPC, publish, direct, message
 *     concerningReasons,
 *     extraConcerningReasons,
 *   });
 */
function attachHubObservability(hub, opts = {}) {
  assertLogger(opts.logger, 'attachHubObservability');

  const { l, lD, lW } = opts.logger;
  const ctx = opts.context || 'hub';
  const verbose = !!opts.verbose;

  const reasons = buildReasonSet(
    DEFAULT_HUB_CONCERNING_REASONS,
    opts.concerningReasons,
    opts.extraConcerningReasons,
  );

  hub.on('peer.connect', ({ kind, replaced }) => {
    if (replaced) l(ctx, `peer re-connected: ${kind} (replaced previous socket)`);
    else          l(ctx, `peer connected: ${kind}`);
  });

  hub.on('peer.disconnect', ({ kind, code, reason }) => {
    const tail = reason ? ` (${code ?? '?'} ${reason})` : '';
    l(ctx, `peer disconnected: ${kind}${tail}`);
  });

  hub.on('peer.replaced', ({ kind }) => {
    lD(ctx, `peer.replaced: ${kind}`);
  });

  hub.on('peer.timeout', ({ remoteAddress, helloTimeoutMs }) => {
    lW(ctx, `pre-hello timeout: ${remoteAddress || '?'} (after ${helloTimeoutMs}ms)`);
  });

  hub.on('protocol-error', (info) => {
    const { reason, kind, type, detail } = info;
    const bits = [`reason=${reason}`];
    if (kind)   bits.push(`kind=${kind}`);
    if (type)   bits.push(`type=${type}`);
    if (detail) bits.push(`detail=${detail}`);
    const logger = reasons.has(reason) ? lW : lD;
    logger(ctx, `protocol-error ${bits.join(' ')}`);
  });

  hub.on('backpressure', ({ kind, type, to, bufferedAmount, maxBufferedBytes }) => {
    lW(ctx,
      `backpressure: ${kind} type=${type}${to ? ` to=${to}` : ''} ` +
      `buffered=${bufferedAmount}/${maxBufferedBytes}`);
  });

  hub.on('rpc.server', ({ from, rpcType, ok, error, durationMs }) => {
    if (!ok) {
      lW(ctx, `rpc.server FAIL ${from} ${rpcType} (${durationMs}ms): ${error}`);
    } else {
      lD(ctx, `rpc.server OK   ${from} ${rpcType} (${durationMs}ms)`);
    }
  });

  if (verbose) {
    hub.on('rpc.forwarded', ({ from, to, rpcType }) => {
      lD(ctx, `rpc.forwarded ${from} -> ${to} ${rpcType}`);
    });

    hub.on('rpc.response.forwarded', ({ from, to, ok }) => {
      lD(ctx, `rpc.response  ${from} -> ${to} ok=${ok}`);
    });

    hub.on('topic.publish', ({ from, topic, subscriberCount, delivered }) => {
      lD(ctx, `topic.publish ${from} -> ${topic} subs=${subscriberCount} delivered=${delivered ?? 0}`);
    });

    hub.on('topic.subscribe',   ({ kind, topic }) => lD(ctx, `subscribe   ${kind} ${topic}`));
    hub.on('topic.unsubscribe', ({ kind, topic }) => lD(ctx, `unsubscribe ${kind} ${topic}`));

    hub.on('direct', ({ from, to, type }) => {
      lD(ctx, `direct ${from} -> ${to} type=${type}`);
    });

    hub.on('message', ({ from, msg }) => {
      lD(ctx, `msg ${from || '<pre-hello>'} type=${msg?.type}`);
    });
  }
}

module.exports = {
  attachClientObservability,
  attachHubObservability,
  DEFAULT_CLIENT_CONCERNING_REASONS,
  DEFAULT_HUB_CONCERNING_REASONS,
};