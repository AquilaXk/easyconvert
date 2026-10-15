import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MAX_CACHE_ENTRY_BYTES, REF_CACHE_SCHEMA_VERSION } from './config';
import { BenchError } from './errors';

/**
 * Cache of the reference side of the quality rows. The reference encoder's output and its measurements depend only on
 * the reference tool, the corpus file, the settings and the measuring code, so a repeat run reads them back instead
 * of encoding and measuring again. A key therefore names the reference tool and its version, the content hash of
 * every input file, the settings, and a hash of the harness source that takes the measurement; changing any of them
 * is a different key, never a stale hit. Throughput is never cached: speed is measured in the job that judges it.
 */

/** An entry on disk that cannot be trusted: wrong shape, wrong key, a size over the limit or a failed value check. */
export class CacheEntryError extends BenchError {}

export type SettingValue = string | number | boolean;

/** What a reference measurement is a function of, by name. Resolved to versions and hashes by the cache. */
export interface RefSpec {
  /** The measurement, e.g. `image-encode` or `ocr-text`. */
  kind: string;
  /** Reference and measuring tools whose version lines enter the key. */
  tools: readonly string[];
  /** Corpus files, relative to the corpus directory, whose content hashes enter the key. */
  files: readonly string[];
  /** Everything else the value depends on: quality, preset, case name. */
  settings: Readonly<Record<string, SettingValue>>;
}

/** A spec with its tools and files resolved: the exact input of the key. */
export interface ResolvedRefSpec {
  schemaVersion: number;
  kind: string;
  tools: Readonly<Record<string, string | null>>;
  files: Readonly<Record<string, string>>;
  settings: Readonly<Record<string, SettingValue>>;
  /** Hash of the harness sources that produce and measure the value. */
  harness: string;
}

/** JSON with object keys sorted at every depth, so equal values serialise equally. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([key, item]) => [key, sortKeys(item)])
    );
  }
  return value;
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** The cache key of a resolved spec. */
export function referenceCacheKey(spec: ResolvedRefSpec): string {
  return sha256Hex(canonicalJson(spec));
}

export interface CacheStats {
  hits: number;
  misses: number;
  /** Entries that failed validation and were measured again. */
  corrupt: number;
}

export interface ReferenceCacheOptions {
  /** Cache directory; null disables the cache (every call computes). */
  dir: string | null;
  toolVersion: (tool: string) => string | null;
  /** SHA-256 of a corpus file by its path relative to the corpus directory. */
  fileHash: (relative: string) => string;
  /** SHA-256 over the harness sources a family depends on. */
  harnessHash: (family: string) => string;
  log: (message: string) => void;
}

interface EntryFile {
  schemaVersion: number;
  key: string;
  spec: ResolvedRefSpec;
  valueSha256: string;
  value: unknown;
}

export class ReferenceCache {
  readonly stats: CacheStats = { hits: 0, misses: 0, corrupt: 0 };

  constructor(private readonly options: ReferenceCacheOptions) {}

  resolve(family: string, spec: RefSpec): ResolvedRefSpec {
    const tools: Record<string, string | null> = {};
    for (const tool of spec.tools) tools[tool] = this.options.toolVersion(tool);
    const files: Record<string, string> = {};
    for (const file of spec.files) files[file] = this.options.fileHash(file);
    return {
      schemaVersion: REF_CACHE_SCHEMA_VERSION,
      kind: `${family}/${spec.kind}`,
      tools,
      files,
      settings: spec.settings,
      harness: this.options.harnessHash(family),
    };
  }

  /**
   * The cached value of `spec`, or `compute()` stored under the key. `parse` checks the shape of a value read back
   * and throws on a malformed one, which makes the entry corrupt: it is reported, measured again and overwritten.
   */
  async value<T>(family: string, spec: RefSpec, parse: (raw: unknown) => T, compute: () => Promise<T> | T): Promise<T> {
    const dir = this.options.dir;
    if (dir === null) {
      this.stats.misses++;
      return compute();
    }
    const resolved = this.resolve(family, spec);
    const key = referenceCacheKey(resolved);
    const file = path.join(dir, `${key}.json`);
    if (fs.existsSync(file)) {
      try {
        const cached = parse(readEntry(file, key));
        this.stats.hits++;
        return cached;
      } catch (error) {
        if (!(error instanceof CacheEntryError) && !(error instanceof TypeError)) throw error;
        this.stats.corrupt++;
        this.options.log(`ignoring corrupt reference cache entry ${path.basename(file)}: ${error.message}`);
      }
    }
    this.stats.misses++;
    const computed = await compute();
    writeEntry(dir, file, { schemaVersion: REF_CACHE_SCHEMA_VERSION, key, spec: resolved, valueSha256: sha256Hex(canonicalJson(computed)), value: computed });
    return computed;
  }
}

function readEntry(file: string, key: string): unknown {
  const size = fs.statSync(file).size;
  if (size > MAX_CACHE_ENTRY_BYTES) throw new CacheEntryError(`entry is ${size} bytes, over the ${MAX_CACHE_ENTRY_BYTES} byte limit`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new CacheEntryError(`entry is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new CacheEntryError('entry is not an object');
  const entry = parsed as Partial<EntryFile>;
  if (entry.schemaVersion !== REF_CACHE_SCHEMA_VERSION) throw new CacheEntryError(`schemaVersion ${String(entry.schemaVersion)} is not ${REF_CACHE_SCHEMA_VERSION}`);
  if (entry.key !== key) throw new CacheEntryError('entry key does not match its file name');
  if (entry.valueSha256 !== sha256Hex(canonicalJson(entry.value))) throw new CacheEntryError('entry value does not match its checksum');
  return entry.value;
}

function writeEntry(dir: string, file: string, entry: EntryFile): void {
  fs.mkdirSync(dir, { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(entry)}\n`);
  fs.renameSync(temporary, file);
}

/** Parser for a value that is a record of finite numbers with exactly these keys. */
export function numberRecord<K extends string>(keys: readonly K[]): (raw: unknown) => Record<K, number> {
  return (raw) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new TypeError('cached value is not an object');
    const record = raw as Record<string, unknown>;
    const out = {} as Record<K, number>;
    for (const key of keys) {
      const value = record[key];
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`cached ${key} is not a finite number`);
      out[key] = value;
    }
    return out;
  };
}

/** Parser for a string value. */
export function stringValue(raw: unknown): string {
  if (typeof raw !== 'string') throw new TypeError('cached value is not a string');
  return raw;
}
