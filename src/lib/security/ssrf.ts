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
  const lower = ip.toLowerCase();
  const mappedIpv4 = parseIpv4MappedIpv6(lower);
  if (mappedIpv4) {
    return isBlockedIpv4(mappedIpv4);
  }
  // Loopback (::1)
  if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') return true;
  // Unspecified (::)
  if (lower === '::' || lower === '0:0:0:0:0:0:0:0') return true;
  // Link-local (fe80::/10)
  if (/^fe[89ab]/i.test(lower)) return true;
  // Unique local (fc00::/7)
  if (/^f[cd]/i.test(lower)) return true;
  // Multicast (ff00::/8)
  if (/^ff/i.test(lower)) return true;

  return false;
}

export function isBlockedIp(ip: string): boolean {
  const clean = ip.replace(/^\[|\]$/g, '').trim().toLowerCase();
  const ipFamily = net.isIP(clean);
  if (ipFamily === 0) {
    return false; // Not an IP literal (e.g. domain name)
  }
  if (ipFamily === 6 || clean.includes(':')) {
    return isBlockedIpv6(clean);
  }
  return isBlockedIpv4(clean);
}

export async function validateUrlForSsrf(targetUrl: URL): Promise<boolean> {
  const rawHostname = targetUrl.hostname.toLowerCase();
  const hostname = rawHostname.startsWith('[') && rawHostname.endsWith(']')
    ? rawHostname.slice(1, -1)
    : rawHostname;

  if (
    hostname === 'localhost' ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.localhost') ||
    (net.isIP(hostname) !== 0 && isBlockedIp(hostname))
  ) {
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

        if (
          cleanHost === 'localhost' ||
          cleanHost.endsWith('.local') ||
          cleanHost.endsWith('.internal') ||
          cleanHost.endsWith('.localhost') ||
          (net.isIP(cleanHost) !== 0 && isBlockedIp(cleanHost))
        ) {
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
