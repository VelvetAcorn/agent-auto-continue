'use strict';

const contract = require('./contract');
const errors = require('./errors');
const settings = require('./settings');
const { DEFAULT_HARNESS, createHarnessRegistry } = require('./registry');
const { createT3Harness } = require('./t3');
const { createOpenCodeHarness } = require('./opencode');
const { createClaudeCodeHarness } = require('./claude-code');
const { createCodexHarness } = require('./codex');
const { createClaudeDesktopHarness } = require('./claude-desktop');
const { createCodexDesktopHarness } = require('./codex-desktop');

// Builds the production registry. `getSettings(id)` returns the resolved
// settings for one adapter; construction starts no processes or requests.
function createHarnesses({ api, getSettings, env = process.env, clientVersion }) {
  return createHarnessRegistry([
    createT3Harness({ api }),
    createOpenCodeHarness({ getSettings, env }),
    createClaudeCodeHarness({ getSettings, env }),
    createClaudeDesktopHarness({ env }),
    createCodexHarness({ getSettings, env, clientVersion }),
    createCodexDesktopHarness({ env })
  ]);
}

module.exports = { ...contract, ...errors, ...settings, DEFAULT_HARNESS, createHarnessRegistry, createHarnesses };
