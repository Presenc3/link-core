'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const { createGracefulShutdown } = require('../../src/helpers/lifecycle.js');
const { createLogger, LEVELS }   = require('../../src/helpers/log.js');

function silentLogger() {
  const noop = () => {};
  return {
    LEVELS,
    l: noop, lD: noop, lW: noop, lE: noop,
    setMinLevel: noop, setErrorSink: noop, clearErrorSink: noop,
  };
}

test('createGracefulShutdown runs steps in order with the signal arg', async () => {
  const order = [];
  const shutdown = createGracefulShutdown({
    logger: silentLogger(),
    timeoutMs: 1000,
    exitProcess: false,
    steps: [
      (sig) => { order.push(['a', sig]); },
      async (sig) => {
        await new Promise((r) => setTimeout(r, 5));
        order.push(['b', sig]);
      },
      (sig) => { order.push(['c', sig]); },
    ],
  });

  await shutdown('SIGTERM');
  assert.deepEqual(order, [
    ['a', 'SIGTERM'],
    ['b', 'SIGTERM'],
    ['c', 'SIGTERM'],
  ]);
});

test('a throwing step does NOT abort subsequent steps', async () => {
  const ran = [];
  const shutdown = createGracefulShutdown({
    logger: silentLogger(),
    timeoutMs: 1000,
    exitProcess: false,
    steps: [
      () => { ran.push('a'); },
      () => { ran.push('b-throws'); throw new Error('nope'); },
      () => { ran.push('c'); },
    ],
  });

  await shutdown('manual');
  assert.deepEqual(ran, ['a', 'b-throws', 'c']);
});

test('calling shutdown twice is a no-op the second time', async () => {
  const ran = [];
  const shutdown = createGracefulShutdown({
    logger: silentLogger(),
    timeoutMs: 1000,
    exitProcess: false,
    steps: [
      async () => {
        await new Promise((r) => setTimeout(r, 10));
        ran.push('once');
      },
    ],
  });

  const first = shutdown('SIGINT');
  const second = shutdown('SIGTERM');
  await Promise.all([first, second]);

  assert.deepEqual(ran, ['once']);
});