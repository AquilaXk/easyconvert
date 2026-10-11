/**
 * The public sample sets of the document, PDF, ebook, font, CAD, vector, RAW and data benchmark families: the manifest
 * (bench/corpus/public-manifest.json) lists every sample's origin, size, SHA-256 and licence, the files themselves are not
 * committed, and this module fetches them from the host that publishes them, checks every digest and keeps them in a cache.
 *
 *   npx tsx bench/public-samples.ts pin <seeds.json>               resolve the digest and size of new samples (prints the entries)
 *   npx tsx bench/public-samples.ts verify [--family font,raw]     fetch every sample and check it against the manifest
 *
 * A digest that differs from the manifest is a failed run, never a refetch with a different file: the benchmark compares
 * against fixed bytes. A sample that cannot be fetched is a failed run under ORACLE_STRICT_MODE=1 and a skipped row otherwise.
 *
 * Fetching reuses the real-world corpus fetcher (bench/realworld/fetch.ts): whole files by URL pinned to a revision, and
 * entries of a ZIP archive by range request.
 */
import fs from 'node:fs';
import path from 'node:path';
import { BenchArgumentError, BenchError } from './errors';
import { type CorpusFile, readManifest as readRealworldManifest } from './realworld/manifest';
import { download, MAX_CORPUS_FILE_BYTES, sha256 } from './realworld/fetch';
import type { FileOrigin, ZipOrigin } from './realworld/manifest';

export const PUBLIC_MANIFEST_SCHEMA = 1;
export const PUBLIC_MANIFEST_PATH = path.join(__dirname, 'corpus', 'public-manifest.json');
/** Verified downloads, content-addressed by family and digest; git-ignored, and CI restores it with `actions/cache` keyed on the manifest's hash. */
export const PUBLIC_CACHE_DIR = process.env.BENCH_CORPUS_CACHE ? path.resolve(process.env.BENCH_CORPUS_CACHE) : path.join(__dirname, '..', '.bench-corpora');
/** Families whose runners read public samples. `pdf-ops` is the PDF family: its samples are the inputs of the PDF operations. */
export const PUBLIC_FAMILIES = ['document', 'pdf-ops', 'ebook', 'font', 'cad', 'raw', 'vector', 'data'] as const;
export type PublicFamily = (typeof PUBLIC_FAMILIES)[number];

const SHA256_HEX = /^[0-9a-f]{64}$/;
/** A sample id is a file name and the first part of a case name (`<id>-><target>`), so it holds no slash and no arrow. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_CLASS = /^[a-z][a-z0-9-]*$/;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
/** The largest single sample; a bigger entry is a mistake in the manifest, not a plan. */
export const MAX_PUBLIC_SAMPLE_BYTES = MAX_CORPUS_FILE_BYTES;

export type PublicOrigin = FileOrigin | ZipOrigin;
export type PublicMeta = Readonly<Record<string, string | number | boolean>>;

/** A file that belongs to a sample and is not a sample itself: the reference picture of an SVG test, say. Fetched and pinned like a sample. */
export interface PublicCompanion {
  /** What the file is to the sample (`truth`). */
  role: string;
  origin: PublicOrigin;
  bytes: number;
  sha256: string;
}

export interface PublicSample {
  /** The file name the sample is known by (with its extension); case names start with it. */
  id: string;
  family: PublicFamily;
  /** The content class the per-class verdict aggregates over (tagged, encrypted, cjk, variable, ...). */
  class: string;
  /** The published collection it belongs to (a key of `sets`). */
  set: string;
  description: string;
  origin: PublicOrigin;
  bytes: number;
  sha256: string;
  /** Short licence code; bench/corpus/PROVENANCE.md carries it on the sample's row (tests/bench-public-samples.test.ts checks). */
  licence: string;
  /** What the family runner needs to know about the file (format, pages, glyph limits), read from the manifest and never from a guess. */
  meta: PublicMeta;
  /** Files that come with the sample (absent when there are none). */
  companions?: PublicCompanion[];
}

export interface PublicSet {
  title: string;
  /** Page of the publisher that states the terms. */
  terms: string;
}

export interface PublicManifest {
  schemaVersion: number;
  sets: Readonly<Record<string, PublicSet>>;
  samples: PublicSample[];
}

/** The manifest is unusable, a sample is not what the manifest pins, or a sample could not be fetched. */
export class PublicSampleError extends BenchError {}
/** Fetched bytes whose SHA-256 differs from the manifest. */
export class PublicDigestError extends PublicSampleError {}
/** A host did not deliver a sample (network, status, size). */
export class PublicFetchError extends PublicSampleError {}

function requireHttps(value: unknown, where: string): void {
  if (typeof value !== 'string' || !value.startsWith('https://')) throw new PublicSampleError(`${where} must be an https URL`);
}

function checkOrigin(id: string, origin: PublicOrigin): void {
  const where = `${id}.origin`;
  if (origin.kind === 'file') {
    requireHttps(origin.url, `${where}.url`);
  } else if (origin.kind === 'zip') {
    requireHttps(origin.archive, `${where}.archive`);
    if (typeof origin.entry !== 'string' || origin.entry === '') throw new PublicSampleError(`${where}.entry must name the archive entry`);
    for (const key of ['offset', 'compressedSize'] as const) {
      if (!Number.isSafeInteger(origin[key]) || origin[key] < 0) throw new PublicSampleError(`${where}.${key} must be a non-negative integer`);
    }
    if (origin.method !== 0 && origin.method !== 8) throw new PublicSampleError(`${where}.method must be 0 (stored) or 8 (deflated)`);
  } else {
    throw new PublicSampleError(`${where}.kind is unknown`);
  }
}

function checkSample(sample: PublicSample, sets: Readonly<Record<string, PublicSet>>, seen: Set<string>): void {
  const id = sample.id;
  if (typeof id !== 'string' || !SAFE_ID.test(id) || id.includes('->')) throw new PublicSampleError(`sample id ${JSON.stringify(id)} is not a safe file name`);
  if (seen.has(id)) throw new PublicSampleError(`duplicate sample id ${id}`);
  seen.add(id);
  if (!(PUBLIC_FAMILIES as readonly string[]).includes(sample.family)) throw new PublicSampleError(`${id}: family must be one of ${PUBLIC_FAMILIES.join(', ')}`);
  if (typeof sample.class !== 'string' || !SAFE_CLASS.test(sample.class)) throw new PublicSampleError(`${id}: class must be a lower-case word`);
  if (sets[sample.set] === undefined) throw new PublicSampleError(`${id}: unknown set ${String(sample.set)}`);
  if (typeof sample.description !== 'string' || sample.description === '') throw new PublicSampleError(`${id}: description is missing`);
  if (typeof sample.licence !== 'string' || sample.licence === '') throw new PublicSampleError(`${id}: licence is missing; every sample records the licence it is used under`);
  if (typeof sample.sha256 !== 'string' || !SHA256_HEX.test(sample.sha256)) throw new PublicSampleError(`${id}: sha256 is not 64 lower-case hex digits`);
  if (!Number.isSafeInteger(sample.bytes) || sample.bytes <= 0 || sample.bytes > MAX_PUBLIC_SAMPLE_BYTES) {
    throw new PublicSampleError(`${id}: bytes must be a positive integer of at most ${MAX_PUBLIC_SAMPLE_BYTES}`);
  }
  if (typeof sample.meta !== 'object' || sample.meta === null || Array.isArray(sample.meta)) throw new PublicSampleError(`${id}: meta must be an object`);
  checkOrigin(id, sample.origin);
  const roles = new Set<string>();
  for (const companion of sample.companions ?? []) {
    if (typeof companion.role !== 'string' || !SAFE_CLASS.test(companion.role) || roles.has(companion.role)) throw new PublicSampleError(`${id}: companion roles must be unique lower-case words`);
    roles.add(companion.role);
    if (typeof companion.sha256 !== 'string' || !SHA256_HEX.test(companion.sha256)) throw new PublicSampleError(`${id}.${companion.role}: sha256 is not 64 lower-case hex digits`);
    if (!Number.isSafeInteger(companion.bytes) || companion.bytes <= 0 || companion.bytes > MAX_PUBLIC_SAMPLE_BYTES) throw new PublicSampleError(`${id}.${companion.role}: bytes must be a positive integer`);
    checkOrigin(`${id}.${companion.role}`, companion.origin);
  }
}

/** Validates a parsed manifest; throws PublicSampleError naming the first problem. */
export function validatePublicManifest(value: unknown): PublicManifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new PublicSampleError('public manifest must be an object');
  const manifest = value as Partial<PublicManifest>;
  if (manifest.schemaVersion !== PUBLIC_MANIFEST_SCHEMA) throw new PublicSampleError(`public manifest schemaVersion must be ${PUBLIC_MANIFEST_SCHEMA}`);
  if (typeof manifest.sets !== 'object' || manifest.sets === null) throw new PublicSampleError('public manifest needs sets');
  for (const [name, set] of Object.entries(manifest.sets)) {
    if (typeof set.title !== 'string' || set.title === '') throw new PublicSampleError(`set ${name} needs a title`);
    requireHttps(set.terms, `set ${name} terms`);
  }
  if (!Array.isArray(manifest.samples)) throw new PublicSampleError('public manifest needs samples');
  const seen = new Set<string>();
  for (const sample of manifest.samples) checkSample(sample, manifest.sets, seen);
  return manifest as PublicManifest;
}

let cachedManifest: PublicManifest | undefined;

/** The manifest at `file` (default: the committed one, read once per process). */
export function readPublicManifest(file: string = PUBLIC_MANIFEST_PATH): PublicManifest {
  if (file === PUBLIC_MANIFEST_PATH && cachedManifest !== undefined) return cachedManifest;
  const size = fs.statSync(file).size;
  if (size > MAX_MANIFEST_BYTES) throw new PublicSampleError(`${file} is ${size} bytes, over the ${MAX_MANIFEST_BYTES} byte limit`);
  const manifest = validatePublicManifest(JSON.parse(fs.readFileSync(file, 'utf8')) as unknown);
  if (file === PUBLIC_MANIFEST_PATH) cachedManifest = manifest;
  return manifest;
}

/** The samples of one family, in manifest order. */
export function publicSamples(family: PublicFamily, manifest: PublicManifest = readPublicManifest()): PublicSample[] {
  return manifest.samples.filter((sample) => sample.family === family);
}

/** The sample with this id, or undefined. */
export function publicSample(id: string, manifest: PublicManifest = readPublicManifest()): PublicSample | undefined {
  return manifest.samples.find((sample) => sample.id === id);
}

/** The prefix of the per-class rows (`class-<class>-><target>`). */
export const CLASS_CASE_PREFIX = 'class-';

/** Whether a case name belongs to a public sample (`<id>-><target>`, `<id>.<format>-><target>`) or is a per-class row. */
export function isPublicCase(caseName: string, manifest: PublicManifest = readPublicManifest()): boolean {
  if (caseName.startsWith(CLASS_CASE_PREFIX)) return true;
  return manifest.samples.some((sample) => caseName.startsWith(`${sample.id}->`) || caseName.startsWith(`${sample.id}.`));
}

const asCorpusFile = (sample: Pick<PublicSample, 'origin' | 'bytes' | 'sha256'> & { id: string }): CorpusFile => ({
  id: sample.id,
  source: 'public',
  origin: sample.origin,
  format: path.extname(sample.id).slice(1),
  size: sample.bytes,
  sha256: sample.sha256,
});

/** The sample's bytes from its origin, before any digest check. */
export async function downloadPublicSample(sample: Pinned): Promise<Buffer> {
  try {
    return await download(asCorpusFile(sample));
  } catch (error) {
    throw new PublicFetchError(`${sample.id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** What the cache keeps: the sample, or one of its companions. */
interface Pinned {
  id: string;
  family: PublicFamily;
  origin: PublicOrigin;
  bytes: number;
  sha256: string;
}

export interface EnsureOptions {
  cacheDir?: string;
  download?: (sample: Pinned) => Promise<Buffer>;
}

const verified = new Map<string, Promise<string>>();

/**
 * Path of the verified sample in the cache, fetching it when absent or when the cached file no longer matches. The cache is
 * content-addressed (`<cacheDir>/<family>/<sha256>`), so a manifest that changes a digest reads another file. Fails closed:
 * bytes with another digest are never stored or returned.
 */
export function ensurePublicSample(sample: Pinned, options: EnsureOptions = {}): Promise<string> {
  const cacheDir = options.cacheDir ?? PUBLIC_CACHE_DIR;
  const key = `${cacheDir}\n${sample.family}\n${sample.sha256}`;
  const known = verified.get(key);
  if (known !== undefined) return known;
  const task = fetchVerified(sample, cacheDir, options.download ?? downloadPublicSample);
  verified.set(key, task);
  task.catch(() => verified.delete(key));
  return task;
}

async function fetchVerified(sample: Pinned, cacheDir: string, fetchSample: (sample: Pinned) => Promise<Buffer>): Promise<string> {
  const target = path.join(cacheDir, sample.family, sample.sha256);
  if (fs.existsSync(target) && fs.statSync(target).size === sample.bytes && sha256(fs.readFileSync(target)) === sample.sha256) return target;
  const bytes = await fetchSample(sample);
  const digest = sha256(bytes);
  if (digest !== sample.sha256 || bytes.length !== sample.bytes) {
    throw new PublicDigestError(
      `${sample.id}: fetched ${bytes.length} bytes with SHA-256 ${digest}; the manifest pins ${sample.bytes} bytes with ${sample.sha256}. The host changed the file or the manifest is wrong; the benchmark does not measure other bytes.`
    );
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const partial = `${target}.${process.pid}.part`;
  fs.writeFileSync(partial, bytes);
  fs.renameSync(partial, target);
  return target;
}

/** Forgets what this process verified (tests change the cache directory and the downloader between cases). */
export function resetVerifiedPublicSamples(): void {
  verified.clear();
  cachedManifest = undefined;
}

/** What a runner needs from the context to fetch a sample: the strict flag and a log. */
export interface FetchContext {
  strict: boolean;
  log: (message: string) => void;
}

/**
 * The verified file of a sample. A digest that differs from the manifest fails the run. A host that cannot deliver the file
 * fails it too under ORACLE_STRICT_MODE=1; otherwise the result is null and the caller reports the sample's rows as skipped.
 */
export async function publicFile(ctx: FetchContext, sample: Pinned, options: EnsureOptions = {}): Promise<string | null> {
  try {
    return await ensurePublicSample(sample, options);
  } catch (error) {
    if (!(error instanceof PublicFetchError) || ctx.strict) throw error;
    ctx.log(`public sample ${sample.id} is not available, its rows are skipped: ${error.message}`);
    return null;
  }
}

/** The verified file of a companion of a sample (null when the host did not deliver it and the run is not strict). */
export async function publicCompanionFile(ctx: FetchContext, sample: PublicSample, role: string): Promise<string | null> {
  const companion = sample.companions?.find((candidate) => candidate.role === role);
  if (companion === undefined) throw new PublicSampleError(`${sample.id} has no ${role} companion`);
  return publicFile(ctx, { id: `${sample.id}.${role}`, family: sample.family, origin: companion.origin, bytes: companion.bytes, sha256: companion.sha256 });
}

// ---- pinning ---------------------------------------------------------------------------------------------------------

/** A sample before its digest is known. `realworld` names a file of the real-world corpus manifest whose origin and digest are taken as they are. */
export type SeedOrigin = FileOrigin | { kind: 'realworld'; id: string };
export type Seed = Omit<PublicSample, 'origin' | 'bytes' | 'sha256' | 'companions'> & { origin: SeedOrigin; companions?: Array<{ role: string; origin: FileOrigin }> };

/** Samples for the seeds: the bytes fetched once and pinned by size and SHA-256. */
export async function pinSeeds(seeds: readonly Seed[], log: (line: string) => void = () => undefined): Promise<PublicSample[]> {
  const pinned: PublicSample[] = [];
  let realworld: Map<string, CorpusFile> | undefined;
  for (const { companions: seededCompanions = [], origin: seedOrigin, ...seed } of seeds) {
    let origin: PublicOrigin;
    let size = 0;
    if (seedOrigin.kind === 'realworld') {
      realworld ??= new Map(readRealworldManifest().files.map((file) => [file.id, file] as const));
      const known = realworld.get(seedOrigin.id);
      if (known === undefined) throw new PublicSampleError(`${seed.id}: ${seedOrigin.id} is not in the real-world manifest`);
      origin = known.origin;
      size = known.size;
    } else {
      origin = seedOrigin;
    }
    const bytes = await download({ ...asCorpusFile({ id: seed.id, origin, bytes: size, sha256: '' }), size });
    log(`pinned ${seed.id}: ${bytes.length} bytes`);
    const companions: PublicCompanion[] = [];
    for (const companion of seededCompanions) {
      const companionBytes = await download(asCorpusFile({ id: `${seed.id}.${companion.role}`, origin: companion.origin, bytes: 0, sha256: '' }));
      companions.push({ role: companion.role, origin: companion.origin, bytes: companionBytes.length, sha256: sha256(companionBytes) });
    }
    pinned.push({ ...seed, origin, bytes: bytes.length, sha256: sha256(bytes), ...(companions.length > 0 ? { companions } : {}) });
  }
  return pinned;
}

// ---- command line ----------------------------------------------------------------------------------------------------

async function main(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  const log = (line: string): void => {
    process.stderr.write(`${line}\n`);
  };
  if (command === 'verify') {
    const familyArg = rest.indexOf('--family');
    const families = familyArg >= 0 ? (rest[familyArg + 1] ?? '').split(',') : [...PUBLIC_FAMILIES];
    let count = 0;
    for (const sample of readPublicManifest().samples.filter((item) => families.includes(item.family))) {
      await ensurePublicSample(sample);
      count++;
      log(`ok ${sample.id}`);
    }
    process.stdout.write(`${count} samples fetched and matching the manifest\n`);
    return 0;
  }
  if (command === 'pin') {
    const file = rest.find((item) => !item.startsWith('--'));
    if (file === undefined) throw new BenchArgumentError('pin needs a seeds file');
    const seeds = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')) as Seed[];
    process.stdout.write(`${JSON.stringify(await pinSeeds(seeds, log), null, 2)}\n`);
    return 0;
  }
  throw new BenchArgumentError('usage: public-samples.ts pin <seeds.json> | verify [--family a,b]');
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`bench public samples failed: ${error instanceof BenchError ? `${error.name}: ${error.message}` : String(error instanceof Error ? error.stack : error)}\n`);
      process.exit(2);
    }
  );
}
