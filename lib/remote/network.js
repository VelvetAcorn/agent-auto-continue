'use strict';

const net = require('node:net');
const os = require('node:os');

// The loopback listener always runs while remote control is enabled.
const LOOPBACK = '127.0.0.1';

function ipv4Octets(address) {
  return net.isIPv4(address) ? address.split('.').map(Number) : null;
}

function ipv6Prefix(address) {
  if (!net.isIPv6(address)) return null;
  // Expand "::" so the leading hextets can be compared numerically.
  const [head, tail = ''] = address.toLowerCase().split('%')[0].split('::');
  const left = head ? head.split(':') : [];
  const right = address.includes('::') && tail ? tail.split(':') : [];
  const groups = address.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  return groups.map((group) => parseInt(group || '0', 16));
}

/**
 * Classifies an address the control API may bind to.
 * Only loopback, the Tailscale overlay and private (RFC 1918 / ULA) ranges qualify.
 * Wildcard, link-local and public addresses always return null.
 */
function classifyAddress(address) {
  const v4 = ipv4Octets(address);
  if (v4) {
    if (address === LOOPBACK) return 'loopback';
    if (v4[0] === 100 && v4[1] >= 64 && v4[1] <= 127) return 'tailscale';
    if (v4[0] === 10 || (v4[0] === 172 && v4[1] >= 16 && v4[1] <= 31) || (v4[0] === 192 && v4[1] === 168)) return 'private';
    return null;
  }
  const v6 = ipv6Prefix(address);
  if (!v6 || address.includes('%')) return null;
  if (v6[0] === 0xfd7a && v6[1] === 0x115c && v6[2] === 0xa1e0) return 'tailscale';
  if ((v6[0] & 0xfe00) === 0xfc00) return 'private';
  return null;
}

const KIND_LABELS = { tailscale: 'Tailscale', private: 'Local network' };

/** Lists the non-loopback addresses on this Mac that the control API may bind to. */
function listBindableAddresses(interfaces = os.networkInterfaces()) {
  const found = [];
  for (const [name, entries] of Object.entries(interfaces || {})) {
    for (const entry of entries || []) {
      const kind = classifyAddress(entry?.address);
      if (!kind || kind === 'loopback' || entry.internal) continue;
      if (found.some((item) => item.address === entry.address)) continue;
      found.push({ address: entry.address, interface: name, kind, label: `${KIND_LABELS[kind]} · ${entry.address} (${name})` });
    }
  }
  // Tailscale first, then IPv4 before IPv6, so the recommended option leads.
  return found.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'tailscale' ? -1 : 1) || (net.isIPv4(b.address) - net.isIPv4(a.address)) || a.address.localeCompare(b.address));
}

/** Returns the URL host form of an address, bracketing IPv6 literals. */
function urlHost(address) {
  return net.isIPv6(address) ? `[${address}]` : address;
}

module.exports = { LOOPBACK, classifyAddress, listBindableAddresses, urlHost };
