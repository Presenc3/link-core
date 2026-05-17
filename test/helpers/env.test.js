'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

const {
  num, bool, requireEnv, linkClientOptionsFromEnv,
} = require('../../src/helpers/env.js');

test('num returns Number for valid input and undefined for missing/empty', () => {
  assert.equal(num('42'),     42);
  assert.equal(num('0'),      0);
  assert.equal(num(' 7.5 '),  7.5);
  assert.equal(num(undefined), undefined);
  assert.equal(num(null),      undefined);
  assert.equal(num(''),        undefined);
});

test('num returns NaN for un-numeric strings (caller responsibility)', () => {
  assert.ok(Number.isNaN(num('abc')));
});

test('bool recognises common truthy strings, defaults false otherwise', () => {
  assert.equal(bool('1'),     true);
  assert.equal(bool('TRUE'),  true);
  assert.equal(bool('yes'),   true);
  assert.equal(bool(' On '),  true);
  assert.equal(bool('0'),     false);
  assert.equal(bool('no'),    false);
  assert.equal(bool('off'),   false);
  assert.equal(bool('false'), false);
  assert.equal(bool(undefined), undefined);
  assert.equal(bool(null),      undefined);
  assert.equal(bool(''),        undefined);
});

test('bool treats whitespace-only strings as undefined (matches num())', () => {
  assert.equal(bool('   '),  undefined);
  assert.equal(bool('\t'),   undefined);
  assert.equal(bool('\n '),  undefined);
});

test('requireEnv returns map of present values', () => {
  const out = requireEnv(['A', 'B'], { A: 'one', B: 'two', C: 'unused' });
  assert.deepEqual(out, { A: 'one', B: 'two' });
});

test('requireEnv throws listing every missing key', () => {
  assert.throws(
    () => requireEnv(['A', 'B', 'C'], { A: 'one' }),
    /missing required env vars: B, C/,
  );
});

test('requireEnv treats whitespace-only strings as missing', () => {
  assert.throws(
    () => requireEnv(['A'], { A: '   ' }),
    /missing required env vars: A/,
  );
});

test('linkClientOptionsFromEnv reads all standard LINK_* knobs', () => {
  const env = {
    LINK_URL:                   'ws://localhost:8080',
    LINK_KIND:                  'worker',
    LINK_SECRET:                'shh',
    LINK_HASH_ALGO:             'sha512',
    LINK_PERMESSAGE_DEFLATE:    'true',
    LINK_RECONNECT_ON_REJECTION:'1',
    LINK_RECONNECT_JITTER:      '0.25',
    LINK_REPLAY_WINDOW_MS:      '60000',
    LINK_MAX_RECENT_IDS:        '500',
    LINK_MAX_MESSAGE_BYTES:     '2000000',
    LINK_MAX_BUFFERED_BYTES:    '5000000',
  };
  const opts = linkClientOptionsFromEnv(env);
  assert.equal(opts.url,                  'ws://localhost:8080');
  assert.equal(opts.kind,                 'worker');
  assert.equal(opts.secret,               'shh');
  assert.equal(opts.hashAlgo,             'sha512');
  assert.equal(opts.perMessageDeflate,    true);
  assert.equal(opts.reconnectOnRejection, true);
  assert.equal(opts.reconnectJitter,      0.25);
  assert.equal(opts.replayWindowMs,       60000);
  assert.equal(opts.maxRecentIds,         500);
  assert.equal(opts.maxMessageBytes,      2000000);
  assert.equal(opts.maxBufferedBytes,     5000000);
});

test('linkClientOptionsFromEnv returns undefined for unset knobs (so library defaults apply)', () => {
  const opts = linkClientOptionsFromEnv({});
  assert.equal(opts.hashAlgo,             undefined);
  assert.equal(opts.perMessageDeflate,    undefined);
  assert.equal(opts.reconnectOnRejection, undefined);
  assert.equal(opts.reconnectJitter,      undefined);
  assert.equal(opts.replayWindowMs,       undefined);
});

test('linkClientOptionsFromEnv honours envPrefix override', () => {
  const env = {
    FOO_URL:    'ws://other:8080',
    FOO_KIND:   'thing',
    FOO_SECRET: 'xx',
  };
  const opts = linkClientOptionsFromEnv(env, { envPrefix: 'FOO_' });
  assert.equal(opts.url,    'ws://other:8080');
  assert.equal(opts.kind,   'thing');
  assert.equal(opts.secret, 'xx');
});