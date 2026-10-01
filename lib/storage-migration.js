'use strict';

const path = require('node:path');

// The app was packaged as "t3code-auto-continue" before it was renamed. Electron derives the
// user-data directory from the product name, so the rename moved it. On first launch the renamed
// app copies the two state files from the old directory so nothing scheduled is lost.
const LEGACY_DIRECTORY = 't3code-auto-continue';
const MIGRATED_FILES = ['config.json', 'jobs.json'];

function readIfPresent(fs, file) {
  try {
    return fs.readFileSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw new Error(`The earlier data file ${file} exists but could not be read, so it was not migrated. Repair or remove it before restarting.`, { cause: error });
  }
}

function migrateLegacyStorage({ fs, appData, userData, legacyDirectory = LEGACY_DIRECTORY, files = MIGRATED_FILES }) {
  const from = path.join(appData, legacyDirectory);
  const migrated = [];
  if (path.resolve(from) === path.resolve(userData)) return { from, migrated };
  for (const name of files) {
    const target = path.join(userData, name);
    // Never overwrite: the renamed app may already have its own state.
    if (readIfPresent(fs, target) !== undefined) continue;
    const content = readIfPresent(fs, path.join(from, name));
    if (content === undefined) continue;
    fs.mkdirSync(userData, { recursive: true });
    const temp = `${target}.migrating`;
    fs.writeFileSync(temp, content, { mode: 0o600 });
    fs.renameSync(temp, target);
    migrated.push(name);
  }
  return { from, migrated };
}

module.exports = { LEGACY_DIRECTORY, MIGRATED_FILES, migrateLegacyStorage };
