'use strict';

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
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }

    this.entries.set(id, now);
  }

  size()  { return this.entries.size; }
  clear() { this.entries.clear(); }
}

module.exports = { RecentIds };