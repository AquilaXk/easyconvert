import dns from 'dns';
import net from 'node:net';
import { Agent } from 'undici';

export const MAX_STREAM_BYTES = 100 * 1024 * 1024; // 100MB limit
export const MAX_REDIRECTS = 5;

export function parseIpv4MappedIpv6(ip: string): string | null {
  const lower = ip.toLowerCase();
  if (!lower.startsWith('::ffff:') && !lower.startsWith('0:0:0:0:0:ffff:')) {
    return null;
  }
  const suffix = lower.replace(/^.*ffff:/, '');
  if (suffix.includes('.')) {
    return suffix;
  }
  const hexParts = suffix.split(':');
  if (hexParts.length === 2) {
    const high = parseInt(hexParts[0], 16);
    const low = parseInt(hexParts[1], 16);
    if (!isNaN(high) && !isNaN(low)) {
      return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
    }
  }
  return null;
}

export function parseIpv6ToWords(ip: string): number[] | null {
  const clean = ip.replace(/^\[|\]$/g, '').trim().toLowerCase();
  if (net.isIP(clean) !== 6) return null;

  let hexPart = clean;
  let embeddedIpv4Words: number[] | null = null;
  const match = clean.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (match) {
    const v4Parts = match[2].split('.').map(Number);
    if (v4Parts.length === 4 && v4Parts.every((p) => !isNaN(p) && p >= 0 && p <= 255)) {
      embeddedIpv4Words = [
        (v4Parts[0] << 8) | v4Parts[1],
        (v4Parts[2] << 8) | v4Parts[3],
      ];
      hexPart = match[1].endsWith('::') ? match[1] : match[1].slice(0, -1);
    }
  }

  const dblColon = hexPart.indexOf('::');
  let parts: string[];
  const targetWords = embeddedIpv4Words ? 6 : 8;

  if (dblColon !== -1) {
    const leftStr = hexPart.slice(0, dblColon);
    const rightStr = hexPart.slice(dblColon + 2);
    const left = leftStr ? leftStr.split(':') : [];
    const right = rightStr ? rightStr.split(':') : [];
    const missing = targetWords - (left.length + right.length);
    if (missing < 0) return null;
    parts = [...left, ...Array(missing).fill('0'), ...right];
  } else {
    parts = hexPart.split(':');
  }

  if (parts.length !== targetWords) return null;

  const words = parts.map((p) => parseInt(p || '0', 16));
  if (words.some((w) => isNaN(w) || w < 0 || w > 0xffff)) return null;

  if (embeddedIpv4Words) {
    words.push(...embeddedIpv4Words);
  }

  return words;
}

export function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return true;
  }
  const [a, b, c] = parts;
  // 0.0.0.0/8
  if (a === 0) return true;
  // 10.0.0.0/8
  if (a === 10) return true;
  // 100.64.0.0/10
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 127.0.0.0/8 (Loopback)
  if (a === 127) return true;
  // 169.254.0.0/16 (Link-local & AWS/GCP Metadata 169.254.169.254)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.0.0.0/24
  if (a === 192 && b === 0 && c === 0) return true;
  // 192.0.2.0/24
  if (a === 192 && b === 0 && c === 2) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // 198.18.0.0/15
  if (a === 198 && (b === 18 || b === 19)) return true;
  // 198.51.100.0/24
  if (a === 198 && b === 51 && c === 100) return true;
  // 203.0.113.0/24
  if (a === 203 && b === 0 && c === 113) return true;
  // 224.0.0.0/4 (Multicast/Reserved)
  if (a >= 224) return true;

  return false;
}

export function isBlockedIpv6(ip: string): boolean {
  const clean = ip.replace(/^\[|\]$/g, '').trim().toLowerCase();
  const words = parseIpv6ToWords(clean);
  if (!words) {
    const mappedIpv4 = parseIpv4MappedIpv6(clean);
    if (mappedIpv4) {
      return isBlockedIpv4(mappedIpv4);
    }
    return clean.includes(':');
  }

  // Unspecified (::)
  if (words.every((w) => w === 0)) return true;

  // Loopback (::1)
  if (words.slice(0, 7).every((w) => w === 0) && words[7] === 1) return true;

  // IPv4-compatible (::x.x.x.x) or IPv4-mapped (::ffff:x.x.x.x)
  const isCompatible = words.slice(0, 6).every((w) => w === 0);
  const isMapped = words.slice(0, 5).every((w) => w === 0) && words[5] === 0xffff;
  if (isCompatible || isMapped) {
    const v4 = [
      (words[6] >> 8) & 0xff,
      words[6] & 0xff,
      (words[7] >> 8) & 0xff,
      words[7] & 0xff,
    ].join('.');
    return isBlockedIpv4(v4);
  }

  // IPv4-translated (64:ff9b::/96)
  if (words[0] === 0x0064 && words[1] === 0xff9b && words.slice(2, 6).every((w) => w === 0)) {
    const v4 = [
      (words[6] >> 8) & 0xff,
      words[6] & 0xff,
      (words[7] >> 8) & 0xff,
      words[7] & 0xff,
    ].join('.');
    return isBlockedIpv4(v4);
  }

  // 6to4 encapsulation (2002::/16)
  if (words[0] === 0x2002) {
    const v4 = [
      (words[1] >> 8) & 0xff,
      words[1] & 0xff,
      (words[2] >> 8) & 0xff,
      words[2] & 0xff,
    ].join('.');
    if (isBlockedIpv4(v4)) return true;
  }

  // Unique local address (fc00::/7)
  if ((words[0] & 0xfe00) === 0xfc00) return true;

  // Link-local unicast (fe80::/10)
  if ((words[0] & 0xffc0) === 0xfe80) return true;

  // Site-local (fec0::/10, deprecated)
  if ((words[0] & 0xffc0) === 0xfec0) return true;

  // Multicast (ff00::/8)
  if ((words[0] & 0xff00) === 0xff00) return true;

  // Documentation (2001:db8::/32)
  if (words[0] === 0x2001 && words[1] === 0x0db8) return true;

  // Discard prefix (0100::/64)
  if (words[0] === 0x0100 && words.slice(1, 4).every((w) => w === 0)) return true;

  return false;
}

export function isBlockedIp(ip: string): boolean {
  const clean = ip.replace(/^\[|\]$/g, '').trim().toLowerCase();
  const ipType = net.isIP(clean);
  if (ipType === 4) {
    return isBlockedIpv4(clean);
  }
  if (ipType === 6) {
    return isBlockedIpv6(clean);
  }
  if (clean.includes(':')) {
    return isBlockedIpv6(clean);
  }
  return false;
}

/**
 * Validates whether a hostname or IP string represents a private, loopback, or cloud-metadata address.
 */
export function isPrivateOrRestrictedHost(hostname: string): boolean {
  if (!hostname || typeof hostname !== 'string') return true;
  const raw = hostname.toLowerCase().trim();
  const unbracketed = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw;
  const clean = unbracketed.replace(/\.+$/, '');

  if (
    !clean ||
    clean === 'localhost' ||
    clean === 'metadata' ||
    clean === 'metadata.google.internal' ||
    clean === 'instance-data' ||
    clean.endsWith('.local') ||
    clean.endsWith('.internal') ||
    clean.endsWith('.localhost') ||
    clean.endsWith('.arpa') ||
    clean.endsWith('.lan') ||
    clean.endsWith('.home') ||
    clean.endsWith('.corp') ||
    clean.endsWith('.onion') ||
    clean.endsWith('.invalid') ||
    clean.endsWith('.test')
  ) {
    return true;
  }

  const ipType = net.isIP(clean);
  if (ipType !== 0) {
    return isBlockedIp(clean);
  }

  return false;
}

export async function validateUrlForSsrf(targetUrl: URL): Promise<boolean> {
  const rawHostname = targetUrl.hostname.toLowerCase();
  const hostname = rawHostname.startsWith('[') && rawHostname.endsWith(']')
    ? rawHostname.slice(1, -1)
    : rawHostname;

  if (isPrivateOrRestrictedHost(hostname)) {
    return false;
  }

  // Pre-resolve hostname via dns.promises.lookup
  try {
    const addresses = await dns.promises.lookup(hostname, { all: true });
    if (!addresses || addresses.length === 0) {
      return false;
    }
    for (const addr of addresses) {
      if (isBlockedIp(addr.address)) {
        return false;
      }
    }
  } catch {
    return false;
  }

  return true;
}

/**
 * Creates an Undici Agent that enforces socket-level IP pinning on every connection.
 * This eliminates Time-of-Check to Time-of-Use (TOCTOU) DNS rebinding vulnerabilities
 * by verifying the resolved destination IP address inside the connection lookup hook.
 */
export function createSsrfSafeAgent(): Agent {
  return new Agent({
    connect: {
      lookup: (hostname, _options, callback) => {
        const rawHost = hostname.toLowerCase();
        const cleanHost = rawHost.startsWith('[') && rawHost.endsWith(']')
          ? rawHost.slice(1, -1)
          : rawHost;

        if (isPrivateOrRestrictedHost(cleanHost)) {
          return callback(new Error(`SSRF blocked: host ${hostname} is restricted`), '', 4);
        }

        dns.lookup(cleanHost, { all: true }, (err, addresses) => {
          if (err) {
            return callback(err, '', 4);
          }
          if (!addresses || addresses.length === 0) {
            return callback(new Error(`SSRF blocked: could not resolve host ${hostname}`), '', 4);
          }
          for (const addr of addresses) {
            if (isBlockedIp(addr.address)) {
              return callback(new Error(`SSRF blocked: resolved IP ${addr.address} is restricted`), '', 4);
            }
          }
          const chosen = addresses[0];
          callback(null, chosen.address, chosen.family);
        });
      },
    },
  });
}
