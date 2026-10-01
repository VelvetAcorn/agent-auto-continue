'use strict';
// Round 2 logo drafts: transparent background, no paper tile.
// Outlines and lettering use currentColor so the same file works on light (ink) and dark (bone) surfaces.
const fs = require('fs');
const path = require('path');
const out = __dirname;
const ACC = '#796B98', ACC_DARK = '#9D8CC2', BONE = '#F8F6F1';
const C = 'currentColor';
const FONT = 'Fraunces, Georgia, serif';

const wrap = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">${inner}</svg>`;
const star = (cx, cy, o, i, n) => Array.from({ length: n * 2 }, (_, k) => { const r = k % 2 ? i : o, a = Math.PI * k / n - Math.PI / 2; return `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`; }).join(' ');
const play = (cx, cy, s) => `${cx - s * .42},${cy - s * .5} ${cx + s * .58},${cy} ${cx - s * .42},${cy + s * .5}`;

const concepts = {
  // A. The user's suggestion: a big play head carrying a small lowercase "aac."
  'a-aac-play': wrap(`
    <polygon points="${play(128, 128, 190)}" fill="${ACC}" stroke="${C}" stroke-width="12" stroke-linejoin="round"/>
    <text x="104" y="142" text-anchor="middle" font-family="${FONT}" font-weight="900" font-size="46" letter-spacing="-1" fill="${BONE}">aac.</text>
  `),
  // B. A metronome on its side is a play button: it keeps time, then it goes.
  'b-metronome': wrap(`
    <polygon points="${play(128, 128, 190)}" fill="${ACC}" stroke="${C}" stroke-width="12" stroke-linejoin="round"/>
    <line x1="60" y1="128" x2="172" y2="128" stroke="${BONE}" stroke-width="10" stroke-linecap="round"/>
    <rect x="118" y="112" width="22" height="32" rx="5" fill="${C}" stroke="${BONE}" stroke-width="6"/>
    <circle cx="60" cy="128" r="9" fill="${C}"/>
  `),
  // C. An hourglass turned on its side: the left half is time passing, the right half is play.
  'c-hourglass': wrap(`
    <polygon points="34,54 128,128 34,202" fill="none" stroke="${C}" stroke-width="12" stroke-linejoin="round"/>
    <polygon points="34,54 128,128 34,202" fill="${C}" opacity="0.18"/>
    <polygon points="128,128 222,54 222,202" fill="${ACC}" stroke="${C}" stroke-width="12" stroke-linejoin="round"/>
    <polygon points="60,92 60,164 96,128" fill="${ACC}"/>
  `),
  // D. A crescent moon cradling a play head: keep the agent working while you sleep.
  'd-moon-play': wrap(`
    <path d="M 150 30 A 100 100 0 1 0 150 226 A 78 78 0 1 1 150 30 Z" fill="${ACC}" stroke="${C}" stroke-width="8" stroke-linejoin="round"/>
    <polygon points="${play(150, 128, 72)}" fill="${C}"/>
  `),
  // E. A terminal prompt where the chevron is a play head: the next input, sent for you.
  'e-prompt-caret': wrap(`
    <polygon points="${play(96, 110, 120)}" fill="${ACC}" stroke="${C}" stroke-width="12" stroke-linejoin="round"/>
    <rect x="156" y="150" width="68" height="20" rx="4" fill="${C}"/>
  `),
  // F. A speech bubble whose tail is a play head, lettered "aac." - a message that continues the thread.
  'f-bubble-tail': wrap(`
    <path d="M 46 48 h 164 a 20 20 0 0 1 20 20 v 96 a 20 20 0 0 1 -20 20 h -62 l -56 42 v -42 h -46 a 20 20 0 0 1 -20 -20 v -96 a 20 20 0 0 1 20 -20 z" fill="${ACC}" stroke="${C}" stroke-width="12" stroke-linejoin="round"/>
    <text x="128" y="134" text-anchor="middle" font-family="${FONT}" font-weight="900" font-size="60" letter-spacing="-2" fill="${BONE}">aac.</text>
  `),
  // G. The dot in "aac." becomes the play head: the name is the logo.
  'g-aac-dot': wrap(`
    <text x="10" y="166" font-family="${FONT}" font-weight="900" font-size="104" letter-spacing="-5" fill="${C}">aac</text>
    <polygon points="${play(216, 148, 40)}" fill="${ACC}" stroke="${C}" stroke-width="8" stroke-linejoin="round"/>
  `),
  // H. Burst: the spoke star from round one with the paper removed and "aac." inside the play head.
  'h-burst-aac': wrap(`
    <polygon points="${star(128, 128, 118, 94, 16)}" fill="${ACC}" stroke="${C}" stroke-width="10" stroke-linejoin="round"/>
    <polygon points="${play(134, 128, 112)}" fill="${BONE}" stroke="${C}" stroke-width="10" stroke-linejoin="round"/>
    <text x="118" y="139" text-anchor="middle" font-family="${FONT}" font-weight="900" font-size="30" letter-spacing="-1" fill="${C}">aac.</text>
  `),
};
const titles = {
  'a-aac-play': 'A. aac. Play', 'b-metronome': 'B. Metronome', 'c-hourglass': 'C. Hourglass', 'd-moon-play': 'D. Moon and Play',
  'e-prompt-caret': 'E. Prompt Caret', 'f-bubble-tail': 'F. Bubble Tail', 'g-aac-dot': 'G. aac dot', 'h-burst-aac': 'H. Burst aac.',
};
for (const [n, svg] of Object.entries(concepts)) fs.writeFileSync(path.join(out, `${n}.svg`), svg);

const INK = '#34303A', BONE_OUT = '#CFC8BB';
const cell = (n) => `<div class="cell">
  <div class="pair"><div class="light">${concepts[n]}</div><div class="dark">${concepts[n].replace(new RegExp(ACC, 'g'), ACC_DARK)}</div></div>
  <div class="tiny">${['64', '32', '16'].map(s => concepts[n].replace('width="256" height="256"', `width="${s}" height="${s}"`)).join('')}</div>
  <h3>${titles[n]}</h3></div>`;
fs.writeFileSync(path.join(out, 'contact-sheet.html'), `<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:#ECE8E1;font-family:Inter,-apple-system,sans-serif;color:${INK};padding:36px}
h1{font-family:${FONT};font-weight:900;font-size:32px;margin:0 0 22px;letter-spacing:-1px}
.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:24px}
.cell{display:flex;flex-direction:column;align-items:center;gap:12px}
.pair{display:flex;border:2px solid ${INK};border-radius:14px;overflow:hidden;box-shadow:4px 4px 0 ${INK}}
.light{background:#F8F6F1;color:${INK};padding:14px}.dark{background:#1F1C24;color:${BONE_OUT};padding:14px}
.pair svg{width:150px;height:150px}
.tiny{display:flex;gap:12px;align-items:center;color:${INK}}
h3{margin:0;font-size:14px}
</style><h1>Agent Auto-Continue - logo concepts, round 2 (transparent)</h1>
<div class="grid">${Object.keys(concepts).map(cell).join('')}</div>`);
console.log('ok');
