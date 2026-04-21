'use strict';

const { createHub     } = require('./hub.js');
const { LinkBusClient } = require('./client.js');
const   protocol        = require('./protocol.js');

module.exports = {
  createHub,
  LinkBusClient,
  sign:            protocol.sign,
  verify:          protocol.verify,
  makeMsg:         protocol.makeMsg,
  stableStringify: protocol.stableStringify,
};