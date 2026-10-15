import {
  clientIpKey,
  isAddressInCidr,
  loadClientIpConfig,
  normalizeClientAddress,
  parseClientIpConfig,
  resolveClientIp,
} from '@/lib/security/client-ip';

/**
 * Normalizes an IP address: strips brackets and ports, folds IPv4-mapped IPv6 to IPv4, and returns the
 * canonical text form. Returns '' for anything that is not an IP address.
 */
export function normalizeIp(ip: string): string {
  if (!ip || typeof ip !== 'string') return '';
  return normalizeClientAddress(ip) ?? '';
}

/**
 * Checks whether an IPv4 or IPv6 address belongs to a CIDR block (e.g. 192.168.1.0/24 or 2001:db8::/32).
 * A bare address matches only itself. IPv4-mapped IPv6 spellings match IPv4 ranges.
 */
export function isIpInCidr(ip: string, cidr: string): boolean {
  return isAddressInCidr(ip, cidr);
}

/**
 * Validates whether a client IP matches an allowed whitelist of IP addresses and CIDR subnets.
 * Normalizes IPv4-mapped IPv6 addresses for consistent comparison. The unattributed client key never
 * matches an address entry.
 */
export function isIpAllowed(clientIp: string, allowedIps?: string[]): boolean {
  if (!allowedIps || allowedIps.length === 0) return true;
  if (allowedIps.some((entry) => entry.trim() === '*')) return true;
  const cleanIp = normalizeIp(clientIp);
  if (!cleanIp) return false;

  return allowedIps.some((entry) => isAddressInCidr(cleanIp, entry));
}

/**
 * Resolves the client identity of a request with the shared trusted-proxy resolver
 * (src/lib/security/client-ip.ts, which documents the deployment contract). Returns a canonical address,
 * or UNATTRIBUTED_CLIENT_KEY when the request cannot be attributed. Throws InvalidForwardingHeaderError
 * (HTTP 400) for malformed forwarding data and ClientIpConfigError for invalid trust configuration.
 *
 * `trustedProxies` overrides TRUSTED_PROXIES and `peerIp` supplies the socket peer when the runtime has it.
 */
export function extractClientIp(
  request: Request,
  trustedProxies?: string[],
  peerIp?: string
): string {
  const envConfig = loadClientIpConfig();
  const config = trustedProxies
    ? { ...envConfig, trustedProxies: parseClientIpConfig({ trustedProxies }).trustedProxies }
    : envConfig;
  return clientIpKey(resolveClientIp(request, { config, peerIp }));
}
