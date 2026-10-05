/**
 * Single client-IP resolver shared by the edge middleware, API-key IP allowlists, anonymous quotas and
 * login throttling. Pure TypeScript with no `node:` imports so it runs in the Edge runtime.
 *
 * Why this exists: forwarding headers are written by the client unless a proxy we control rewrites them.
 * Trusting them unconditionally lets any caller pick its own rate-limit identity and satisfy any IP
 * allowlist. The rules below follow the usual trusted-proxy model (RFC 7239 semantics, X-Forwarded-For
 * walked from the RIGHT).
 *
 * DEPLOYMENT CONTRACT
 *  1. The socket peer is the only address a client cannot forge. Next.js middleware and App Router route
 *     handlers cannot see it, so on those paths the peer is unknown unless the caller passes `peerIp`
 *     (custom server, Node-style request exposing `socket.remoteAddress`).
 *  2. Forwarding headers (`X-Forwarded-For`, `Forwarded`) are honoured only when their sender is trusted:
 *       - peer known: the peer must be in `TRUSTED_PROXIES` (default when unset: loopback and private
 *         ranges, see DEFAULT_TRUSTED_PROXY_RANGES). An untrusted peer IS the client; its headers are ignored.
 *       - peer unknown (edge middleware, App Router): the operator must DECLARE a front proxy by setting
 *         `TRUSTED_PROXIES` (CIDR list) and/or `TRUSTED_CDN`. The declaration asserts that the origin only
 *         accepts connections from those hops and that the nearest hop appends the address it saw to
 *         `X-Forwarded-For`. The chain is then walked right to left, skipping trusted hops; the first
 *         untrusted address is the client. Everything left of it is attacker-controlled and never read.
 *  3. Nothing declared and no peer known (the default): the request is UNATTRIBUTED. Callers must key rate
 *     limits and quotas on UNATTRIBUTED_CLIENT_KEY (one shared conservative bucket), never on a header, and
 *     IP allowlists never match it. This is fail-closed: an unconfigured production deployment is
 *     throttled as one client rather than trusting spoofable headers.
 *  4. `CF-Connecting-IP` is honoured only with `TRUSTED_CDN=cloudflare` AND when the nearest hop (the peer,
 *     or the rightmost forwarding entry when the peer is unknown) lies in the Cloudflare ranges
 *     (override with `TRUSTED_CDN_RANGES`). `X-Real-IP` and `request.ip` are never consulted.
 *  5. Malformed forwarding data from a trusted sender throws InvalidForwardingHeaderError (HTTP 400);
 *     malformed trust configuration throws ClientIpConfigError (HTTP 500). Header size and hop count are
 *     bounded by MAX_FORWARDING_HEADER_LENGTH and MAX_FORWARDING_HOPS.
 */

export const UNATTRIBUTED_CLIENT_KEY = 'unattributed';

/** Longest forwarding header value inspected (bytes of text). */
export const MAX_FORWARDING_HEADER_LENGTH = 4096;
/** Most hops accepted in one forwarding header. */
export const MAX_FORWARDING_HOPS = 32;
/** Most CIDR entries accepted in one trust list. */
export const MAX_TRUSTED_RANGES = 256;

/** `[ffff:ffff:ffff:ffff:ffff:ffff:255.255.255.255]:65535` is 53 characters; leave headroom. */
const MAX_NODE_TEXT_LENGTH = 64;
const MAX_CIDR_TEXT_LENGTH = MAX_NODE_TEXT_LENGTH + 4;
const MAX_TRUST_LIST_LENGTH = MAX_TRUSTED_RANGES * (MAX_CIDR_TEXT_LENGTH + 1);

const IPV4_BYTES = 4;
const IPV6_BYTES = 16;
const IPV6_GROUPS = 8;
const BITS_PER_BYTE = 8;
const IPV4_BITS = IPV4_BYTES * BITS_PER_BYTE;
const IPV6_BITS = IPV6_BYTES * BITS_PER_BYTE;
const IPV4_MAPPED_PREFIX_BITS = IPV6_BITS - IPV4_BITS;
const IPV4_MAPPED_MARKER_BYTE = 0xff;
const IPV4_MAPPED_MARKER_INDEX = 10;
/** IPv6 clients commonly hold a whole /64, so rate limits and quotas bucket on that prefix. */
export const RATE_LIMIT_IPV6_PREFIX_BITS = 64;
const MAX_PORT = 65535;
const MAX_OCTET = 255;
const HEX_GROUP_MAX_LENGTH = 4;
const BYTE_MASK = 0xff;

/** Loopback and private ranges, used as the trusted-proxy set only when a peer address is known. */
export const DEFAULT_TRUSTED_PROXY_RANGES: readonly string[] = [
  '127.0.0.1/8',
  '::1/128',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  'fc00::/7',
];

/** Published Cloudflare edge ranges (https://www.cloudflare.com/ips/). Override with TRUSTED_CDN_RANGES. */
export const CLOUDFLARE_IP_RANGES: readonly string[] = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
];

const CDN_PROVIDER_RANGES: ReadonlyMap<string, readonly string[]> = new Map([['cloudflare', CLOUDFLARE_IP_RANGES]]);

/** TRUSTED_PROXIES value that declares the server is exposed directly (no proxy in front). */
const NO_TRUSTED_PROXIES = 'none';

const HTTP_BAD_REQUEST = 400;
const HTTP_INTERNAL_ERROR = 500;

export class ClientIpError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ClientIpError';
    this.status = status;
  }
}

/** A trusted sender supplied forwarding data that is not a valid address chain. Maps to HTTP 400. */
export class InvalidForwardingHeaderError extends ClientIpError {
  constructor(message: string) {
    super(message, HTTP_BAD_REQUEST);
    this.name = 'InvalidForwardingHeaderError';
  }
}

/** The operator's trust configuration (or the supplied peer address) is invalid. Maps to HTTP 500. */
export class ClientIpConfigError extends ClientIpError {
  constructor(message: string) {
    super(message, HTTP_INTERNAL_ERROR);
    this.name = 'ClientIpConfigError';
  }
}

// ---------------------------------------------------------------------------------------------------------
// Address parsing
// ---------------------------------------------------------------------------------------------------------

interface ParsedAddress {
  family: 4 | 6;
  bytes: Uint8Array;
}

interface ParsedCidr extends ParsedAddress {
  prefix: number;
}

const DECIMAL_OCTET = /^(?:0|[1-9]\d{0,2})$/;
const HEX_GROUP = /^[0-9a-f]{1,4}$/i;
const IPV6_CHARS = /^[0-9a-f:.]+$/i;
const DIGITS_PORT = /^\d{1,5}$/;
const OBFUSCATED_TOKEN = /^_[A-Za-z0-9._-]+$/;
const PREFIX_LENGTH = /^\d{1,3}$/;
const TCHAR = /[!#$%&'*+\-.^_`|~0-9A-Za-z]/;

function parseIPv4(text: string): Uint8Array | null {
  const parts = text.split('.');
  if (parts.length !== IPV4_BYTES) return null;
  const bytes = new Uint8Array(IPV4_BYTES);
  for (let i = 0; i < IPV4_BYTES; i++) {
    // Leading zeros are rejected: "010" is octal to some stacks and decimal to others.
    if (!DECIMAL_OCTET.test(parts[i])) return null;
    const value = Number(parts[i]);
    if (value > MAX_OCTET) return null;
    bytes[i] = value;
  }
  return bytes;
}

function parseIPv6(input: string): Uint8Array | null {
  if (input.indexOf(':') < 0 || !IPV6_CHARS.test(input)) return null;
  let text = input;

  if (text.includes('.')) {
    const lastColon = text.lastIndexOf(':');
    const tail = parseIPv4(text.slice(lastColon + 1));
    if (!tail) return null;
    const high = ((tail[0] << BITS_PER_BYTE) | tail[1]).toString(16);
    const low = ((tail[2] << BITS_PER_BYTE) | tail[3]).toString(16);
    text = `${text.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] === '' ? [] : halves[0].split(':');
  let groups: string[];
  if (halves.length === 1) {
    groups = head;
    if (groups.length !== IPV6_GROUPS) return null;
  } else {
    const tailGroups = halves[1] === '' ? [] : halves[1].split(':');
    const missing = IPV6_GROUPS - head.length - tailGroups.length;
    // "::" stands for at least one zero group.
    if (missing < 1) return null;
    groups = [...head, ...new Array<string>(missing).fill('0'), ...tailGroups];
  }

  const bytes = new Uint8Array(IPV6_BYTES);
  for (let i = 0; i < IPV6_GROUPS; i++) {
    if (!HEX_GROUP.test(groups[i])) return null;
    const value = parseInt(groups[i], 16);
    bytes[i * 2] = value >> BITS_PER_BYTE;
    bytes[i * 2 + 1] = value & BYTE_MASK;
  }
  return bytes;
}

function isIpv4MappedBytes(bytes: Uint8Array): boolean {
  if (bytes[IPV4_MAPPED_MARKER_INDEX] !== IPV4_MAPPED_MARKER_BYTE || bytes[IPV4_MAPPED_MARKER_INDEX + 1] !== IPV4_MAPPED_MARKER_BYTE) {
    return false;
  }
  for (let i = 0; i < IPV4_MAPPED_MARKER_INDEX; i++) {
    if (bytes[i] !== 0) return false;
  }
  return true;
}

interface RawAddress extends ParsedAddress {
  mapped: boolean;
}

function parseBareAddressRaw(text: string): RawAddress | null {
  if (text.length === 0 || text.length > MAX_NODE_TEXT_LENGTH) return null;
  const v4 = parseIPv4(text);
  if (v4) return { family: 4, bytes: v4, mapped: false };
  const v6 = parseIPv6(text);
  if (!v6) return null;
  if (isIpv4MappedBytes(v6)) {
    return { family: 4, bytes: v6.slice(IPV4_MAPPED_PREFIX_BITS / BITS_PER_BYTE), mapped: true };
  }
  return { family: 6, bytes: v6, mapped: false };
}

function parseBareAddress(text: string): ParsedAddress | null {
  const raw = parseBareAddressRaw(text);
  return raw ? { family: raw.family, bytes: raw.bytes } : null;
}

function formatAddress(address: ParsedAddress): string {
  if (address.family === 4) return Array.from(address.bytes).join('.');

  const groups: number[] = [];
  for (let i = 0; i < IPV6_GROUPS; i++) {
    groups.push((address.bytes[i * 2] << BITS_PER_BYTE) | address.bytes[i * 2 + 1]);
  }
  // RFC 5952 s4.2: compress the longest run of zero groups (first on a tie), never a single group.
  let bestStart = -1;
  let bestLength = 0;
  let runStart = -1;
  for (let i = 0; i <= IPV6_GROUPS; i++) {
    if (i < IPV6_GROUPS && groups[i] === 0) {
      if (runStart < 0) runStart = i;
    } else if (runStart >= 0) {
      if (i - runStart > bestLength) {
        bestStart = runStart;
        bestLength = i - runStart;
      }
      runStart = -1;
    }
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestLength < 2) return hex.join(':');
  const left = hex.slice(0, bestStart).join(':');
  const right = hex.slice(bestStart + bestLength).join(':');
  return `${left}::${right}`;
}

interface NodeParts {
  host: string;
}

/**
 * Splits an RFC 7239 `node` (or an X-Forwarded-For entry) into its host part, dropping the optional port.
 * Returns null when the brackets or the port are malformed.
 */
function splitNode(text: string, allowObfuscatedPort: boolean): NodeParts | null {
  const node = text.trim();
  if (node.length === 0 || node.length > MAX_NODE_TEXT_LENGTH) return null;

  let host: string;
  let port: string | null = null;
  if (node.startsWith('[')) {
    const close = node.indexOf(']');
    if (close < 0) return null;
    host = node.slice(1, close);
    const rest = node.slice(close + 1);
    if (rest !== '') {
      if (!rest.startsWith(':')) return null;
      port = rest.slice(1);
    }
    // Brackets are IPv6-only.
    if (host.indexOf(':') < 0) return null;
  } else {
    const firstColon = node.indexOf(':');
    if (firstColon >= 0 && firstColon === node.lastIndexOf(':')) {
      host = node.slice(0, firstColon);
      port = node.slice(firstColon + 1);
    } else {
      host = node;
    }
  }

  if (port !== null) {
    const numeric = DIGITS_PORT.test(port) && Number(port) <= MAX_PORT;
    const obfuscated = allowObfuscatedPort && OBFUSCATED_TOKEN.test(port);
    if (!numeric && !obfuscated) return null;
  }
  return { host };
}

function parseClientAddress(text: string): ParsedAddress | null {
  const node = splitNode(text, false);
  return node ? parseBareAddress(node.host) : null;
}

/**
 * Validates a client address (optionally with brackets and/or a port) and returns its canonical text:
 * dotted quad for IPv4, RFC 5952 lowercase compressed form for IPv6, IPv4-mapped IPv6 as plain IPv4.
 * Returns null for anything that is not an IP address.
 */
export function normalizeClientAddress(text: string): string | null {
  if (typeof text !== 'string') return null;
  const parsed = parseClientAddress(text);
  return parsed ? formatAddress(parsed) : null;
}

// ---------------------------------------------------------------------------------------------------------
// CIDR matching
// ---------------------------------------------------------------------------------------------------------

function parseCidr(text: string): ParsedCidr | null {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_CIDR_TEXT_LENGTH) return null;
  const parts = trimmed.split('/');
  if (parts.length > 2) return null;
  const base = parseBareAddressRaw(parts[0]);
  if (!base) return null;

  let prefix: number;
  if (parts.length === 2) {
    if (!PREFIX_LENGTH.test(parts[1])) return null;
    prefix = Number(parts[1]);
  } else {
    // A bare address is a single host. A mapped address is held as IPv6 here and narrowed to IPv4 below.
    prefix = base.family === 4 && !base.mapped ? IPV4_BITS : IPV6_BITS;
  }

  if (base.mapped) {
    // ::ffff:a.b.c.d/N with N >= 96 is the IPv4 range a.b.c.d/(N-96); a shorter prefix spans non-IPv4 space.
    if (prefix < IPV4_MAPPED_PREFIX_BITS || prefix > IPV6_BITS) return null;
    return { family: 4, bytes: base.bytes, prefix: prefix - IPV4_MAPPED_PREFIX_BITS };
  }
  const maxBits = base.family === 4 ? IPV4_BITS : IPV6_BITS;
  if (prefix > maxBits) return null;
  return { family: base.family, bytes: base.bytes, prefix };
}

function addressInCidr(address: ParsedAddress, cidr: ParsedCidr): boolean {
  if (address.family !== cidr.family) return false;
  const fullBytes = Math.floor(cidr.prefix / BITS_PER_BYTE);
  for (let i = 0; i < fullBytes; i++) {
    if (address.bytes[i] !== cidr.bytes[i]) return false;
  }
  const remainder = cidr.prefix % BITS_PER_BYTE;
  if (remainder === 0) return true;
  const mask = (BYTE_MASK << (BITS_PER_BYTE - remainder)) & BYTE_MASK;
  return (address.bytes[fullBytes] & mask) === (cidr.bytes[fullBytes] & mask);
}

/** True when `address` (any spelling) lies in `cidr` (an address or `address/prefix`). Invalid input is false. */
export function isAddressInCidr(address: string, cidr: string): boolean {
  if (typeof address !== 'string' || typeof cidr !== 'string') return false;
  const parsedAddress = parseClientAddress(address);
  const parsedCidr = parseCidr(cidr);
  if (!parsedAddress || !parsedCidr) return false;
  return addressInCidr(parsedAddress, parsedCidr);
}

function inAnyRange(address: ParsedAddress, ranges: readonly ParsedCidr[]): boolean {
  for (const range of ranges) {
    if (addressInCidr(address, range)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------------------

export interface ClientIpConfig {
  /** Explicit trusted-proxy ranges; null when the operator declared none. */
  trustedProxies: readonly ParsedCidr[] | null;
  /** Trusted CDN edge ranges; null when no CDN is configured. */
  cdnRanges: readonly ParsedCidr[] | null;
}

export interface ClientIpConfigInput {
  trustedProxies?: string | readonly string[] | null;
  trustedCdn?: string | null;
  trustedCdnRanges?: string | null;
}

function parseCidrEntries(entries: readonly string[], label: string): ParsedCidr[] {
  if (entries.length > MAX_TRUSTED_RANGES) {
    throw new ClientIpConfigError(`${label} lists more than ${MAX_TRUSTED_RANGES} ranges.`);
  }
  return entries.map((entry) => {
    const parsed = typeof entry === 'string' ? parseCidr(entry) : null;
    if (!parsed) {
      throw new ClientIpConfigError(`${label} contains an entry that is not a valid IPv4/IPv6 address or CIDR range.`);
    }
    return parsed;
  });
}

function parseCidrList(raw: string, label: string): ParsedCidr[] {
  if (raw.length > MAX_TRUST_LIST_LENGTH) {
    throw new ClientIpConfigError(`${label} is longer than ${MAX_TRUST_LIST_LENGTH} characters.`);
  }
  return parseCidrEntries(
    raw.split(',').map((s) => s.trim()),
    label
  );
}

/**
 * True once the operator chose a trust mode (TRUSTED_PROXIES as a CIDR list or "none", or TRUSTED_CDN).
 * Production deployments must not run undeclared.
 */
export function isClientIpTrustDeclared(config: ClientIpConfig): boolean {
  return config.trustedProxies !== null || config.cdnRanges !== null;
}

function isBlank(value: string | null | undefined): boolean {
  return value === undefined || value === null || value.trim() === '';
}

/** Parses raw TRUSTED_PROXIES / TRUSTED_CDN / TRUSTED_CDN_RANGES values; blank means "not declared". */
export function parseClientIpConfig(input: ClientIpConfigInput): ClientIpConfig {
  let trustedProxies: ParsedCidr[] | null = null;
  if (Array.isArray(input.trustedProxies)) {
    trustedProxies = parseCidrEntries(input.trustedProxies, 'TRUSTED_PROXIES');
  } else if (typeof input.trustedProxies === 'string' && !isBlank(input.trustedProxies)) {
    // "none" acknowledges direct exposure: an explicit, empty trusted set.
    trustedProxies =
      input.trustedProxies.trim().toLowerCase() === NO_TRUSTED_PROXIES
        ? []
        : parseCidrList(input.trustedProxies, 'TRUSTED_PROXIES');
  }

  let cdnRanges: ParsedCidr[] | null = null;
  if (isBlank(input.trustedCdn)) {
    if (!isBlank(input.trustedCdnRanges)) {
      throw new ClientIpConfigError('TRUSTED_CDN_RANGES requires TRUSTED_CDN to name the provider.');
    }
  } else {
    const provider = (input.trustedCdn as string).trim().toLowerCase();
    const shipped = CDN_PROVIDER_RANGES.get(provider);
    if (!shipped) {
      throw new ClientIpConfigError(`TRUSTED_CDN must be one of: ${[...CDN_PROVIDER_RANGES.keys()].join(', ')}.`);
    }
    cdnRanges = isBlank(input.trustedCdnRanges)
      ? parseCidrEntries(shipped, 'TRUSTED_CDN')
      : parseCidrList(input.trustedCdnRanges as string, 'TRUSTED_CDN_RANGES');
  }

  return { trustedProxies, cdnRanges };
}

let cachedConfig: { key: string; config: ClientIpConfig } | null = null;

/** Reads the trust configuration from the environment, re-parsing only when the raw values change. */
export function loadClientIpConfig(): ClientIpConfig {
  const env: Record<string, string | undefined> = typeof process !== 'undefined' && process.env ? process.env : {};
  const raw: ClientIpConfigInput = {
    trustedProxies: env.TRUSTED_PROXIES,
    trustedCdn: env.TRUSTED_CDN,
    trustedCdnRanges: env.TRUSTED_CDN_RANGES,
  };
  const key = [raw.trustedProxies ?? '', raw.trustedCdn ?? '', raw.trustedCdnRanges ?? ''].join('\u0000');
  if (cachedConfig && cachedConfig.key === key) return cachedConfig.config;
  const config = parseClientIpConfig(raw);
  cachedConfig = { key, config };
  return config;
}

let defaultProxyRanges: ParsedCidr[] | null = null;

function getDefaultProxyRanges(): ParsedCidr[] {
  defaultProxyRanges ??= parseCidrEntries(DEFAULT_TRUSTED_PROXY_RANGES, 'DEFAULT_TRUSTED_PROXY_RANGES');
  return defaultProxyRanges;
}

// ---------------------------------------------------------------------------------------------------------
// Forwarding headers
// ---------------------------------------------------------------------------------------------------------

/** A hop is a parsed address, or null for a placeholder ("unknown", an RFC 7239 obfuscated node). */
type Hop = ParsedAddress | null;

interface Chain {
  /** Raw entries left to right as the headers list them; undefined marks an element without `for=`. */
  entries: Array<string | undefined>;
  forwardedSyntax: boolean;
  header: string;
}

function invalidHeader(header: string, reason: string): InvalidForwardingHeaderError {
  return new InvalidForwardingHeaderError(`${header} header ${reason}.`);
}

function parseHop(chain: Chain, entry: string | undefined): Hop {
  if (entry === undefined) return null;
  const node = splitNode(entry, chain.forwardedSyntax);
  if (!node) throw invalidHeader(chain.header, 'contains an invalid address');
  if (node.host.toLowerCase() === 'unknown') return null;
  if (chain.forwardedSyntax && OBFUSCATED_TOKEN.test(node.host)) return null;
  const address = parseBareAddress(node.host);
  if (!address) throw invalidHeader(chain.header, 'contains an invalid address');
  return address;
}

function readXForwardedFor(value: string): Chain {
  const header = 'X-Forwarded-For';
  if (value.length > MAX_FORWARDING_HEADER_LENGTH) throw invalidHeader(header, 'is too long');
  const entries = value.split(',');
  if (entries.length > MAX_FORWARDING_HOPS) throw invalidHeader(header, 'lists too many hops');
  return { entries: entries.map((e) => e.trim()), forwardedSyntax: false, header };
}

function isOws(char: string): boolean {
  return char === ' ' || char === '\t';
}

/**
 * Tokenizes an RFC 7239 `Forwarded` header into one entry per element (the raw `for` value, or undefined
 * when the element has none). Quoted strings may contain commas, semicolons and backslash escapes.
 */
function readForwarded(value: string): Chain {
  const header = 'Forwarded';
  if (value.length > MAX_FORWARDING_HEADER_LENGTH) throw invalidHeader(header, 'is too long');
  const entries: Array<string | undefined> = [];
  const length = value.length;
  let i = 0;

  const skipOws = (): void => {
    while (i < length && isOws(value[i])) i++;
  };

  while (i < length) {
    let sawPair = false;
    let forValue: string | undefined;

    // One forwarded-element: pairs separated by ';', element ends at ',' or end of input.
    for (;;) {
      skipOws();
      if (i >= length || value[i] === ',') break;
      if (value[i] === ';') {
        i++;
        continue;
      }

      const nameStart = i;
      while (i < length && TCHAR.test(value[i])) i++;
      const name = value.slice(nameStart, i).toLowerCase();
      if (name === '' || value[i] !== '=') throw invalidHeader(header, 'has a malformed parameter');
      i++;

      let pairValue: string;
      if (value[i] === '"') {
        i++;
        let quoted = '';
        let closed = false;
        while (i < length) {
          const char = value[i];
          if (char === '\\' && i + 1 < length) {
            quoted += value[i + 1];
            i += 2;
          } else if (char === '"') {
            closed = true;
            i++;
            break;
          } else {
            quoted += char;
            i++;
          }
        }
        if (!closed) throw invalidHeader(header, 'has an unterminated quoted string');
        pairValue = quoted;
      } else {
        const valueStart = i;
        while (i < length && TCHAR.test(value[i])) i++;
        pairValue = value.slice(valueStart, i);
        if (pairValue === '') throw invalidHeader(header, 'has an empty parameter value');
      }

      skipOws();
      if (i < length && value[i] !== ';' && value[i] !== ',') throw invalidHeader(header, 'has a malformed parameter');

      sawPair = true;
      if (name === 'for') {
        if (forValue !== undefined) throw invalidHeader(header, 'repeats for= within one element');
        forValue = pairValue;
      }
    }

    if (sawPair) {
      entries.push(forValue);
      if (entries.length > MAX_FORWARDING_HOPS) throw invalidHeader(header, 'lists too many hops');
    }
    if (i < length && value[i] === ',') i++;
  }

  return { entries, forwardedSyntax: true, header };
}

function readChains(headers: Headers | undefined): Chain[] {
  const chains: Chain[] = [];
  if (!headers || typeof headers.get !== 'function') return chains;
  const xff = headers.get('x-forwarded-for');
  if (xff !== null && xff.trim() !== '') chains.push(readXForwardedFor(xff));
  const forwarded = headers.get('forwarded');
  if (forwarded !== null && forwarded.trim() !== '') chains.push(readForwarded(forwarded));
  return chains;
}

// ---------------------------------------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------------------------------------

export type ClientIpSource = 'peer' | 'forwarded' | 'cdn-header' | 'unattributed';

export interface ResolvedClientIp {
  /** Canonical client address, or null when the request cannot be attributed. */
  ip: string | null;
  source: ClientIpSource;
}

export interface ResolveClientIpOptions {
  /** Immediate socket peer when the runtime exposes it. */
  peerIp?: string;
  /** Trust configuration; defaults to the environment (TRUSTED_PROXIES, TRUSTED_CDN, TRUSTED_CDN_RANGES). */
  config?: ClientIpConfig;
}

const UNATTRIBUTED: ResolvedClientIp = Object.freeze({ ip: null, source: 'unattributed' as const });

/** Identity to key rate limits and quotas on. Never an address a client chose. */
export function clientIpKey(resolved: ResolvedClientIp): string {
  return resolved.ip ?? UNATTRIBUTED_CLIENT_KEY;
}

/**
 * Bucket key for rate limits and quotas derived from a client key: IPv6 addresses collapse to their /64
 * network ("2001:db8:1:2::/64"), IPv4 (including IPv4-mapped IPv6) and the unattributed key are unchanged.
 * Allowlist checks must keep using the full address.
 */
export function rateLimitKey(clientKey: string): string {
  const address = parseClientAddress(clientKey);
  if (!address) return clientKey;
  if (address.family === 4) return formatAddress(address);
  const network = new Uint8Array(IPV6_BYTES);
  network.set(address.bytes.subarray(0, RATE_LIMIT_IPV6_PREFIX_BITS / BITS_PER_BYTE));
  return `${formatAddress({ family: 6, bytes: network })}/${RATE_LIMIT_IPV6_PREFIX_BITS}`;
}

/** Node-style requests (custom server, Pages API) expose the connection as `socket`; Web Requests do not. */
function readSocketPeer(request: unknown): string | undefined {
  const socket = (request as { socket?: { remoteAddress?: unknown } } | null | undefined)?.socket;
  const address = socket?.remoteAddress;
  return typeof address === 'string' && address !== '' ? address : undefined;
}

function resolvePeer(request: unknown, explicit: string | undefined): ParsedAddress | null {
  const raw = explicit !== undefined && explicit !== '' ? explicit : readSocketPeer(request);
  if (raw === undefined) return null;
  // A link-local socket address may carry a zone id ("fe80::1%eth0"); it is not part of the identity.
  const zoneStart = raw.indexOf('%');
  const peer = parseClientAddress(zoneStart >= 0 ? raw.slice(0, zoneStart) : raw);
  if (!peer) throw new ClientIpConfigError('The supplied socket peer address is not a valid IP address.');
  return peer;
}

function readCdnHeaderAddress(headers: Headers | undefined): ParsedAddress | null {
  const value = headers && typeof headers.get === 'function' ? headers.get('cf-connecting-ip') : null;
  if (value === null || value.trim() === '') return null;
  const address = parseClientAddress(value);
  if (!address) throw invalidHeader('CF-Connecting-IP', 'is not a valid address');
  return address;
}

function resolveChain(
  chain: Chain,
  peer: ParsedAddress | null,
  trusted: readonly ParsedCidr[],
  cdnRanges: readonly ParsedCidr[] | null,
  headers: Headers | undefined
): ResolvedClientIp {
  // Nearest hop: the peer when known, otherwise the address the closest proxy recorded (rightmost entry).
  let nearest: Hop = peer;
  if (nearest === null && chain.entries.length > 0) {
    nearest = parseHop(chain, chain.entries[chain.entries.length - 1]);
  }

  if (cdnRanges && nearest && inAnyRange(nearest, cdnRanges)) {
    const cdnClient = readCdnHeaderAddress(headers);
    if (cdnClient) return { ip: formatAddress(cdnClient), source: 'cdn-header' };
  }

  for (let i = chain.entries.length - 1; i >= 0; i--) {
    const hop = parseHop(chain, chain.entries[i]);
    if (hop === null) return UNATTRIBUTED;
    if (!inAnyRange(hop, trusted)) return { ip: formatAddress(hop), source: 'forwarded' };
  }

  // Every hop is a trusted proxy (internal client): the nearest hop is the only address a proxy vouched for.
  if (peer) return { ip: formatAddress(peer), source: 'peer' };
  if (nearest) return { ip: formatAddress(nearest), source: 'forwarded' };
  return UNATTRIBUTED;
}

/**
 * Resolves the client address of a request under the trusted-proxy contract documented at the top of this
 * file. Throws InvalidForwardingHeaderError (HTTP 400) for malformed forwarding data from a trusted sender
 * and ClientIpConfigError (HTTP 500) for invalid trust configuration.
 */
export function resolveClientIp(
  request: { headers?: Headers } | Request,
  options: ResolveClientIpOptions = {}
): ResolvedClientIp {
  const config = options.config ?? loadClientIpConfig();
  const peer = resolvePeer(request, options.peerIp);

  const declared = (config.trustedProxies !== null && config.trustedProxies.length > 0) || config.cdnRanges !== null;
  // Peer unknown and no front proxy declared: any forwarding header would be attacker-controlled.
  if (peer === null && !declared) return UNATTRIBUTED;

  const proxyRanges = config.trustedProxies ?? (peer ? getDefaultProxyRanges() : []);
  const trusted = config.cdnRanges ? [...proxyRanges, ...config.cdnRanges] : proxyRanges;

  // A peer outside the trusted set is the client itself: its headers are never parsed.
  if (peer && !inAnyRange(peer, trusted)) return { ip: formatAddress(peer), source: 'peer' };

  const headers = (request as { headers?: Headers } | null | undefined)?.headers;
  const chains = readChains(headers);
  if (chains.length === 0) chains.push({ entries: [], forwardedSyntax: false, header: 'X-Forwarded-For' });

  const results = chains.map((chain) => resolveChain(chain, peer, trusted, config.cdnRanges, headers));
  if (results.length === 1) return results[0];

  // X-Forwarded-For and Forwarded both present: one of them may be client-written (the proxy only maintains
  // one), so they must agree on the client or the request is unattributed.
  const [first, second] = results;
  if (first.ip === null || first.ip !== second.ip) return UNATTRIBUTED;
  return first;
}
