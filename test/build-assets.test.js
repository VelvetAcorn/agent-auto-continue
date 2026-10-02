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

test('the menu-bar template images are 18px with a 36px Retina representation', () => {
  assert.ok(build.files.includes('assets/tray*Template*.png'));
  // The idle glyph, and the keep-awake glyph with its dot.
  for (const glyph of ['trayTemplate', 'trayAwakeTemplate']) {
    assert.deepEqual(pngSize(fs.readFileSync(path.join(root, `assets/${glyph}.png`))), { width: 18, height: 18 });
    assert.deepEqual(pngSize(fs.readFileSync(path.join(root, `assets/${glyph}@2x.png`))), { width: 36, height: 36 });
  }
});

test('the disk image has a stable name, a signature, and a HiDPI drag-to-Applications background', () => {
  const { dmg } = build;
  // https://github.com/VelvetAcorn/agent-auto-continue/releases/latest/download/Agent-Auto-Continue.dmg always serves the newest release.
  assert.equal(dmg.artifactName, 'Agent-Auto-Continue.${ext}');
  assert.doesNotMatch(dmg.artifactName, /\s|\$\{version\}/, 'GitHub rewrites spaces, and a version would break the stable link');
  assert.equal(dmg.sign, true);
  assert.equal(dmg.background, 'build/background.png');
  const one = pngSize(fs.readFileSync(path.join(root, 'build/background.png')));
  const two = pngSize(fs.readFileSync(path.join(root, 'build/background@2x.png')));
  // electron-builder sizes the window from the 1x background and merges the @2x file into a HiDPI TIFF.
  assert.deepEqual(one, { width: dmg.window.width, height: dmg.window.height });
  assert.deepEqual(two, { width: one.width * 2, height: one.height * 2 });
  // The app on the left, the Applications link on the right, level, with room for each icon and its name.
  const [file, link] = dmg.contents;
  assert.equal(file.type, 'file');
  assert.deepEqual([link.type, link.path], ['link', '/Applications']);
  assert.ok(file.x < link.x && file.y === link.y);
  const half = dmg.iconSize / 2;
  for (const item of dmg.contents) {
    assert.ok(item.x - half - 20 >= 0 && item.x + half + 20 <= one.width, `${item.type} fits horizontally with its name`);
    // Finder may take the title bar's height from the bottom of the window, so the names stay well clear of it.
    assert.ok(item.y - half >= 100 && item.y + half + 30 <= one.height - 60, `${item.type} fits vertically with its name`);
  }
});

test('the updater feed is GitHub Releases and only the versioned ZIP carries update information', () => {
  assert.deepEqual(build.publish, [{ provider: 'github', owner: 'VelvetAcorn', repo: 'agent-auto-continue' }]);
  assert.equal(build.artifactName, '${name}-${version}-${arch}.${ext}', 'the ZIP stays versioned for the updater');
  assert.deepEqual(build.mac.target, ['dmg', 'zip']);
  // Stapling the DMG after the build changes its bytes, so it stays out of latest-mac.yml; macOS updates come from the ZIP.
  assert.equal(build.dmg.writeUpdateInfo, false);
  const { dependencies, devDependencies } = require('../package.json');
  assert.ok(dependencies['electron-updater'], 'electron-updater ships inside the app, so it is a dependency');
  assert.equal(devDependencies['electron-updater'], undefined);
});
