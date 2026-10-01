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
 * Classifies an address the control API may bind to: `loopback` for 127.0.0.1, `tailscale`
 * for Tailscale's ranges (100.64.0.0/10 and fd7a:115c:a1e0::/48), otherwise null.
 * Ordinary local-network (RFC 1918, ULA), wildcard, link-local and public addresses are never
 * allowed, because on a shared network the bearer token would travel unencrypted.
 */
function classifyAddress(address) {
  const v4 = ipv4Octets(address);
  if (v4) {
    if (address === LOOPBACK) return 'loopback';
    if (v4[0] === 100 && v4[1] >= 64 && v4[1] <= 127) return 'tailscale';
    return null;
  }
  const v6 = ipv6Prefix(address);
  if (!v6 || address.includes('%')) return null;
  if (v6[0] === 0xfd7a && v6[1] === 0x115c && v6[2] === 0xa1e0) return 'tailscale';
  return null;
}

// Tailscale runs as a tunnel interface (utunN on macOS, tailscaleN elsewhere). Carrier-grade NAT,
// for example a phone hotspot, hands out addresses from the same 100.64.0.0/10 range on an ordinary
// interface, so an address in that range only counts on a tunnel interface.
const TUNNEL_INTERFACE = /^(utun|tailscale)\d*$/;

/** Lists the Tailscale addresses on this Mac that the control API may bind to, IPv4 first. */
function listBindableAddresses(interfaces = os.networkInterfaces()) {
  const found = [];
  for (const [name, entries] of Object.entries(interfaces || {})) {
    if (!TUNNEL_INTERFACE.test(name)) continue;
    for (const entry of entries || []) {
      if (classifyAddress(entry?.address) !== 'tailscale' || entry.internal) continue;
      if (found.some((item) => item.address === entry.address)) continue;
      found.push({ address: entry.address, interface: name, kind: 'tailscale', label: `Tailscale · ${entry.address} (${name})` });
    }
  }
  return found.sort((a, b) => (net.isIPv4(b.address) - net.isIPv4(a.address)) || a.address.localeCompare(b.address));
}

/** Returns the URL host form of an address, bracketing IPv6 literals. */
function urlHost(address) {
  return net.isIPv6(address) ? `[${address}]` : address;
}

module.exports = { LOOPBACK, classifyAddress, listBindableAddresses, urlHost };
