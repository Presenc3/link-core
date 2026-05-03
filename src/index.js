'use strict';

const { createHub       } = require('./hub.js');
const { LinkBusClient   } = require('./client.js');
const   protocol          = require('./protocol.js');
const { createHubServer } = require('./hub-server.js');

module.exports = {
  createHub,
  LinkBusClient,
  createHubServer,
  sign:             protocol.sign,
  verify:           protocol.verify,
  makeMsg:          protocol.makeMsg,
  stableStringify:  protocol.stableStringify,
  PROTOCOL_VERSION: protocol.PROTOCOL_VERSION
};