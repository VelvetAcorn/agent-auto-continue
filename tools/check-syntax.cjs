'use strict';
// Syntax-checks every production and tool script, including nested directories.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
function scripts(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return scripts(full);
    return /\.c?js$/.test(entry.name) ? [full] : [];
  });
}
const files = ['main.js', 'preload.js'].map((file) => path.join(root, file)).concat(...['lib', 'renderer', 'tools'].map((directory) => scripts(path.join(root, directory))));
let failed = 0;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) { failed++; process.stderr.write(result.stderr); }
}
console.log(`Checked ${files.length} scripts${failed ? `, ${failed} failed` : ''}.`);
process.exit(failed ? 1 : 0);
