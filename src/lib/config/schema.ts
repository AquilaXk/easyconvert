import { BlockList, isIP } from 'node:net';

/**
 * The configuration schema: every environment variable the application reads, with its parser, default,
 * production requirement and owning area. `index.ts` validates an environment against it at start-up;
 * `render-docs.ts` writes docs/configuration.md and docs/configuration.example.env from it.
 *
 * Names and defaults are those the code uses today. A parser is no stricter than the code that consumes the
 * variable, except where that code silently replaced a malformed value with a default: a set-but-malformed
 * value is an error here in every environment.
 */

// ---------------------------------------------------------------------------------------------------------
// Limits that bound untrusted input
// ---------------------------------------------------------------------------------------------------------

/** Longest value of any variable that is parsed at all (the Linux limit for one environment string). */
export const MAX_RAW_VALUE_LENGTH = 131_072;
/** Longest free-form string, host name or credential value. */
export const MAX_STRING_LENGTH = 4096;
/** Longest executable or directory path (PATH_MAX). */
export const MAX_PATH_LENGTH = 4096;
export const MAX_URL_LENGTH = 2048;
/** Longest secret, in UTF-8 bytes. */
export const MAX_SECRET_BYTES = 4096;
/** Most entries in a CIDR list; the client-address resolver accepts the same number (tests/config-schema.test.ts). */
export const MAX_CIDR_LIST_ENTRIES = 256;
/** One CIDR entry: a bracketed IPv6 address with a port is 53 characters, so this is generous (as in client-ip.ts). */
export const MAX_CIDR_ENTRY_LENGTH = 68;
export const MAX_CIDR_LIST_LENGTH = MAX_CIDR_LIST_ENTRIES * (MAX_CIDR_ENTRY_LENGTH + 1);
/** Longest bare address text the resolver takes. */
const MAX_ADDRESS_TEXT_LENGTH = 64;
/** More digits than any integer variable needs; keeps `Number()` exact and the regex bounded. */
const MAX_INTEGER_DIGITS = 16;

export const MIN_PRODUCTION_SECRET_BYTES = 32;
const INT32_MAX = 2_147_483_647;
const TCP_PORT_MAX = 65_535;
const IPV4_BITS = 32;
const IPV6_BITS = 128;
const IPV4_MAPPED_PREFIX_BITS = 96;
const MAX_PORT_DIGITS = 5;
const MAX_PREFIX_DIGITS = 3;
const BYTES_PER_GIB = 1024 * 1024 * 1024;
const BYTES_PER_MIB = 1024 * 1024;

const DECIMAL_DIGITS = new RegExp(`^\\d{1,${MAX_INTEGER_DIGITS}}$`);
const PORT_DIGITS = new RegExp(`^\\d{1,${MAX_PORT_DIGITS}}$`);
const PREFIX_DIGITS = new RegExp(`^\\d{1,${MAX_PREFIX_DIGITS}}$`);
const NONE_KEYWORD = 'none';

// ---------------------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------------------

export type ProcessRole = 'web' | 'worker';

export type ConfigArea =
  | 'runtime'
  | 'network'
  | 'auth'
  | 'secrets'
  | 'storage'
  | 'queue'
  | 'worker'
  | 'limits'
  | 'security'
  | 'tools'
  | 'ui';

export type ValueKind =
  | { readonly type: 'integer'; readonly min: number; readonly max: number }
  | {
      readonly type: 'url';
      readonly schemes: readonly string[];
      /** Schemes allowed when NODE_ENV is production; defaults to `schemes`. */
      readonly productionSchemes?: readonly string[];
      readonly rejectUserInfo?: boolean;
    }
  | {
      readonly type: 'secret';
      readonly minBytes: number;
      /** The consumer trims the value before using it. */
      readonly trim: boolean;
      /** The consumer refuses leading or trailing whitespace in production. */
      readonly rejectSurroundingWhitespace: boolean;
    }
  | { readonly type: 'credential' }
  | { readonly type: 'cidrList'; readonly allowNone: boolean }
  | { readonly type: 'enum'; readonly values: readonly string[]; readonly caseInsensitive: boolean }
  | { readonly type: 'executable' }
  | { readonly type: 'path' }
  | { readonly type: 'boolean' }
  | { readonly type: 'string'; readonly maxLength?: number };

/** What a parser returns for each kind. A CIDR list is the entries as written; an empty list is an explicit "none". */
export interface KindValues {
  integer: number;
  url: string;
  secret: string;
  credential: string;
  cidrList: readonly string[];
  enum: string;
  executable: string;
  path: string;
  boolean: boolean;
  string: string;
}

export type ParsedValue = KindValues[keyof KindValues] | undefined;

export interface VariableSpec {
  readonly name: string;
  readonly area: ConfigArea;
  readonly description: string;
  readonly kind: ValueKind;
  /** Value used when the variable is unset. Parsed values of this kind: number, boolean or string. */
  readonly default?: string | number | boolean;
  /** Value used when unset and NODE_ENV is not production. */
  readonly developmentDefault?: string | number | boolean;
  /** Documentation only: the default is computed by the consumer, so no constant exists. */
  readonly computedDefault?: string;
  /** Start-up fails in production when the variable is unset (in the processes of `roles`). */
  readonly requiredInProduction: boolean;
  /** Required in production only when another variable has this value. */
  readonly requiredWhen?: { readonly variable: string; readonly equals: string };
  /** Setting this variable requires another one to be set. */
  readonly requires?: { readonly variable: string; readonly because: string };
  /** The value is a credential or key: documents show it empty and errors never mention it. */
  readonly secret: boolean;
  /** The processes that read the variable; a production requirement is enforced in these. */
  readonly roles: readonly ProcessRole[];
  /** The platform sets it (not the operator), so the example file leaves it out. */
  readonly platformManaged?: boolean;
}

/** One of these variables must be set in production, in the processes of `roles`. */
export interface AnyOfGroup {
  readonly names: readonly string[];
  readonly roles: readonly ProcessRole[];
  /**
   * The consumer uses the first name that is set and ignores the rest, so the production rules of a name that an
   * earlier name shadows do not apply (a stale value there must not stop a working deployment).
   */
  readonly firstSetWins: boolean;
}

export interface ParseContext {
  readonly production: boolean;
}

/** A value broke the rule of its parser. `rule` is fixed text that never contains any part of the value. */
export class ConfigRuleError extends Error {
  constructor(readonly rule: string) {
    super(rule);
    this.name = 'ConfigRuleError';
  }
}

// ---------------------------------------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------------------------------------

function fail(rule: string): never {
  throw new ConfigRuleError(rule);
}

function parseInteger(raw: string, kind: Extract<ValueKind, { type: 'integer' }>): number {
  const text = raw.trim();
  const rule = `must be a whole number from ${kind.min} to ${kind.max}`;
  if (!DECIMAL_DIGITS.test(text)) return fail(rule);
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < kind.min || value > kind.max) return fail(rule);
  return value;
}

function describeSchemes(schemes: readonly string[]): string {
  return schemes.map((scheme) => scheme.replace(/:$/, '')).join(' or ');
}

function parseUrl(raw: string, kind: Extract<ValueKind, { type: 'url' }>, context: ParseContext): string {
  const text = raw.trim();
  if (text.length > MAX_URL_LENGTH) return fail(`must be at most ${MAX_URL_LENGTH} characters`);
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return fail(`must be a URL with the scheme ${describeSchemes(kind.schemes)}`);
  }
  if (!kind.schemes.includes(parsed.protocol)) return fail(`must be a URL with the scheme ${describeSchemes(kind.schemes)}`);
  if (context.production && kind.productionSchemes !== undefined && !kind.productionSchemes.includes(parsed.protocol)) {
    return fail(`must use ${describeSchemes(kind.productionSchemes)} in production`);
  }
  if (kind.rejectUserInfo === true && (parsed.username !== '' || parsed.password !== '')) return fail('must not carry user info');
  return text;
}

/**
 * Every consumer of a key secret (job-secret-seal.ts, storage-config.ts, secret-encryption.ts, jwt.ts,
 * webhook-secret-store.ts, credentials-vault.ts, key-store.ts) feeds the UTF-8 bytes of the text to HKDF, SHA-256
 * or HMAC. None of them decodes hex or base64, so the length is measured on the text and never decoded.
 */
function parseSecret(raw: string, kind: Extract<ValueKind, { type: 'secret' }>, context: ParseContext): string {
  const value = kind.trim ? raw.trim() : raw;
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > MAX_SECRET_BYTES) return fail(`must be at most ${MAX_SECRET_BYTES} bytes`);
  if (context.production) {
    if (kind.rejectSurroundingWhitespace && value !== value.trim()) return fail('must not start or end with whitespace');
    if (bytes < kind.minBytes) return fail(`must be at least ${kind.minBytes} bytes (UTF-8 text, not decoded) in production`);
  }
  return value;
}

function parseCredential(raw: string): string {
  if (Buffer.byteLength(raw, 'utf8') > MAX_SECRET_BYTES) return fail(`must be at most ${MAX_SECRET_BYTES} bytes`);
  return raw;
}

const CIDR_RULE = 'must be a comma-separated list of IPv4/IPv6 addresses or CIDR ranges';

/** An address with an optional `[...]` and `:port`, as an unranged list entry may be written (client-ip.ts splitNode). */
function hostOfBareEntry(entry: string): string | undefined {
  if (entry.length === 0 || entry.length > MAX_ADDRESS_TEXT_LENGTH) return undefined;
  let host: string;
  let port: string | undefined;
  if (entry.startsWith('[')) {
    const close = entry.indexOf(']');
    if (close < 0) return undefined;
    host = entry.slice(1, close);
    const rest = entry.slice(close + 1);
    if (rest !== '') {
      if (!rest.startsWith(':')) return undefined;
      port = rest.slice(1);
    }
    // Brackets are IPv6-only.
    if (!host.includes(':')) return undefined;
  } else {
    const firstColon = entry.indexOf(':');
    if (firstColon >= 0 && firstColon === entry.lastIndexOf(':')) {
      host = entry.slice(0, firstColon);
      port = entry.slice(firstColon + 1);
    } else {
      host = entry;
    }
  }
  if (port !== undefined && !(PORT_DIGITS.test(port) && Number(port) <= TCP_PORT_MAX)) return undefined;
  return host;
}

const IPV4_MAPPED_RANGE = new BlockList();
IPV4_MAPPED_RANGE.addSubnet('::ffff:0:0', IPV4_MAPPED_PREFIX_BITS, 'ipv6');

/**
 * One list entry: an address or `address/prefix`. Node's `BlockList` decides whether address and prefix are valid
 * for the family; the extra rules are those of the client-address resolver that will read these lists: no zone
 * ids, an IPv4-mapped range of at least /96, and the port or brackets only on an unranged entry.
 */
function isValidCidrEntry(entry: string): boolean {
  if (entry.length > MAX_CIDR_ENTRY_LENGTH) return false;
  const parts = entry.split('/');
  if (parts.length > 2) return false;
  const host = parts.length === 1 ? hostOfBareEntry(parts[0]) : parts[0];
  if (host === undefined || host.length > MAX_ADDRESS_TEXT_LENGTH || host.includes('%')) return false;
  const family = isIP(host);
  if (family === 0) return false;
  const ipv6 = family === 6;
  let prefix = ipv6 ? IPV6_BITS : IPV4_BITS;
  if (parts.length === 2) {
    if (!PREFIX_DIGITS.test(parts[1])) return false;
    prefix = Number(parts[1]);
    if (ipv6 && IPV4_MAPPED_RANGE.check(host, 'ipv6') && prefix < IPV4_MAPPED_PREFIX_BITS) return false;
  }
  try {
    new BlockList().addSubnet(host, prefix, ipv6 ? 'ipv6' : 'ipv4');
  } catch {
    return false;
  }
  return true;
}

/**
 * A comma-separated list of addresses and ranges, or `none` (an explicit empty set) when the kind allows it.
 * Returns undefined for a list that holds only separators: it declares nothing, as in client-ip.ts.
 */
function parseCidrList(raw: string, kind: Extract<ValueKind, { type: 'cidrList' }>): readonly string[] | undefined {
  const text = raw.trim();
  if (text.length > MAX_CIDR_LIST_LENGTH) return fail(`must be at most ${MAX_CIDR_LIST_LENGTH} characters`);
  if (kind.allowNone && text.toLowerCase() === NONE_KEYWORD) return [];
  const entries = text
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  if (entries.length > MAX_CIDR_LIST_ENTRIES) return fail(`must list at most ${MAX_CIDR_LIST_ENTRIES} ranges`);
  for (const entry of entries) {
    if (!isValidCidrEntry(entry)) return fail(CIDR_RULE);
  }
  return entries.length === 0 ? undefined : entries;
}

function parseEnum(raw: string, kind: Extract<ValueKind, { type: 'enum' }>): string {
  const text = kind.caseInsensitive ? raw.trim().toLowerCase() : raw.trim();
  if (!kind.values.includes(text)) return fail(`must be one of: ${kind.values.join(', ')}`);
  return text;
}

/** An executable or directory path. Whether it exists is the consumer's concern: it may be created later. */
function parsePath(raw: string): string {
  if (raw.includes('\0')) return fail('must not contain a NUL byte');
  if (raw.length > MAX_PATH_LENGTH) return fail(`must be at most ${MAX_PATH_LENGTH} characters`);
  return raw;
}

function parseBoolean(raw: string): boolean {
  const text = raw.trim().toLowerCase();
  if (text === 'true') return true;
  if (text === 'false') return false;
  return fail('must be true or false');
}

function parseString(raw: string, kind: Extract<ValueKind, { type: 'string' }>): string {
  const limit = kind.maxLength ?? MAX_STRING_LENGTH;
  if (raw.length > limit) return fail(`must be at most ${limit} characters`);
  return raw;
}

/** Parses one non-blank value. Throws ConfigRuleError with a rule that does not contain the value. */
export function parseKind(kind: ValueKind, raw: string, context: ParseContext): ParsedValue {
  if (raw.length > MAX_RAW_VALUE_LENGTH) return fail(`must be at most ${MAX_RAW_VALUE_LENGTH} characters`);
  switch (kind.type) {
    case 'integer':
      return parseInteger(raw, kind);
    case 'url':
      return parseUrl(raw, kind, context);
    case 'secret':
      return parseSecret(raw, kind, context);
    case 'credential':
      return parseCredential(raw);
    case 'cidrList':
      return parseCidrList(raw, kind);
    case 'enum':
      return parseEnum(raw, kind);
    case 'executable':
    case 'path':
      return parsePath(raw);
    case 'boolean':
      return parseBoolean(raw);
    case 'string':
      return parseString(raw, kind);
  }
}

// ---------------------------------------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------------------------------------

const WEB: readonly ProcessRole[] = ['web'];
const BOTH: readonly ProcessRole[] = ['web', 'worker'];

/** A native tool's executable path: optional, never secret, searched in the standard locations when unset. */
function toolPath<const N extends string>(name: N, description: string, roles: readonly ProcessRole[]) {
  return {
    name,
    area: 'tools',
    description,
    kind: { type: 'executable' },
    requiredInProduction: false,
    secret: false,
    roles,
  } as const satisfies VariableSpec;
}

const HTTP_SCHEMES = ['http:', 'https:'] as const;
const REDIS_SCHEMES = ['redis:', 'rediss:'] as const;
const HTTPS_ONLY = ['https:'] as const;
const STORAGE_DRIVERS = ['oci', 's3', 'local'] as const;
const FORWARDING_HEADERS = ['x-forwarded-for', 'forwarded'] as const;
const CDN_PROVIDERS = ['cloudflare'] as const;

/** Key material: the consumers hash or derive from the UTF-8 text. */
const KEY_SECRET = { type: 'secret', minBytes: MIN_PRODUCTION_SECRET_BYTES, trim: false, rejectSurroundingWhitespace: false } as const;
/** src/lib/security/job-secret-seal.ts readKek: untrimmed bytes, surrounding whitespace refused in production. */
const SEALING_SECRET = { type: 'secret', minBytes: MIN_PRODUCTION_SECRET_BYTES, trim: false, rejectSurroundingWhitespace: true } as const;
/** src/lib/storage/storage-config.ts readVar and resolveSigningSecret: the value is trimmed, then measured. */
const SIGNING_SECRET = { type: 'secret', minBytes: MIN_PRODUCTION_SECRET_BYTES, trim: true, rejectSurroundingWhitespace: false } as const;

const SCHEMA_ENTRIES = [
  // ---- runtime ----------------------------------------------------------------------------------------
  {
    name: 'NODE_ENV',
    area: 'runtime',
    description:
      'Runtime mode. Only the value `production` switches on production start-up validation and production-only behaviour; any other value is treated as development.',
    kind: { type: 'string', maxLength: 32 },
    requiredInProduction: false,
    secret: false,
    roles: BOTH,
    platformManaged: true,
  },
  {
    name: 'NEXT_PHASE',
    area: 'runtime',
    description: 'Set by Next.js. During `next build` (`phase-production-build`) production requirements are not enforced.',
    kind: { type: 'string', maxLength: 64 },
    requiredInProduction: false,
    secret: false,
    roles: BOTH,
    platformManaged: true,
  },
  {
    name: 'NEXT_RUNTIME',
    area: 'runtime',
    description: 'Set by Next.js to `nodejs` or `edge`; the start-up hook runs only under `nodejs`.',
    kind: { type: 'string', maxLength: 32 },
    requiredInProduction: false,
    secret: false,
    roles: WEB,
    platformManaged: true,
  },
  {
    name: 'PATH',
    area: 'runtime',
    description: 'Directories searched for the native conversion tools and handed to sandboxed child processes.',
    kind: { type: 'string', maxLength: MAX_RAW_VALUE_LENGTH },
    requiredInProduction: false,
    secret: false,
    roles: BOTH,
    platformManaged: true,
  },
  {
    name: 'KUBERNETES_SERVICE_HOST',
    area: 'runtime',
    description: 'Set by Kubernetes. Any non-empty value marks the process as already container-isolated.',
    kind: { type: 'string' },
    requiredInProduction: false,
    secret: false,
    roles: BOTH,
    platformManaged: true,
  },
  {
    name: 'CONTAINER_SANDBOX',
    area: 'runtime',
    description: 'Any non-empty value declares that the process already runs inside a container sandbox.',
    kind: { type: 'string' },
    requiredInProduction: false,
    secret: false,
    roles: BOTH,
  },
  {
    name: 'STRICT_SANDBOX',
    area: 'security',
    description: 'Set to `true` to refuse running native tools without the strict process sandbox.',
    kind: { type: 'boolean' },
    default: false,
    requiredInProduction: false,
    secret: false,
    roles: BOTH,
  },

  // ---- network ----------------------------------------------------------------------------------------
  {
    name: 'APP_URL',
    area: 'network',
    description:
      'Public origin of this application, used to build the URLs of local-driver uploads. Required in production when STORAGE_DRIVER is `local`.',
    kind: { type: 'url', schemes: HTTP_SCHEMES },
    developmentDefault: 'http://localhost:3000',
    requiredInProduction: false,
    requiredWhen: { variable: 'STORAGE_DRIVER', equals: 'local' },
    secret: false,
    roles: WEB,
  },
  {
    name: 'APP_ORIGIN',
    area: 'network',
    description: 'Canonical origin used for OAuth redirects and the same-origin check of the API; takes precedence over NEXT_PUBLIC_APP_URL.',
    kind: { type: 'url', schemes: HTTP_SCHEMES },
    requiredInProduction: false,
    secret: false,
    roles: WEB,
  },
  {
    name: 'NEXT_PUBLIC_APP_URL',
    area: 'network',
    description: 'Public origin exposed to the browser; used when APP_ORIGIN is not set.',
    kind: { type: 'url', schemes: HTTP_SCHEMES },
    requiredInProduction: false,
    secret: false,
    roles: WEB,
  },
  {
    name: 'TRUSTED_PROXIES',
    area: 'security',
    description:
      'Comma-separated IPv4/IPv6 addresses or CIDR ranges of the reverse proxies in front of the server, or `none` for a directly exposed server. Production should declare one of TRUSTED_PROXIES or TRUSTED_CDN; the edge middleware answers API requests with 503 until it does (docs/client-ip-trust.md).',
    kind: { type: 'cidrList', allowNone: true },
    requiredInProduction: false,
    secret: false,
    roles: WEB,
  },
  {
    name: 'TRUSTED_CDN',
    area: 'security',
    description: 'Name of the CDN whose edge ranges are trusted to forward client addresses.',
    kind: { type: 'enum', values: CDN_PROVIDERS, caseInsensitive: true },
    requiredInProduction: false,
    secret: false,
    roles: WEB,
  },
  {
    name: 'TRUSTED_CDN_RANGES',
    area: 'security',
    description: 'CIDR ranges that replace the built-in edge ranges of TRUSTED_CDN.',
    kind: { type: 'cidrList', allowNone: false },
    requiredInProduction: false,
    requires: { variable: 'TRUSTED_CDN', because: 'to name the provider' },
    secret: false,
    roles: WEB,
  },
  {
    name: 'TRUSTED_PROXY_HEADER',
    area: 'security',
    description: 'The one forwarding header the trusted proxy writes: `x-forwarded-for` (default) or `forwarded`.',
    kind: { type: 'enum', values: FORWARDING_HEADERS, caseInsensitive: true },
    requiredInProduction: false,
    secret: false,
    roles: WEB,
  },

  // ---- auth -------------------------------------------------------------------------------------------
  {
    name: 'JWT_SECRET',
    area: 'auth',
    description:
      'Signs session tokens. At least 32 bytes of UTF-8 text in production; also the last fallback key of the credential vault and of API key secret encryption.',
    kind: KEY_SECRET,
    requiredInProduction: true,
    secret: true,
    roles: WEB,
  },
  {
    name: 'GOOGLE_CLIENT_ID',
    area: 'auth',
    description: 'OAuth client id for Google sign-in. Without it, development uses a local mock sign-in and production refuses to sign in.',
    kind: { type: 'string' },
    requiredInProduction: false,
    secret: false,
    roles: WEB,
  },
  {
    name: 'GOOGLE_CLIENT_SECRET',
    area: 'auth',
    description: 'OAuth client secret for Google sign-in; required together with GOOGLE_CLIENT_ID.',
    kind: { type: 'credential' },
    requiredInProduction: false,
    secret: true,
    roles: WEB,
  },

  // ---- secrets ----------------------------------------------------------------------------------------
  {
    name: 'KEY_HASH_PEPPER',
    area: 'secrets',
    description:
      'Pepper of the HMAC that hashes API key secrets. At least 32 bytes of UTF-8 text in production. Also the second fallback key of API key secret encryption.',
    kind: KEY_SECRET,
    requiredInProduction: true,
    secret: true,
    roles: WEB,
  },
  {
    name: 'KEY_ENCRYPTION_KEY',
    area: 'secrets',
    description:
      'Key that encrypts API key webhook secrets at rest; falls back to KEY_HASH_PEPPER, then JWT_SECRET. Also the second fallback key of the credential vault.',
    kind: KEY_SECRET,
    requiredInProduction: false,
    secret: true,
    roles: BOTH,
  },
  {
    name: 'WEBHOOK_SECRET_KEK',
    area: 'secrets',
    description:
      'Key-encryption key of the webhook signing secrets. At least 32 bytes of UTF-8 text in production. The worker dispatches webhooks and needs it too once the deployment sends them.',
    kind: KEY_SECRET,
    requiredInProduction: true,
    secret: true,
    roles: WEB,
  },
  {
    name: 'STORAGE_VAULT_KEY',
    area: 'secrets',
    description: 'Master key of the vault that holds customer storage credentials; falls back to KEY_ENCRYPTION_KEY, then JWT_SECRET.',
    kind: KEY_SECRET,
    requiredInProduction: false,
    secret: true,
    roles: BOTH,
  },
  {
    name: 'JOB_SECRET_KEK',
    area: 'secrets',
    description:
      'Key-encryption key that seals signed URLs and headers inside queued jobs. At least 32 bytes of UTF-8 text, no surrounding whitespace, in production. Shared by the API and every worker.',
    kind: SEALING_SECRET,
    requiredInProduction: true,
    secret: true,
    roles: BOTH,
  },
  {
    name: 'JOB_SECRET_KEK_PREVIOUS',
    area: 'secrets',
    description: 'The previous JOB_SECRET_KEK during a rotation, so jobs sealed under it can still be opened.',
    kind: SEALING_SECRET,
    requiredInProduction: false,
    secret: true,
    roles: BOTH,
  },

  // ---- storage ----------------------------------------------------------------------------------------
  {
    name: 'STORAGE_DRIVER',
    area: 'storage',
    description:
      'Where objects live: `oci` (OCI Object Storage), `s3` (an S3-compatible service) or `local` (disk of this host, for development and single-node use). Must be chosen in production.',
    kind: { type: 'enum', values: STORAGE_DRIVERS, caseInsensitive: true },
    developmentDefault: 'local',
    requiredInProduction: true,
    secret: false,
    roles: BOTH,
  },
  {
    name: 'STORAGE_SIGNING_SECRET',
    area: 'storage',
    description:
      'Signs upload and download URLs. At least 32 bytes of UTF-8 text in production (surrounding whitespace is trimmed). One of STORAGE_SIGNING_SECRET, S3_SIGNING_SECRET or OCI_SIGNING_SECRET is required in production; the first one set wins.',
    kind: SIGNING_SECRET,
    requiredInProduction: false,
    secret: true,
    roles: BOTH,
  },
  {
    name: 'S3_SIGNING_SECRET',
    area: 'storage',
    description: 'Alternative name of STORAGE_SIGNING_SECRET; used when STORAGE_SIGNING_SECRET is not set.',
    kind: SIGNING_SECRET,
    requiredInProduction: false,
    secret: true,
    roles: BOTH,
  },
  {
    name: 'OCI_SIGNING_SECRET',
    area: 'storage',
    description: 'Alternative name of STORAGE_SIGNING_SECRET; used when neither STORAGE_SIGNING_SECRET nor S3_SIGNING_SECRET is set.',
    kind: SIGNING_SECRET,
    requiredInProduction: false,
    secret: true,
    roles: BOTH,
  },
  {
    name: 'EASYCONVERT_STORAGE_DIR',
    area: 'storage',
    description: 'Directory of the local storage driver and of the API key, usage and file stores. Share it between the API and the workers.',
    kind: { type: 'path' },
    computedDefault: '.easyconvert/storage under the working directory',
    requiredInProduction: false,
    secret: false,
    roles: BOTH,
  },
  {
    name: 'OCI_NAMESPACE',
    area: 'storage',
    description: 'OCI Object Storage namespace (a single DNS label). Required when STORAGE_DRIVER is `oci`; checked when storage is selected.',
    kind: { type: 'string', maxLength: 64 },
    requiredInProduction: false,
    secret: false,
    roles: BOTH,
  },
  {
    name: 'OCI_REGION',
    area: 'storage',
    description:
      'OCI region (lowercase letters, digits, hyphens). Required when STORAGE_DRIVER is `oci`; only the in-memory OCI emulation falls back to a region.',
    kind: { type: 'string', maxLength: 64 },
    computedDefault: 'ap-seoul-1 (in-memory OCI emulation only)',
    requiredInProduction: false,
    secret: false,
    roles: BOTH,
  },
  {
    name: 'OCI_BUCKET',
    area: 'storage',
    description:
      'OCI bucket name. Required when STORAGE_DRIVER is `oci` (OCI_BUCKET_NAME is accepted instead); only the in-memory OCI emulation falls back to a bucket.',
    kind: { type: 'string', maxLength: 256 },
    computedDefault: 'easyconvert-transcode-bucket (in-memory OCI emulation only)',
    requiredInProduction: false,
    secret: false,
    roles: BOTH,
  },
  {
    name: 'OCI_BUCKET_NAME',
    area: 'storage',
    description: 'Alternative name of OCI_BUCKET; used when OCI_BUCKET is not set.',
    kind: { type: 'string', maxLength: 256 },
    requiredInProduction: false,
    secret: false,
    roles: BOTH,
  },
  {
    name: 'OCI_ENDPOINT',
    area: 'storage',
    description: 'Overrides the S3-compatible endpoint derived from the namespace and region (private endpoint, test server). https in production.',
    kind: { type: 'url', schemes: HTTP_SCHEMES, productionSchemes: HTTPS_ONLY, rejectUserInfo: true },
    requiredInProduction: false,
    secret: false,
    roles: BOTH,
  },
  {
    name: 'OCI_ACCESS_KEY_ID',
    area: 'storage',
    description: 'Customer secret key id of the OCI S3-compatible API. Required when STORAGE_DRIVER is `oci`.',
    kind: { type: 'credential' },
    requiredInProduction: false,
    secret: true,
    roles: BOTH,
  },
  {
    name: 'OCI_SECRET_ACCESS_KEY',
    area: 'storage',
    description: 'Customer secret key of the OCI S3-compatible API. Required when STORAGE_DRIVER is `oci`.',
    kind: { type: 'credential' },
    requiredInProduction: false,
    secret: true,
    roles: BOTH,
  },
  {
    name: 'S3_ENDPOINT',
    area: 'storage',
    description: 'Endpoint of the S3-compatible service. Required when STORAGE_DRIVER is `s3`. https in production.',
    kind: { type: 'url', schemes: HTTP_SCHEMES, productionSchemes: HTTPS_ONLY, rejectUserInfo: true },
    requiredInProduction: false,
    secret: false,
    roles: BOTH,
  },
  {
    name: 'S3_REGION',
    area: 'storage',
    description: 'Region of the S3-compatible service (lowercase letters, digits, hyphens). Required when STORAGE_DRIVER is `s3`.',
    kind: { type: 'string', maxLength: 64 },
    requiredInProduction: false,
    secret: false,
    roles: BOTH,
  },
  {
    name: 'S3_BUCKET',
    area: 'storage',
    description: 'Bucket name. Required when STORAGE_DRIVER is `s3` (S3_BUCKET_NAME is accepted instead).',
    kind: { type: 'string', maxLength: 256 },
    requiredInProduction: false,
    secret: false,
    roles: BOTH,
  },
  {
    name: 'S3_BUCKET_NAME',
    area: 'storage',
    description: 'Alternative name of S3_BUCKET; used when S3_BUCKET is not set.',
    kind: { type: 'string', maxLength: 256 },
    requiredInProduction: false,
    secret: false,
    roles: BOTH,
  },
  {
    name: 'S3_ACCESS_KEY_ID',
    area: 'storage',
    description: 'Access key id of the S3-compatible service. Required when STORAGE_DRIVER is `s3`.',
    kind: { type: 'credential' },
    requiredInProduction: false,
    secret: true,
    roles: BOTH,
  },
  {
    name: 'S3_SECRET_ACCESS_KEY',
    area: 'storage',
    description: 'Secret access key of the S3-compatible service. Required when STORAGE_DRIVER is `s3`.',
    kind: { type: 'credential' },
    requiredInProduction: false,
    secret: true,
    roles: BOTH,
  },
  {
    name: 'S3_FORCE_PATH_STYLE',
    area: 'storage',
    description: 'Path-style bucket addressing. Set to `false` for virtual-hosted-style addressing.',
    kind: { type: 'boolean' },
    default: true,
    requiredInProduction: false,
    secret: false,
    roles: BOTH,
  },
  {
    name: 'AWS_ACCESS_KEY_ID',
    area: 'storage',
    description: 'Deprecated fallback of OCI_ACCESS_KEY_ID and S3_ACCESS_KEY_ID; logs a warning when used.',
    kind: { type: 'credential' },
    requiredInProduction: false,
    secret: true,
    roles: BOTH,
  },
  {
    name: 'AWS_SECRET_ACCESS_KEY',
    area: 'storage',
    description: 'Deprecated fallback of OCI_SECRET_ACCESS_KEY and S3_SECRET_ACCESS_KEY; logs a warning when used.',
    kind: { type: 'credential' },
    requiredInProduction: false,
    secret: true,
    roles: BOTH,
  },
  {
    name: 'AWS_REGION',
    area: 'storage',
    description: 'Deprecated fallback of OCI_REGION and S3_REGION; logs a warning when used.',
    kind: { type: 'string', maxLength: 64 },
    requiredInProduction: false,
    secret: false,
    roles: BOTH,
  },
  {
    name: 'AWS_BUCKET_NAME',
    area: 'storage',
    description: 'Deprecated fallback of OCI_BUCKET and S3_BUCKET; logs a warning when used.',
    kind: { type: 'string', maxLength: 256 },
    requiredInProduction: false,
    secret: false,
    roles: BOTH,
  },
  {
    name: 'BYOS_S3_DEV_ENDPOINT_ALLOWLIST',
    area: 'storage',
    description:
      'Comma-separated host[:port] list of customer S3 endpoints that may be plain http or private-address. Honoured only when NODE_ENV is exactly `development`.',
    kind: { type: 'string' },
    requiredInProduction: false,
    secret: false,
    roles: BOTH,
  },

  // ---- queue ------------------------------------------------------------------------------------------
  {
    name: 'REDIS_URL',
    area: 'queue',
    description:
      'Redis connection URL (`redis://` or `rediss://`, may carry a password). With neither REDIS_URL nor REDIS_HOST set, the queue and stores run in memory (development only).',
    kind: { type: 'url', schemes: REDIS_SCHEMES },
    requiredInProduction: false,
    secret: true,
    roles: BOTH,
  },
  {
    name: 'REDIS_HOST',
    area: 'queue',
    description: 'Redis host, used when REDIS_URL is not set.',
    kind: { type: 'string' },
    requiredInProduction: false,
    secret: false,
    roles: BOTH,
  },
  {
    name: 'REDIS_PORT',
    area: 'queue',
    description: 'Redis port, used with REDIS_HOST.',
    kind: { type: 'integer', min: 1, max: TCP_PORT_MAX },
    default: 6379,
    requiredInProduction: false,
    secret: false,
    roles: BOTH,
  },
  {
    name: 'EASYCONVERT_WORKER_ENABLED',
    area: 'queue',
    description: 'Set to `true` to run the queue worker inside the web process (single-node use).',
    kind: { type: 'boolean' },
    default: false,
    requiredInProduction: false,
    secret: false,
    roles: WEB,
  },

  // ---- worker -----------------------------------------------------------------------------------------
  {
    name: 'WORKER_CONCURRENCY',
    area: 'worker',
    description: 'Jobs a worker runs at once.',
    kind: { type: 'integer', min: 1, max: 1024 },
    default: 3,
    requiredInProduction: false,
    secret: false,
    roles: ['worker'],
  },
  {
    name: 'WORKER_MAX_JOBS',
    area: 'worker',
    description: 'Jobs after which the worker drains and exits so the container manager restarts it. `0` turns recycling by job count off.',
    kind: { type: 'integer', min: 0, max: INT32_MAX },
    default: 1000,
    requiredInProduction: false,
    secret: false,
    roles: ['worker'],
  },
  {
    name: 'WORKER_MAX_RSS_MB',
    area: 'worker',
    description: 'Resident memory in MiB above which the worker drains and exits after a job. `0` turns recycling by memory off.',
    kind: { type: 'integer', min: 0, max: 1_048_576 },
    default: 4096,
    requiredInProduction: false,
    secret: false,
    roles: ['worker'],
  },
  {
    name: 'WORKER_DRAIN_TIMEOUT_MS',
    area: 'worker',
    description: 'Milliseconds a draining worker waits for active jobs before it aborts them.',
    kind: { type: 'integer', min: 0, max: INT32_MAX },
    default: 60_000,
    requiredInProduction: false,
    secret: false,
    roles: ['worker'],
  },
  {
    name: 'WORKER_HEARTBEAT_INTERVAL_MS',
    area: 'worker',
    description: 'Milliseconds between heartbeat file updates.',
    kind: { type: 'integer', min: 1, max: INT32_MAX },
    default: 5000,
    requiredInProduction: false,
    secret: false,
    roles: ['worker'],
  },
  {
    name: 'WORKER_HEARTBEAT_FILE',
    area: 'worker',
    description: 'File the worker writes its heartbeat to; the container health check reads it.',
    kind: { type: 'path' },
    computedDefault: 'worker-heartbeat.json in the operating system temporary directory',
    requiredInProduction: false,
    secret: false,
    roles: ['worker'],
  },
  {
    name: 'WORKER_HEARTBEAT_MAX_STALE_MS',
    area: 'worker',
    description: 'Age in milliseconds after which the container health check (scripts/worker-healthcheck.js) calls the heartbeat stale.',
    kind: { type: 'integer', min: 1, max: INT32_MAX },
    default: 35_000,
    requiredInProduction: false,
    secret: false,
    roles: ['worker'],
  },
  {
    name: 'CHECK_REDIS',
    area: 'worker',
    description: 'Set to `false` to skip the Redis connection check of the container health check.',
    kind: { type: 'boolean' },
    default: true,
    requiredInProduction: false,
    secret: false,
    roles: ['worker'],
  },
  {
    name: 'WORKER_QUEUES',
    area: 'worker',
    description:
      'Comma-separated queues this worker takes jobs from (`default`, `light`, `cpu`, `memory`, `gpu`). All queues when unset.',
    kind: { type: 'string' },
    requiredInProduction: false,
    secret: false,
    roles: ['worker'],
  },
  {
    name: 'LIBREOFFICE_POOL_READINESS_TIMEOUT_MS',
    area: 'worker',
    description: 'Milliseconds the LibreOffice pool waits for a worker process to become ready (5000 to 40000).',
    kind: { type: 'integer', min: 5000, max: 40_000 },
    default: 30_000,
    requiredInProduction: false,
    secret: false,
    roles: ['worker'],
  },

  // ---- limits -----------------------------------------------------------------------------------------
  {
    name: 'MAX_IN_MEMORY_BYTES',
    area: 'limits',
    description: 'Largest stored object, in bytes, that may be read into memory instead of streamed.',
    kind: { type: 'integer', min: 1, max: Number.MAX_SAFE_INTEGER },
    default: 512 * BYTES_PER_MIB,
    requiredInProduction: false,
    secret: false,
    roles: BOTH,
  },
  {
    name: 'GRAPH_URL_IMPORT_MAX_BYTES',
    area: 'limits',
    description: 'Largest body, in bytes, that an `import.url` graph node downloads.',
    kind: { type: 'integer', min: 1, max: Number.MAX_SAFE_INTEGER },
    default: 5 * BYTES_PER_GIB,
    requiredInProduction: false,
    secret: false,
    roles: BOTH,
  },
  {
    name: 'EASYCONVERT_MAX_INPUT_PIXELS',
    area: 'limits',
    description: 'Largest declared canvas, in pixels, of a still-image input. A larger value is lowered to the built-in ceiling.',
    kind: { type: 'integer', min: 1, max: Number.MAX_SAFE_INTEGER },
    default: 100_000_000,
    requiredInProduction: false,
    secret: false,
    roles: BOTH,
  },
  {
    name: 'EASYCONVERT_PDF_TEXT_DEADLINE_MS',
    area: 'limits',
    description: 'Milliseconds the PDF text extraction may run before it is stopped.',
    kind: { type: 'integer', min: 1, max: INT32_MAX },
    default: 60_000,
    requiredInProduction: false,
    secret: false,
    roles: BOTH,
  },
  {
    name: 'EASYCONVERT_XLS_MAX_GRID_CELLS',
    area: 'limits',
    description:
      'Most cells (rows x columns of the used range) of a legacy XLS sheet that an HTML, ODS or XLSX conversion expands to a grid in memory; a larger sheet is refused with HTTP 413. CSV, TSV and JSON are written row by row and are not limited by it.',
    kind: { type: 'integer', min: 1, max: Number.MAX_SAFE_INTEGER },
    default: 4 * 1024 * 1024,
    requiredInProduction: false,
    secret: false,
    roles: BOTH,
  },
  {
    name: 'EASYCONVERT_XLS_MAX_PDF_TEXT_CELLS',
    area: 'limits',
    description:
      'Most cells holding text of a legacy XLS sheet that the in-process PDF writer lays out as a table (about 3 KB of memory per cell); a sheet with more is refused with HTTP 413. Blank cells are not counted.',
    kind: { type: 'integer', min: 1, max: Number.MAX_SAFE_INTEGER },
    default: 500_000,
    requiredInProduction: false,
    secret: false,
    roles: BOTH,
  },
  {
    name: 'EASYCONVERT_XLS_MAX_CELL_TEXT_CHARS',
    area: 'limits',
    description:
      'Most characters the cells of a legacy XLS sheet may expand to for an HTML, ODS, XLSX or PDF conversion, shared strings counted once per cell that uses them; a sheet over it is refused with HTTP 413 (protects against one long shared string used by many cells).',
    kind: { type: 'integer', min: 1, max: Number.MAX_SAFE_INTEGER },
    default: 64 * 1024 * 1024,
    requiredInProduction: false,
    secret: false,
    roles: BOTH,
  },
  {
    name: 'EASYCONVERT_XLSX_MAX_CELL_TEXT_CHARS',
    area: 'limits',
    description:
      'Most characters the cells of an XLSX workbook may expand to, shared strings counted once per cell that uses them; a workbook over it is refused with HTTP 413 (protects against one long shared string used by many cells).',
    kind: { type: 'integer', min: 1, max: Number.MAX_SAFE_INTEGER },
    default: 64 * 1024 * 1024,
    requiredInProduction: false,
    secret: false,
    roles: BOTH,
  },
  {
    name: 'ANONYMOUS_DAILY_LIMIT',
    area: 'limits',
    description: 'Conversions per day for an anonymous caller.',
    kind: { type: 'integer', min: 1, max: INT32_MAX },
    default: 10,
    requiredInProduction: false,
    secret: false,
    roles: WEB,
  },
  {
    name: 'ANONYMOUS_BURST_CAPACITY',
    area: 'limits',
    description: 'Token bucket size (largest burst of requests) of one anonymous caller.',
    kind: { type: 'integer', min: 1, max: INT32_MAX },
    default: 10,
    requiredInProduction: false,
    secret: false,
    roles: WEB,
  },
  {
    name: 'ANONYMOUS_BURST_REFILL_RATE',
    area: 'limits',
    description: 'Requests per second that refill the token bucket of one anonymous caller.',
    kind: { type: 'integer', min: 1, max: INT32_MAX },
    default: 1,
    requiredInProduction: false,
    secret: false,
    roles: WEB,
  },
  {
    name: 'ANONYMOUS_UNATTRIBUTED_BURST_CAPACITY',
    area: 'limits',
    description: 'Token bucket size shared by every anonymous caller whose address cannot be trusted.',
    kind: { type: 'integer', min: 1, max: INT32_MAX },
    default: 600,
    requiredInProduction: false,
    secret: false,
    roles: WEB,
  },
  {
    name: 'ANONYMOUS_UNATTRIBUTED_BURST_REFILL_RATE',
    area: 'limits',
    description: 'Requests per second that refill the bucket shared by untrusted anonymous callers.',
    kind: { type: 'integer', min: 1, max: INT32_MAX },
    default: 100,
    requiredInProduction: false,
    secret: false,
    roles: WEB,
  },

  // ---- tools ------------------------------------------------------------------------------------------
  toolPath('FFMPEG_PATH', 'Path of the ffmpeg executable; searched in the standard locations when unset.', BOTH),
  toolPath('FFPROBE_PATH', 'Path of the ffprobe executable.', BOTH),
  toolPath('P7ZIP_PATH', 'Path of the 7-Zip executable (`7zz`, `7z` or `7za`).', BOTH),
  toolPath('P7Z_PATH', 'Alternative name of P7ZIP_PATH for the archive code paths; used when P7ZIP_PATH is not set.', BOTH),
  toolPath('ZIP_PATH', 'Path of the Info-ZIP `zip` executable.', BOTH),
  toolPath('UNRAR_PATH', 'Path of the `unrar` executable.', BOTH),
  toolPath('SOFFICE_PATH', 'Path of the LibreOffice `soffice` executable.', BOTH),
  toolPath('PDFINFO_PATH', 'Path of the poppler `pdfinfo` executable.', BOTH),
  toolPath('PDFTOPPM_PATH', 'Path of the poppler `pdftoppm` executable.', BOTH),
  toolPath('PDFTOCAIRO_PATH', 'Path of the poppler `pdftocairo` executable.', BOTH),
  toolPath('PDFTOTEXT_PATH', 'Path of the poppler `pdftotext` executable.', BOTH),
  toolPath('PDFTOPS_PATH', 'Path of the poppler `pdftops` executable.', BOTH),
  toolPath('PS2PDF_PATH', 'Path of the Ghostscript `ps2pdf` executable.', BOTH),
  toolPath('DCRAW_EMU_PATH', 'Path of the LibRaw `dcraw_emu` executable.', BOTH),
  toolPath('TESSERACT_PATH', 'Path of the `tesseract` executable.', BOTH),
  {
    name: 'TESSDATA_PREFIX',
    area: 'tools',
    description: 'Directory of the Tesseract language data.',
    kind: { type: 'path' },
    requiredInProduction: false,
    secret: false,
    roles: BOTH,
  },
  toolPath('VERAPDF_PATH', 'Path of the `verapdf` executable that validates PDF/A output.', BOTH),
  toolPath('QPDF_PATH', 'Path of the `qpdf` executable that encrypts PDF output.', BOTH),
  toolPath('FC_LIST_PATH', 'Path of the fontconfig `fc-list` executable.', BOTH),
  {
    name: 'JAVA_HOME',
    area: 'tools',
    description: 'Java installation handed to LibreOffice for PDF/A export.',
    kind: { type: 'path' },
    requiredInProduction: false,
    secret: false,
    roles: BOTH,
  },

  // ---- ui ---------------------------------------------------------------------------------------------
  {
    name: 'NEXT_PUBLIC_ADSENSE_CLIENT',
    area: 'ui',
    description: 'Ad network publisher id shown in the page banner; no ads are rendered without it.',
    kind: { type: 'string' },
    requiredInProduction: false,
    secret: false,
    roles: WEB,
  },
  {
    name: 'NEXT_PUBLIC_ADSENSE_SLOT',
    area: 'ui',
    description: 'Ad slot id of the page banner.',
    kind: { type: 'string' },
    requiredInProduction: false,
    secret: false,
    roles: WEB,
  },
] as const satisfies readonly VariableSpec[];

/** The schema as data, for the loader and the documentation generator. */
export const CONFIG_SCHEMA: readonly VariableSpec[] = SCHEMA_ENTRIES;

/**
 * Alternatives of which one must be set in production: the signing secret has three names, and the first one set
 * wins (storage-config.ts SIGNING_SECRET_VARIABLES).
 */
export const PRODUCTION_ANY_OF_GROUPS: readonly AnyOfGroup[] = [
  { names: ['STORAGE_SIGNING_SECRET', 'S3_SIGNING_SECRET', 'OCI_SIGNING_SECRET'], roles: BOTH, firstSetWins: true },
];

type SchemaEntry = (typeof SCHEMA_ENTRIES)[number];

export type ConfigName = SchemaEntry['name'];

type SchemaValue<E extends SchemaEntry> = KindValues[E['kind']['type']];

/**
 * The parsed configuration: one property per variable. A variable with a default always has a value; any other is
 * undefined when unset (and, for `developmentDefault`, in production).
 */
export type Config = {
  readonly [E in SchemaEntry as E['name']]: E extends { readonly default: string | number | boolean }
    ? SchemaValue<E>
    : SchemaValue<E> | undefined;
};
