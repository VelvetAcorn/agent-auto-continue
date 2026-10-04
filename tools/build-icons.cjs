'use strict';
// Regenerates the committed icon assets from their sources:
//   assets/icon.png         -> assets/icon.icns (16px to 1024px, including @2x sizes) and assets/logo.webp (the header mark)
//                              The 1024px master is the painted crescent built by design/logo-ideas/round4/generate.py.
//   assets/trayTemplate.svg -> assets/trayTemplate.png (18px) and assets/trayTemplate@2x.png (36px)
//   assets/trayAwakeTemplate.svg -> assets/trayAwakeTemplate.png (18px) and @2x (36px), shown while keep-awake holds
// Run with `npm run icons` on macOS. The sources are rasterised by Electron's offscreen
// renderer and the .icns is packed by the system `iconutil`, so no extra dependencies are needed.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const assets = path.resolve(__dirname, '..', 'assets');
// Every point size macOS looks up in an app icon, each at 1x and 2x.
const ICON_POINT_SIZES = [16, 32, 128, 256, 512];
// The tray glyphs are drawn on an 18pt grid; each @2x file is its Retina representation.
const TRAY_POINT_SIZE = 18;
const TRAY_GLYPHS = ['trayTemplate', 'trayAwakeTemplate'];

// The header shows the mark at 22pt; 88px covers Retina with room to spare.
const LOGO_PIXELS = 88;

async function rasterise(window, sourceFile, pixels, type = 'image/png', quality) {
  const source = fs.readFileSync(path.join(assets, sourceFile));
  const url = `data:${sourceFile.endsWith('.svg') ? 'image/svg+xml' : 'image/png'};base64,${source.toString('base64')}`;
  const dataUrl = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = ${pixels};
      const context = canvas.getContext('2d');
      if (${JSON.stringify(!sourceFile.endsWith('.svg'))}) context.imageSmoothingQuality = 'high';
      context.drawImage(image, 0, 0, ${pixels}, ${pixels});
      resolve(canvas.toDataURL(${JSON.stringify(type)}, ${JSON.stringify(quality)}));
    };
    image.onerror = () => reject(new Error('Could not decode ${sourceFile}'));
    image.src = ${JSON.stringify(url)};
  })`);
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
}

async function run() {
  if (process.platform !== 'darwin') throw new Error('Icon generation needs macOS for iconutil.');
  await app.whenReady();
  app.dock?.hide();
  const window = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await window.loadURL('about:blank');

  const iconset = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'app-icon-')), 'icon.iconset');
  fs.mkdirSync(iconset);
  try {
    for (const points of ICON_POINT_SIZES) {
      fs.writeFileSync(path.join(iconset, `icon_${points}x${points}.png`), await rasterise(window, 'icon.png', points));
      fs.writeFileSync(path.join(iconset, `icon_${points}x${points}@2x.png`), await rasterise(window, 'icon.png', points * 2));
    }
    execFileSync('iconutil', ['--convert', 'icns', '--output', path.join(assets, 'icon.icns'), iconset], { stdio: 'inherit' });
  } finally {
    fs.rmSync(path.dirname(iconset), { recursive: true, force: true });
  }

  fs.writeFileSync(path.join(assets, 'logo.webp'), await rasterise(window, 'icon.png', LOGO_PIXELS, 'image/webp', 0.92));

  for (const glyph of TRAY_GLYPHS) {
    fs.writeFileSync(path.join(assets, `${glyph}.png`), await rasterise(window, `${glyph}.svg`, TRAY_POINT_SIZE));
    fs.writeFileSync(path.join(assets, `${glyph}@2x.png`), await rasterise(window, `${glyph}.svg`, TRAY_POINT_SIZE * 2));
  }
  console.log(`Wrote assets/icon.icns and ${TRAY_GLYPHS.map(glyph => `assets/${glyph}.png and @2x`).join(', ')}.`);
}

if (!app) {
  console.error('Run this script with Electron (`npm run icons`), and unset ELECTRON_RUN_AS_NODE.');
  process.exit(1);
}
run().then(() => app.exit(0), error => { console.error(error.stack); app.exit(1); });
