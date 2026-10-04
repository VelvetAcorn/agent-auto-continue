'use strict';
// Renders round4/preview.html to preview.png with Electron's capturePage (never screencapture).
// Run generate.py first, then from the repository root:
//   env -u ELECTRON_RUN_AS_NODE npx electron design/logo-ideas/round4/capture.cjs
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

// One CSS pixel per image pixel, so the pre-reduced 16 and 32 px icons are shown exactly as made.
app.commandLine.appendSwitch('force-device-scale-factor', '1');

const WIDTH = 1800;
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: WIDTH, height: 1000, webPreferences: { backgroundThrottling: false } });
  await win.loadFile(path.join(__dirname, 'preview.html'));
  await win.webContents.executeJavaScript('document.documentElement.style.overflow = "hidden", document.fonts.ready.then(() => new Promise(r => setTimeout(r, 400)))');
  const height = await win.webContents.executeJavaScript('Math.ceil(document.body.getBoundingClientRect().height)');
  win.setContentSize(WIDTH, height);
  await new Promise((resolve) => setTimeout(resolve, 400));
  let image = await win.webContents.capturePage();
  if (image.getSize().width > WIDTH) image = image.resize({ width: WIDTH, quality: 'best' });
  const out = path.join(__dirname, 'preview.png');
  fs.writeFileSync(out, image.toPNG());
  console.log(`Captured ${out} (${image.getSize().width}x${image.getSize().height})`);
  win.destroy();
  app.exit(0);
  setTimeout(() => process.exit(0), 3000).unref(); // app.exit alone can leave the process hanging
}).catch((error) => { console.error(error); app.exit(1); setTimeout(() => process.exit(1), 3000).unref(); });
