'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { migrateLegacyStorage } = require('../lib/storage-migration');

function memoryFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  const writes = [];
  return {
    files,
    writes,
    readFileSync(name) {
      if (!files.has(name)) throw Object.assign(new Error(`ENOENT: ${name}`), { code: 'ENOENT' });
      const value = files.get(name);
      if (value instanceof Error) throw value;
      return value;
    },
    mkdirSync(name, options) { writes.push(['mkdir', name, options]); },
    writeFileSync(name, value, options) { writes.push(['write', name, options]); files.set(name, value); },
    renameSync(from, to) { files.set(to, files.get(from)); files.delete(from); }
  };
}

const appData = '/home/Library/Application Support';
const userData = `${appData}/Agent Auto-Continue`;
const legacy = `${appData}/t3code-auto-continue`;

test('copies config and jobs from the legacy directory when the new one is empty', () => {
  const fs = memoryFs({ [`${legacy}/config.json`]: '{"httpPort":3773}', [`${legacy}/jobs.json`]: '[]' });
  const result = migrateLegacyStorage({ fs, appData, userData });
  assert.deepEqual(result, { from: legacy, migrated: ['config.json', 'jobs.json'] });
  assert.equal(fs.files.get(`${userData}/config.json`), '{"httpPort":3773}');
  assert.equal(fs.files.get(`${userData}/jobs.json`), '[]');
  assert.equal(fs.files.get(`${legacy}/config.json`), '{"httpPort":3773}', 'the legacy copy is left in place');
  assert.ok(fs.writes.every(([kind, , options]) => kind !== 'write' || options.mode === 0o600), 'migrated files are owner-only');
  assert.ok(fs.writes.some(([kind, name]) => kind === 'mkdir' && name === userData));
  assert.ok(![...fs.files.keys()].some(name => name.endsWith('.migrating')), 'no temporary file is left behind');
});

test('never overwrites state the renamed app already has', () => {
  const fs = memoryFs({ [`${legacy}/config.json`]: 'old', [`${legacy}/jobs.json`]: 'old-jobs', [`${userData}/jobs.json`]: 'new-jobs' });
  const result = migrateLegacyStorage({ fs, appData, userData });
  assert.deepEqual(result.migrated, ['config.json']);
  assert.equal(fs.files.get(`${userData}/jobs.json`), 'new-jobs');
});

test('does nothing when there is no legacy directory', () => {
  const fs = memoryFs();
  assert.deepEqual(migrateLegacyStorage({ fs, appData, userData }).migrated, []);
  assert.deepEqual(fs.writes, []);
});

test('does nothing when the legacy and current directories are the same', () => {
  const fs = memoryFs({ [`${legacy}/config.json`]: 'x' });
  assert.deepEqual(migrateLegacyStorage({ fs, appData, userData: legacy }).migrated, []);
  assert.deepEqual(fs.writes, []);
});

test('an unreadable legacy file is reported rather than silently skipped', () => {
  const fs = memoryFs({ [`${legacy}/jobs.json`]: Object.assign(new Error('EACCES'), { code: 'EACCES' }) });
  assert.throws(() => migrateLegacyStorage({ fs, appData, userData }), /could not be read, so it was not migrated/);
  assert.deepEqual(fs.writes, []);
});
