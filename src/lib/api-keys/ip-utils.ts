import net from 'node:net';

/**
 * Checks whether an IPv4 or IPv6 address belongs to a CIDR block (e.g. 192.168.1.0/24 or 2001:db8::/32).
 */
export function isIpInCidr(ip: string, cidr: string): boolean {
  const cleanIp = ip.trim();
  const cleanCidr = cidr.trim();

  if (!cleanCidr.includes('/')) {
    return cleanIp === cleanCidr;
  }

  const [range, bitsStr] = cleanCidr.split('/');
  const prefixLength = parseInt(bitsStr, 10);
  if (isNaN(prefixLength)) return false;

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
 */
export function isIpAllowed(clientIp: string, allowedIps?: string[]): boolean {
  if (!allowedIps || allowedIps.length === 0) return true;
  const cleanIp = clientIp.trim();
  if (!cleanIp) return false;

  for (const entry of allowedIps) {
    const trimmed = entry.trim();
    if (!trimmed || trimmed === '*') return true;
    if (trimmed === cleanIp) return true;
    if (trimmed.includes('/') && isIpInCidr(cleanIp, trimmed)) {
      return true;
    }
  }
  return false;
}
