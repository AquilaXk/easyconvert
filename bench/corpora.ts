/**
 * The public sample sets the parity benchmark measures beyond the small generated corpus (bench/corpus/): the manifest
 * (bench/corpus/remote-manifest.json) lists every sample's origin, size, SHA-256 and licence, the files themselves are never
 * committed, and this module fetches them from the host that publishes them, checks every digest and keeps them in a cache.
 *
 *   npx tsx bench/corpora.ts pin <seeds.json> [--write]   resolve the offsets and digests of new samples
 *   npx tsx bench/corpora.ts verify [--family image,audio] fetch every sample and check it against the manifest
 *
 * A digest that differs from the manifest is a failed run, never a refetch with a different file: the benchmark compares
 * against fixed bytes. A sample that cannot be fetched is a failed run under ORACLE_STRICT_MODE=1 and a skipped row otherwise.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { REMOTE_CACHE_DIR, REMOTE_MANIFEST_PATH } from './config';
import { BenchArgumentError, BenchError } from './errors';
import { EOCD_SEARCH_BYTES, inflateEntry, localHeaderLength, locateCentralDirectory, parseCentralDirectory } from './realworld/zip-range';

export const REMOTE_MANIFEST_SCHEMA = 1;
/** Families whose runners read remote samples. */
export const REMOTE_FAMILIES = ['image', 'video', 'audio', 'compression'] as const;
export type RemoteFamily = (typeof REMOTE_FAMILIES)[number];

const SHA256_HEX = /^[0-9a-f]{64}$/;
/** A sample id is a file name and the first part of a case name (`<id>-><target>`), so it holds no slash and no arrow. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_CLASS = /^[a-z][a-z0-9-]*$/;
/** The largest single sample; a bigger entry is a mistake in the manifest, not a plan. */
export const MAX_REMOTE_SAMPLE_BYTES = 256 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
/** Attempts after the first one; BENCH_CORPUS_RETRIES lowers it for a test that fetches from nowhere. */
const DEFAULT_RETRIES = 3;
const BACKOFF_BASE_MS = 2000;
const REQUEST_TIMEOUT_MS = 300_000;
const HTTP_OK = 200;
const HTTP_PARTIAL = 206;
const ZIP_LOCAL_HEADER_PROBE_BYTES = 30;
const USER_AGENT = 'easyconvert-parity-bench/1.0 (+https://github.com/AquilaXk/easyconvert)';

/** A file served on its own at a URL. */
export interface FileOrigin {
  kind: 'file';
  url: string;
}

/** A file inside a ZIP archive, read with range requests. */
export interface ZipOrigin {
  kind: 'zip';
  archive: string;
  entry: string;
  /** Offset of the entry's local file header in the archive. */
  offset: number;
  compressedSize: number;
  /** ZIP compression method (0 stored, 8 deflated). */
  method: number;
}

/** The first bytes of a larger file (a few frames of an uncompressed video, read with one range request). */
export interface RangeOrigin {
  kind: 'range';
  url: string;
  /** Inclusive byte positions. */
  start: number;
  end: number;
}

export type RemoteOrigin = FileOrigin | ZipOrigin | RangeOrigin;

export type RemoteMeta = Readonly<Record<string, string | number | boolean>>;

export interface RemoteSample {
  /** The file name the sample is known by; case names start with it. */
  id: string;
  family: RemoteFamily;
  /** The content class the per-class verdict aggregates over (photo, screen, speech, text, ...). */
  class: string;
  /** The published collection it belongs to (a key of `sets`). */
  set: string;
  description: string;
  origin: RemoteOrigin;
  bytes: number;
  sha256: string;
  /** Short licence code; bench/corpus/PROVENANCE.md carries it on the sample's row (tests/bench-corpora.test.ts checks). */
  licence: string;
  /** What the family runner needs to know about the file (bit depth, frames, channels), checked against the file when it is read. */
  meta: RemoteMeta;
}

export interface RemoteSet {
  title: string;
  /** Page of the publisher that states the terms. */
  terms: string;
}

export interface RemoteManifest {
  schemaVersion: number;
  sets: Readonly<Record<string, RemoteSet>>;
  samples: RemoteSample[];
}

/** The manifest is unusable, a sample is not what the manifest pins, or a sample could not be fetched. */
export class CorpusError extends BenchError {}
/** Fetched bytes whose SHA-256 differs from the manifest. */
export class CorpusDigestError extends CorpusError {}
/** A host did not deliver a sample (network, status, size). */
export class CorpusFetchError extends CorpusError {}

export const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

function requireHttps(value: unknown, where: string): void {
  if (typeof value !== 'string' || !value.startsWith('https://')) throw new CorpusError(`${where} must be an https URL`);
}

function requireCount(value: unknown, where: string): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new CorpusError(`${where} must be a non-negative integer`);
}

function checkOrigin(id: string, origin: RemoteOrigin): void {
  const where = `${id}.origin`;
  if (origin.kind === 'file') {
    requireHttps(origin.url, `${where}.url`);
  } else if (origin.kind === 'zip') {
    requireHttps(origin.archive, `${where}.archive`);
    if (typeof origin.entry !== 'string' || origin.entry === '') throw new CorpusError(`${where}.entry must name the archive entry`);
    requireCount(origin.offset, `${where}.offset`);
    requireCount(origin.compressedSize, `${where}.compressedSize`);
    if (origin.method !== 0 && origin.method !== 8) throw new CorpusError(`${where}.method must be 0 (stored) or 8 (deflated)`);
  } else if (origin.kind === 'range') {
    requireHttps(origin.url, `${where}.url`);
    requireCount(origin.start, `${where}.start`);
    requireCount(origin.end, `${where}.end`);
    if (origin.end < origin.start) throw new CorpusError(`${where} ends before it starts`);
  } else {
    throw new CorpusError(`${where}.kind is unknown`);
  }
}

function checkSample(sample: RemoteSample, sets: Readonly<Record<string, RemoteSet>>, seen: Set<string>): void {
  const id = sample.id;
  if (typeof id !== 'string' || !SAFE_ID.test(id) || id.includes('->')) throw new CorpusError(`sample id ${JSON.stringify(id)} is not a safe file name`);
  if (seen.has(id)) throw new CorpusError(`duplicate sample id ${id}`);
  seen.add(id);
  if (!(REMOTE_FAMILIES as readonly string[]).includes(sample.family)) throw new CorpusError(`${id}: family must be one of ${REMOTE_FAMILIES.join(', ')}`);
  if (typeof sample.class !== 'string' || !SAFE_CLASS.test(sample.class)) throw new CorpusError(`${id}: class must be a lower-case word`);
  if (sets[sample.set] === undefined) throw new CorpusError(`${id}: unknown set ${String(sample.set)}`);
  if (typeof sample.description !== 'string' || sample.description === '') throw new CorpusError(`${id}: description is missing`);
  if (typeof sample.licence !== 'string' || sample.licence === '') throw new CorpusError(`${id}: licence is missing; every sample records the licence it is used under`);
  if (typeof sample.sha256 !== 'string' || !SHA256_HEX.test(sample.sha256)) throw new CorpusError(`${id}: sha256 is not 64 lower-case hex digits`);
  if (!Number.isSafeInteger(sample.bytes) || sample.bytes <= 0 || sample.bytes > MAX_REMOTE_SAMPLE_BYTES) throw new CorpusError(`${id}: bytes must be a positive integer of at most ${MAX_REMOTE_SAMPLE_BYTES}`);
  if (typeof sample.meta !== 'object' || sample.meta === null || Array.isArray(sample.meta)) throw new CorpusError(`${id}: meta must be an object`);
  checkOrigin(id, sample.origin);
}

/** Validates a parsed manifest; throws CorpusError naming the first problem. */
export function validateRemoteManifest(value: unknown): RemoteManifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new CorpusError('remote manifest must be an object');
  const manifest = value as Partial<RemoteManifest>;
  if (manifest.schemaVersion !== REMOTE_MANIFEST_SCHEMA) throw new CorpusError(`remote manifest schemaVersion must be ${REMOTE_MANIFEST_SCHEMA}`);
  if (typeof manifest.sets !== 'object' || manifest.sets === null) throw new CorpusError('remote manifest needs sets');
  for (const [name, set] of Object.entries(manifest.sets)) {
    if (typeof set.title !== 'string' || set.title === '') throw new CorpusError(`set ${name} needs a title`);
    requireHttps(set.terms, `set ${name} terms`);
  }
  if (!Array.isArray(manifest.samples)) throw new CorpusError('remote manifest needs samples');
  const seen = new Set<string>();
  for (const sample of manifest.samples) checkSample(sample, manifest.sets, seen);
  return manifest as RemoteManifest;
}

let cachedManifest: RemoteManifest | undefined;

/** The manifest at `file` (default: the committed one, read once per process). */
export function readRemoteManifest(file: string = REMOTE_MANIFEST_PATH): RemoteManifest {
  if (file === REMOTE_MANIFEST_PATH && cachedManifest !== undefined) return cachedManifest;
  const size = fs.statSync(file).size;
  if (size > MAX_MANIFEST_BYTES) throw new CorpusError(`${file} is ${size} bytes, over the ${MAX_MANIFEST_BYTES} byte limit`);
  const manifest = validateRemoteManifest(JSON.parse(fs.readFileSync(file, 'utf8')) as unknown);
  if (file === REMOTE_MANIFEST_PATH) cachedManifest = manifest;
  return manifest;
}

/** The samples of one family, in manifest order. */
export function remoteSamples(family: RemoteFamily, manifest: RemoteManifest = readRemoteManifest()): RemoteSample[] {
  return manifest.samples.filter((sample) => sample.family === family);
}

/** The sample with this id, or undefined. */
export function remoteSample(id: string, manifest: RemoteManifest = readRemoteManifest()): RemoteSample | undefined {
  return manifest.samples.find((sample) => sample.id === id);
}

/** The prefix of the generated edge cases (a silent passage, a surround mix, a clipped signal) built from public samples. */
export const EDGE_CASE_PREFIX = 'edge-';

/** Whether a case name belongs to a public sample (`<id>-><target>`, `<id>.tar-><target>`, `<id>.<format>->tar`), to an edge case built from public samples, or to a per-class row. */
export function isRemoteCase(caseName: string, manifest: RemoteManifest = readRemoteManifest()): boolean {
  if (caseName.startsWith('class-') || caseName.startsWith(EDGE_CASE_PREFIX)) return true;
  return manifest.samples.some((sample) => caseName.startsWith(`${sample.id}->`) || caseName.startsWith(`${sample.id}.`));
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function attempt(url: string, range: [number, number] | null, maxBytes: number): Promise<Buffer> {
  const headers: Record<string, string> = { 'user-agent': USER_AGENT };
  if (range) headers.range = `bytes=${range[0]}-${range[1]}`;
  const response = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const expected = range ? HTTP_PARTIAL : HTTP_OK;
  if (response.status !== expected) throw new CorpusFetchError(`${url}: HTTP ${response.status}, expected ${expected}`);
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > maxBytes) throw new CorpusFetchError(`${url}: ${declared} bytes exceeds the ${maxBytes}-byte cap`);
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > maxBytes) throw new CorpusFetchError(`${url}: ${body.length} bytes exceeds the ${maxBytes}-byte cap`);
  if (range && body.length !== range[1] - range[0] + 1) throw new CorpusFetchError(`${url}: the range returned ${body.length} bytes, expected ${range[1] - range[0] + 1}`);
  return body;
}

/** The body of `url`, or of the inclusive byte range of it, retried with a pause on network and server errors. */
export async function httpBytes(url: string, range: [number, number] | null, maxBytes: number = MAX_REMOTE_SAMPLE_BYTES): Promise<Buffer> {
  let last: unknown;
  const retries = process.env.BENCH_CORPUS_RETRIES === undefined ? DEFAULT_RETRIES : Number(process.env.BENCH_CORPUS_RETRIES);
  for (let tryNumber = 0; tryNumber <= retries; tryNumber++) {
    try {
      return await attempt(url, range, maxBytes);
    } catch (error) {
      last = error;
      if (tryNumber < retries) await sleep(BACKOFF_BASE_MS * 2 ** tryNumber);
    }
  }
  throw new CorpusFetchError(`${url}: failed after ${retries + 1} attempts: ${last instanceof Error ? last.message : String(last)}`);
}

/** The sample's bytes from its origin, before any digest check. */
export async function downloadSample(sample: RemoteSample): Promise<Buffer> {
  const origin = sample.origin;
  if (origin.kind === 'file') return httpBytes(origin.url, null, sample.bytes);
  if (origin.kind === 'range') return httpBytes(origin.url, [origin.start, origin.end], sample.bytes);
  const head = await httpBytes(origin.archive, [origin.offset, origin.offset + ZIP_LOCAL_HEADER_PROBE_BYTES - 1], ZIP_LOCAL_HEADER_PROBE_BYTES);
  const dataStart = origin.offset + localHeaderLength(head);
  const data = origin.compressedSize === 0 ? Buffer.alloc(0) : await httpBytes(origin.archive, [dataStart, dataStart + origin.compressedSize - 1], origin.compressedSize);
  return inflateEntry({ name: origin.entry, method: origin.method, compressedSize: origin.compressedSize, size: sample.bytes, localHeaderOffset: origin.offset }, data);
}

export interface EnsureOptions {
  cacheDir?: string;
  download?: (sample: RemoteSample) => Promise<Buffer>;
}

const verified = new Map<string, Promise<string>>();

/**
 * Path of the verified sample in the cache, fetching it when absent or when the cached file no longer matches. The cache is
 * content-addressed (`<cacheDir>/<family>/<sha256>`), kept in one directory per family so that a workflow caches the families it runs, so a manifest that changes a digest reads a different file. Fails closed: bytes
 * with another digest are never stored or returned.
 */
export function ensureSample(sample: RemoteSample, options: EnsureOptions = {}): Promise<string> {
  const cacheDir = options.cacheDir ?? REMOTE_CACHE_DIR;
  const key = `${cacheDir}\n${sample.family}\n${sample.sha256}`;
  const known = verified.get(key);
  if (known !== undefined) return known;
  const task = fetchVerified(sample, cacheDir, options.download ?? downloadSample);
  verified.set(key, task);
  task.catch(() => verified.delete(key));
  return task;
}

async function fetchVerified(sample: RemoteSample, cacheDir: string, download: (sample: RemoteSample) => Promise<Buffer>): Promise<string> {
  const target = path.join(cacheDir, sample.family, sample.sha256);
  if (fs.existsSync(target) && fs.statSync(target).size === sample.bytes && sha256(fs.readFileSync(target)) === sample.sha256) return target;
  const bytes = await download(sample);
  const digest = sha256(bytes);
  if (digest !== sample.sha256 || bytes.length !== sample.bytes) {
    throw new CorpusDigestError(`${sample.id}: fetched ${bytes.length} bytes with SHA-256 ${digest}; the manifest pins ${sample.bytes} bytes with ${sample.sha256}. The host changed the file or the manifest is wrong; the benchmark does not measure other bytes.`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const partial = `${target}.${process.pid}.part`;
  fs.writeFileSync(partial, bytes);
  fs.renameSync(partial, target);
  return target;
}

/** Forgets what this process verified (tests change the cache directory and the downloader between cases). */
export function resetVerifiedSamples(): void {
  verified.clear();
  cachedManifest = undefined;
}

// ---- pinning ---------------------------------------------------------------------------------------------------------

/** A sample before its digest is known: the origin names what to fetch and the pin step resolves the rest. */
export type SeedOrigin = FileOrigin | { kind: 'zip'; archive: string; entry: string } | { kind: 'y4m'; url: string; frames: number };
export type Seed = Omit<RemoteSample, 'origin' | 'bytes' | 'sha256'> & { origin: SeedOrigin };

const Y4M_FRAME_MARKER = 'FRAME\n';
const Y4M_HEADER_PROBE_BYTES = 4096;
/** Samples per pixel of the 8-bit chroma layouts by the first three characters of the `C` tag. */
const Y4M_SAMPLES_PER_PIXEL: Readonly<Record<string, number>> = { '420': 1.5, '422': 2, '444': 3 };

/** Bytes per frame of an uncompressed 4:2:0 or 4:2:2 or 4:4:4 y4m stream, from its header line. */
export function y4mLayout(header: string): { width: number; height: number; frameBytes: number; fps: string; chroma: string } {
  const fields = header.trim().split(' ');
  if (fields[0] !== 'YUV4MPEG2') throw new CorpusError('not a YUV4MPEG2 stream');
  const field = (prefix: string): string => fields.find((item) => item.startsWith(prefix))?.slice(prefix.length) ?? '';
  const width = Number(field('W'));
  const height = Number(field('H'));
  const chroma = field('C') || '420jpeg';
  if (/p1[0-6]/.test(chroma)) throw new CorpusError(`${header.trim()}: high bit depth y4m is not used by the benchmark`);
  const samplesPerPixel = Y4M_SAMPLES_PER_PIXEL[chroma.slice(0, 3)];
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || samplesPerPixel === undefined) throw new CorpusError(`unsupported y4m header: ${header.trim()}`);
  return { width, height, frameBytes: width * height * samplesPerPixel, fps: field('F'), chroma };
}

async function resolveOrigin(seed: Seed): Promise<{ origin: RemoteOrigin; meta: RemoteMeta }> {
  const origin = seed.origin;
  if (origin.kind === 'file') return { origin, meta: seed.meta };
  if (origin.kind === 'zip') {
    const tail = await tailOf(origin.archive);
    const location = locateCentralDirectory(tail.bytes);
    const directory = await httpBytes(origin.archive, [location.offset, location.offset + location.size - 1], location.size);
    const entry = parseCentralDirectory(directory, location.entries).find((item) => item.name === origin.entry);
    if (entry === undefined) throw new CorpusError(`${seed.id}: ${origin.entry} is not in ${origin.archive}`);
    return { origin: { kind: 'zip', archive: origin.archive, entry: origin.entry, offset: entry.localHeaderOffset, compressedSize: entry.compressedSize, method: entry.method }, meta: seed.meta };
  }
  const head = await httpBytes(origin.url, [0, Y4M_HEADER_PROBE_BYTES - 1], Y4M_HEADER_PROBE_BYTES);
  const newline = head.indexOf(0x0a);
  const layout = y4mLayout(head.subarray(0, newline).toString('latin1'));
  const frameStride = Y4M_FRAME_MARKER.length + layout.frameBytes;
  const headerLength = newline + 1;
  if (head.subarray(headerLength, headerLength + Y4M_FRAME_MARKER.length).toString('latin1') !== Y4M_FRAME_MARKER) throw new CorpusError(`${seed.id}: the first frame does not follow the header (frame headers with parameters are not supported)`);
  const end = headerLength + origin.frames * frameStride - 1;
  return { origin: { kind: 'range', url: origin.url, start: 0, end }, meta: { ...seed.meta, width: layout.width, height: layout.height, frames: origin.frames, fps: layout.fps, chroma: layout.chroma } };
}

async function tailOf(url: string): Promise<{ bytes: Buffer }> {
  const probe = await fetch(url, { headers: { range: 'bytes=0-0', 'user-agent': USER_AGENT }, redirect: 'follow', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  await probe.arrayBuffer();
  const total = /\/(\d+)$/.exec(probe.headers.get('content-range') ?? '');
  if (probe.status !== HTTP_PARTIAL || total === null) throw new CorpusFetchError(`${url}: the host does not answer range requests (HTTP ${probe.status})`);
  const size = Number(total[1]);
  const start = Math.max(0, size - EOCD_SEARCH_BYTES);
  return { bytes: await httpBytes(url, [start, size - 1], EOCD_SEARCH_BYTES) };
}

/** Samples for the seeds: the origin resolved, the bytes fetched once and pinned by size and SHA-256. */
export async function pinSeeds(seeds: readonly Seed[], log: (line: string) => void = () => undefined): Promise<RemoteSample[]> {
  const pinned: RemoteSample[] = [];
  for (const seed of seeds) {
    const { origin, meta } = await resolveOrigin(seed);
    const expectedBytes = origin.kind === 'zip' ? await zipEntrySize(origin) : MAX_REMOTE_SAMPLE_BYTES;
    const draft = { ...seed, origin, meta, bytes: expectedBytes, sha256: '0'.repeat(64) } as RemoteSample;
    const bytes = await downloadSample(draft);
    log(`pinned ${seed.id}: ${bytes.length} bytes`);
    pinned.push({ ...draft, bytes: bytes.length, sha256: sha256(bytes) });
  }
  return pinned;
}

async function zipEntrySize(origin: ZipOrigin): Promise<number> {
  const tail = await tailOf(origin.archive);
  const location = locateCentralDirectory(tail.bytes);
  const directory = await httpBytes(origin.archive, [location.offset, location.offset + location.size - 1], location.size);
  const entry = parseCentralDirectory(directory, location.entries).find((item) => item.name === origin.entry);
  if (entry === undefined) throw new CorpusError(`${origin.entry} is not in ${origin.archive}`);
  return entry.size;
}

// ---- command line ----------------------------------------------------------------------------------------------------

async function main(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  const log = (line: string): void => {
    process.stderr.write(`${line}\n`);
  };
  if (command === 'verify') {
    const familyArg = rest.indexOf('--family');
    const families = familyArg >= 0 ? (rest[familyArg + 1] ?? '').split(',') : [...REMOTE_FAMILIES];
    const manifest = readRemoteManifest();
    let count = 0;
    for (const sample of manifest.samples.filter((item) => families.includes(item.family))) {
      await ensureSample(sample);
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
    const pinned = await pinSeeds(seeds, log);
    process.stdout.write(`${JSON.stringify(pinned, null, 2)}\n`);
    return 0;
  }
  throw new BenchArgumentError('usage: corpora.ts pin <seeds.json> | verify [--family a,b]');
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`bench:corpora failed: ${error instanceof BenchError ? `${error.name}: ${error.message}` : String(error instanceof Error ? error.stack : error)}\n`);
      process.exit(2);
    }
  );
}
