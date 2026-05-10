'use strict';

/*
 * 02-vault.js
  * A "secrets vault" peer. Other services ask it for credentials over RPC.
  * In a real deployment, replace the in-memory STORE with a call to
  * HashiCorp Vault, AWS Secrets Manager, GCP Secret Manager, 1Password
  * Connect, etc. The link-core surface stays exactly the same.
  * 
  * Run from the repo root: node examples/02-vault.js
**/

const { LinkClient } = require('../src/index.js');

const fn = '[ Vault ]';

const STORE = {
  'db-password'       :   'super-secret-db-password',
  'api-key:openai'    :   'sk-not-a-real-key',
  'api-key:stripe'    :   'sk_live_also_not_real',
  'flag:experimental' :   'true',
};

// Trivial authorization policy: every kind we know about may read every secret. A real vault would consult an ACL based on `from`
const ALLOW = new Set(['worker', 'coordinator']);

const link = new LinkClient({
  kind   : 'vault',
  name   : 'vault',
  url    : process.env.LINK_URL       || 'ws://localhost:8080',
  secret : process.env.LINK_KEY_VAULT || 'dev-vault-key',

  rpcHandlers: {
    // secrets.get({ name }) → { name, value }
    'secrets.get': async ({ name } = {}, msg) => {

      // The string is what shows up on the caller's RpcRemoteError.message.
      if (!ALLOW.has(msg.from)) throw new Error(
        `Forbidden: ${msg.from} cannot read secrets`
      );

      if (typeof name !== 'string' || !name) throw new Error(
        'secrets.get: "name" is required'
      );

      const value = STORE[name];

      if (value === undefined) throw new Error(
        `Unknown secret: ${name}`
      );

      console.log(`${fn} secrets.get(${name}) → ${msg.from}`);
      return { name, value };
    },

    // secrets.list() → { names: string[] }
    'secrets.list': async (_data, msg) => {
      if (!ALLOW.has(msg.from)) throw new Error(`Forbidden: ${msg.from}`);
      
      console.log(`${fn} secrets.list → ${msg.from}`);
      return { names: Object.keys(STORE) };
    },
  },
});

link.on('rejected',       ({ reason }) => console.error(`${fn} hub rejected hello: ${reason}`));
link.on('protocol-error', ({ reason }) => console.warn(`${fn} protocol-error: ${reason}`));

(async () => {
  await link.ready({ timeoutMs: 10_000 });
  console.log(`${fn} ready`);
})().catch((e) => {
  console.error(`${fn} error: `, e.message || e);
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { console.log(`${fn} ${sig}, stopping`); link.stop(); process.exit(0); });
}