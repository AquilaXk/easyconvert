import { afterEach, describe, expect, it } from 'vitest';
import { BlockList } from 'node:net';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  CONFIG_SCHEMA,
  ConfigRuleError,
  MAX_CIDR_LIST_ENTRIES,
  PRODUCTION_ANY_OF_GROUPS,
  parseKind,
  type ValueKind,
} from '../src/lib/config/schema';
import { ConfigurationError, loadConfig, parseConfig, resetConfigCache } from '../src/lib/config';
import { MAX_TRUSTED_RANGES, parseClientIpConfig } from '../src/lib/security/client-ip';
import { DEFAULT_MAX_INPUT_PIXELS } from '../src/lib/conversions/image-input-limit-config';
import { OCR_DOCUMENT_DEADLINE_MS } from '../src/lib/conversions/ocr-work-budget';
import { PDF_TEXT_DEADLINE_MS } from '../src/lib/conversions/pdf-text-types';
import { DEFAULT_MAX_IN_MEMORY_BYTES } from '../src/lib/storage/errors';
import {
  DEFAULT_XLSX_MAX_CELL_TEXT_CHARS,
  DEFAULT_XLS_MAX_CELL_TEXT_CHARS,
  XLS_MAX_CELL_TEXT_CHARS_ENV,
  DEFAULT_XLS_MAX_GRID_CELLS,
  DEFAULT_XLS_MAX_PDF_TEXT_CELLS,
  XLSX_MAX_CELL_TEXT_CHARS_ENV,
  XLS_MAX_GRID_CELLS_ENV,
  XLS_MAX_PDF_TEXT_CELLS_ENV,
} from '../src/lib/conversions/office/spreadsheet-limits';

/**
 * Parsers and loader, checked against values written out from the rules of the code that consumes each variable
 * (the line references are in the schema) and against two independent parsers: `node:net.BlockList` for CIDR
 * syntax and the client-address resolver's own list parser for the exact set it accepts.
 */

const PRODUCTION = { production: true } as const;
const DEVELOPMENT = { production: false } as const;

function rule(kind: ValueKind, raw: string, context: { production: boolean } = PRODUCTION): string {
  try {
    parseKind(kind, raw, context);
  } catch (error) {
    if (error instanceof ConfigRuleError) return error.rule;
    throw error;
  }
  throw new Error(`"${raw}" was accepted`);
}

/** An ASCII string of exactly `bytes` bytes. */
function ascii(bytes: number): string {
  return 'aB3-'.repeat(Math.ceil(bytes / 4)).slice(0, bytes);
}

describe('integer parser', () => {
  const kind: ValueKind = { type: 'integer', min: 1, max: 100 };

  it.each([
    ['1', 1],
    ['100', 100],
    ['42', 42],
    [' 7 ', 7],
    ['0042', 42],
  ])('accepts %j as %i', (raw, expected) => {
    expect(parseKind(kind, raw, PRODUCTION)).toBe(expected);
  });

  it.each(['0', '101', '-1', '+1', '1.5', '1e2', '0x10', '12abc', 'abc', '١٢', '9'.repeat(40), '1 2'])(
    'rejects %j with a rule that names the range and not the value',
    (raw) => {
      const message = rule(kind, raw);
      expect(message).toBe('must be a whole number from 1 to 100');
    }
  );

  it('allows a range that starts at zero for the limits where zero switches the limit off', () => {
    const zeroBased: ValueKind = { type: 'integer', min: 0, max: 10 };
    expect(parseKind(zeroBased, '0', PRODUCTION)).toBe(0);
    expect(rule(zeroBased, '11')).toBe('must be a whole number from 0 to 10');
  });

  it('keeps the largest safe integer exact and refuses the next one', () => {
    const wide: ValueKind = { type: 'integer', min: 1, max: Number.MAX_SAFE_INTEGER };
    expect(parseKind(wide, String(Number.MAX_SAFE_INTEGER), PRODUCTION)).toBe(9007199254740991);
    expect(rule(wide, '9007199254740992')).toBe(`must be a whole number from 1 to ${Number.MAX_SAFE_INTEGER}`);
  });
});

describe('url parser', () => {
  const http: ValueKind = { type: 'url', schemes: ['http:', 'https:'] };

  it.each([
    ['https://convert.example.org', 'https://convert.example.org'],
    ['http://localhost:3000', 'http://localhost:3000'],
    ['  https://convert.example.org/base/  ', 'https://convert.example.org/base/'],
    ['https://[2001:db8::1]:8443', 'https://[2001:db8::1]:8443'],
  ])('accepts %j', (raw, expected) => {
    expect(parseKind(http, raw, PRODUCTION)).toBe(expected);
  });

  it.each([
    ['ftp://files.example.org', 'must be a URL with the scheme http or https'],
    ['javascript:alert(1)', 'must be a URL with the scheme http or https'],
    ['file:///etc/passwd', 'must be a URL with the scheme http or https'],
    ['localhost:3000', 'must be a URL with the scheme http or https'],
    ['convert.example.org', 'must be a URL with the scheme http or https'],
    ['not a url', 'must be a URL with the scheme http or https'],
    ['https://', 'must be a URL with the scheme http or https'],
  ])('rejects %j', (raw, expected) => {
    expect(rule(http, raw)).toBe(expected);
  });

  it('rejects a URL longer than the limit without parsing it', () => {
    expect(rule(http, `https://example.org/${'a'.repeat(5000)}`)).toBe('must be at most 2048 characters');
  });

  it('accepts redis and rediss URLs for the queue and nothing else', () => {
    const redis: ValueKind = { type: 'url', schemes: ['redis:', 'rediss:'] };
    expect(parseKind(redis, 'redis://:pw@cache.internal:6379/0', PRODUCTION)).toBe('redis://:pw@cache.internal:6379/0');
    expect(parseKind(redis, 'rediss://cache.internal:6380', PRODUCTION)).toBe('rediss://cache.internal:6380');
    expect(rule(redis, 'http://cache.internal')).toBe('must be a URL with the scheme redis or rediss');
  });

  it('requires https in production only when the kind says so', () => {
    const endpoint: ValueKind = { type: 'url', schemes: ['http:', 'https:'], productionSchemes: ['https:'], rejectUserInfo: true };
    expect(parseKind(endpoint, 'http://minio.local:9000', DEVELOPMENT)).toBe('http://minio.local:9000');
    expect(rule(endpoint, 'http://minio.local:9000', PRODUCTION)).toBe('must use https in production');
    expect(parseKind(endpoint, 'https://s3.example.org', PRODUCTION)).toBe('https://s3.example.org');
  });

  it('rejects user info when the kind forbids it', () => {
    const endpoint: ValueKind = { type: 'url', schemes: ['https:'], rejectUserInfo: true };
    expect(rule(endpoint, 'https://key:secret@s3.example.org')).toBe('must not carry user info');
    expect(rule(endpoint, 'https://key@s3.example.org')).toBe('must not carry user info');
  });
});

describe('secret parser', () => {
  /** JOB_SECRET_KEK: job-secret-seal.ts derives the key from the UTF-8 bytes of the text and rejects stray whitespace. */
  const kek: ValueKind = { type: 'secret', minBytes: 32, trim: false, rejectSurroundingWhitespace: true };
  /** STORAGE_SIGNING_SECRET: storage-config.ts trims the value and measures its UTF-8 bytes. */
  const signing: ValueKind = { type: 'secret', minBytes: 32, trim: true, rejectSurroundingWhitespace: false };

  it('accepts exactly 32 bytes and refuses 31 in production', () => {
    expect(parseKind(kek, ascii(32), PRODUCTION)).toBe(ascii(32));
    expect(rule(kek, ascii(31))).toBe('must be at least 32 bytes (UTF-8 text, not decoded) in production');
  });

  it('accepts a short secret outside production, as the consumers do', () => {
    expect(parseKind(kek, ascii(31), DEVELOPMENT)).toBe(ascii(31));
    expect(parseKind(kek, 'dev', DEVELOPMENT)).toBe('dev');
  });

  it('measures UTF-8 bytes, not characters', () => {
    const sixteenTwoByteCharacters = 'é'.repeat(16);
    expect(sixteenTwoByteCharacters.length).toBe(16);
    expect(parseKind(kek, sixteenTwoByteCharacters, PRODUCTION)).toBe(sixteenTwoByteCharacters);
    const thirtyOneBytes = `${'é'.repeat(15)}a`;
    expect(thirtyOneBytes.length).toBe(16);
    expect(rule(kek, thirtyOneBytes)).toBe('must be at least 32 bytes (UTF-8 text, not decoded) in production');
  });

  it('does not decode hex or base64: the consumers hash the text itself', () => {
    // 32 hex characters would decode to 16 bytes; the consumers use the 32 characters as they are.
    const hex32 = '0123456789abcdef0123456789abcdef';
    expect(parseKind(kek, hex32, PRODUCTION)).toBe(hex32);
    // 62 hexadecimal characters are 62 bytes of text, and 44 base64 characters (a 32-byte key) are 44.
    const hex62 = 'a1'.repeat(31);
    expect(parseKind(kek, hex62, PRODUCTION)).toBe(hex62);
    const base64Of32Bytes = Buffer.alloc(32, 7).toString('base64');
    expect(base64Of32Bytes).toBe('BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=');
    expect(parseKind(kek, base64Of32Bytes, PRODUCTION)).toBe(base64Of32Bytes);
  });

  it('rejects surrounding whitespace in production when the consumer does', () => {
    expect(rule(kek, ` ${ascii(40)}`)).toBe('must not start or end with whitespace');
    expect(rule(kek, `${ascii(40)}\n`)).toBe('must not start or end with whitespace');
    expect(parseKind(kek, ` ${ascii(40)}`, DEVELOPMENT)).toBe(` ${ascii(40)}`);
  });

  it('trims before measuring for the signing secret', () => {
    expect(parseKind(signing, `  ${ascii(32)}\n`, PRODUCTION)).toBe(ascii(32));
    expect(rule(signing, `${ascii(31)}   `)).toBe('must be at least 32 bytes (UTF-8 text, not decoded) in production');
  });

  it('refuses a secret longer than the limit', () => {
    expect(rule(kek, ascii(4097), DEVELOPMENT)).toBe('must be at most 4096 bytes');
    expect(parseKind(kek, ascii(4096), PRODUCTION)).toBe(ascii(4096));
  });

  it('accepts any non-empty credential and bounds its length', () => {
    const credential: ValueKind = { type: 'credential' };
    expect(parseKind(credential, 'k', PRODUCTION)).toBe('k');
    expect(rule(credential, 'x'.repeat(5000))).toBe('must be at most 4096 bytes');
  });
});

describe('CIDR list parser', () => {
  const list: ValueKind = { type: 'cidrList', allowNone: true };
  const listWithoutNone: ValueKind = { type: 'cidrList', allowNone: false };

  it('parses IPv4 and IPv6 ranges and bare addresses', () => {
    expect(parseKind(list, '10.0.0.0/8, 192.168.1.1, 2001:db8::/32, ::1', PRODUCTION)).toEqual([
      '10.0.0.0/8',
      '192.168.1.1',
      '2001:db8::/32',
      '::1',
    ]);
  });

  it('accepts the boundary prefix lengths of both families', () => {
    expect(parseKind(list, '0.0.0.0/0,10.1.2.3/32,::/0,2001:db8::1/128', PRODUCTION)).toHaveLength(4);
  });

  it('rejects a prefix one past each boundary', () => {
    expect(rule(list, '10.0.0.0/33')).toBe('must be a comma-separated list of IPv4/IPv6 addresses or CIDR ranges');
    expect(rule(list, '2001:db8::/129')).toBe('must be a comma-separated list of IPv4/IPv6 addresses or CIDR ranges');
  });

  it('declares an explicit empty set with none', () => {
    expect(parseKind(list, 'none', PRODUCTION)).toEqual([]);
    expect(parseKind(list, '  NONE ', PRODUCTION)).toEqual([]);
    expect(rule(listWithoutNone, 'none')).toBe('must be a comma-separated list of IPv4/IPv6 addresses or CIDR ranges');
  });

  it('ignores empty entries left by stray commas', () => {
    expect(parseKind(list, '10.0.0.0/8,, ,172.16.0.0/12,', PRODUCTION)).toEqual(['10.0.0.0/8', '172.16.0.0/12']);
  });

  it('refuses a list with more entries than the resolver accepts', () => {
    const entries = (count: number): string => Array.from({ length: count }, (_, i) => `10.${i >> 8}.${i & 255}.0/24`).join(',');
    expect(parseKind(list, entries(MAX_CIDR_LIST_ENTRIES), PRODUCTION)).toHaveLength(MAX_CIDR_LIST_ENTRIES);
    expect(rule(list, entries(MAX_CIDR_LIST_ENTRIES + 1))).toBe(`must list at most ${MAX_CIDR_LIST_ENTRIES} ranges`);
  });

  it('uses the limit of the resolver that consumes the list', () => {
    expect(MAX_CIDR_LIST_ENTRIES).toBe(MAX_TRUSTED_RANGES);
  });

  /**
   * Entries judged by two parsers that do not share code with the schema. `node:net.BlockList` decides whether an
   * address and prefix are valid; the client-address resolver (which will read these values) decides the exact set it
   * takes. A schema that accepted what the resolver rejects would let a bad list through startup.
   */
  const CORPUS: readonly string[] = [
    '10.0.0.0/8',
    '10.0.0.0/33',
    '10.0.0.0/-1',
    '10.0.0.0/8/8',
    '10.0.0.0/ 8',
    '10.0.0.0/08',
    '10.0.0.256/24',
    '10.0.0/24',
    '010.0.0.1',
    '1.2.3.4:8080',
    '1.2.3.4:99999',
    '[2001:db8::1]:443',
    '[2001:db8::1]',
    '[1.2.3.4]',
    '2001:db8::/32',
    '2001:db8::/129',
    '2001:db8::1::2',
    'fe80::1%eth0',
    'fe80::1%eth0/64',
    '::ffff:1.2.3.4',
    '::ffff:1.2.3.4/120',
    '::ffff:1.2.3.4/64',
    '::ffff:102:304/112',
    '0:0:0:0:0:ffff:1.2.3.4/64',
    'localhost',
    'example.org/24',
    '10.0.0.0/8 x',
    '/8',
    '203.0.113.0/24',
    '203.0.113.0/24;198.51.100.0/24',
    '::',
    '1::',
    '::1.2.3.4',
    '1:2:3:4:5:6:1.2.3.4',
    '1:2:3:4:5:6:7:8/64',
    ':1',
    '[::1]:65536',
    '::ffff:0:0/95',
    '::ffff:0:0/96',
    '1.2.3.4/003',
    '1.2.3.4/1000',
    '2001:DB8::/32',
  ];

  /** `net.BlockList` as the oracle for address and prefix syntax. */
  function blockListAccepts(entry: string): boolean {
    const [address, prefix, ...rest] = entry.split('/');
    if (rest.length > 0 || address === '') return false;
    const family = address.includes(':') ? 'ipv6' : 'ipv4';
    const bits = prefix === undefined ? (family === 'ipv6' ? 128 : 32) : Number(prefix);
    try {
      new BlockList().addSubnet(address, bits, family);
      return true;
    } catch {
      return false;
    }
  }

  function schemaAccepts(entry: string): boolean {
    try {
      parseKind(list, entry, PRODUCTION);
      return true;
    } catch (error) {
      if (error instanceof ConfigRuleError) return false;
      throw error;
    }
  }

  function resolverAccepts(entry: string): boolean {
    try {
      parseClientIpConfig({ trustedProxies: entry });
      return true;
    } catch {
      return false;
    }
  }

  it.each(CORPUS)('agrees with the resolver on %j', (entry) => {
    expect(schemaAccepts(entry)).toBe(resolverAccepts(entry));
  });

  /** Entries without a port or brackets are plain `address[/prefix]`, which BlockList judges on its own. */
  const PLAIN_ENTRIES = CORPUS.filter((entry) => !entry.includes('[') && !/^\d+\.\d+\.\d+\.\d+:\d+$/.test(entry));

  it.each(PLAIN_ENTRIES)('never accepts what net.BlockList refuses: %j', (entry) => {
    if (schemaAccepts(entry)) {
      expect(blockListAccepts(entry)).toBe(true);
    }
  });

  it('rejects every entry the resolver rejects in a list that also holds a valid entry', () => {
    for (const entry of CORPUS) {
      const mixed = `203.0.113.0/24, ${entry}`;
      expect(schemaAccepts(mixed), mixed).toBe(resolverAccepts(mixed));
    }
  });
});

describe('enum parser', () => {
  const driver: ValueKind = { type: 'enum', values: ['oci', 's3', 'local'], caseInsensitive: true };
  const strict: ValueKind = { type: 'enum', values: ['a', 'b'], caseInsensitive: false };

  it('accepts a listed value in any case when the consumer lowercases it', () => {
    expect(parseKind(driver, 'S3', PRODUCTION)).toBe('s3');
    expect(parseKind(driver, ' local ', PRODUCTION)).toBe('local');
  });

  it('rejects an unlisted value and names the choices', () => {
    expect(rule(driver, 'gcs')).toBe('must be one of: oci, s3, local');
    expect(rule(strict, 'A')).toBe('must be one of: a, b');
  });
});

describe('executable path and string parsers', () => {
  const executable: ValueKind = { type: 'executable' };

  it('accepts an absolute path or a command name without checking that it exists', () => {
    expect(parseKind(executable, '/opt/does-not-exist/ffmpeg', PRODUCTION)).toBe('/opt/does-not-exist/ffmpeg');
    expect(parseKind(executable, 'ffmpeg', PRODUCTION)).toBe('ffmpeg');
  });

  it('rejects a NUL byte and an over-long path', () => {
    expect(rule(executable, '/usr/bin/ff\0mpeg')).toBe('must not contain a NUL byte');
    expect(rule(executable, `/${'a'.repeat(4097)}`)).toBe('must be at most 4096 characters');
  });

  it('requires an absolute path where the tool is never looked up by name', () => {
    const absolute: ValueKind = { type: 'absoluteExecutable' };
    expect(parseKind(absolute, '/opt/does-not-exist/avifenc', PRODUCTION)).toBe('/opt/does-not-exist/avifenc');
    expect(rule(absolute, 'avifenc')).toBe('must be an absolute path');
    expect(rule(absolute, './bin/avifenc')).toBe('must be an absolute path');
    expect(rule(absolute, '/usr/bin/avif\0enc')).toBe('must not contain a NUL byte');
    expect(rule(absolute, `/${'a'.repeat(4097)}`)).toBe('must be at most 4096 characters');
  });

  it('bounds a free-form string', () => {
    const text: ValueKind = { type: 'string', maxLength: 8 };
    expect(parseKind(text, '12345678', PRODUCTION)).toBe('12345678');
    expect(rule(text, '123456789')).toBe('must be at most 8 characters');
  });
});

describe('boolean parser', () => {
  const flag: ValueKind = { type: 'boolean' };

  it('accepts true and false in any case', () => {
    expect(parseKind(flag, 'true', PRODUCTION)).toBe(true);
    expect(parseKind(flag, ' FALSE ', PRODUCTION)).toBe(false);
  });

  it.each(['1', '0', 'yes', 'on', 'enabled', 'tru'])('rejects %j instead of reading it as false', (raw) => {
    expect(rule(flag, raw)).toBe('must be true or false');
  });
});

describe('schema', () => {
  const NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

  it('names every variable once, in upper case', () => {
    const names = CONFIG_SCHEMA.map((spec) => spec.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(NAME_PATTERN);
  });

  it('gives every variable a description and an area', () => {
    for (const spec of CONFIG_SCHEMA) {
      expect(spec.description.length, spec.name).toBeGreaterThan(10);
      expect(spec.area.length, spec.name).toBeGreaterThan(0);
    }
  });

  it('parses its own defaults, so a default can never be a value the parser refuses', () => {
    for (const spec of CONFIG_SCHEMA) {
      for (const value of [spec.default, spec.developmentDefault]) {
        if (value === undefined) continue;
        expect(() => parseKind(spec.kind, String(value), DEVELOPMENT), spec.name).not.toThrow(ConfigRuleError);
        expect(parseKind(spec.kind, String(value), DEVELOPMENT), spec.name).toEqual(value);
      }
    }
  });

  it('never ships a default for a secret', () => {
    const secrets = CONFIG_SCHEMA.filter((spec) => spec.secret);
    expect(secrets.length).toBeGreaterThan(10);
    for (const spec of secrets) {
      expect(spec.default, spec.name).toBeUndefined();
      expect(spec.developmentDefault, spec.name).toBeUndefined();
    }
  });

  it('marks every key, pepper and key-encryption secret as secret', () => {
    const byName = new Map(CONFIG_SCHEMA.map((spec) => [spec.name, spec]));
    for (const name of [
      'JOB_SECRET_KEK',
      'JOB_SECRET_KEK_PREVIOUS',
      'STORAGE_SIGNING_SECRET',
      'S3_SIGNING_SECRET',
      'OCI_SIGNING_SECRET',
      'KEY_ENCRYPTION_KEY',
      'KEY_HASH_PEPPER',
      'WEBHOOK_SECRET_KEK',
      'JWT_SECRET',
      'STORAGE_VAULT_KEY',
      'GOOGLE_CLIENT_SECRET',
      'S3_SECRET_ACCESS_KEY',
      'OCI_SECRET_ACCESS_KEY',
      'REDIS_URL',
    ]) {
      expect(byName.get(name)?.secret, name).toBe(true);
    }
  });

  it('measures each key secret the way its consumer reads it', () => {
    const byName = new Map(CONFIG_SCHEMA.map((spec) => [spec.name, spec]));
    // src/lib/security/job-secret-seal.ts: UTF-8 bytes of the untrimmed text, surrounding whitespace refused.
    for (const name of ['JOB_SECRET_KEK', 'JOB_SECRET_KEK_PREVIOUS']) {
      expect(byName.get(name)?.kind, name).toEqual({ type: 'secret', minBytes: 32, trim: false, rejectSurroundingWhitespace: true });
    }
    // src/lib/storage/storage-config.ts: trimmed, then UTF-8 bytes.
    for (const name of ['STORAGE_SIGNING_SECRET', 'S3_SIGNING_SECRET', 'OCI_SIGNING_SECRET']) {
      expect(byName.get(name)?.kind, name).toEqual({ type: 'secret', minBytes: 32, trim: true, rejectSurroundingWhitespace: false });
    }
    // JWT, pepper, key-encryption key, webhook KEK and vault key reach createHash/createHmac/hkdf as the raw string.
    for (const name of ['JWT_SECRET', 'KEY_HASH_PEPPER', 'KEY_ENCRYPTION_KEY', 'WEBHOOK_SECRET_KEK', 'STORAGE_VAULT_KEY']) {
      expect(byName.get(name)?.kind, name).toEqual({ type: 'secret', minBytes: 32, trim: false, rejectSurroundingWhitespace: false });
    }
  });

  it('keeps the default of every limit the consumers apply today', () => {
    const defaults = new Map(CONFIG_SCHEMA.map((spec) => [spec.name, spec.default]));
    // Constants exported by the consuming modules.
    expect(defaults.get('EASYCONVERT_MAX_INPUT_PIXELS')).toBe(DEFAULT_MAX_INPUT_PIXELS);
    expect(defaults.get('EASYCONVERT_PDF_TEXT_DEADLINE_MS')).toBe(PDF_TEXT_DEADLINE_MS);
    expect(defaults.get('EASYCONVERT_OCR_DEADLINE_MS')).toBe(OCR_DOCUMENT_DEADLINE_MS);
    expect(defaults.get('MAX_IN_MEMORY_BYTES')).toBe(DEFAULT_MAX_IN_MEMORY_BYTES);
    expect(defaults.get(XLS_MAX_GRID_CELLS_ENV)).toBe(DEFAULT_XLS_MAX_GRID_CELLS);
    expect(defaults.get(XLS_MAX_PDF_TEXT_CELLS_ENV)).toBe(DEFAULT_XLS_MAX_PDF_TEXT_CELLS);
    expect(defaults.get(XLSX_MAX_CELL_TEXT_CHARS_ENV)).toBe(DEFAULT_XLSX_MAX_CELL_TEXT_CHARS);
    expect(defaults.get(XLS_MAX_CELL_TEXT_CHARS_ENV)).toBe(DEFAULT_XLS_MAX_CELL_TEXT_CHARS);
    // Values written in the consumers' expressions (`|| '1000'`, `: 10`, `?? 600`) and in the issue text.
    expect(Object.fromEntries(['WORKER_CONCURRENCY', 'WORKER_MAX_JOBS', 'WORKER_MAX_RSS_MB', 'WORKER_DRAIN_TIMEOUT_MS', 'WORKER_HEARTBEAT_INTERVAL_MS'].map((name) => [name, defaults.get(name)]))).toEqual({
      WORKER_CONCURRENCY: 3,
      WORKER_MAX_JOBS: 1000,
      WORKER_MAX_RSS_MB: 4096,
      WORKER_DRAIN_TIMEOUT_MS: 60000,
      WORKER_HEARTBEAT_INTERVAL_MS: 5000,
    });
    expect(Object.fromEntries(['ANONYMOUS_DAILY_LIMIT', 'ANONYMOUS_BURST_CAPACITY', 'ANONYMOUS_BURST_REFILL_RATE', 'ANONYMOUS_UNATTRIBUTED_BURST_CAPACITY', 'ANONYMOUS_UNATTRIBUTED_BURST_REFILL_RATE', 'REDIS_PORT', 'GRAPH_URL_IMPORT_MAX_BYTES', 'LIBREOFFICE_POOL_READINESS_TIMEOUT_MS', 'WORKER_HEARTBEAT_MAX_STALE_MS'].map((name) => [name, defaults.get(name)]))).toEqual({
      ANONYMOUS_DAILY_LIMIT: 10,
      ANONYMOUS_BURST_CAPACITY: 10,
      ANONYMOUS_BURST_REFILL_RATE: 1,
      ANONYMOUS_UNATTRIBUTED_BURST_CAPACITY: 600,
      ANONYMOUS_UNATTRIBUTED_BURST_REFILL_RATE: 100,
      REDIS_PORT: 6379,
      GRAPH_URL_IMPORT_MAX_BYTES: 5 * 1024 * 1024 * 1024,
      LIBREOFFICE_POOL_READINESS_TIMEOUT_MS: 30000,
      WORKER_HEARTBEAT_MAX_STALE_MS: 35000,
    });
  });

  /**
   * Every `process.env.NAME` the source reads is a schema entry. The scan reads the source files themselves, so the
   * inventory cannot drift from the code. Reads that build the name at run time are listed by hand.
   */
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
    });
  }

  it('covers every process.env name that the source reads literally', () => {
    const names = new Set(CONFIG_SCHEMA.map((spec) => spec.name));
    const read = new Set<string>();
    for (const file of sourceFiles(path.resolve(__dirname, '..', 'src'))) {
      if (file.includes(`${path.sep}lib${path.sep}config${path.sep}`)) continue;
      for (const match of readFileSync(file, 'utf8').matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) read.add(match[1]);
    }
    expect(read.size).toBeGreaterThan(40);
    expect([...read].filter((name) => !names.has(name)).sort()).toEqual([]);
  });

  it('covers the variables the source reads through computed names', () => {
    const names = new Set(CONFIG_SCHEMA.map((spec) => spec.name));
    const computed = [
      // key-store.ts KEY_HASH_PEPPER_ENV, s3.ts S3_DEV_ENDPOINT_ALLOWLIST_ENV, libreoffice-pool.ts, image-input-limits.ts, pdf-text-host.ts, ocr-work-budget.ts
      'KEY_HASH_PEPPER',
      'BYOS_S3_DEV_ENDPOINT_ALLOWLIST',
      'LIBREOFFICE_POOL_READINESS_TIMEOUT_MS',
      'EASYCONVERT_MAX_INPUT_PIXELS',
      'EASYCONVERT_PDF_TEXT_DEADLINE_MS',
      // ocr-work-budget.ts
      'EASYCONVERT_OCR_DEADLINE_MS',
      // spreadsheet-limits.ts
      'EASYCONVERT_XLS_MAX_GRID_CELLS',
      'EASYCONVERT_XLS_MAX_PDF_TEXT_CELLS',
      'EASYCONVERT_XLSX_MAX_CELL_TEXT_CHARS',
      'EASYCONVERT_XLS_MAX_CELL_TEXT_CHARS',
      // job-secret-seal.ts
      'JOB_SECRET_KEK',
      'JOB_SECRET_KEK_PREVIOUS',
      // api-keys/guard.ts readPositiveIntEnv
      'ANONYMOUS_UNATTRIBUTED_BURST_CAPACITY',
      'ANONYMOUS_UNATTRIBUTED_BURST_REFILL_RATE',
      // security/client-ip.ts
      'TRUSTED_PROXIES',
      'TRUSTED_CDN',
      'TRUSTED_CDN_RANGES',
      'TRUSTED_PROXY_HEADER',
      // storage/storage-config.ts
      'STORAGE_DRIVER',
      'STORAGE_SIGNING_SECRET',
      'S3_SIGNING_SECRET',
      'OCI_SIGNING_SECRET',
      'APP_URL',
      'NEXT_PHASE',
      'OCI_ACCESS_KEY_ID',
      'OCI_SECRET_ACCESS_KEY',
      'S3_ENDPOINT',
      'S3_REGION',
      'S3_BUCKET',
      'S3_BUCKET_NAME',
      'S3_ACCESS_KEY_ID',
      'S3_SECRET_ACCESS_KEY',
      'S3_FORCE_PATH_STYLE',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_REGION',
      'AWS_BUCKET_NAME',
      // pdf-postprocess and pdf-fonts resolveBinaryPath(envVarName)
      'QPDF_PATH',
      'VERAPDF_PATH',
      'FC_LIST_PATH',
      // worker/engines.ts NATIVE_BINARY_ENV_VARS
      'SOFFICE_PATH',
      'PS2PDF_PATH',
      // scripts/worker-healthcheck.js
      'WORKER_HEARTBEAT_MAX_STALE_MS',
      'CHECK_REDIS',
    ];
    expect(computed.filter((name) => !names.has(name))).toEqual([]);
  });

  it('declares each alternative group over variables that exist', () => {
    const names = new Set(CONFIG_SCHEMA.map((spec) => spec.name));
    expect(PRODUCTION_ANY_OF_GROUPS.length).toBeGreaterThan(0);
    for (const group of PRODUCTION_ANY_OF_GROUPS) {
      for (const name of group.names) expect(names.has(name), name).toBe(true);
    }
  });
});

describe('loadConfig', () => {
  afterEach(() => {
    resetConfigCache();
  });

  const SIGNING = ascii(40);
  const KEK = `kek-${ascii(40)}`;
  /** Everything the worker needs in production. */
  const WORKER_PRODUCTION: Record<string, string> = {
    NODE_ENV: 'production',
    STORAGE_DRIVER: 'local',
    STORAGE_SIGNING_SECRET: SIGNING,
    JOB_SECRET_KEK: KEK,
  };
  const WEB_PRODUCTION: Record<string, string> = {
    ...WORKER_PRODUCTION,
    APP_URL: 'https://convert.example.org',
    JWT_SECRET: `jwt-${ascii(40)}`,
    KEY_HASH_PEPPER: `pepper-${ascii(40)}`,
    WEBHOOK_SECRET_KEK: `webhook-${ascii(40)}`,
  };

  function omit(env: Record<string, string>, name: string): Record<string, string> {
    return Object.fromEntries(Object.entries(env).filter(([key]) => key !== name));
  }

  function failures(env: Record<string, string>, role?: 'web' | 'worker'): Array<{ variable: string; rule: string }> {
    try {
      parseConfig(env, role === undefined ? {} : { role });
    } catch (error) {
      if (error instanceof ConfigurationError) return error.failures.map((f) => ({ variable: f.variable, rule: f.rule }));
      throw error;
    }
    return [];
  }

  it('starts in development with an empty environment and applies the defaults', () => {
    const config = parseConfig({});
    expect(config.WORKER_CONCURRENCY).toBe(3);
    expect(config.STORAGE_DRIVER).toBe('local');
    expect(config.APP_URL).toBe('http://localhost:3000');
    expect(config.REDIS_PORT).toBe(6379);
    expect(config.STRICT_SANDBOX).toBe(false);
    expect(config.CHECK_REDIS).toBe(true);
    expect(config.S3_FORCE_PATH_STYLE).toBe(true);
    expect(config.JWT_SECRET).toBeUndefined();
    expect(config.TRUSTED_PROXIES).toBeUndefined();
  });

  it('treats an empty or blank value as unset, as compose files and the consumers do', () => {
    const config = parseConfig({ WORKER_CONCURRENCY: '', REDIS_HOST: '   ', JWT_SECRET: '', STORAGE_DRIVER: ' ' });
    expect(config.WORKER_CONCURRENCY).toBe(3);
    expect(config.REDIS_HOST).toBeUndefined();
    expect(config.JWT_SECRET).toBeUndefined();
    expect(config.STORAGE_DRIVER).toBe('local');
  });

  it('returns a frozen object', () => {
    const config = parseConfig({});
    expect(Object.isFrozen(config)).toBe(true);
    expect(() => {
      (config as { WORKER_CONCURRENCY: number }).WORKER_CONCURRENCY = 9;
    }).toThrow(TypeError);
  });

  it('parses and caches once: later calls return the first result whatever the environment says', () => {
    const first = loadConfig({ WORKER_CONCURRENCY: '5' });
    const second = loadConfig({ WORKER_CONCURRENCY: '9' });
    expect(second).toBe(first);
    expect(second.WORKER_CONCURRENCY).toBe(5);
    resetConfigCache();
    expect(loadConfig({ WORKER_CONCURRENCY: '9' }).WORKER_CONCURRENCY).toBe(9);
  });

  it('does not cache a failure', () => {
    expect(() => loadConfig({ WORKER_CONCURRENCY: 'x' })).toThrow(ConfigurationError);
    expect(loadConfig({ WORKER_CONCURRENCY: '4' }).WORKER_CONCURRENCY).toBe(4);
  });

  it('rejects a malformed value in development instead of using the default', () => {
    expect(failures({ NODE_ENV: 'development', WORKER_MAX_JOBS: '-5' })).toEqual([
      { variable: 'WORKER_MAX_JOBS', rule: 'must be a whole number from 0 to 2147483647' },
    ]);
    expect(failures({ NODE_ENV: 'test', STRICT_SANDBOX: 'yes' })).toEqual([{ variable: 'STRICT_SANDBOX', rule: 'must be true or false' }]);
  });

  it('collects every failing variable into one error', () => {
    const list = failures({ NODE_ENV: 'development', WORKER_CONCURRENCY: '0', APP_URL: 'nope', TRUSTED_PROXIES: '10.0.0.0/33' });
    expect(list.map((f) => f.variable).sort()).toEqual(['APP_URL', 'TRUSTED_PROXIES', 'WORKER_CONCURRENCY']);
  });

  it('never puts a value into the error message or the failure list', () => {
    const canaries: Record<string, string> = {
      WORKER_CONCURRENCY: 'canary-int-value',
      APP_URL: 'ftp://canary-url-host.invalid/canary',
      TRUSTED_PROXIES: '198.51.100.7/99',
      STORAGE_DRIVER: 'canary-driver',
      STRICT_SANDBOX: 'canary-flag',
      FFMPEG_PATH: '/canary/bin/ff\0mpeg',
      JOB_SECRET_KEK: 'canary-short-kek',
    };
    try {
      parseConfig({ NODE_ENV: 'production', ...canaries });
      throw new Error('accepted');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      const serialised = `${(error as Error).message}\n${JSON.stringify((error as ConfigurationError).failures)}\n${(error as Error).stack}`;
      for (const value of Object.values(canaries)) {
        expect(serialised).not.toContain(value);
      }
      expect(serialised).not.toContain('canary');
      for (const name of Object.keys(canaries)) {
        expect(serialised).toContain(name);
      }
    }
  });

  it('rejects an AVIFENC_PATH that is not absolute at start-up, without echoing the value, and accepts an absolute one', () => {
    const list = failures({ NODE_ENV: 'development', AVIFENC_PATH: 'canary-avifenc' });
    expect(list.map((f) => [f.variable, f.rule])).toEqual([['AVIFENC_PATH', 'must be an absolute path']]);
    expect(JSON.stringify(list)).not.toContain('canary');
    expect(failures({ NODE_ENV: 'development', AVIFENC_PATH: '/usr/bin/avifenc' })).toEqual([]);
    // The other tool paths still take a command name.
    expect(failures({ NODE_ENV: 'development', FFMPEG_PATH: 'ffmpeg' })).toEqual([]);
  });

  it('requires the production secrets and lists each missing one', () => {
    const list = failures({ NODE_ENV: 'production' }, 'web');
    expect(list.map((f) => f.variable).sort()).toEqual(
      ['JOB_SECRET_KEK', 'JWT_SECRET', 'KEY_HASH_PEPPER', 'STORAGE_DRIVER', 'STORAGE_SIGNING_SECRET', 'WEBHOOK_SECRET_KEK'].sort()
    );
    for (const entry of list) expect(entry.rule).toContain('required in production');
  });

  it('accepts a complete production environment for each role', () => {
    expect(failures(WEB_PRODUCTION, 'web')).toEqual([]);
    expect(failures(WORKER_PRODUCTION, 'worker')).toEqual([]);
  });

  it('asks a worker only for what it needs: no session or API key secrets', () => {
    expect(failures({ NODE_ENV: 'production' }, 'worker').map((f) => f.variable).sort()).toEqual([
      'JOB_SECRET_KEK',
      'STORAGE_DRIVER',
      'STORAGE_SIGNING_SECRET',
    ]);
  });

  it('asks for the strictest set when no role is given', () => {
    expect(failures(WORKER_PRODUCTION).map((f) => f.variable).sort()).toEqual([
      'APP_URL',
      'JWT_SECRET',
      'KEY_HASH_PEPPER',
      'WEBHOOK_SECRET_KEK',
    ]);
  });

  it('accepts any one of the signing secret variables', () => {
    const withoutStorage = omit(WORKER_PRODUCTION, 'STORAGE_SIGNING_SECRET');
    expect(failures({ ...withoutStorage, S3_SIGNING_SECRET: SIGNING }, 'worker')).toEqual([]);
    expect(failures({ ...withoutStorage, OCI_SIGNING_SECRET: SIGNING }, 'worker')).toEqual([]);
    expect(failures(withoutStorage, 'worker')).toEqual([
      {
        variable: 'STORAGE_SIGNING_SECRET',
        rule: 'one of STORAGE_SIGNING_SECRET, S3_SIGNING_SECRET, OCI_SIGNING_SECRET is required in production',
      },
    ]);
  });

  it('applies the production length rule to the signing secret that is in use, not to one it shadows', () => {
    const stale = ascii(10);
    expect(failures({ ...WORKER_PRODUCTION, S3_SIGNING_SECRET: stale, OCI_SIGNING_SECRET: stale }, 'worker')).toEqual([]);
    const withoutStorage = omit(WORKER_PRODUCTION, 'STORAGE_SIGNING_SECRET');
    expect(failures({ ...withoutStorage, S3_SIGNING_SECRET: stale, OCI_SIGNING_SECRET: ascii(40) }, 'worker')).toEqual([
      { variable: 'S3_SIGNING_SECRET', rule: 'must be at least 32 bytes (UTF-8 text, not decoded) in production' },
    ]);
  });

  it('refuses a signing secret of 31 bytes in production and accepts it in development', () => {
    expect(failures({ ...WORKER_PRODUCTION, STORAGE_SIGNING_SECRET: ascii(31) }, 'worker')).toEqual([
      { variable: 'STORAGE_SIGNING_SECRET', rule: 'must be at least 32 bytes (UTF-8 text, not decoded) in production' },
    ]);
    expect(failures({ STORAGE_SIGNING_SECRET: ascii(31) })).toEqual([]);
  });

  it('requires APP_URL in production only for the local storage driver, and only in the web process', () => {
    const withoutAppUrl = omit(WEB_PRODUCTION, 'APP_URL');
    expect(failures(withoutAppUrl, 'web')).toEqual([{ variable: 'APP_URL', rule: 'is required in production when STORAGE_DRIVER is local' }]);
    expect(failures(withoutAppUrl, 'worker')).toEqual([]);
    expect(failures({ ...withoutAppUrl, STORAGE_DRIVER: 'oci' }, 'web')).toEqual([]);
  });

  it('keeps the development URL out of production', () => {
    expect(parseConfig({ NODE_ENV: 'production', ...WORKER_PRODUCTION }, { role: 'worker' }).APP_URL).toBeUndefined();
    expect(parseConfig({ ...WORKER_PRODUCTION, NODE_ENV: 'development' }, { role: 'worker' }).APP_URL).toBe('http://localhost:3000');
  });

  it('does not enforce production requirements during next build', () => {
    expect(failures({ NODE_ENV: 'production', NEXT_PHASE: 'phase-production-build' }, 'web')).toEqual([]);
    expect(failures({ NODE_ENV: 'production', NEXT_PHASE: 'phase-production-build', WORKER_CONCURRENCY: 'x' }, 'web')).toEqual([
      { variable: 'WORKER_CONCURRENCY', rule: 'must be a whole number from 1 to 1024' },
    ]);
  });

  it('requires TRUSTED_CDN to name the provider when TRUSTED_CDN_RANGES is set', () => {
    expect(failures({ TRUSTED_CDN_RANGES: '203.0.113.0/24' })).toEqual([
      { variable: 'TRUSTED_CDN_RANGES', rule: 'requires TRUSTED_CDN to name the provider' },
    ]);
    expect(failures({ TRUSTED_CDN: 'cloudflare', TRUSTED_CDN_RANGES: '203.0.113.0/24' })).toEqual([]);
  });

  it('parses the trust list into entries and keeps an explicit none distinct from unset', () => {
    expect(parseConfig({ TRUSTED_PROXIES: '10.0.0.0/8, 2001:db8::/32' }).TRUSTED_PROXIES).toEqual(['10.0.0.0/8', '2001:db8::/32']);
    expect(parseConfig({ TRUSTED_PROXIES: 'none' }).TRUSTED_PROXIES).toEqual([]);
    expect(parseConfig({}).TRUSTED_PROXIES).toBeUndefined();
  });

  it('does not make the trust declaration a start-up requirement: the edge middleware answers 503 for that', () => {
    expect(failures(WEB_PRODUCTION, 'web')).toEqual([]);
    expect(parseConfig(WEB_PRODUCTION, { role: 'web' }).TRUSTED_PROXIES).toBeUndefined();
  });

  it('rejects a raw value longer than the variable allows before parsing it', () => {
    expect(failures({ REDIS_HOST: 'h'.repeat(5000) })).toEqual([{ variable: 'REDIS_HOST', rule: 'must be at most 4096 characters' }]);
  });
});
