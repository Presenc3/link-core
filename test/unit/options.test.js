'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  LinkClient, createHub, createHubServer,
} = require('../../src/index.js');

describe('LinkClient option validation', () => {
  function ctor(overrides) {
    return () => new LinkClient({
      url: 'ws://x', secret: 's', kind: 'k', logger: null,
      ...overrides,
    });
  }

  test('rejects NaN for every positive-finite numeric option', () => {
    const keys = [
      'maxRecentIds', 'defaultRpcTimeoutMs', 'reconnectMaxMs',
      'reconnectInitialMs', 'statusIntervalMs',
      'maxMessageBytes', 'maxBufferedBytes',
    ];
    for (const k of keys) {
      assert.throws(ctor({ [k]: NaN }), TypeError, `${k} should reject NaN`);
    }
  });

  test('rejects Infinity, negatives, zero for positive-finite options', () => {
    for (const k of ['defaultRpcTimeoutMs', 'maxBufferedBytes', 'statusIntervalMs']) {
      assert.throws(ctor({ [k]: Infinity }), TypeError);
      assert.throws(ctor({ [k]: -1        }), TypeError);
      assert.throws(ctor({ [k]:  0        }), TypeError);
    }
  });

  test('rejects wrong types (string, object, boolean) for numeric options', () => {
    assert.throws(ctor({ defaultRpcTimeoutMs: '5000' }), TypeError);
    assert.throws(ctor({ defaultRpcTimeoutMs: {}     }), TypeError);
    assert.throws(ctor({ defaultRpcTimeoutMs: true   }), TypeError);
  });

  test('accepts 0 for disabled-sentinels (replayWindowMs, helloAckDiagnosticMs)', () => {
    assert.doesNotThrow(ctor({ replayWindowMs:       0 }));
    assert.doesNotThrow(ctor({ helloAckDiagnosticMs: 0 }));
    assert.throws    (ctor({ replayWindowMs:       -1 }), TypeError);
    assert.throws    (ctor({ helloAckDiagnosticMs: -1 }), TypeError);
  });

  test('reconnectJitter must be in [0, 1] (previously silently clamped)', () => {
    assert.doesNotThrow(ctor({ reconnectJitter: 0   }));
    assert.doesNotThrow(ctor({ reconnectJitter: 0.5 }));
    assert.doesNotThrow(ctor({ reconnectJitter: 1   }));
    assert.throws    (ctor({ reconnectJitter: 1.1 }), TypeError);
    assert.throws    (ctor({ reconnectJitter: -0.1}), TypeError);
    assert.throws    (ctor({ reconnectJitter: NaN }), TypeError);
  });

  test('reconnectGrowth must be >= 1 (sub-1 would shrink backoff per attempt)', () => {
    assert.doesNotThrow(ctor({ reconnectGrowth: 1   }));
    assert.doesNotThrow(ctor({ reconnectGrowth: 2.5 }));
    assert.throws    (ctor({ reconnectGrowth: 0.5 }), TypeError);
    assert.throws    (ctor({ reconnectGrowth: 0   }), TypeError);
    assert.throws    (ctor({ reconnectGrowth: NaN }), TypeError);
  });

  test('undefined falls through to the default (does not throw)', () => {
    const c = new LinkClient({
      url: 'ws://x', secret: 's', kind: 'k', logger: null,
      defaultRpcTimeoutMs: undefined,
      maxBufferedBytes:    undefined,
      reconnectJitter:     undefined,
    });
    assert.strictEqual(c.defaultRpcTimeoutMs, 5000);
    assert.strictEqual(c.maxBufferedBytes,    4 * 1048576);
    assert.strictEqual(c.reconnectJitter,     0.5);
    c.stop();
  });
});

describe('createHub option validation', () => {
  function ctor(overrides) {
    return () => createHub({ secret: 's', logger: null, ...overrides });
  }

  test('rejects NaN, Infinity, negative on hub numeric options', () => {
    for (const k of ['keepaliveIntervalMs', 'maxMessageBytes', 'maxBufferedBytes', 'maxRecentIds']) {
      assert.throws(ctor({ [k]: NaN      }), TypeError, `${k} should reject NaN`);
      assert.throws(ctor({ [k]: Infinity }), TypeError);
      assert.throws(ctor({ [k]: -1       }), TypeError);
      assert.throws(ctor({ [k]: 0        }), TypeError);
    }
  });

  test('accepts 0 for documented disabled-sentinels (replayWindowMs, helloTimeoutMs)', () => {
    assert.doesNotThrow(ctor({ replayWindowMs: 0 }));
    assert.doesNotThrow(ctor({ helloTimeoutMs: 0 }));
    assert.throws    (ctor({ replayWindowMs: -5 }), TypeError);
    assert.throws    (ctor({ helloTimeoutMs: -5 }), TypeError);
  });
});

describe('createHubServer option validation', () => {
  function ctor(overrides) {
    return () => createHubServer({
      secret: 's', logger: null, handleSignals: false, ...overrides,
    });
  }

  test('rejects NaN on createHubServer-specific options', () => {
    assert.throws(ctor({ port:              NaN }), TypeError);
    assert.throws(ctor({ drainDelayMs:      NaN }), TypeError);
    assert.throws(ctor({ shutdownTimeoutMs: NaN }), TypeError);
    assert.throws(ctor({ maxMessageBytes:   NaN }), TypeError);
  });

  test('allows port=0 (Node "any available") and drainDelayMs=0', () => {
    assert.doesNotThrow(ctor({ port:         0 }));
    assert.doesNotThrow(ctor({ drainDelayMs: 0 }));
    assert.throws(ctor({ shutdownTimeoutMs: 0 }), TypeError);
  });

  test('forwards validation errors from createHub (hub options validated once)', () => {
    assert.throws(ctor({ keepaliveIntervalMs: NaN }), TypeError);
    assert.throws(ctor({ replayWindowMs:      -1  }), TypeError);
  });
});