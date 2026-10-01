'use strict';

// App profiles: one module per desktop app, holding every contact point the
// harnesses rely on. See profiles/define.js for the shape.
const { deepLinkFor, defineProfile } = require('./define');
const claudeDesktop = require('./claude-desktop');
const codexDesktop = require('./codex-desktop');

const PROFILES = Object.freeze({ [claudeDesktop.harness]: claudeDesktop, [codexDesktop.harness]: codexDesktop });

module.exports = { PROFILES, claudeDesktop, codexDesktop, deepLinkFor, defineProfile };
