'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const { build } = require('../package.json');

function pngSize(buffer) {
  assert.equal(buffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG signature');
  assert.equal(buffer.toString('ascii', 12, 16), 'IHDR');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function icnsChunks(buffer) {
  assert.equal(buffer.toString('ascii', 0, 4), 'icns', 'icns magic');
  assert.equal(buffer.readUInt32BE(4), buffer.length, 'icns header length matches the file');
  const chunks = new Map();
  for (let offset = 8; offset < buffer.length;) {
    const length = buffer.readUInt32BE(offset + 4);
    assert.ok(length > 8 && offset + length <= buffer.length, 'icns chunk fits in the file');
    chunks.set(buffer.toString('ascii', offset, offset + 4), buffer.subarray(offset + 8, offset + length));
    offset += length;
  }
  return chunks;
}

test('the packaged app icon is a valid icns with every size up to 1024px', () => {
  assert.equal(build.icon, 'assets/icon.icns');
  const chunks = icnsChunks(fs.readFileSync(path.join(root, build.icon)));
  // 1x and @2x of every point size from 16 to 512. iconutil stores the 1x 16 and 32 point
  // images as ARGB (ic04, ic05) or PNG (icp4, icp5) depending on the macOS version.
  for (const types of [['ic04', 'icp4'], ['ic05', 'icp5'], ['ic11'], ['ic12'], ['ic07'], ['ic13'], ['ic08'], ['ic14'], ['ic09'], ['ic10']]) {
    assert.ok(types.some(type => chunks.has(type)), `icns contains ${types.join(' or ')}`);
  }
  assert.deepEqual(pngSize(chunks.get('ic10')), { width: 1024, height: 1024 });
});

test('every literal build.files entry exists', () => {
  for (const entry of build.files.filter(file => !/[*?{[]/.test(file))) {
    assert.ok(fs.existsSync(path.join(root, entry)), `${entry} is listed in build.files but missing`);
  }
});

test('the menu-bar template image is 18px with a 36px Retina representation', () => {
  assert.ok(build.files.includes('assets/trayTemplate*.png'));
  assert.deepEqual(pngSize(fs.readFileSync(path.join(root, 'assets/trayTemplate.png'))), { width: 18, height: 18 });
  assert.deepEqual(pngSize(fs.readFileSync(path.join(root, 'assets/trayTemplate@2x.png'))), { width: 36, height: 36 });
});
