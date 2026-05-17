'use strict';

const http = require('http');
const { WebSocketServer } = require('ws');

const { createHub } = require('./index.js');
const { DEFAULT_MAX_MESSAGE_BYTES } = require('./constants.js');
const { noopLogger, consoleLogger } = require('../internal/logger.js');
const { positiveFinite, nonNegFinite } = require('../internal/options.js');

const TAG = 'link-core:hub-server';

const WS_CLOSED    = 3;
const DEFAULT_PORT = 8080;
const DEFAULT_HOST = '0.0.0.0';

const DEFAULT_DRAIN_DELAY_MS      = 250;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

function pickPath(url) {
  if (typeof url !== 'string') return '/';

  const q = url.indexOf('?');
  const noQuery = q === -1 ? url : url.slice(0, q);

  return noQuery.replace(/\/+$/, '') || '/';
}

function createHubServer(opts = {}) {
  const {
    secret,
    rpcHandlers = {},

    path: wsPath,
    host = DEFAULT_HOST,
    server: existingServer = null,

    extraState,
    routes = {},
    enableHealthRoute = true,
    enableStateRoute  = false,

    onShutdown,
    handleSignals = true,
    signals = ['SIGINT', 'SIGTERM'],

    logger,
    hashAlgo,
    maxRecentIds,
    replayWindowMs,
    helloTimeoutMs,
    maxBufferedBytes,
    maxPendingSockets,
    keepaliveIntervalMs,
    perMessageDeflate = false
  } = opts;

  if (secret == null) throw new Error('createHubServer({ secret }) is required');

  const port              = nonNegFinite(  opts.port,              DEFAULT_PORT,                'port');
  const drainDelayMs      = nonNegFinite(  opts.drainDelayMs,      DEFAULT_DRAIN_DELAY_MS,      'drainDelayMs');
  const maxMessageBytes   = positiveFinite(opts.maxMessageBytes,   DEFAULT_MAX_MESSAGE_BYTES,   'maxMessageBytes');
  const shutdownTimeoutMs = positiveFinite(opts.shutdownTimeoutMs, DEFAULT_SHUTDOWN_TIMEOUT_MS, 'shutdownTimeoutMs');

  const log = logger === null ? noopLogger : (logger || consoleLogger);

  if (!existingServer && enableStateRoute && host === '0.0.0.0') {
    log.warn(TAG,
      `/state is enabled and bound to 0.0.0.0 - peer kinds, hello payloads, ` +
      `and last-known statuses will be reachable to anyone who can reach `    +
      `the port. If this is intentional (e.g. internal-network dashboard), `  +
      `you can ignore this. Otherwise bind to 127.0.0.1 or disable /state.`,
    );
  }

  const hub = createHub({
    secret,
    hashAlgo,
    rpcHandlers,
    logger: log,
    maxRecentIds,
    replayWindowMs,
    helloTimeoutMs,
    maxMessageBytes,
    maxBufferedBytes,
    maxPendingSockets,
    keepaliveIntervalMs,
  });

  const ownsHttpServer = !existingServer;
  let httpServer = existingServer;

  if (ownsHttpServer) {
    httpServer = http.createServer(async (req, res) => {
      try {
        const pathOnly = pickPath(req.url);

        const userHandler = routes[pathOnly];
        if (typeof userHandler === 'function') {
          await userHandler(req, res);
          return;
        }

        if (enableHealthRoute && pathOnly === '/health') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, now: Date.now(), hub: hub.health() }));
          return;
        }

        if (enableStateRoute && pathOnly === '/state') {
          const hubState = hub.getState();
          let extra = null;

          if (typeof extraState === 'function') {
            try { extra = await extraState(); }
            catch (e) { log.warn(TAG, 'extraState() threw:', e?.message || e); }
          }

          const merged = { ...hubState };

          if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
            for (const k of Object.keys(extra)) {
              if (k in hubState) {
                log.warn(TAG, `extraState(): key '${k}' collides with hub state, ignoring`);
              } else {
                merged[k] = extra[k];
              }
            }
          } else if (extra != null) {
            log.warn(TAG,
              `extraState() returned non-object (typeof=${typeof extra}` +
              `${Array.isArray(extra) ? ', array' : ''}); ignored`);
          }

          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(merged, null, 2));
          return;
        }

        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
      } catch (e) {
        log.warn(TAG, 'http handler error:', e?.message || e);
        if (!res.headersSent) {
          try {
            res.writeHead(500, { 'content-type': 'text/plain' });
            res.end('internal error');
          } catch {}
        }
      }
    });
  }

  const wssOpts = {
    server:      httpServer,
    maxPayload:  maxMessageBytes,
    perMessageDeflate,
    ...(wsPath ? { path: wsPath } : {}),
  };

  const wss = new WebSocketServer(wssOpts);

  wss.on('connection', (ws, req) => hub.attach(ws, req));
  wss.on('error', (e) => log.warn(TAG, 'wss error:', e?.message || e));

  if (existingServer && !wsPath) {
    log.warn(TAG,
      'attached to user-provided http server without a `path` - every WebSocket upgrade on this server will be routed to the hub. Pass `path: \'/your-link-endpoint\'` to scope it.'
    );
  }

  let stopPromise    = null;
  let started        = false;
  let stopping       = false;
  let stopped        = false;
  const signalHandlers = new Map();

  async function start() {
    if (stopped) {
      throw new Error('createHubServer is single-shot; call createHubServer() again to start a new server');
    }
    
    if (started) return;

    if (ownsHttpServer) {
      await new Promise((resolve, reject) => {
        const onError     = (e) => { httpServer.off('listening', onListening); reject(e); };
        const onListening = ()   => { httpServer.off('error',    onError);     resolve(); };

        httpServer.once('error',     onError);
        httpServer.once('listening', onListening);
        httpServer.listen(port, host);
      });

      log.log(TAG, `listening on http://${host}:${port}`);
      log.log(TAG, `ws on ws://${host}:${port}${wsPath || ''}`);

    } else {
      log.log(TAG, 'attached to user-provided http server');
    }

    started = true;

    if (handleSignals) {
      for (const sig of signals) {
        const handler = () => { stop(sig).catch((e) => log.warn(TAG, 'stop() failed:', e?.message || e)); };
        signalHandlers.set(sig, handler);
        process.on(sig, handler);
      }
    }
  }

  async function stop(reason) {
    if (stopPromise) return stopPromise;
    if (stopped) return Promise.resolve();

    if (!started) {
      try { wss.close(); } catch (e) { log.warn(TAG, 'wss.close() error:',  e?.message || e); }
      try { hub.stop();  } catch (e) { log.warn(TAG, 'hub.stop() error:',   e?.message || e); }

      stopped = true;
      return Promise.resolve();
    }

    stopping = true;
    let timeoutHandle = null;

    log.log(TAG, `shutting down${reason ? ` (${reason})` : ''}...`);

    const timeout = new Promise((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error(`shutdown timeout after ${shutdownTimeoutMs}ms`)),
        shutdownTimeoutMs,
      );

      timeoutHandle.unref?.();
    });

    const work = (async () => {
      const wssClosed = new Promise((resolve) => {
        wss.once('close', resolve);
      });

      try { wss.close(); }
      catch (e) { log.warn(TAG, 'wss.close() error:', e?.message || e); }

      for (const ws of wss.clients) {
        try { ws.close(1001, 'server shutdown'); } catch {}
      }

      await new Promise((r) => setTimeout(r, drainDelayMs));

      for (const ws of wss.clients) {
        try { if (ws.readyState !== WS_CLOSED) ws.terminate(); } catch {}
      }

      try { await wssClosed; } catch {}

      if (ownsHttpServer) {
        try { await new Promise((r) => httpServer.close(() => r())); }
        catch (e) { log.warn(TAG, 'httpServer.close() error:', e?.message || e); }
      }

      try { hub.stop(); }
      catch (e) { log.warn(TAG, 'hub.stop() error:', e?.message || e); }

      if (typeof onShutdown === 'function') {
        try { await onShutdown(); }
        catch (e) { log.warn(TAG, 'onShutdown() threw:', e?.message || e); }
      }

      for (const [sig, handler] of signalHandlers.entries()) {
        try { process.off(sig, handler); } catch {}
      }
      signalHandlers.clear();
    })();

    stopPromise = (async () => {
      try {
        await Promise.race([work, timeout]);
        if (timeoutHandle) clearTimeout(timeoutHandle);

        log.log(TAG, 'shutdown complete');
      } catch (e) {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        log.warn(TAG, 'shutdown error:', e?.message || e);

        throw e;
      } finally {
        stopping    = false;
        stopped     = true;
        stopPromise = null;
      }
    })();

    return stopPromise;
  }

  return {
    hub,
    wss,
    stop,
    start,
    httpServer,
    health:   () => hub.health(),
    getState: () => hub.getState(),
    get isStarted()       { return started;        },
    get isStopping()      { return stopping;       },
    get isStopped()       { return stopped;        },
    get isOwnHttpServer() { return ownsHttpServer; },
  };
}

module.exports = { createHubServer };