'use strict';

/*
 * 01-hub.js
  * A hub server using PER-PEER KEYS auth.
  * 
  * Run from the repo root: node examples/01-hub.js
**/

const { createHubServer } = require('../src/index.js');

const PORT = Number(process.env.LINK_PORT) || 8080;

/*
 * Static map of kind → key. The hub silently drops hellos for kinds that
  * aren't in the map (without confirming whether the kind exists, on
  * purpose - see Security & threat model in the README). For a production
  * deployment, swap this for a function that reads from your secrets store:
  * secret: async (kind) => vault.get(`link-core/keys/${kind}`)
**/
const KEYS = {
  vault:       process.env.LINK_KEY_VAULT       || 'dev-vault-key',
  worker:      process.env.LINK_KEY_WORKER      || 'dev-worker-key',
  coordinator: process.env.LINK_KEY_COORDINATOR || 'dev-coord-key',
};

const server = createHubServer({
  port:   PORT,
  secret: KEYS,

  // Clients call this with: link.rpc('server', 'hub.now', {})
  rpcHandlers: {
    'hub.now': async () => ({ now: Date.now() }),
  },
});

server.hub.on('peer.connect',     ({ kind, replaced }) => {
  console.log(`[hub] + ${kind}${replaced ? ' (replaced previous connection)' : ''}`);
});

server.hub.on('peer.disconnect',  ({ kind, reason }) => {
  console.log(`[hub] - ${kind}${reason ? ` (${reason})` : ''}`);
});

server.hub.on('peer.timeout',     ({ remoteAddress }) => {
  console.warn(`[hub] pre-hello timeout from ${remoteAddress || '<unknown>'}`);
});

server.hub.on('protocol-error',   ({ reason, kind }) => {
  console.warn(`[hub] protocol-error: ${reason} (kind=${kind || '<pending>'})`);
});

server.start().then(() => {
  console.log(`[hub] listening on http://0.0.0.0:${PORT}`);
  console.log(`[hub] ws on ws://0.0.0.0:${PORT}`);
  console.log(`[hub] /health and /state available on http://localhost:${PORT}`);
}).catch((e) => {
  console.error('[hub] failed to start:', e);
  process.exit(1);
});