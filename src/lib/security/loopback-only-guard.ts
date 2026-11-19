const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

const ALWAYS_EXTERNAL_PROXY_HEADERS = [
  'cf-connecting-ip',
  'forwarded',
  'true-client-ip',
  'x-client-ip',
] as const;

function stripBrackets(raw: string): string {
  return raw.trim().replace(/^\[|\]$/g, '').toLowerCase();
}

function isLoopbackOrPrivateIpv4(ipv4: string): boolean {
  const parts = ipv4.split('.');
  if (parts.length !== 4) return false;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) return false;
    const n = Number(part);
    if (n < 0 || n > 255) return false;
    octets.push(n);
  }
  const [a, b] = octets;
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * Returns true if the supplied IP literal denotes host loopback (`127.0.0.1`, `::1`, or IPv4-mapped `::ffff:127.0.0.1`).
 */
export function isLoopbackIp(raw: string): boolean {
  return LOOPBACK_ADDRESSES.has(stripBrackets(raw));
}

/**
 * Returns true if `raw` is a single direct loopback or local container-bridge socket peer address
 * (`127.0.0.0/8`, `::1`, RFC 1918 `10/8` · `172.16/12` · `192.168/16`, or RFC 4193 `fc00::/7`).
 * Next.js `base-server.js` populates `x-forwarded-for` from `socket.remoteAddress` on every request,
 * which inside Docker `127.0.0.1:8090:3000` is the local bridge gateway (`::ffff:172.18.0.1`).
 */
export function isLocalOrBridgePeerIp(raw: string): boolean {
  const normalized = stripBrackets(raw);
  if (normalized.length === 0) return false;
  if (normalized === '::1') return true;
  if (normalized.startsWith('::ffff:')) {
    return isLoopbackOrPrivateIpv4(normalized.slice(7));
  }
  if (/^f[cd][0-9a-f]{0,2}:/.test(normalized)) {
    return true;
  }
  return isLoopbackOrPrivateIpv4(normalized);
}

/**
 * Returns true when a request carries external reverse-proxy or CDN forwarding headers, while allowing
 * direct plain-HTTP loopback and local Docker bridge calls (`http://127.0.0.1:8090`) where Next.js
 * `base-server.js` synthesizes a single local `x-forwarded-for` peer and `x-forwarded-proto: http`.
 */
export function hasExternalProxyForwardingHeaders(headers: Headers): boolean {
  for (const name of ALWAYS_EXTERNAL_PROXY_HEADERS) {
    if (headers.has(name)) {
      return true;
    }
  }
  const proto = headers.get('x-forwarded-proto');
  if (proto !== null && proto.split(',').some((entry) => entry.trim().toLowerCase() !== 'http')) {
    return true;
  }
  const realIp = headers.get('x-real-ip');
  if (realIp !== null && realIp.split(',').some((entry) => !isLoopbackIp(entry))) {
    return true;
  }
  const forwardedFor = headers.get('x-forwarded-for');
  if (forwardedFor === null) {
    return false;
  }
  const hops = forwardedFor.split(',');
  return hops.length !== 1 || !isLocalOrBridgePeerIp(hops[0]);
}
