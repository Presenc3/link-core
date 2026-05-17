'use strict';

/**
 * Subpath entry: `require('@presenc3/link-core/helpers')`.
 *
 * Exports helpers as a flat object, so consumers who want the
 * helpers namespaced (rather than mingled with the protocol/client/hub
 * surface at the package root) can pull them all at once.
 *
 *   const helpers = require('@presenc3/link-core/helpers');
 *   helpers.createLogger();
 *   helpers.loadSecrets(link, mapping);
 *
 * The same symbols are also exported flat from the package root,
 * so both styles work; pick whichever fits the call site.
 */

const log           = require('./log.js');
const env           = require('./env.js');
const rpc           = require('./rpc.js');
const secrets       = require('./secrets.js');
const lifecycle     = require('./lifecycle.js');
const observability = require('./observability.js');
const eventRecorder = require('./event-recorder.js');

module.exports = {
  ...log,
  ...env,
  ...rpc,
  ...secrets,
  ...lifecycle,
  ...observability,
  ...eventRecorder
};