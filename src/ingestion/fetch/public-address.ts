import { BlockList, isIP } from 'node:net';

// IANA special-purpose IPv4 ranges (RFC 6890 and friends).
const blockedV4 = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blockedV4.addSubnet(net, prefix, 'ipv4');
}

// IPv6: only global unicast (2000::/3), minus ranges that can tunnel to
// private IPv4 or are reserved. IPv4-mapped (::ffff:0:0/96) falls outside 2000::/3.
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const blockedV6 = new BlockList();
for (const [net, prefix] of [
  ['2001::', 32],
  ['2001:db8::', 32],
  ['2002::', 16],
] as const) {
  blockedV6.addSubnet(net, prefix, 'ipv6');
}

export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return !blockedV4.check(ip, 'ipv4');
  if (family === 6) {
    return globalV6.check(ip, 'ipv6') && !blockedV6.check(ip, 'ipv6');
  }
  return false;
}
