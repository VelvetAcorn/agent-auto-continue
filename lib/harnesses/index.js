'use strict';

const contract = require('./contract');
const errors = require('./errors');
const settings = require('./settings');
const { DEFAULT_HARNESS, createHarnessRegistry } = require('./registry');
const { createT3Harness } = require('./t3');

// Builds the production registry. `getSettings(id)` returns the resolved
// settings for one adapter; construction starts no processes or requests.
function createHarnesses({ api, getSettings }) {
  return createHarnessRegistry([
    createT3Harness({ api })
  ]);
}

module.exports = { ...contract, ...errors, ...settings, DEFAULT_HARNESS, createHarnessRegistry, createHarnesses };
