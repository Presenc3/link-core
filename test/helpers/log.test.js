'use strict';

const test     = require('node:test');
const assert   = require('node:assert/strict');
const { createLogger, LEVELS } = require('../../src/helpers/log.js');

function captureConsole() {
  const original = {
    debug: console.debug, log: console.log,
    warn:  console.warn,  error: console.error,
  };
  const calls = { debug: [], log: [], warn: [], error: [] };
  console.debug = (...a) => calls.debug.push(a);
  console.log   = (...a) => calls.log.push(a);
  console.warn  = (...a) => calls.warn.push(a);
  console.error = (...a) => calls.error.push(a);
  return {
    calls,
    restore() { Object.assign(console, original); },
  };
}

test('LEVELS exports DEBUG/INFO/WARN/ERROR ordered ascending', () => {
  assert.equal(LEVELS.DEBUG, 0);
  assert.equal(LEVELS.INFO,  1);
  assert.equal(LEVELS.WARN,  2);
  assert.equal(LEVELS.ERROR, 3);
});

test('createLogger emits l/lD/lW/lE to the right console method with a [context] prefix', () => {
  const cap = captureConsole();
  try {
    const log = createLogger({ minLevel: LEVELS.DEBUG });
    log.l ('boot', 'hello');
    log.lD('boot', 'detail');
    log.lW('link', 'careful');
    log.lE('link', 'oops');

    assert.equal(cap.calls.log.length,   1, 'l → console.log once');
    assert.equal(cap.calls.debug.length, 1, 'lD → console.debug once');
    assert.equal(cap.calls.warn.length,  1, 'lW → console.warn once');
    assert.equal(cap.calls.error.length, 1, 'lE → console.error once');

    const [prefix, msg] = cap.calls.log[0];
    assert.match(prefix, /^\[\d{2}:\d{2}:\d{2}\.\d{3}\] \[boot\]$/, 'prefix shape');
    assert.equal(msg, 'hello');
  } finally { cap.restore(); }
});

test('minLevel=WARN suppresses INFO and DEBUG but keeps WARN/ERROR', () => {
  const cap = captureConsole();
  try {
    const log = createLogger({ minLevel: LEVELS.WARN });
    log.l ('x', 'i');
    log.lD('x', 'd');
    log.lW('x', 'w');
    log.lE('x', 'e');

    assert.equal(cap.calls.log.length,   0);
    assert.equal(cap.calls.debug.length, 0);
    assert.equal(cap.calls.warn.length,  1);
    assert.equal(cap.calls.error.length, 1);
  } finally { cap.restore(); }
});

test('minLevel accepts string names and is case-insensitive', () => {
  const cap = captureConsole();
  try {
    const log = createLogger({ minLevel: 'warn' });
    log.l ('x', 'should be silent');
    log.lW('x', 'should appear');
    assert.equal(cap.calls.log.length,  0);
    assert.equal(cap.calls.warn.length, 1);
  } finally { cap.restore(); }
});

test('setMinLevel mutates threshold at runtime', () => {
  const cap = captureConsole();
  try {
    const log = createLogger({ minLevel: LEVELS.DEBUG });
    log.lD('x', 'visible');
    log.setMinLevel(LEVELS.INFO);
    log.lD('x', 'hidden');
    assert.equal(cap.calls.debug.length, 1);
  } finally { cap.restore(); }
});

test('errorSink is invoked once per Error passed to lE, and never on lW', () => {
  const cap = captureConsole();
  try {
    const sinkCalls = [];
    const log = createLogger({
      minLevel: LEVELS.DEBUG,
      errorSink: (ctx, msg, err) => sinkCalls.push({ ctx, msg, err }),
    });

    const err = new Error('boom');
    log.lW('x', 'plain warn', err);
    log.lE('x', 'first',  err);
    log.lE('x', 'second', err);
    log.lE('x', 'no error here, just a string');

    assert.equal(sinkCalls.length, 2);
    assert.equal(sinkCalls[0].msg, 'first');
    assert.equal(sinkCalls[1].msg, 'second');
  } finally { cap.restore(); }
});

test('errorSink synchronous throws are swallowed', () => {
  const cap = captureConsole();
  try {
    const log = createLogger({
      errorSink: () => { throw new Error('sink-broken'); },
    });
    assert.doesNotThrow(() => log.lE('x', 'msg', new Error('real')));
  } finally { cap.restore(); }
});

test('errorSink async rejections are swallowed', async () => {
  const cap = captureConsole();
  try {
    const log = createLogger({
      errorSink: async () => { throw new Error('async-sink-broken'); },
    });
    log.lE('x', 'msg', new Error('real'));
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(true);
  } finally { cap.restore(); }
});

test('clearErrorSink stops further sink invocations', () => {
  const cap = captureConsole();
  try {
    const sinkCalls = [];
    const log = createLogger({
      errorSink: () => sinkCalls.push(1),
    });
    log.lE('x', 'msg', new Error('a'));
    log.clearErrorSink();
    log.lE('x', 'msg', new Error('b'));
    assert.equal(sinkCalls.length, 1);
  } finally { cap.restore(); }
});