'use strict';
// Captures the feature prototypes (05-08) as full-page screenshots.
// Usage from the repository root: env -u ELECTRON_RUN_AS_NODE npx electron design/mockups/capture.cjs [outDir]
// Loads index.html from disk; Google Fonts load when online and fall back to Georgia/system sans otherwise.
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const out = path.resolve(process.argv[2] || path.join(__dirname, 'screenshots'));
const page = path.join(__dirname, 'index.html');
const shots = [
  // [file, query, width]
  ['05-board-tonight', 'concept=board', 1180],
  ['05-board-tonight-dark', 'concept=board&theme=dark', 1180],
  ['05-board-something-wrong', 'concept=board&scenario=trouble', 1180],
  ['05-board-next-morning', 'concept=board&scenario=morning', 1180],
  ['05-board-empty', 'concept=board&scenario=empty', 1180],
  ['05-board-awake-chip-only', 'concept=board&awake=strip', 1180],
  ['05-board-words-handoff', 'concept=board&words=handoff', 1180],
  ['05-board-620', 'concept=board', 620],
  ['05-board-420-dark', 'concept=board&theme=dark', 420],
  ['05-compose-when-free-until-done', 'concept=board&view=compose&stops=1', 1180],
  ['05-compose-at-a-time-dark', 'concept=board&view=compose&when=time&far=turns&turns=3&theme=dark', 1180],
  ['05-compose-turn-error', 'concept=board&view=compose&far=turns&turns=0', 1180],
  ['05-compose-presets', 'concept=board&view=compose&composer=presets', 1180],
  ['05-compose-420', 'concept=board&view=compose', 420],
  ['05-picker-grouped', 'concept=board&view=picker', 1180],
  ['05-picker-agent-first', 'concept=board&view=picker&picker=agent', 1180],
  ['05-detail-needs-you', 'concept=board&view=detail&task=billing', 1180],
  ['05-detail-running-dark', 'concept=board&view=detail&task=sched&theme=dark', 1180],
  ['05-agents', 'concept=board&view=agents&agent=CL', 1180],
  ['05-agents-add', 'concept=board&view=agents&agent=&add=1', 1180],
  ['05-settings-awake-phone', 'concept=board&view=settings&pairing=1', 1180],
  ['05-settings-420-dark', 'concept=board&view=settings&theme=dark', 420],
  ['05-history', 'concept=board&view=history', 1180],
  ['06-queue-tonight', 'concept=queue', 1180],
  ['06-queue-tonight-dark', 'concept=queue&theme=dark', 1180],
  ['07-phone', 'concept=phone', 1000],
  ['07-phone-unreachable-dark', 'concept=phone&scenario=trouble&theme=dark', 1000],
  ['08-menu-bar', 'concept=tray', 1180],
  ['08-menu-bar-dark', 'concept=tray&theme=dark', 1180]
];

app.whenReady().then(async () => {
  fs.mkdirSync(out, { recursive: true });
  const win = new BrowserWindow({ show: false, width: 1180, height: 800, webPreferences: { backgroundThrottling: false } });
  for (const [name, query, width] of shots) {
    win.setContentSize(width, 800);
    await win.loadURL(`file://${page}?${query}`);
    await win.webContents.executeJavaScript('document.documentElement.style.overflow = "hidden", document.fonts.ready.then(() => new Promise(r => setTimeout(r, 250)))');
    const height = await win.webContents.executeJavaScript('Math.max(document.documentElement.scrollHeight, 800)');
    win.setContentSize(width, height);
    await new Promise((resolve) => setTimeout(resolve, 250));
    let image = await win.webContents.capturePage();
    if (image.getSize().width > width) image = image.resize({ width, quality: 'best' });
    fs.writeFileSync(path.join(out, `${name}.png`), image.toPNG());
  }
  console.log(`Captured ${shots.length} prototype screenshots into ${out}`);
  app.exit(0);
}).catch((error) => { console.error(error); app.exit(1); });
