import dns, { type LookupAddress } from 'node:dns';
import net from 'node:net';
import { Agent } from 'undici';
import { isPublicAddress } from '../conversions/public-address';

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
  const clean = ip.trim();
  if (net.isIP(clean) !== 4) {
    return true;
  }
  return !isPublicAddress(clean);
}

export function isBlockedIpv6(ip: string): boolean {
  const clean = ip.replace(/^\[|\]$/g, '').trim().toLowerCase();
  const zone = clean.indexOf('%');
  const unzoned = zone < 0 ? clean : clean.slice(0, zone);
  if (net.isIP(unzoned) === 6) {
    return !isPublicAddress(clean);
  }
  const mappedIpv4 = parseIpv4MappedIpv6(clean);
  if (mappedIpv4) {
    return isBlockedIpv4(mappedIpv4);
  }
  return clean.includes(':');
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

export function validateWebhookUrl(urlString: string): { valid: boolean; error?: string } {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    return { valid: false, error: 'webhookUrl must be a valid HTTP or HTTPS URL.' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { valid: false, error: 'webhookUrl must use the http: or https: protocol.' };
  }

  if (parsed.username || parsed.password) {
    return { valid: false, error: 'webhookUrl cannot include embedded credentials.' };
  }

  const rawHostname = parsed.hostname.toLowerCase();
  const hostname = rawHostname.startsWith('[') && rawHostname.endsWith(']')
    ? rawHostname.slice(1, -1)
    : rawHostname;

  if (!hostname || isPrivateOrRestrictedHost(hostname)) {
    return { valid: false, error: 'webhookUrl cannot target a private, loopback, or restricted host.' };
  }

  return { valid: true };
}

export class InvalidWebhookConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWebhookConfigError';
  }
}

/**
 * The webhook of a job: the request's own, else the API key's. `webhookKeyId` names `keyId` only when the url and the secret
 * both are the key's, since only then do the key's rotated secrets sign the delivery (`WebhookDispatchOptions.ownerKeyId`).
 */
export function resolveEffectiveWebhook(
  paramUrl: string | undefined,
  paramSecret: string | undefined,
  keyUrl: string | undefined,
  keySecret: string | undefined,
  keyId?: string
): { webhookUrl?: string; webhookSecret?: string; webhookKeyId?: string; error?: string } {
  const webhookUrl = paramUrl || keyUrl;
  const webhookSecret = paramSecret || keySecret;
  if (webhookUrl) {
    const urlCheck = validateWebhookUrl(webhookUrl);
    if (!urlCheck.valid) {
      return { error: urlCheck.error };
    }
    if ((paramUrl && !paramSecret) || !webhookSecret) {
      return { error: 'webhookSecret is required when webhookUrl is provided.' };
    }
  }
  const fromKey = webhookUrl !== undefined && !paramUrl && !paramSecret;
  return { webhookUrl, webhookSecret, webhookKeyId: fromKey ? keyId : undefined };
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

const IP_FAMILIES: ReadonlySet<number> = new Set([4, 6]);

function ssrfBlockedError(message: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(`SSRF blocked: ${message}`);
  err.code = 'ESSRFBLOCKED';
  return err;
}

/**
 * Connect-time DNS lookup that refuses restricted hosts and every resolution containing a
 * restricted IP. Implements the full `net.LookupFunction` contract: with `options.all` (used by
 * autoSelectFamily) it returns the validated address list, otherwise a single address and family.
 */
export const ssrfSafeLookup: net.LookupFunction = (hostname, options, callback) => {
  const rawHost = hostname.toLowerCase();
  const cleanHost = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost;
  const family = IP_FAMILIES.has(Number(options.family)) ? Number(options.family) : 0;

  if (isPrivateOrRestrictedHost(cleanHost)) {
    callback(ssrfBlockedError(`host ${hostname} is restricted`), '', family);
    return;
  }

  dns.lookup(cleanHost, { all: true, family, hints: options.hints }, (err, resolved: LookupAddress[]) => {
    if (err) {
      callback(err, '', family);
      return;
    }
    for (const addr of resolved ?? []) {
      if (isBlockedIp(addr.address)) {
        callback(ssrfBlockedError(`resolved IP ${addr.address} is restricted`), '', family);
        return;
      }
    }
    const addresses = (resolved ?? []).filter((addr) => family === 0 || addr.family === family);
    if (addresses.length === 0) {
      callback(ssrfBlockedError(`could not resolve host ${hostname}`), '', family);
      return;
    }
    if (options.all) {
      callback(null, addresses.map(({ address, family: addrFamily }) => ({ address, family: addrFamily })));
      return;
    }
    callback(null, addresses[0].address, addresses[0].family);
  });
};

/**
 * Creates an Undici Agent that enforces socket-level IP pinning on every connection.
 * This eliminates Time-of-Check to Time-of-Use (TOCTOU) DNS rebinding vulnerabilities
 * by verifying the resolved destination IP address inside the connection lookup hook.
 */
export function createSsrfSafeAgent(): Agent {
  return new Agent({ connect: { lookup: ssrfSafeLookup } });
}
