'use strict';

// qrcode-generator is a dependency-free, MIT-licensed encoder; see docs/remote-control.md.
const qrcode = require('qrcode-generator');

/** Encodes text as a scalable black-on-white SVG QR code data URL for an <img> element. */
function qrDataUrl(text) {
  const code = qrcode(0, 'M');
  code.addData(text, 'Byte');
  code.make();
  const svg = code.createSvgTag({ cellSize: 4, margin: 16, scalable: true, title: 'Device token QR code' });
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

module.exports = { qrDataUrl };
