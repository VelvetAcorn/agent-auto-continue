'use strict';
// Renders the simple-direction sketches into shots/ with Electron's capturePage (never screencapture).
// Usage from the repository root: env -u ELECTRON_RUN_AS_NODE npx electron design/mockups/simple/capture.cjs [outDir]
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const out = path.resolve(process.argv[2] || path.join(__dirname, 'shots'));
const shots = [
  // [file, page, query, width]
  ['01-rail', '01-rail.html', '', 560],
  ['01-rail-dark', '01-rail.html', 'theme=dark', 560],
  ['01-rail-custom-time', '01-rail.html', 's=custom', 560],
  ['01-rail-picker', '01-rail.html', 's=picker', 560],
  ['01-rail-settings', '01-rail.html', 's=settings', 560],
  ['01-rail-settings-dark', '01-rail.html', 's=settings&theme=dark', 560],
  ['01-rail-empty', '01-rail.html', 's=empty', 560],
  ['01-rail-hover', '01-rail.html', 's=hover', 560],
  ['01-rail-awake-tip', '01-rail.html', 's=tip', 560],
  ['02-app', '02-app.html', '', 900],
  ['02-app-dark', '02-app.html', 'theme=dark', 900],
  ['02-app-custom-time', '02-app.html', 's=custom', 900],
  ['02-app-settings', '02-app.html', 's=settings', 900],
  ['02-app-settings-dark', '02-app.html', 's=settings&theme=dark', 900],
  ['02-app-empty', '02-app.html', 's=empty', 900],
  ['02-app-hover', '02-app.html', 's=hover', 900],
  ['02-app-awake-tip-dark', '02-app.html', 's=tip&theme=dark', 900]
];

app.whenReady().then(async () => {
  fs.mkdirSync(out, { recursive: true });
  const win = new BrowserWindow({ show: false, width: 900, height: 800, webPreferences: { backgroundThrottling: false } });
  for (const [name, page, query, width] of shots) {
    win.setContentSize(width, 800);
    await win.loadURL(`file://${path.join(__dirname, page)}${query ? '?' + query : ''}`);
    await win.webContents.executeJavaScript('document.documentElement.style.overflow = "hidden", document.fonts.ready.then(() => new Promise(r => setTimeout(r, 250)))');
    const height = await win.webContents.executeJavaScript('Math.max(document.documentElement.scrollHeight, 600)');
    win.setContentSize(width, height);
    await new Promise((resolve) => setTimeout(resolve, 250));
    let image = await win.webContents.capturePage();
    if (image.getSize().width > width) image = image.resize({ width, quality: 'best' });
    fs.writeFileSync(path.join(out, `${name}.png`), image.toPNG());
  }
  console.log(`Captured ${shots.length} sketches into ${out}`);
  app.exit(0);
}).catch((error) => { console.error(error); app.exit(1); });
