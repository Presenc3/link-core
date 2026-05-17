'use strict';

const { test } = require('node:test');
const assert   = require('node:assert');

const {
  LinkError, RpcError,
  RpcAbortError, RpcRemoteError, RpcTimeoutError, RpcDisconnectError,
  BackpressureError, ProtocolError, HelloRejectedError,
  LinkNotReadyError, FeatureUnsupportedError,
} = require('../../src/index.js');

test('every typed error extends Error and LinkError', () => {
  for (const Cls of [
    RpcError, RpcAbortError, RpcRemoteError, RpcTimeoutError, RpcDisconnectError,
    BackpressureError, ProtocolError, HelloRejectedError,
    LinkNotReadyError, FeatureUnsupportedError,
  ]) {
    const e = new Cls('m');
    assert.ok(e instanceof Error,     `${Cls.name} extends Error`);
    assert.ok(e instanceof LinkError, `${Cls.name} extends LinkError`);
    assert.strictEqual(e.message, 'm');
  }
});

test('RPC subclasses extend RpcError', () => {
  for (const Cls of [RpcAbortError, RpcRemoteError, RpcTimeoutError, RpcDisconnectError]) {
    assert.ok(new Cls('m') instanceof RpcError, `${Cls.name} extends RpcError`);
  }
});

test('codes are stable on each subclass', () => {
  assert.strictEqual(new LinkError('m').code,             'LINK_ERROR');
  assert.strictEqual(new RpcError('m').code,              'RPC_ERROR');
  assert.strictEqual(new RpcTimeoutError('m').code,       'RPC_TIMEOUT');
  assert.strictEqual(new RpcDisconnectError('m').code,    'RPC_DISCONNECT');
  assert.strictEqual(new RpcAbortError('m').code,         'RPC_ABORT');
  assert.strictEqual(new RpcRemoteError('m').code,        'RPC_REMOTE');
  assert.strictEqual(new BackpressureError('m').code,     'BACKPRESSURE');
  assert.strictEqual(new ProtocolError('m').code,         'PROTOCOL_ERROR');
  assert.strictEqual(new HelloRejectedError('m').code,    'HELLO_REJECTED');
  assert.strictEqual(new LinkNotReadyError('m').code,     'LINK_NOT_READY');
  assert.strictEqual(new FeatureUnsupportedError('m').code, 'FEATURE_UNSUPPORTED');
});

test('subclass constructors ignore caller-supplied code', () => {
  const e = new RpcTimeoutError('m', { code: 'NOPE' });
  assert.strictEqual(e.code, 'RPC_TIMEOUT', 'subclass forces its own code');
});

test('names are stable on each subclass', () => {
  assert.strictEqual(new RpcTimeoutError('m').name,          'RpcTimeoutError');
  assert.strictEqual(new BackpressureError('m').name,        'BackpressureError');
  assert.strictEqual(new LinkNotReadyError('m').name,        'LinkNotReadyError');
  assert.strictEqual(new FeatureUnsupportedError('m').name,  'FeatureUnsupportedError');
});

test('RpcError carries to/rpcType/id when supplied', () => {
  const e = new RpcRemoteError('m', { to: 'worker', rpcType: 'job.run', id: 'abc' });
  assert.strictEqual(e.to,      'worker');
  assert.strictEqual(e.rpcType, 'job.run');
  assert.strictEqual(e.id,      'abc');
});

test('RpcError omits absent context fields', () => {
  const e = new RpcRemoteError('m');
  assert.strictEqual('to'      in e, false);
  assert.strictEqual('rpcType' in e, false);
  assert.strictEqual('id'      in e, false);
});

test('RpcTimeoutError carries timeoutMs', () => {
  const e = new RpcTimeoutError('m', { timeoutMs: 5000 });
  assert.strictEqual(e.timeoutMs, 5000);
});

test('BackpressureError carries the buffer fields and id', () => {
  const e = new BackpressureError('m', {
    type: 'rpc.request', to: 'b', rpcType: 'r', id: 'x',
    bufferedAmount: 1234, maxBufferedBytes: 5678,
  });
  assert.strictEqual(e.type,             'rpc.request');
  assert.strictEqual(e.to,               'b');
  assert.strictEqual(e.rpcType,          'r');
  assert.strictEqual(e.id,               'x');
  assert.strictEqual(e.bufferedAmount,   1234);
  assert.strictEqual(e.maxBufferedBytes, 5678);
});

test('LinkNotReadyError carries op', () => {
  const e = new LinkNotReadyError('m', { op: 'publish' });
  assert.strictEqual(e.op, 'publish');
});

test('FeatureUnsupportedError carries op and feature', () => {
  const e = new FeatureUnsupportedError('m', { op: 'send', feature: 'direct' });
  assert.strictEqual(e.op,      'send');
  assert.strictEqual(e.feature, 'direct');
});

test('ProtocolError carries reason', () => {
  const e = new ProtocolError('m', { reason: 'bad-signature' });
  assert.strictEqual(e.reason, 'bad-signature');
});

test('HelloRejectedError carries reason', () => {
  const e = new HelloRejectedError('m', { reason: 'unknown kind' });
  assert.strictEqual(e.reason, 'unknown kind');
});