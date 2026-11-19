const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

const EXTERNAL_PROXY_HEADER_NAMES = [
  'x-forwarded-for',
  'cf-connecting-ip',
  'forwarded',
  'true-client-ip',
  'x-client-ip',
] as const;

/**
 * Returns true if the supplied IP literal denotes host loopback (`127.0.0.1`, `::1`, or IPv4-mapped `::ffff:127.0.0.1`).
 */
export function isLoopbackIp(raw: string): boolean {
  const normalized = raw.trim().replace(/^\[|\]$/g, '').toLowerCase();
  return LOOPBACK_ADDRESSES.has(normalized);
}

/**
 * Returns true when a request carries external reverse-proxy or CDN forwarding headers.
 * Used by host-only / loopback diagnostics in production so external callers routed through nginx or a CDN
 * cannot trigger or inspect host-local endpoints even if misrouted or header-spoofed.
 */
export function hasExternalProxyForwardingHeaders(headers: Headers): boolean {
  for (const name of EXTERNAL_PROXY_HEADER_NAMES) {
    if (headers.has(name)) {
      return true;
    }
  }
  const realIp = headers.get('x-real-ip');
  if (realIp === null) {
    return false;
  }
  return realIp.split(',').some((entry) => !isLoopbackIp(entry));
}
