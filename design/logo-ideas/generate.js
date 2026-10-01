const fs = require('fs');
const out = 'design/logo-ideas';
const INK = '#34303A', PAPER = '#F8F6F1', BG = '#ECE8E1', ACC = '#796B98', AMBER = '#D3A065', GREEN = '#537362';

// Shared paper tile with hard offset shadow
const tile = (inner, id) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  <rect x="34" y="34" width="196" height="196" rx="40" fill="${INK}"/>
  <rect x="22" y="22" width="196" height="196" rx="40" fill="${PAPER}" stroke="${INK}" stroke-width="8"/>
  ${inner}
</svg>`;

function starPoints(cx, cy, outer, inner, n) {
  const pts = [];
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = (Math.PI * i) / n - Math.PI / 2;
    pts.push(`${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`);
  }
  return pts.join(' ');
}

const play = (cx, cy, s, fill, stroke = INK, sw = 8) =>
  `<polygon points="${cx - s * 0.42},${cy - s * 0.5} ${cx + s * 0.58},${cy} ${cx - s * 0.42},${cy + s * 0.5}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" stroke-linejoin="round"/>`;

const concepts = {};

// A. Later Play - clock ring with a play triangle as its face
concepts['a-later-play'] = tile(`
  <circle cx="120" cy="120" r="66" fill="${BG}" stroke="${INK}" stroke-width="8"/>
  <g stroke="${INK}" stroke-width="8" stroke-linecap="round">
    <line x1="120" y1="62" x2="120" y2="74"/><line x1="120" y1="166" x2="120" y2="178"/>
    <line x1="62" y1="120" x2="74" y2="120"/><line x1="166" y1="120" x2="178" y2="120"/>
  </g>
  ${play(124, 120, 60, ACC)}
`);

// B. Ellipsis Arrow - a thread trailing off, then picked back up
concepts['b-ellipsis-arrow'] = tile(`
  <circle cx="64" cy="120" r="11" fill="${INK}"/>
  <circle cx="98" cy="120" r="13" fill="${INK}"/>
  <circle cx="134" cy="120" r="15" fill="${INK}"/>
  ${play(176, 120, 48, ACC)}
`);

// C. Spoke Star - the existing Support star, repurposed as the mark
concepts['c-spoke-star'] = tile(`
  <polygon points="${starPoints(120, 120, 86, 68, 16)}" fill="${ACC}" stroke="${INK}" stroke-width="7" stroke-linejoin="round"/>
  ${play(126, 120, 54, PAPER)}
`);

// D. Thread Loop - a return arrow that lands on a play head
concepts['d-thread-loop'] = tile(`
  <path d="M 76 78 A 66 66 0 1 1 72 158" fill="none" stroke="${INK}" stroke-width="12" stroke-linecap="round"/>
  <polygon points="54,148 92,142 72,178" fill="${INK}" stroke="${INK}" stroke-width="6" stroke-linejoin="round"/>
  ${play(126, 122, 52, ACC)}
`);

// E. Page and Clock - a thread page with a scheduled time badge
concepts['e-page-clock'] = tile(`
  <path d="M 66 50 h 76 l 36 36 v 120 h -112 z" fill="${BG}" stroke="${INK}" stroke-width="8" stroke-linejoin="round"/>
  <path d="M 142 50 v 36 h 36" fill="${PAPER}" stroke="${INK}" stroke-width="8" stroke-linejoin="round"/>
  <g stroke="${INK}" stroke-width="8" stroke-linecap="round">
    <line x1="86" y1="112" x2="150" y2="112"/><line x1="86" y1="136" x2="130" y2="136"/>
  </g>
  <circle cx="166" cy="166" r="40" fill="${ACC}" stroke="${INK}" stroke-width="8"/>
  <path d="M 166 144 v 24 l 16 10" fill="none" stroke="${PAPER}" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>
`);

// F. Pause Play - the pause bars become a play head: "paused, then continued"
concepts['f-pause-to-play'] = tile(`
  <rect x="58" y="76" width="26" height="88" rx="6" fill="${INK}"/>
  <rect x="100" y="76" width="26" height="88" rx="6" fill="${INK}"/>
  ${play(170, 120, 56, ACC)}
`);

for (const [name, svg] of Object.entries(concepts)) fs.writeFileSync(`${out}/${name}.svg`, svg);

// Monochrome 18px tray versions (template images: black only)
const tray = {
  'a-later-play': `<circle cx="9" cy="9" r="7.5" fill="none" stroke="#000" stroke-width="1.6"/><polygon points="7,5.5 12.5,9 7,12.5" fill="#000"/>`,
  'b-ellipsis-arrow': `<circle cx="2.5" cy="9" r="1.5" fill="#000"/><circle cx="7" cy="9" r="1.75" fill="#000"/><polygon points="11,4.5 17,9 11,13.5" fill="#000"/>`,
  'c-spoke-star': `<polygon points="${starPoints(9, 9, 8.6, 6.6, 16)}" fill="#000"/><polygon points="7,5.5 12.5,9 7,12.5" fill="#fff"/>`,
  'd-thread-loop': `<path d="M 9 2.2 A 6.8 6.8 0 1 1 3.6 4.6" fill="none" stroke="#000" stroke-width="1.8" stroke-linecap="round"/><polygon points="1.5,1.5 6,3.5 2.5,7" fill="#000"/><polygon points="7.5,6.5 12.5,9.3 7.5,12.1" fill="#000"/>`,
  'f-pause-to-play': `<rect x="2" y="4" width="3" height="10" rx="1" fill="#000"/><rect x="6.5" y="4" width="3" height="10" rx="1" fill="#000"/><polygon points="11.5,4 17.5,9 11.5,14" fill="#000"/>`,
};
for (const [name, inner] of Object.entries(tray)) {
  fs.writeFileSync(`${out}/${name}-tray.svg`, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18">${inner}</svg>`);
}

// Wordmark lockups
const word = (mark, label, file) => fs.writeFileSync(`${out}/${file}`, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 220" width="1000" height="220">
  <g transform="translate(20,-18) scale(1)">${mark.replace(/<svg[^>]*>|<\/svg>/g, '')}</g>
  <text x="300" y="138" font-family="Fraunces, Georgia, serif" font-weight="900" font-size="80" letter-spacing="-2.5" fill="${INK}">${label}</text>
</svg>`);
word(concepts['a-later-play'], 'Auto<tspan fill="' + ACC + '">-</tspan>Continue', 'wordmark-a.svg');
word(concepts['b-ellipsis-arrow'], 'Continue<tspan fill="' + ACC + '">…</tspan>', 'wordmark-b.svg');

// Contact sheet
const names = Object.keys(concepts);
const titles = {
  'a-later-play': 'A. Later Play', 'b-ellipsis-arrow': 'B. Ellipsis Arrow', 'c-spoke-star': 'C. Spoke Star',
  'd-thread-loop': 'D. Thread Loop', 'e-page-clock': 'E. Page and Clock', 'f-pause-to-play': 'F. Pause to Play',
};
const cell = (n) => `<div class="cell"><div class="big">${concepts[n]}</div>
  <div class="small">${tray[n] ? `<div class="bar"><svg viewBox="0 0 18 18" width="18" height="18">${tray[n]}</svg><span>Menu bar</span></div>` : '<div class="bar dim">No tray variant</div>'}
  <div class="tiny">${concepts[n].replace('width="256" height="256"', 'width="32" height="32"')} ${concepts[n].replace('width="256" height="256"', 'width="16" height="16"')}</div></div>
  <h3>${titles[n]}</h3></div>`;
fs.writeFileSync(`${out}/contact-sheet.html`, `<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:${BG};font-family:Inter,-apple-system,sans-serif;color:${INK};padding:40px}
h1{font-family:Fraunces,Georgia,serif;font-weight:900;font-size:34px;margin:0 0 24px;letter-spacing:-1px}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:28px}
.cell{background:${PAPER};border:2px solid ${INK};border-radius:14px;box-shadow:4px 4px 0 ${INK};padding:24px;display:flex;flex-direction:column;align-items:center;gap:14px}
h3{margin:0;font-size:15px}
.small{display:flex;align-items:center;gap:22px}
.bar{display:flex;align-items:center;gap:8px;background:#e5e3df;border:1px solid #c9c5bd;border-radius:6px;padding:4px 10px;font-size:12px}
.dim{color:#6C6773}
.tiny{display:flex;gap:10px;align-items:center}
.words{margin-top:36px;display:grid;gap:20px}
.words svg{background:${PAPER};border:2px solid ${INK};border-radius:14px;box-shadow:4px 4px 0 ${INK};width:100%;max-width:1000px}
</style><h1>Agent Auto-Continue - logo concepts</h1>
<div class="grid">${names.map(cell).join('')}</div>
<div class="words">${fs.readFileSync(`${out}/wordmark-a.svg`, 'utf8')}${fs.readFileSync(`${out}/wordmark-b.svg`, 'utf8')}</div>`);
console.log('ok');
