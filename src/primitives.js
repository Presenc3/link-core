'use strict';

/**
 * Stable, shared low-level building blocks, promoted to a public surface
 * so sibling packages (notably `@presenc3/link-helpers`) can build on the
 * exact same primitives link-core uses internally - rather than vendoring
 * divergent copies. Everything here is semver-protected like the rest of
 * the public API.
 */

const { normalizeLogger, noopLogger, consoleLogger } = require('./internal/logger.js');
const { settleOnEvents } = require('./internal/await-event.js');

const {
  inRange,
  atLeast,
  nonNegInt,
  positiveInt,
  applyOptions,
  nonNegFinite,
  validHashAlgo,
  positiveFinite,
  positiveIntOrInfinity,
} = require('./internal/options.js');

module.exports = {
  inRange,
  atLeast,
  nonNegInt,
  noopLogger,
  positiveInt,
  applyOptions,
  nonNegFinite,
  consoleLogger,
  validHashAlgo,
  settleOnEvents,
  positiveFinite,
  normalizeLogger,
  positiveIntOrInfinity,
};