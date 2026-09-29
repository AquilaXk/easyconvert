import net from 'node:net';

/**
 * Normalizes an IP address by stripping brackets, ports, and IPv4-mapped IPv6 prefixes (::ffff:x.x.x.x).
 */
export function normalizeIp(ip: string): string {
  if (!ip || typeof ip !== 'string') return '';
  let clean = ip.trim();

  // Strip brackets and optional port from IPv6, e.g. [2001:db8::1]:8080 or [::ffff:192.168.1.1]
  const bracketMatch = clean.match(/^\[([a-fA-F0-9:.]+)\](?::\d+)?$/);
  if (bracketMatch) {
    clean = bracketMatch[1];
  } else {
    // Strip trailing port from IPv4, e.g. 192.168.1.1:8080
    const portMatch = clean.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):\d+$/);
    if (portMatch) {
      clean = portMatch[1];
    }
  }

  // Handle IPv4-mapped IPv6 addresses: ::ffff:192.168.1.1 or 0:0:0:0:0:ffff:192.168.1.1
  const lower = clean.toLowerCase();
  if (lower.startsWith('::ffff:') || lower.startsWith('0:0:0:0:0:ffff:')) {
    const candidate = lower.replace(/^.*ffff:/, '');
    if (net.isIPv4(candidate)) {
      return candidate;
    }
  }

  return clean;
}

/**
 * Checks whether an IPv4 or IPv6 address belongs to a CIDR block (e.g. 192.168.1.0/24 or 2001:db8::/32).
 * Automatically normalizes IPv4-mapped IPv6 addresses.
 */
export function isIpInCidr(ip: string, cidr: string): boolean {
  const cleanIp = normalizeIp(ip);
  let cleanCidr = cidr.trim();

  if (!cleanCidr.includes('/')) {
    return cleanIp === normalizeIp(cleanCidr);
  }

  const [rawRange, bitsStr] = cleanCidr.split('/');
  let prefixLength = parseInt(bitsStr, 10);
  if (isNaN(prefixLength)) return false;

  let range = normalizeIp(rawRange);
  // If the CIDR range was an IPv4-mapped IPv6 with /120..128 prefix, normalize prefix length to /24..32
  if (net.isIPv4(range) && rawRange.toLowerCase().includes('ffff:') && prefixLength >= 96) {
    prefixLength = prefixLength - 96;
  }

  const ipFamily = net.isIP(cleanIp);
  const rangeFamily = net.isIP(range);

  // Both must be valid IP addresses and belong to the same IP family
  if (ipFamily === 0 || rangeFamily === 0 || ipFamily !== rangeFamily) {
    return false;
  }

  if (ipFamily === 4) {
    if (prefixLength < 0 || prefixLength > 32) return false;
    const ipToInt = (addr: string): number => {
      const parts = addr.split('.').map(Number);
      if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) return 0;
      return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
    };

    const ipNum = ipToInt(cleanIp);
    const rangeNum = ipToInt(range);
    const mask = prefixLength === 0 ? 0 : (~0 << (32 - prefixLength)) >>> 0;

    return (ipNum & mask) === (rangeNum & mask);
  }

  if (ipFamily === 6) {
    if (prefixLength < 0 || prefixLength > 128) return false;
    const ipv6ToBigInt = (addr: string): bigint | null => {
      let fullAddr = addr.toLowerCase();
      if (fullAddr.includes(':::')) return null;
      if (fullAddr.includes('::')) {
        const parts = fullAddr.split('::');
        if (parts.length > 2) return null;
        const left = parts[0] ? parts[0].split(':') : [];
        const right = parts[1] ? parts[1].split(':') : [];
        const missing = 8 - (left.length + right.length);
        if (missing < 0) return null;
        const expanded = [...left, ...Array(missing).fill('0'), ...right];
        fullAddr = expanded.join(':');
      }
      const blocks = fullAddr.split(':');
      if (blocks.length !== 8) return null;
      let result = 0n;
      for (const b of blocks) {
        if (!/^[0-9a-f]{1,4}$/i.test(b)) return null;
        result = (result << 16n) | BigInt(parseInt(b, 16));
      }
      return result;
    };

    const ipBig = ipv6ToBigInt(cleanIp);
    const rangeBig = ipv6ToBigInt(range);
    if (ipBig === null || rangeBig === null) return false;

    if (prefixLength === 0) return true;
    const mask = ((2n ** 128n - 1n) << BigInt(128 - prefixLength)) & (2n ** 128n - 1n);
    return (ipBig & mask) === (rangeBig & mask);
  }

  return false;
}

/**
 * Validates whether a client IP matches an allowed whitelist of IP addresses and CIDR subnets.
 * Normalizes IPv4-mapped IPv6 addresses for consistent comparison.
 */
export const DEFAULT_TRUSTED_PROXIES: readonly string[] = [
  '127.0.0.1/8',
  '::1/128',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  'fc00::/7',
];

/**
 * Returns the active list of trusted proxy CIDRs/IPs from environment or defaults.
 */
export function getTrustedProxies(): string[] {
  const envVal = process.env.TRUSTED_PROXIES;
  if (!envVal || !envVal.trim()) {
    return [...DEFAULT_TRUSTED_PROXIES];
  }
  return envVal
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Validates whether a client IP matches an allowed whitelist of IP addresses and CIDR subnets.
 * Normalizes IPv4-mapped IPv6 addresses for consistent comparison.
 */
export function isIpAllowed(clientIp: string, allowedIps?: string[]): boolean {
  if (!allowedIps || allowedIps.length === 0) return true;
  const cleanIp = normalizeIp(clientIp);
  if (!cleanIp) return false;

  for (const entry of allowedIps) {
    const trimmed = entry.trim();
    if (!trimmed || trimmed === '*') return true;
    const normalizedEntry = normalizeIp(trimmed);
    if (normalizedEntry === cleanIp) return true;
    if (trimmed.includes('/') && isIpInCidr(cleanIp, trimmed)) {
      return true;
    }
  }
  return false;
}

/**
 * Securely extracts and normalizes the client IP from trusted reverse proxy headers.
 * Protects against IP spoofing attacks by parsing X-Forwarded-For chains from right-to-left
 * against trusted reverse proxy subnets (RFC 7239 / Nginx standard practice).
 */
export function extractClientIp(
  request: Request,
  trustedProxies?: string[]
): string {
  // 1. Authenticated CDN edge header (Cloudflare)
  const cfIp = request.headers.get('cf-connecting-ip');
  if (cfIp) {
    const normalized = normalizeIp(cfIp);
    if (net.isIP(normalized) !== 0) return normalized;
  }

  // 2. Direct upstream reverse proxy header (Nginx / HAProxy / Envoy)
  const realIp = request.headers.get('x-real-ip');
  if (realIp) {
    const normalized = normalizeIp(realIp);
    if (net.isIP(normalized) !== 0) return normalized;
  }

  // 3. Parse X-Forwarded-For chain from right-to-left against trusted reverse proxies
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const rawIps = forwarded
      .split(',')
      .map((s) => normalizeIp(s.trim()))
      .filter((ip) => net.isIP(ip) !== 0);

    if (rawIps.length > 0) {
      const proxies = trustedProxies || getTrustedProxies();
      // Scan right-to-left: peel away trusted reverse proxies
      for (let i = rawIps.length - 1; i >= 0; i--) {
        const candidate = rawIps[i];
        if (!isIpAllowed(candidate, proxies)) {
          // First untrusted IP from the right is the genuine client IP
          return candidate;
        }
      }
      // If all hops are trusted (e.g. private VPC mesh), fallback to leftmost
      return rawIps[0];
    }
  }

  return '127.0.0.1';
}
