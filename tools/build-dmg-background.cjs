'use strict';
// Regenerates the disk image window background from the SVG drawn below:
//   build/background.png    (640 x 400, the window size in points)
//   build/background@2x.png (1280 x 800, the Retina representation)
// electron-builder combines the two into one HiDPI TIFF when it makes the DMG.
// Run with `npm run dmg-background` on macOS. The SVG is rasterised by Electron's offscreen
// renderer, like the app icons, so no extra dependencies are needed and the output is reproducible.
//
// The layout matches build.dmg in package.json: the app icon sits at (170, 212), the Applications
// link at (470, 212), both at 112 px. Finder draws the icons and their names; the background only
// carries the heading, the arrow and the drop slot. Nothing is drawn in the bottom 60 px, which
// Finder may cover with the window's title bar height.
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const WIDTH = 640;
const HEIGHT = 400;
const out = path.resolve(__dirname, '..', 'build');
// Day tokens from styles.css: plaster ground, umber ink and gilt.
const INK = '#2C2118';
const MUTED = '#5F5142';
const PAPER = '#EFE7D6';
const RAISED = '#FBF6EA';
const ACCENT = '#8A6A2A';
const SELECTED = '#C9A652';

// A gentle arc from the app icon towards the drop slot, ending in an open arrowhead along its tangent.
function arrow({ from, control1, control2, to, head = 17, spread = 30 }) {
  const angle = Math.atan2(to[1] - control2[1], to[0] - control2[0]);
  const wing = (sign) => [to[0] - head * Math.cos(angle + sign * spread * Math.PI / 180), to[1] - head * Math.sin(angle + sign * spread * Math.PI / 180)];
  const point = (value) => value.map((number) => number.toFixed(1)).join(' ');
  return `M ${point(from)} C ${point(control1)}, ${point(control2)}, ${point(to)} M ${point(wing(1))} L ${point(to)} L ${point(wing(-1))}`;
}

function svg() {
  const stroke = arrow({ from: [250, 208], control1: [284, 178], control2: [334, 176], to: [372, 202] });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <rect width="${WIDTH}" height="${HEIGHT}" fill="${PAPER}"/>
  <text x="320" y="74" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-weight="700" font-size="25" letter-spacing="-0.4" fill="${INK}">Drag into Applications</text>
  <text x="320" y="100" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-style="italic" font-size="14" fill="${MUTED}">Then open it from there. It keeps itself up to date.</text>
  <rect x="394" y="130" width="152" height="170" rx="24" fill="${RAISED}" stroke="${ACCENT}" stroke-width="2.5" stroke-dasharray="9 7"/>
  <path d="${stroke}" transform="translate(3.5 3.5)" fill="none" stroke="${SELECTED}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="${stroke}" fill="none" stroke="${INK}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
}

async function rasterise(window, markup, scale) {
  const url = `data:image/svg+xml;base64,${Buffer.from(markup).toString('base64')}`;
  const dataUrl = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = ${WIDTH * scale};
      canvas.height = ${HEIGHT * scale};
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/png'));
    };
    image.onerror = () => reject(new Error('Could not decode the background SVG'));
    image.src = ${JSON.stringify(url)};
  })`);
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
}

async function run() {
  if (process.platform !== 'darwin') throw new Error('Background generation needs macOS for its system fonts.');
  await app.whenReady();
  app.dock?.hide();
  const window = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await window.loadURL('about:blank');
  // Let the system fonts load before the first rasterisation.
  await window.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
  const markup = svg();
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'background.png'), await rasterise(window, markup, 1));
  fs.writeFileSync(path.join(out, 'background@2x.png'), await rasterise(window, markup, 2));
  console.log(`Wrote build/background.png (${WIDTH}x${HEIGHT}) and build/background@2x.png (${WIDTH * 2}x${HEIGHT * 2}).`);
}

if (!app) {
  console.error('Run this script with Electron (`npm run dmg-background`), and unset ELECTRON_RUN_AS_NODE.');
  process.exit(1);
}
run().then(() => app.exit(0), error => { console.error(error.stack); app.exit(1); });
