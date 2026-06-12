'use strict';

const { test } = require('node:test');
const assert   = require('node:assert');

const { RecentIds } = require('../../src/internal/recent.js');

test('ctor rejects non-positive maxAgeMs', () => {
  assert.throws(() => new RecentIds({ maxAgeMs: 0,        maxCount: 10 }),  /maxAgeMs/);
  assert.throws(() => new RecentIds({ maxAgeMs: -1,       maxCount: 10 }),  /maxAgeMs/);
  assert.throws(() => new RecentIds({ maxAgeMs: NaN,      maxCount: 10 }),  /maxAgeMs/);
  assert.throws(() => new RecentIds({ maxAgeMs: Infinity, maxCount: 10 }),  /maxAgeMs/);
});

test('ctor rejects non-positive maxCount', () => {
  assert.throws(() => new RecentIds({ maxAgeMs: 1000,     maxCount: 0  }),  /maxCount/);
  assert.throws(() => new RecentIds({ maxAgeMs: 1000,     maxCount: -5 }),  /maxCount/);
  assert.throws(() => new RecentIds({ maxAgeMs: 1000,     maxCount: NaN }), /maxCount/);
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

test('re-adding moves an entry to the back of the LRU (true LRU, not FIFO)', () => {
  const r = new RecentIds({ maxAgeMs: 60_000, maxCount: 3 });
  r.add('a'); r.add('b'); r.add('c');
  r.add('a');
  r.add('d');
  assert.strictEqual(r.has('a'), true,  '"a" should still be present after re-add + eviction');
  assert.strictEqual(r.has('b'), false, '"b" should now be the oldest and evicted');
  assert.strictEqual(r.has('c'), true);
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

const { PeerRecentIds } = require('../../src/internal/recent.js');

test('PeerRecentIds: ctor validates maxAgeMs / maxCount', () => {
  assert.throws(() => new PeerRecentIds({ maxAgeMs: 0,    maxCount: 10 }), /maxAgeMs/);
  assert.throws(() => new PeerRecentIds({ maxAgeMs: 1000, maxCount: 0  }), /maxCount/);
});

test('PeerRecentIds: ids are namespaced per peer', () => {
  const r = new PeerRecentIds({ maxAgeMs: 60_000, maxCount: 10 });
  r.add('peerA', 'id-1');
  assert.strictEqual(r.has('peerA', 'id-1'), true);
  assert.strictEqual(r.has('peerB', 'id-1'), false);
  r.add('peerB', 'id-1');
  assert.strictEqual(r.has('peerB', 'id-1'), true);
});

test('PeerRecentIds: a noisy peer cannot evict another peer\'s ids', () => {
  const r = new PeerRecentIds({ maxAgeMs: 60_000, maxCount: 3 });
  r.add('peerB', 'keep-me');
  for (let i = 0; i < 100; i++) r.add('peerA', `flood-${i}`);
  assert.strictEqual(r.has('peerB', 'keep-me'), true);
  assert.strictEqual(r.peerCount(), 2);
});

test('PeerRecentIds: forget() drops a peer\'s window; size() sums all peers', () => {
  const r = new PeerRecentIds({ maxAgeMs: 60_000, maxCount: 10 });
  r.add('peerA', 'a'); r.add('peerA', 'b'); r.add('peerB', 'c');
  assert.strictEqual(r.size(), 3);
  assert.strictEqual(r.forget('peerA'), true);
  assert.strictEqual(r.has('peerA', 'a'), false);
  assert.strictEqual(r.size(), 1);
});