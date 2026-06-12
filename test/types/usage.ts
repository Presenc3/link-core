/**
 * Type-level usage suite for `@presenc3/link-core`.
 *
 * This file is never executed. It is compiled by `npm run type-check`
 * (`tsc --noEmit`, see `tsconfig.json`) and exercises the public API the
 * way a consumer would - constructing clients and hubs, wiring event
 * listeners, catching typed errors, reaching for each subpath entry.
 *
 * Its job is drift protection: the package ships a hand-maintained
 * `index.d.ts`, and a declaration that disagrees with how the API is
 * actually meant to be used will fail to compile here, in CI, instead of
 * surfacing in a downstream project. When you add or change a public
 * symbol, add a matching line of usage below.
 *
 * `// @ts-expect-error` lines assert that a misuse is correctly rejected;
 * if the type ever becomes too loose, the unused directive itself errors.
 */

import {
  LinkClient,
  createHub,
  createHubServer,
  RpcTimeoutError,
  RpcRemoteError,
  BackpressureError,
  makeMsg,
  type Hub,
  type HubServer,
  type LinkClientOptions,
  type CreateHubOptions,
  type HubAclVerdict,
  type CanRpcContext,
  type LinkErrorCode,
} from '../../src/index';

import { sign, verify, PROTOCOL_VERSION } from '../../src/protocol';
import { RpcAbortError, LinkNotReadyError } from '../../src/errors';
import { LinkClient as ClientOnly } from '../../src/client/index';
import { createHub as hubOnly, createHubServer as serverOnly } from '../../src/hub/index';

const _v: number = PROTOCOL_VERSION;
const _s: string = sign('secret', { id: 'x' });
const _ok: boolean = verify('secret', { id: 'x', sig: _s });
void ClientOnly;
void hubOnly;
void serverOnly;

const clientOpts: LinkClientOptions = {
  url: 'ws://127.0.0.1:8080',
  secret: 'shared',
  kind: 'worker',
  maxOutboxBytes: 1 << 20,
  reconnectOnRejection: false,
};

const link = new LinkClient(clientOpts);

link.on('ready', (info) => {
  const k: string = info.kind;
  void k;
});
link.on('rpc.complete', (info) => {
  const ok: boolean = info.ok;
  const dur: number = info.durationMs;
  void ok; void dur;
});

async function exerciseClient(): Promise<void> {
  await link.ready({ timeoutMs: 3000 });

  const r1 = await link.rpc('vault', 'secrets.get', { name: 'API_KEY' });
  void r1;

  const ac = new AbortController();
  const r2 = await link.rpc('vault', 'secrets.get', { name: 'API_KEY' }, {
    timeoutMs: 1000,
    signal: ac.signal,
  });
  void r2;

  const r3 = await link.rpc('vault', 'secrets.get', undefined, 500);
  void r3;

  link.send('worker', 'event', { n: 1 });
  link.publish('jobs.done', { id: 'abc' });

  await link.stop();
  await link.stop({ drain: false });
}
void exerciseClient;

function classify(e: unknown): string {
  if (e instanceof RpcTimeoutError)   return `timeout after ${e.timeoutMs ?? '?'}ms`;
  if (e instanceof RpcRemoteError)    return `remote: ${e.code}`;
  if (e instanceof RpcAbortError)     return 'aborted';
  if (e instanceof BackpressureError) return 'backpressure';
  if (e instanceof LinkNotReadyError) return `not ready (${e.op ?? 'unknown'})`;
  return 'other';
}
void classify;

const _code: LinkErrorCode = 'RPC_FORBIDDEN';
void _code;

const aclAllow: HubAclVerdict = true;
const aclDeny: HubAclVerdict  = { ok: false, code: 'RPC_FORBIDDEN', error: 'nope' };
void aclAllow;
void aclDeny;

const hubOpts: CreateHubOptions = {
  secret: 'shared',
  canRpc: (ctx: CanRpcContext) => {
    return ctx.from === 'admin' ? true : { ok: false, code: 'RPC_FORBIDDEN', error: 'denied' };
  },
  canPublish: async (ctx) => ctx.topic.startsWith('public.'),
  canSubscribe: (ctx) => ({ ok: true }),
  canSend: (ctx) => ctx.to !== 'quarantine',
};

const hub: Hub = createHub(hubOpts);

hub.on('rpc.cancelled', (info) => {
  const found: boolean = info.found;
  const id: string = info.id;
  void found; void id;
});

hub.on('acl-denied', (info) => {
  const op: 'rpc' | 'publish' | 'subscribe' | 'send' = info.op;
  void op;
});

const server: HubServer = createHubServer({
  secret: 'shared',
  port: 8080,
  canRpc: () => true,
});
void server;

const env = makeMsg('secret', { id: 'm1', type: 'ping', data: { n: 1 } });
const _envType: string = env.type;
void _envType;

// @ts-expect-error - `kind` must be a string, not a number
new LinkClient({ url: 'ws://x', secret: 's', kind: 123 });

// @ts-expect-error - `canRpc` must be a function
createHub({ secret: 's', canRpc: true });

// @ts-expect-error - `secret` is required on createHubServer
createHubServer({ port: 8080 });

// @ts-expect-error - rpc() requires a string rpcType
link.rpc('vault', 42, {});