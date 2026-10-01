'use strict';

// Minimal RFC 6455 client codec for talking JSON-RPC to the Codex app-server
// daemon through `codex app-server proxy`, which relays raw socket bytes over
// stdio. Only what that link needs: the upgrade handshake, masked text frames,
// fragmented messages, ping/pong and close.
const crypto = require('node:crypto');

const OPCODES = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa };
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

function handshakeRequest(key = crypto.randomBytes(16).toString('base64'), host = 'localhost') {
  return { key, text: `GET / HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n` };
}

function expectedAccept(key) {
  return crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
}

// Client frames are always masked (RFC 6455 section 5.3).
function encodeFrame(opcode, payload = Buffer.alloc(0), mask = crypto.randomBytes(4)) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  let header;
  if (data.length < 126) header = Buffer.from([0x80 | opcode, 0x80 | data.length]);
  else if (data.length < 65_536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 0x80 | 126; header.writeUInt16BE(data.length, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(data.length), 2); }
  const masked = Buffer.alloc(data.length);
  for (let index = 0; index < data.length; index++) masked[index] = data[index] ^ mask[index % 4];
  return Buffer.concat([header, mask, masked]);
}

// Incremental decoder. `push(chunk)` returns the events completed so far:
// { type: 'handshake', ok, status } once, then { type: 'message', text },
// { type: 'ping', payload }, { type: 'close' } or { type: 'error', message }.
function createDecoder(key) {
  let buffer = Buffer.alloc(0);
  let upgraded = false;
  let fragments = [];
  let fragmentBytes = 0;
  return {
    push(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      const events = [];
      if (!upgraded) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return buffer.length > 16_384 ? [{ type: 'error', message: 'WebSocket handshake too large' }] : events;
        const lines = buffer.subarray(0, end).toString('latin1').split('\r\n');
        buffer = buffer.subarray(end + 4);
        const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(lines[0])?.[1]);
        const accept = lines.find((line) => /^sec-websocket-accept:/i.test(line))?.split(':').slice(1).join(':').trim();
        const ok = status === 101 && accept === expectedAccept(key);
        events.push({ type: 'handshake', ok, status });
        if (!ok) return events;
        upgraded = true;
      }
      while (buffer.length >= 2) {
        const fin = (buffer[0] & 0x80) !== 0;
        const opcode = buffer[0] & 0x0f;
        const masked = (buffer[1] & 0x80) !== 0;
        let length = buffer[1] & 0x7f, offset = 2;
        if (length === 126) { if (buffer.length < 4) break; length = buffer.readUInt16BE(2); offset = 4; }
        else if (length === 127) { if (buffer.length < 10) break; const big = buffer.readBigUInt64BE(2); if (big > BigInt(MAX_MESSAGE_BYTES)) return [...events, { type: 'error', message: 'WebSocket frame too large' }]; length = Number(big); offset = 10; }
        const maskBytes = masked ? 4 : 0;
        if (buffer.length < offset + maskBytes + length) break;
        let payload = buffer.subarray(offset + maskBytes, offset + maskBytes + length);
        if (masked) { const mask = buffer.subarray(offset, offset + 4); payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4])); }
        buffer = buffer.subarray(offset + maskBytes + length);
        if (opcode === OPCODES.ping) events.push({ type: 'ping', payload });
        else if (opcode === OPCODES.close) events.push({ type: 'close' });
        else if (opcode === OPCODES.pong) continue;
        else if (opcode === OPCODES.text || opcode === OPCODES.binary || opcode === OPCODES.continuation) {
          fragments.push(payload); fragmentBytes += payload.length;
          if (fragmentBytes > MAX_MESSAGE_BYTES) return [...events, { type: 'error', message: 'WebSocket message too large' }];
          if (fin) { events.push({ type: 'message', text: Buffer.concat(fragments).toString('utf8') }); fragments = []; fragmentBytes = 0; }
        }
      }
      return events;
    }
  };
}

module.exports = { OPCODES, createDecoder, encodeFrame, expectedAccept, handshakeRequest };
