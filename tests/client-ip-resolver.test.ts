import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLOUDFLARE_IP_RANGES,
  ClientIpConfigError,
  InvalidForwardingHeaderError,
  MAX_FORWARDING_HEADER_LENGTH,
  MAX_FORWARDING_HOPS,
  MAX_TRUSTED_RANGES,
  UNATTRIBUTED_CLIENT_KEY,
  clientIpKey,
  isAddressInCidr,
  normalizeClientAddress,
  parseClientIpConfig,
  resolveClientIp,
  type ClientIpConfig,
} from '../src/lib/security/client-ip';
import { extractClientIp } from '../src/lib/api-keys/ip-utils';

function req(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/v1/jobs', { headers });
}

function cfg(raw: { trustedProxies?: string; trustedCdn?: string } = {}): ClientIpConfig {
  return parseClientIpConfig(raw);
}

function ipOf(headers: Record<string, string>, config: ClientIpConfig, peerIp?: string): string | null {
  return resolveClientIp(req(headers), { config, peerIp }).ip;
}

describe('normalizeClientAddress: validation and canonical spelling', () => {
  // Hand-written goldens (RFC 4291 / RFC 5952 canonical text, RFC 4291 s2.5.5.2 mapped form).
  const GOLDEN: Array<[string, string]> = [
    ['192.0.2.1', '192.0.2.1'],
    ['  192.0.2.1  ', '192.0.2.1'],
    ['192.0.2.1:8080', '192.0.2.1'],
    ['0.0.0.0', '0.0.0.0'],
    ['255.255.255.255', '255.255.255.255'],
    ['2001:db8::1', '2001:db8::1'],
    ['2001:0DB8:0:0:0:0:0:1', '2001:db8::1'],
    ['[2001:db8::1]', '2001:db8::1'],
    ['[2001:db8::1]:4711', '2001:db8::1'],
    ['2001:db8:0:0:1:0:0:1', '2001:db8::1:0:0:1'],
    ['2001:db8:0:1:1:1:1:1', '2001:db8:0:1:1:1:1:1'],
    ['1:0:0:0:0:0:0:1', '1::1'],
    ['0:0:0:0:0:0:0:0', '::'],
    ['::', '::'],
    ['::1', '::1'],
    ['0000:0000:0000:0000:0000:0000:0000:0001', '::1'],
    ['1::', '1::'],
    ['::ffff:192.0.2.1', '192.0.2.1'],
    ['::FFFF:192.0.2.1', '192.0.2.1'],
    ['[::ffff:192.0.2.1]:80', '192.0.2.1'],
    ['::ffff:c000:201', '192.0.2.1'],
    ['0:0:0:0:0:ffff:c000:0201', '192.0.2.1'],
    ['0:0:0:0:0:ffff:192.0.2.1', '192.0.2.1'],
    ['64:ff9b::192.0.2.33', '64:ff9b::c000:221'],
  ];

  it.each(GOLDEN)('normalizes %j to %j', (input, expected) => {
    expect(normalizeClientAddress(input)).toBe(expected);
  });

  const GARBAGE = [
    '',
    ' ',
    'garbage',
    'unknown',
    '_hidden',
    '999.1.1.1',
    '1.2.3',
    '1.2.3.4.5',
    '01.2.3.4',
    '1.2.3.04',
    '0x7f.0.0.1',
    '2130706433',
    '1.2.3.4:',
    '1.2.3.4:99999',
    '1.2.3.4:port',
    'a.b.c.d',
    ':::',
    '1::2::3',
    '12345::1',
    '1:2:3:4:5:6:7:8:9',
    '1:2:3:4:5:6:7:8::',
    'fe80::1%eth0',
    '[::1',
    '::1]',
    '[::1]x',
    '[1.2.3.4]',
    '::ffff:999.0.0.1',
    '2001:db8::g',
    '1.2.3.4 5.6.7.8',
    '1.2.3.4,5.6.7.8',
  ];

  it.each(GARBAGE)('rejects %j', (input) => {
    expect(normalizeClientAddress(input)).toBeNull();
  });

  it('rejects absurdly long input without scanning it', () => {
    expect(normalizeClientAddress('1'.repeat(10_000))).toBeNull();
    expect(normalizeClientAddress(`${'0:'.repeat(5_000)}1`)).toBeNull();
  });

  it('agrees with the platform parser (node:net) on which bare addresses are valid', () => {
    const corpus = [
      '1.2.3.4', '255.255.255.255', '256.1.1.1', '1.2.3', '01.2.3.4', '1.2.3.04', '::', '::1', '1::', '1::2', 'a:b:c:d:e:f:1:2',
      'a:b:c:d:e:f:1:2:3', '::ffff:1.2.3.4', '1:2:3:4:5:6:1.2.3.4', '1:2:3:4:5:6:7::', '1::2::3', ':1', '1:',
      '1:2:3:4:5:6:7:8', 'fffff::1', 'g::1', '::1.2.3.4', '::1.2.3', '2001:db8::', '2001:db8:::1', ':::',
    ];
    for (const text of corpus) {
      expect(normalizeClientAddress(text) !== null, text).toBe(net.isIP(text) !== 0);
    }
  });
});

describe('isAddressInCidr', () => {
  it('agrees with node:net BlockList on a v4 and v6 corpus', () => {
    const v4Cidrs = ['0.0.0.0/0', '10.0.0.0/8', '172.16.0.0/12', '192.168.1.0/24', '192.0.2.1/32', '127.0.0.1/8'];
    const v4Addrs = ['10.1.2.3', '11.0.0.0', '172.31.255.255', '172.32.0.0', '192.168.1.200', '192.168.2.1', '192.0.2.1', '192.0.2.2', '127.9.9.9'];
    const v6Cidrs = ['::/0', '::1/128', 'fc00::/7', '2001:db8::/32', 'fe80::/10', '2a06:98c0::/29'];
    const v6Addrs = ['::1', '::2', 'fd12:3456::1', 'fe00::1', '2001:db8:ffff::1', '2001:db9::1', 'fe80::abcd', 'febf::1', '2a06:98c7::1', '2a06:98c8::1'];

    for (const [cidrs, addrs, family] of [
      [v4Cidrs, v4Addrs, 'ipv4'],
      [v6Cidrs, v6Addrs, 'ipv6'],
    ] as const) {
      for (const cidr of cidrs) {
        const [base, bits] = cidr.split('/');
        const list = new net.BlockList();
        list.addSubnet(base, Number(bits), family);
        for (const addr of addrs) {
          expect(isAddressInCidr(addr, cidr), `${addr} in ${cidr}`).toBe(list.check(addr, family));
        }
      }
    }
  });

  it('treats a bare address as a /32 or /128 and never matches across families', () => {
    expect(isAddressInCidr('192.0.2.1', '192.0.2.1')).toBe(true);
    expect(isAddressInCidr('192.0.2.2', '192.0.2.1')).toBe(false);
    expect(isAddressInCidr('2001:db8::1', '2001:0db8:0:0:0:0:0:1')).toBe(true);
    expect(isAddressInCidr('192.0.2.1', '::/0')).toBe(false);
    expect(isAddressInCidr('::1', '0.0.0.0/0')).toBe(false);
  });

  it('matches IPv4-mapped IPv6 spellings against IPv4 ranges and the reverse', () => {
    expect(isAddressInCidr('::ffff:10.1.2.3', '10.0.0.0/8')).toBe(true);
    expect(isAddressInCidr('10.1.2.3', '::ffff:10.0.0.0/104')).toBe(true);
    expect(isAddressInCidr('::ffff:11.1.2.3', '10.0.0.0/8')).toBe(false);
  });

  it('returns false for invalid addresses or malformed prefixes', () => {
    expect(isAddressInCidr('garbage', '10.0.0.0/8')).toBe(false);
    expect(isAddressInCidr('10.0.0.1', '10.0.0.0/33')).toBe(false);
    expect(isAddressInCidr('2001:db8::1', '2001:db8::/129')).toBe(false);
    expect(isAddressInCidr('10.0.0.1', '10.0.0.0/-1')).toBe(false);
    expect(isAddressInCidr('10.0.0.1', '10.0.0.0/8x')).toBe(false);
  });
});

describe('parseClientIpConfig', () => {
  it('records nothing as declared when no variables are set', () => {
    const c = parseClientIpConfig({});
    expect(c.trustedProxies).toBeNull();
    expect(c.cdnRanges).toBeNull();
  });

  it('treats blank values as unset', () => {
    const c = parseClientIpConfig({ trustedProxies: '  ', trustedCdn: '' });
    expect(c.trustedProxies).toBeNull();
    expect(c.cdnRanges).toBeNull();
  });

  it.each(['10.0.0.0/33', 'abc', '10.0.0.0/8/9', '10.0.0.0/x', '2001:db8::/129', '10.0.0.0/8,,'])(
    'throws ClientIpConfigError for malformed TRUSTED_PROXIES entry list %j',
    (raw) => {
      expect(() => parseClientIpConfig({ trustedProxies: raw })).toThrow(ClientIpConfigError);
    }
  );

  it('bounds the number of trusted ranges', () => {
    const tooMany = Array.from({ length: MAX_TRUSTED_RANGES + 1 }, (_, i) => `10.0.${i % 256}.${Math.floor(i / 256)}`).join(',');
    expect(() => parseClientIpConfig({ trustedProxies: tooMany })).toThrow(ClientIpConfigError);
    const atLimit = Array.from({ length: MAX_TRUSTED_RANGES }, (_, i) => `10.0.${i % 256}.${Math.floor(i / 256)}`).join(',');
    expect(parseClientIpConfig({ trustedProxies: atLimit }).trustedProxies).toHaveLength(MAX_TRUSTED_RANGES);
  });

  it('rejects an unknown TRUSTED_CDN provider', () => {
    expect(() => parseClientIpConfig({ trustedCdn: 'someothercdn' })).toThrow(ClientIpConfigError);
  });

  it('accepts cloudflare case-insensitively and ships the published ranges', () => {
    const c = parseClientIpConfig({ trustedCdn: ' Cloudflare ' });
    expect(c.cdnRanges).toHaveLength(CLOUDFLARE_IP_RANGES.length);
    expect(CLOUDFLARE_IP_RANGES).toContain('173.245.48.0/20');
    expect(CLOUDFLARE_IP_RANGES).toContain('2606:4700::/32');
  });

  it('lets TRUSTED_CDN_RANGES override the shipped provider ranges', () => {
    const c = parseClientIpConfig({ trustedCdn: 'cloudflare', trustedCdnRanges: '203.0.113.0/24' });
    expect(c.cdnRanges).toHaveLength(1);
    expect(ipOf({ 'cf-connecting-ip': '198.51.100.9' }, c, '203.0.113.7')).toBe('198.51.100.9');
    expect(ipOf({ 'cf-connecting-ip': '198.51.100.9' }, c, '173.245.48.5')).toBe('173.245.48.5');
  });

  it('rejects TRUSTED_CDN_RANGES without TRUSTED_CDN (a range list alone declares nothing)', () => {
    expect(() => parseClientIpConfig({ trustedCdnRanges: '203.0.113.0/24' })).toThrow(ClientIpConfigError);
  });
});

describe('resolveClientIp: nothing declared', () => {
  const none = cfg();

  it('never derives an address from client headers when the peer is unknown', () => {
    const r = resolveClientIp(
      req({
        'x-forwarded-for': '198.51.100.7',
        'cf-connecting-ip': '198.51.100.8',
        'x-real-ip': '198.51.100.9',
        forwarded: 'for=198.51.100.10',
      }),
      { config: none }
    );
    expect(r.ip).toBeNull();
    expect(r.source).toBe('unattributed');
    expect(clientIpKey(r)).toBe(UNATTRIBUTED_CLIENT_KEY);
  });

  it('reports the unattributed key as a non-address so allowlists cannot match it', () => {
    expect(net.isIP(UNATTRIBUTED_CLIENT_KEY)).toBe(0);
  });

  it('uses the socket peer when it is known and not a default-trusted proxy', () => {
    const r = resolveClientIp(req({ 'x-forwarded-for': '10.0.0.1' }), { config: none, peerIp: '203.0.113.99' });
    expect(r).toEqual({ ip: '203.0.113.99', source: 'peer' });
  });

  it('reads the peer from a Node-style request socket', () => {
    const nodeLike = Object.assign(req({ 'x-forwarded-for': '10.0.0.1' }), {
      socket: { remoteAddress: '::ffff:203.0.113.98' },
    });
    expect(resolveClientIp(nodeLike, { config: none }).ip).toBe('203.0.113.98');
  });

  it('does not read the platform-provided request.ip property', () => {
    const withIp = Object.assign(req({ 'x-forwarded-for': '10.0.0.1' }), { ip: '203.0.113.97' });
    expect(resolveClientIp(withIp, { config: none }).ip).toBeNull();
  });

  it('with a known default-trusted private peer (e.g. a sidecar proxy) walks the forwarding chain', () => {
    expect(ipOf({ 'x-forwarded-for': '198.51.100.7' }, none, '10.0.0.5')).toBe('198.51.100.7');
    expect(ipOf({}, none, '127.0.0.1')).toBe('127.0.0.1');
  });

  it('throws on an unparseable explicit peer instead of guessing', () => {
    expect(() => resolveClientIp(req(), { config: none, peerIp: 'not-an-ip' })).toThrow(ClientIpConfigError);
  });
});

describe('resolveClientIp: untrusted peers cannot inject headers', () => {
  const proxies = cfg({ trustedProxies: '127.0.0.1/32,172.16.0.0/12' });

  it('ignores every forwarding header, including malformed ones, from an untrusted peer', () => {
    const r = resolveClientIp(
      req({
        'x-forwarded-for': 'garbage, 10.0.0.1',
        'cf-connecting-ip': '10.0.0.2',
        'x-real-ip': '10.0.0.3',
        forwarded: 'for=banana',
      }),
      { config: proxies, peerIp: '203.0.113.99' }
    );
    expect(r).toEqual({ ip: '203.0.113.99', source: 'peer' });
  });

  it('normalizes the peer spelling', () => {
    expect(ipOf({}, proxies, '::ffff:203.0.113.99')).toBe('203.0.113.99');
    expect(ipOf({}, proxies, '[2001:0db8:0:0:0:0:0:5]')).toBe('2001:db8::5');
  });
});

describe('resolveClientIp: trusted proxy chains (right-to-left walk)', () => {
  const proxies = cfg({ trustedProxies: '172.16.0.0/12,127.0.0.1/32,10.0.0.0/8' });

  it('peels trusted hops from the right and ignores spoofed leftmost claims (peer known)', () => {
    const xff = { 'x-forwarded-for': '10.0.0.99, 198.51.100.22, 172.16.0.1' };
    expect(ipOf(xff, proxies, '172.16.0.9')).toBe('198.51.100.22');
  });

  it('does the same when the peer is unknown (headers-only deployment)', () => {
    const xff = { 'x-forwarded-for': '10.0.0.99, 198.51.100.22, 172.16.0.1' };
    expect(ipOf(xff, proxies)).toBe('198.51.100.22');
  });

  it('stops at the first untrusted hop: addresses left of it are never consulted', () => {
    const xff = { 'x-forwarded-for': 'garbage-claim, 203.0.113.1, 198.51.100.5, 10.0.0.1' };
    expect(ipOf(xff, proxies)).toBe('198.51.100.5');
  });

  it('a rotating spoofed prefix cannot change the resolved client', () => {
    const seen = new Set<string | null>();
    for (let i = 1; i <= 50; i++) {
      seen.add(ipOf({ 'x-forwarded-for': `203.0.113.${i}, 198.51.100.7` }, proxies));
    }
    expect([...seen]).toEqual(['198.51.100.7']);
  });

  it('when every hop is trusted the nearest hop is the identity (never a leftmost claim)', () => {
    expect(ipOf({ 'x-forwarded-for': '10.9.9.9, 10.0.0.7' }, proxies)).toBe('10.0.0.7');
    expect(ipOf({ 'x-forwarded-for': '10.9.9.9, 10.0.0.7' }, proxies, '172.16.0.2')).toBe('172.16.0.2');
  });

  it('a trusted peer with no forwarding headers is its own client', () => {
    expect(ipOf({}, proxies, '10.0.0.5')).toBe('10.0.0.5');
  });

  it('with the peer unknown and no forwarding headers the request is unattributed', () => {
    expect(resolveClientIp(req(), { config: proxies })).toEqual({ ip: null, source: 'unattributed' });
  });

  it('strips ports, brackets, mapped prefixes and canonicalizes IPv6 spellings', () => {
    expect(ipOf({ 'x-forwarded-for': '[2001:db8::1]:8080, 10.0.0.1' }, proxies)).toBe('2001:db8::1');
    expect(ipOf({ 'x-forwarded-for': '203.0.113.9:5555' }, proxies)).toBe('203.0.113.9');
    expect(ipOf({ 'x-forwarded-for': '::ffff:198.51.100.5' }, proxies)).toBe('198.51.100.5');
    expect(ipOf({ 'x-forwarded-for': '::ffff:c633:6405' }, proxies)).toBe('198.51.100.5');
    // Two spellings of one address must collapse to one rate-limit identity.
    expect(ipOf({ 'x-forwarded-for': '2001:0db8:0000:0000:0000:0000:0000:0001' }, proxies)).toBe('2001:db8::1');
    expect(ipOf({ 'x-forwarded-for': '2001:DB8::1' }, proxies)).toBe('2001:db8::1');
  });

  it('treats an IPv4-mapped spelling of a trusted proxy as trusted', () => {
    expect(ipOf({ 'x-forwarded-for': '198.51.100.5, ::ffff:10.0.0.1' }, proxies)).toBe('198.51.100.5');
  });

  it('supports IPv6 trusted ranges', () => {
    const v6 = cfg({ trustedProxies: 'fc00::/7,::1/128' });
    expect(ipOf({ 'x-forwarded-for': '2001:db8::77, fd00::1' }, v6)).toBe('2001:db8::77');
    expect(ipOf({ 'x-forwarded-for': '2001:db8::77' }, v6, '::1')).toBe('2001:db8::77');
  });

  it('x-real-ip is never consulted', () => {
    expect(ipOf({ 'x-real-ip': '198.51.100.1' }, proxies)).toBeNull();
    expect(ipOf({ 'x-real-ip': '198.51.100.1', 'x-forwarded-for': '198.51.100.2' }, proxies)).toBe('198.51.100.2');
  });

  it('answers unattributed for an "unknown" placeholder hop rather than skipping it', () => {
    expect(ipOf({ 'x-forwarded-for': '198.51.100.5, unknown' }, proxies)).toBeNull();
  });
});

describe('resolveClientIp: malformed chains throw typed errors', () => {
  const proxies = cfg({ trustedProxies: '10.0.0.0/8' });

  it.each([
    ['garbage on the right', '198.51.100.1, not-an-ip'],
    ['empty trailing entry', '198.51.100.1,'],
    ['empty entry in the middle of trusted hops', '198.51.100.1,,10.0.0.1'],
    ['out of range octet', '999.1.1.1'],
    ['leading zero octet', '01.2.3.4'],
  ])('rejects %s', (_label, value) => {
    expect(() => resolveClientIp(req({ 'x-forwarded-for': value }), { config: proxies })).toThrow(
      InvalidForwardingHeaderError
    );
  });

  it('carries HTTP 400 on the error', () => {
    try {
      resolveClientIp(req({ 'x-forwarded-for': 'nope' }), { config: proxies });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidForwardingHeaderError);
      expect((error as InvalidForwardingHeaderError).status).toBe(400);
    }
  });

  it('bounds header length and hop count', () => {
    const tooLong = `${'198.51.100.1, '.repeat(MAX_FORWARDING_HEADER_LENGTH)}10.0.0.1`;
    expect(() => resolveClientIp(req({ 'x-forwarded-for': tooLong }), { config: proxies })).toThrow(
      InvalidForwardingHeaderError
    );

    const manyHops = Array.from({ length: MAX_FORWARDING_HOPS + 1 }, () => '10.0.0.1').join(',');
    expect(manyHops.length).toBeLessThan(MAX_FORWARDING_HEADER_LENGTH);
    expect(() => resolveClientIp(req({ 'x-forwarded-for': manyHops }), { config: proxies })).toThrow(
      InvalidForwardingHeaderError
    );

    const atLimit = Array.from({ length: MAX_FORWARDING_HOPS }, () => '10.0.0.1').join(',');
    expect(ipOf({ 'x-forwarded-for': atLimit }, proxies)).toBe('10.0.0.1');
  });
});

describe('resolveClientIp: RFC 7239 Forwarded header', () => {
  const proxies = cfg({ trustedProxies: '10.0.0.0/8,2001:db8:cafe::/48' });

  it('walks for= parameters from the right, skipping trusted proxies', () => {
    expect(ipOf({ forwarded: 'for=203.0.113.50, for=198.51.100.7;proto=https, for=10.0.0.4' }, proxies)).toBe('198.51.100.7');
  });

  it('parses the RFC 7239 examples (sections 4 and 7.1)', () => {
    const open = cfg({ trustedProxies: '198.51.100.0/24' });
    expect(ipOf({ forwarded: 'for=192.0.2.60;proto=http;by=203.0.113.43' }, open)).toBe('192.0.2.60');
    expect(ipOf({ forwarded: 'For="[2001:db8:cafe::17]:4711"' }, open)).toBe('2001:db8:cafe::17');
    expect(
      ipOf({ forwarded: 'for=192.0.2.43, for=198.51.100.17;by=203.0.113.60;proto=http;host=example.com' }, open)
    ).toBe('192.0.2.43');
  });

  it('is case-insensitive for parameter names and tolerates whitespace around separators', () => {
    expect(ipOf({ forwarded: 'By=10.0.0.9 ; FOR=203.0.113.50 ;Proto=https' }, proxies)).toBe('203.0.113.50');
  });

  it('keeps a quoted comma or semicolon inside one element', () => {
    expect(ipOf({ forwarded: 'for=203.0.113.5;by="a,b;c"' }, proxies)).toBe('203.0.113.5');
    expect(ipOf({ forwarded: 'for=203.0.113.5;by="x\\"y,z"' }, proxies)).toBe('203.0.113.5');
  });

  it('attributes nothing to obfuscated or unknown nodes, and to elements without for=', () => {
    expect(ipOf({ forwarded: 'for=198.51.100.7, for=_hidden' }, proxies)).toBeNull();
    expect(ipOf({ forwarded: 'for=198.51.100.7, for=unknown' }, proxies)).toBeNull();
    expect(ipOf({ forwarded: 'for=198.51.100.7, by=10.0.0.1;proto=https' }, proxies)).toBeNull();
  });

  it('accepts an obfuscated port on an otherwise valid node', () => {
    expect(ipOf({ forwarded: 'for="203.0.113.5:_p1"' }, proxies)).toBe('203.0.113.5');
  });

  it.each([
    'for=banana',
    'for=',
    'for="203.0.113.5',
    'for=203.0.113.5;;;proto',
    'for=1.2.3.4:99999',
    'for=[2001:db8::1]',
    'garbage',
  ])('rejects malformed Forwarded %j', (value) => {
    expect(() => resolveClientIp(req({ forwarded: value }), { config: proxies })).toThrow(InvalidForwardingHeaderError);
  });

  it('is ignored from an untrusted peer', () => {
    expect(ipOf({ forwarded: 'for=10.0.0.1' }, proxies, '203.0.113.99')).toBe('203.0.113.99');
  });

  it('when X-Forwarded-For and Forwarded name different clients the request is unattributed', () => {
    expect(
      ipOf({ 'x-forwarded-for': '198.51.100.7', forwarded: 'for=198.51.100.8' }, proxies)
    ).toBeNull();
  });

  it('when X-Forwarded-For and Forwarded agree the shared client is used', () => {
    expect(
      ipOf({ 'x-forwarded-for': '198.51.100.7, 10.0.0.1', forwarded: 'for=198.51.100.7;by=10.0.0.1' }, proxies)
    ).toBe('198.51.100.7');
  });
});

describe('resolveClientIp: TRUSTED_CDN=cloudflare', () => {
  const cdn = cfg({ trustedCdn: 'cloudflare' });
  const cdnAndProxy = cfg({ trustedCdn: 'cloudflare', trustedProxies: '10.0.0.0/8' });

  it('honours CF-Connecting-IP when the socket peer is inside a Cloudflare range (IPv4 and IPv6)', () => {
    expect(ipOf({ 'cf-connecting-ip': '198.51.100.7' }, cdn, '173.245.48.5')).toBe('198.51.100.7');
    expect(ipOf({ 'cf-connecting-ip': '2001:db8::7' }, cdn, '2400:cb00::1')).toBe('2001:db8::7');
    expect(ipOf({ 'cf-connecting-ip': '2001:db8::7' }, cdn, '::ffff:104.16.0.1')).toBe('2001:db8::7');
    const r = resolveClientIp(req({ 'cf-connecting-ip': '198.51.100.7' }), { config: cdn, peerIp: '173.245.48.5' });
    expect(r.source).toBe('cdn-header');
  });

  it('ignores CF-Connecting-IP when the peer is outside the Cloudflare ranges', () => {
    expect(ipOf({ 'cf-connecting-ip': '198.51.100.7' }, cdn, '203.0.113.99')).toBe('203.0.113.99');
    // 173.245.64.0 is just outside 173.245.48.0/20.
    expect(ipOf({ 'cf-connecting-ip': '198.51.100.7' }, cdn, '173.245.64.1')).toBe('173.245.64.1');
  });

  it('ignores CF-Connecting-IP without TRUSTED_CDN even from a Cloudflare address or a trusted proxy', () => {
    const plain = cfg({ trustedProxies: '10.0.0.0/8' });
    expect(ipOf({ 'cf-connecting-ip': '198.51.100.7' }, plain, '173.245.48.5')).toBe('173.245.48.5');
    expect(ipOf({ 'cf-connecting-ip': '198.51.100.7' }, plain, '10.0.0.5')).toBe('10.0.0.5');
  });

  it('with the peer unknown, the nearest forwarding hop stands in for the peer', () => {
    const viaEdge = { 'x-forwarded-for': '198.51.100.7, 173.245.48.5', 'cf-connecting-ip': '198.51.100.7' };
    expect(ipOf(viaEdge, cdn)).toBe('198.51.100.7');
    // Forged: nearest hop is a client address, not a Cloudflare edge => header ignored.
    expect(ipOf({ 'x-forwarded-for': '203.0.113.200', 'cf-connecting-ip': '198.51.100.7' }, cdn)).toBe('203.0.113.200');
    // Nothing identifies the nearest hop at all.
    expect(ipOf({ 'cf-connecting-ip': '198.51.100.7' }, cdn)).toBeNull();
  });

  it('treats Cloudflare edges as skippable hops when walking X-Forwarded-For without the header', () => {
    expect(ipOf({ 'x-forwarded-for': '198.51.100.7, 173.245.48.5' }, cdnAndProxy, '10.0.0.5')).toBe('198.51.100.7');
  });

  it('a forged CF-Connecting-IP from a trusted private proxy is still ignored (the proxy is not a CDN)', () => {
    expect(ipOf({ 'cf-connecting-ip': '1.1.1.1', 'x-forwarded-for': '198.51.100.7' }, cdnAndProxy, '10.0.0.5')).toBe(
      '198.51.100.7'
    );
  });

  it('throws when a verified edge sends a malformed CF-Connecting-IP', () => {
    expect(() => ipOf({ 'cf-connecting-ip': 'bogus' }, cdn, '173.245.48.5')).toThrow(InvalidForwardingHeaderError);
  });

  it('falls back to the forwarding chain when the verified edge sent no CF-Connecting-IP', () => {
    expect(ipOf({ 'x-forwarded-for': '198.51.100.7' }, cdn, '173.245.48.5')).toBe('198.51.100.7');
  });
});

describe('extractClientIp (api-keys facade) and environment loading', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('delegates to the shared resolver and returns the unattributed key instead of a loopback default', () => {
    vi.stubEnv('TRUSTED_PROXIES', '');
    vi.stubEnv('TRUSTED_CDN', '');
    expect(extractClientIp(req({ 'x-forwarded-for': '198.51.100.7' }))).toBe(UNATTRIBUTED_CLIENT_KEY);
    expect(extractClientIp(req())).toBe(UNATTRIBUTED_CLIENT_KEY);
  });

  it('reads TRUSTED_PROXIES from the environment at call time', () => {
    vi.stubEnv('TRUSTED_PROXIES', '10.0.0.0/8');
    vi.stubEnv('TRUSTED_CDN', '');
    expect(extractClientIp(req({ 'x-forwarded-for': '198.51.100.7, 10.1.1.1' }))).toBe('198.51.100.7');
    vi.stubEnv('TRUSTED_PROXIES', '192.168.0.0/16');
    expect(extractClientIp(req({ 'x-forwarded-for': '198.51.100.7, 10.1.1.1' }))).toBe('10.1.1.1');
  });

  it('explicit trustedProxies and peer arguments keep working', () => {
    expect(extractClientIp(req({ 'x-forwarded-for': '203.0.113.1, 198.51.100.5' }), ['10.0.0.0/8', '127.0.0.1/32'], '10.0.0.2')).toBe(
      '198.51.100.5'
    );
    expect(extractClientIp(req({ 'cf-connecting-ip': '10.0.0.1' }), ['127.0.0.1/32'], '203.0.113.99')).toBe('203.0.113.99');
  });

  it('throws ClientIpConfigError when the environment is misconfigured', () => {
    vi.stubEnv('TRUSTED_PROXIES', 'not-a-cidr');
    expect(() => extractClientIp(req())).toThrow(ClientIpConfigError);
  });
});
