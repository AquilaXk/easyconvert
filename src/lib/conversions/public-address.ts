import net from 'node:net';

/**
 * Whether an IP address may be connected to when a converter fetches a resource for a document: only addresses that
 * are globally reachable unicast. Everything the IANA special-purpose registries reserve is refused: loopback,
 * private, carrier-grade NAT, link-local (cloud metadata), documentation, benchmarking, multicast and reserved
 * ranges, and the IPv6 forms that carry an IPv4 address (mapped, compatible, NAT64, 6to4, Teredo).
 *
 * IPv4 is a deny list of the special-purpose blocks. IPv6 is an allow list (2000::/3) minus the special-purpose
 * blocks inside it, so an address outside the global unicast range is refused without being named.
 */

const IPV4_OCTETS = 4;
const IPV4_BITS = 32;
const IPV6_GROUPS = 8;
const IPV6_MAPPED_GROUP = 0xffff;
const GROUP_BITS = 16;
const GROUP_MASK = 0xffff;
const ZONE_SEPARATOR = '%';

/** IPv4 special-purpose blocks (IANA IPv4 Special-Purpose Address Registry) that are not globally reachable. */
const IPV4_REFUSED: ReadonlyArray<readonly [address: string, prefixLength: number]> = [
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
];

/** IPv6 special-purpose blocks inside global unicast 2000::/3 that are not globally reachable. */
const IPV6_REFUSED: ReadonlyArray<readonly [groups: readonly number[], prefixLength: number]> = [
  [[0x2001, 0x0000], 23],
  [[0x2001, 0x0db8], 32],
  [[0x2002], 16],
  [[0x3fff], 20],
];
const GLOBAL_UNICAST_PREFIX = 0x2000;
const GLOBAL_UNICAST_MASK = 0xe000;

function parseIpv4(text: string): number | null {
  if (net.isIP(text) !== 4) return null;
  const octets = text.split('.').map(Number);
  if (octets.length !== IPV4_OCTETS) return null;
  return octets.reduce((value, octet) => value * 256 + octet, 0);
}

function inIpv4Block(value: number, block: string, prefixLength: number): boolean {
  const base = parseIpv4(block) as number;
  const shift = IPV4_BITS - prefixLength;
  return Math.floor(value / 2 ** shift) === Math.floor(base / 2 ** shift);
}

function isPublicIpv4(value: number): boolean {
  return !IPV4_REFUSED.some(([block, prefixLength]) => inIpv4Block(value, block, prefixLength));
}

/** The eight 16-bit groups of an IPv6 address, or null when the text is not one. */
function parseIpv6(text: string): number[] | null {
  const zone = text.indexOf(ZONE_SEPARATOR);
  const address = zone < 0 ? text : text.slice(0, zone);
  if (net.isIP(address) !== 6) return null;
  let head = address;
  let tail: number[] = [];
  const dotted = address.lastIndexOf('.');
  if (dotted >= 0) {
    const separator = address.lastIndexOf(':');
    const embedded = parseIpv4(address.slice(separator + 1));
    if (embedded === null) return null;
    tail = [Math.floor(embedded / 65536), embedded % 65536];
    head = `${address.slice(0, separator + 1)}0:0`;
  }
  const [before, after] = head.split('::');
  const leading = before === '' ? [] : before.split(':');
  const trailing = after === undefined || after === '' ? [] : after.split(':');
  const missing = after === undefined ? 0 : IPV6_GROUPS - leading.length - trailing.length;
  const groups = [...leading, ...Array<string>(missing).fill('0'), ...trailing].map((group) => Number.parseInt(group, 16));
  if (groups.length !== IPV6_GROUPS || groups.some((group) => Number.isNaN(group))) return null;
  if (tail.length > 0) groups.splice(IPV6_GROUPS - 2, 2, ...tail);
  return groups;
}

function inIpv6Block(groups: readonly number[], block: readonly number[], prefixLength: number): boolean {
  let remaining = prefixLength;
  for (let index = 0; remaining > 0; index++) {
    const bits = Math.min(remaining, GROUP_BITS);
    const shift = GROUP_BITS - bits;
    if (((groups[index] ^ (block[index] ?? 0)) & GROUP_MASK) >> shift !== 0) return false;
    remaining -= bits;
  }
  return true;
}

function isPublicIpv6(groups: readonly number[]): boolean {
  const isMapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === IPV6_MAPPED_GROUP;
  if (isMapped) return isPublicIpv4(groups[6] * 65536 + groups[7]);
  if ((groups[0] & GLOBAL_UNICAST_MASK) !== GLOBAL_UNICAST_PREFIX) return false;
  return !IPV6_REFUSED.some(([block, prefixLength]) => inIpv6Block(groups, block, prefixLength));
}

export function isPublicAddress(address: string): boolean {
  const ipv4 = parseIpv4(address);
  if (ipv4 !== null) return isPublicIpv4(ipv4);
  const groups = parseIpv6(address);
  return groups !== null && isPublicIpv6(groups);
}
