'use strict';

const { test } = require('node:test');
const assert   = require('node:assert');

const { RecentIds } = require('../src/util/recent.js');

test('ctor rejects non-positive maxAgeMs', () => {
  assert.throws(() => new RecentIds({ maxAgeMs: 0,    maxCount: 10 }), /maxAgeMs/);
  assert.throws(() => new RecentIds({ maxAgeMs: -1,   maxCount: 10 }), /maxAgeMs/);
  assert.throws(() => new RecentIds({ maxAgeMs: NaN,  maxCount: 10 }), /maxAgeMs/);
  assert.throws(() => new RecentIds({ maxAgeMs: Infinity, maxCount: 10 }), /maxAgeMs/);
});

test('ctor rejects non-positive maxCount', () => {
  assert.throws(() => new RecentIds({ maxAgeMs: 1000, maxCount: 0  }), /maxCount/);
  assert.throws(() => new RecentIds({ maxAgeMs: 1000, maxCount: -5 }), /maxCount/);
  assert.throws(() => new RecentIds({ maxAgeMs: 1000, maxCount: NaN }), /maxCount/);
});

test('add + has roundtrip', () => {
  const r = new RecentIds({ maxAgeMs: 60_000, maxCount: 10 });
  assert.strictEqual(r.has('a'), false);
  r.add('a');
  assert.strictEqual(r.has('a'), true);
});

test('size and clear work', () => {
  const r = new RecentIds({ maxAgeMs: 60_000, maxCount: 10 });
  r.add('a'); r.add('b'); r.add('c');
  assert.strictEqual(r.size(), 3);
  r.clear();
  assert.strictEqual(r.size(), 0);
  assert.strictEqual(r.has('a'), false);
});

test('expired entries fall out of has()', async () => {
  const r = new RecentIds({ maxAgeMs: 30, maxCount: 10 });
  r.add('a');
  assert.strictEqual(r.has('a'), true);
  await new Promise((res) => setTimeout(res, 60));
  assert.strictEqual(r.has('a'), false);
});

test('LRU evicts oldest when at maxCount', () => {
  const r = new RecentIds({ maxAgeMs: 60_000, maxCount: 3 });
  r.add('a'); r.add('b'); r.add('c');
  assert.strictEqual(r.size(), 3);
  r.add('d');
  assert.strictEqual(r.size(), 3);
  assert.strictEqual(r.has('a'), false, 'oldest "a" should have been evicted');
  assert.strictEqual(r.has('d'), true);
});

test('expiry sweep on add() reclaims room before LRU', async () => {
  const r = new RecentIds({ maxAgeMs: 30, maxCount: 3 });
  r.add('a'); r.add('b');
  await new Promise((res) => setTimeout(res, 60));
  r.add('c');
  assert.strictEqual(r.has('a'), false);
  assert.strictEqual(r.has('b'), false);
  assert.strictEqual(r.has('c'), true);
});
