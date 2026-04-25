'use strict';

const http = require('http');
const { WebSocketServer } = require('ws');
const { createHub } = require('./hub.js');

const TAG = 'link-core:hub-server';

const WS_CLOSED                   = 3;
const DEFAULT_DRAIN_DELAY_MS      = 250;
const DEFAULT_PORT                = 8080;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;
const DEFAULT_HOST                = '0.0.0.0';

const noopLogger    = { log: () => {}, warn: () => {} };

const consoleLogger = {
  log:  (fn, ...args) => console.log(`[${fn}]`,  ...args),
  warn: (fn, ...args) => console.warn(`[${fn}]`, ...args),
};

function pickPath(url) {
  if (typeof url !== 'string') return '/';

  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

function createHubServer(opts = {}) {
  const {
    secret,
    serverRpcHandlers = {},

    path: wsPath,
    host = DEFAULT_HOST,
    port = DEFAULT_PORT,
    server: existingServer = null,

    extraState,
    routes = {},
    enableHealthRoute = true,
    enableStateRoute  = true,

    onShutdown,
    handleSignals     = true,
    signals           = ['SIGINT', 'SIGTERM'],
    drainDelayMs      = DEFAULT_DRAIN_DELAY_MS,
    shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,

    logger,
  } = opts;

  if (!secret) throw new Error('createHubServer({ secret }) is required');

  const log = logger === null ? noopLogger : (logger || consoleLogger);

  const hub = createHub({ secret, serverRpcHandlers, logger: log });

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
          res.end(JSON.stringify({ ok: true, now: Date.now() }));
          return;
        }

        if (enableStateRoute && pathOnly === '/state') {
          let extra = {};
          if (typeof extraState === 'function') {
            try { extra = (await extraState()) || {}; }
            catch (e) { log.warn(TAG, 'extraState() threw:', e?.message || e); }
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ...hub.getState(), ...extra }, null, 2));
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

  const wss = new WebSocketServer(wsPath ? { server: httpServer, path: wsPath } : { server: httpServer });
  wss.on('connection', (ws, req) => hub.attach(ws, req));

  let started        = false;
  let stopping       = false;
  let stopPromise    = null;
  const signalHandlers = new Map();

  async function start() {
    if (started) return;
    started = true;

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
    stopping = true;

    log.log(TAG, `shutting down${reason ? ` (${reason})` : ''}...`);

    let timeoutHandle = null;
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

      started  = false;
      stopping = false;
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
    getState: () => hub.getState(),
    get isStarted()       { return started;        },
    get isStopping()      { return stopping;       },
    get isOwnHttpServer() { return ownsHttpServer; },
  };
}

module.exports = { createHubServer };
