'use strict';

/**
 * Bounded-size, age-bounded recent-id cache for replay protection.
 *
 * Implementation note on the monotonic-clock assumption:
 *   Entries are inserted with `Date.now()` and `Map` preserves
 *   insertion order. The age-prune loop in `add()` `break`s as soon
 *   as it sees a still-fresh entry - that's correct iff insertion
 *   order matches timestamp order, which holds while the system
 *   clock is monotonic.
 *
 *   If the wall clock jumps backwards (NTP step, VM clock skew,
 *   hibernation), pruning may be conservative for one window: some
 *   old ids stick around past their nominal TTL until the LRU cap
 *   evicts them. Replay protection itself still works (the cache is
 *   strictly more restrictive in this case, not less); the only
 *   observable effect is slightly larger memory footprint and a
 *   slightly elevated false-positive rate for the same id arriving
 *   from a peer that legitimately reused it after the window.
 */
class RecentIds {
  constructor({ maxAgeMs, maxCount }) {
    if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
      throw new Error('RecentIds: maxAgeMs must be a positive finite number');
    }

    if (!Number.isFinite(maxCount) || maxCount <= 0) {
      throw new Error('RecentIds: maxCount must be a positive finite number');
    }

    this.maxAgeMs = maxAgeMs;
    this.maxCount = maxCount;
    this.entries  = new Map();
  }

  has(id) {
    const ts = this.entries.get(id);
    if (ts === undefined) return false;

    if (Date.now() - ts > this.maxAgeMs) {
      this.entries.delete(id);
      return false;
    }
    
    return true;
  }

  add(id) {
    const now = Date.now();

    for (const [k, ts] of this.entries) {
      if (now - ts <= this.maxAgeMs) break;
      this.entries.delete(k);
    }

    if (this.entries.has(id)) this.entries.delete(id);

    while (this.entries.size >= this.maxCount) {
      const it = this.entries.keys().next();
      if (it.done) break;
      this.entries.delete(it.value);
    }

    this.entries.set(id, now);
  }

  size()  { return this.entries.size; }
  clear() { this.entries.clear(); }
}

module.exports = { RecentIds };