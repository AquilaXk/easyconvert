import { describe, expect, it } from 'vitest';
import { isPublicAddress } from '../src/lib/conversions/public-address';

/**
 * The address classifier decides which hosts an HTML page's images may be fetched from. Each class is checked at both
 * edges (the last address inside the range and the first outside it), so a range that is too short or too long fails.
 * The ranges come from the IANA special-purpose address registries, written out here as literal addresses.
 */

type Edge = [address: string, isPublic: boolean];

const IPV4_CLASSES: Array<[name: string, edges: Edge[]]> = [
  ['0.0.0.0/8 (this network)', [['0.0.0.0', false], ['0.255.255.255', false], ['1.0.0.0', true]]],
  ['10.0.0.0/8 (private)', [['9.255.255.255', true], ['10.0.0.0', false], ['10.255.255.255', false], ['11.0.0.0', true]]],
  ['100.64.0.0/10 (carrier-grade NAT)', [['100.63.255.255', true], ['100.64.0.0', false], ['100.127.255.255', false], ['100.128.0.0', true]]],
  ['127.0.0.0/8 (loopback)', [['126.255.255.255', true], ['127.0.0.0', false], ['127.0.0.1', false], ['127.255.255.255', false], ['128.0.0.0', true]]],
  ['169.254.0.0/16 (link-local, cloud metadata)', [['169.253.255.255', true], ['169.254.0.0', false], ['169.254.169.254', false], ['169.254.255.255', false], ['169.255.0.0', true]]],
  ['172.16.0.0/12 (private)', [['172.15.255.255', true], ['172.16.0.0', false], ['172.31.255.255', false], ['172.32.0.0', true]]],
  ['192.0.0.0/24 (protocol assignments)', [['191.255.255.255', true], ['192.0.0.0', false], ['192.0.0.192', false], ['192.0.0.255', false], ['192.0.1.0', true]]],
  ['192.0.2.0/24 (documentation)', [['192.0.1.255', true], ['192.0.2.0', false], ['192.0.2.255', false], ['192.0.3.0', true]]],
  ['192.88.99.0/24 (6to4 relay)', [['192.88.98.255', true], ['192.88.99.0', false], ['192.88.99.255', false], ['192.88.100.0', true]]],
  ['192.168.0.0/16 (private)', [['192.167.255.255', true], ['192.168.0.0', false], ['192.168.255.255', false], ['192.169.0.0', true]]],
  ['198.18.0.0/15 (benchmarking)', [['198.17.255.255', true], ['198.18.0.0', false], ['198.19.255.255', false], ['198.20.0.0', true]]],
  ['198.51.100.0/24 (documentation)', [['198.51.99.255', true], ['198.51.100.0', false], ['198.51.100.255', false], ['198.51.101.0', true]]],
  ['203.0.113.0/24 (documentation)', [['203.0.112.255', true], ['203.0.113.0', false], ['203.0.113.255', false], ['203.0.114.0', true]]],
  ['224.0.0.0/4 (multicast)', [['223.255.255.255', true], ['224.0.0.0', false], ['239.255.255.255', false]]],
  ['240.0.0.0/4 (reserved, broadcast)', [['240.0.0.0', false], ['255.255.255.254', false], ['255.255.255.255', false]]],
  ['ordinary public addresses', [['1.1.1.1', true], ['8.8.8.8', true], ['93.184.215.14', true], ['172.217.14.206', true], ['223.255.254.255', true]]],
];

const IPV6_CLASSES: Array<[name: string, edges: Edge[]]> = [
  ['::/128 (unspecified) and ::1/128 (loopback)', [['::', false], ['::1', false], ['0:0:0:0:0:0:0:1', false]]],
  ['IPv4-compatible ::/96', [['::7f00:1', false], ['::127.0.0.1', false], ['::10.0.0.1', false], ['::8.8.8.8', false]]],
  ['IPv4-mapped ::ffff:0:0/96 follows the IPv4 address', [
    ['::ffff:127.0.0.1', false],
    ['::ffff:7f00:1', false],
    ['::ffff:10.1.2.3', false],
    ['::ffff:a01:203', false],
    ['::ffff:169.254.169.254', false],
    ['::ffff:100.64.0.1', false],
    ['::ffff:0.0.0.0', false],
    ['0:0:0:0:0:ffff:c0a8:1', false],
    ['::ffff:8.8.8.8', true],
    ['::ffff:808:808', true],
  ]],
  ['NAT64 64:ff9b::/96', [['64:ff9b::', false], ['64:ff9b::7f00:1', false], ['64:ff9b::8.8.8.8', false], ['64:ff9b::ffff:ffff', false]]],
  ['local-use NAT64 64:ff9b:1::/48', [['64:ff9b:1::1', false]]],
  ['fc00::/7 (unique local, includes the cloud metadata fd00:ec2::254)', [['fbff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', false], ['fc00::', false], ['fd00:ec2::254', false], ['fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', false]]],
  ['fe80::/10 (link-local)', [['fe80::', false], ['fe80::1', false], ['febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff', false], ['fe80::1%eth0', false]]],
  ['fec0::/10 (site-local)', [['fec0::1', false]]],
  ['ff00::/8 (multicast)', [['ff00::', false], ['ff02::1', false], ['ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', false]]],
  ['2001::/23 (protocol assignments, Teredo)', [['2000:ffff:ffff:ffff:ffff:ffff:ffff:ffff', true], ['2001::', false], ['2001:0:4136:e378:8000:63bf:3fff:fdd2', false], ['2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff', false], ['2001:200::1', true]]],
  ['2001:db8::/32 (documentation)', [['2001:db7:ffff:ffff:ffff:ffff:ffff:ffff', true], ['2001:db8::', false], ['2001:db8:ffff:ffff:ffff:ffff:ffff:ffff', false], ['2001:db9::', true]]],
  ['2002::/16 (6to4, embeds an IPv4 address)', [['2001:ffff:ffff:ffff:ffff:ffff:ffff:ffff', true], ['2002::', false], ['2002:7f00:1::1', false], ['2002:808:808::1', false], ['2002:8000::1', false], ['2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff', false], ['2003::', true]]],
  ['3fff::/20 (documentation)', [['3ffe:ffff::', true], ['3fff::', false], ['3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff', false], ['3fff:1000::', true]]],
  ['outside global unicast 2000::/3', [['1fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', false], ['4000::', false], ['8000::1', false]]],
  ['ordinary global unicast addresses', [['2001:4860:4860::8888', true], ['2606:4700:4700::1111', true], ['2a00:1450:4001:81b::200e', true], ['2000::1', true], ['3ffe::1', true]]],
];

describe('isPublicAddress', () => {
  describe.each(IPV4_CLASSES)('IPv4 %s', (_name, edges) => {
    it.each(edges)('%s -> public: %s', (address, expected) => {
      expect(isPublicAddress(address)).toBe(expected);
    });
  });

  describe.each(IPV6_CLASSES)('IPv6 %s', (_name, edges) => {
    it.each(edges)('%s -> public: %s', (address, expected) => {
      expect(isPublicAddress(address)).toBe(expected);
    });
  });

  it.each([
    '',
    'example.com',
    'localhost',
    '010.0.0.1',
    '0x7f.0.0.1',
    '2130706433',
    '127.1',
    '1.2.3',
    '1.2.3.4.5',
    '256.1.1.1',
    '1.2.3.4/8',
    ' 8.8.8.8',
    '[::1]',
    '1:2:3:4:5:6:7:8:9',
    ':::',
    '2001:db8::1::2',
  ])('refuses the text %j, which is not a plain IP address', (text) => {
    expect(isPublicAddress(text)).toBe(false);
  });
});
