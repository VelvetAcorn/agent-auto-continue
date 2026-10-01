'use strict';
// Regenerates the committed icon assets from their SVG sources:
//   assets/icon.svg         -> assets/icon.icns (16px to 1024px, including @2x sizes)
//   assets/trayTemplate.svg -> assets/trayTemplate.png (18px) and assets/trayTemplate@2x.png (36px)
//   assets/trayAwakeTemplate.svg -> assets/trayAwakeTemplate.png (18px) and @2x (36px), shown while keep-awake holds
// Run with `npm run icons` on macOS. The SVGs are rasterised by Electron's offscreen
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

async function rasterise(window, svgFile, pixels) {
  const svg = fs.readFileSync(path.join(assets, svgFile));
  const url = `data:image/svg+xml;base64,${svg.toString('base64')}`;
  const dataUrl = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = ${pixels};
      canvas.getContext('2d').drawImage(image, 0, 0, ${pixels}, ${pixels});
      resolve(canvas.toDataURL('image/png'));
    };
    image.onerror = () => reject(new Error('Could not decode ${svgFile}'));
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
      fs.writeFileSync(path.join(iconset, `icon_${points}x${points}.png`), await rasterise(window, 'icon.svg', points));
      fs.writeFileSync(path.join(iconset, `icon_${points}x${points}@2x.png`), await rasterise(window, 'icon.svg', points * 2));
    }
    execFileSync('iconutil', ['--convert', 'icns', '--output', path.join(assets, 'icon.icns'), iconset], { stdio: 'inherit' });
  } finally {
    fs.rmSync(path.dirname(iconset), { recursive: true, force: true });
  }

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
