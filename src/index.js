'use strict';

const   protocol        = require('./protocol.js');
const { LinkBusClient } = require('./client.js');

module.exports = {
  LinkBusClient,
  sign:            protocol.sign,
  verify:          protocol.verify,
  makeMsg:         protocol.makeMsg,
  stableStringify: protocol.stableStringify,
};