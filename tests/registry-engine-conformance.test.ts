import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { FORMAT_REGISTRY } from '../src/lib/registry';
import { convertFile } from '../src/lib/conversions';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { probeNativeEngines } from '../src/worker/engines';
import { convertOffice } from '../src/lib/conversions/office';
import { convertDocument } from '../src/lib/conversions/document';
import { compressXz, create7zArchive } from '../src/lib/conversions/archive';
import { EngineUnavailableError, UnsupportedTargetError } from '../src/lib/types';
import { OracleToolMissingError, getOracleToolPath, isOracleToolAvailable } from './helpers/differential-oracle';
import { HAS_PDFTOCAIRO, HAS_PDFTOPPM, HAS_SOFFICE, withMissingBinary } from './helpers/native-tools';
const HAS_PDFINFO = isOracleToolAvailable('pdfinfo');
import { buildStoredRar4 } from './helpers/rar4-stored';
import { readPiFrame, readX3fContainer } from './helpers/raw-container-oracle';
import { buildDfont, buildMacBinary, buildTrueTypeFont } from './helpers/mac-font-containers';
import { buildPatchExr, buildPatchUltraHdr } from './helpers/hdr-test-images';

/**
 * Registry/engine conformance gate.
 *
 * Every source -> target pair advertised by FORMAT_REGISTRY must reach a real engine path.
 * Each pair is dispatched through convertFile with small probe inputs; a pair fails only when
 * the engine rejects it with a routing error ("no code path for this pair"). Parse errors,
 * missing native tools, and other input-dependent failures do not count either way.
 *
 * Every entry point converts through the shared dispatcher, which tries a native engine route
 * (LibreOffice, Poppler) before the in-process engine. A pair listed in NATIVE_ENGINE_PAIRS has
 * no in-process path: it counts as routed only because the dedicated suite below proves that the
 * dispatcher converts it with the native tool installed, and fails with EngineUnavailableError
 * (never a routing error) without it. Without the tool, that suite records an explicit skip.
 *
 * The routing-error classifier below is authored by hand from the engines' fail-closed
 * messages; it is not derived from the registry or the dispatcher, so the expected outcome
 * ("zero routing errors") cannot be produced by the code under test agreeing with itself.
 */

const ROUTING_ERROR_PATTERNS: readonly RegExp[] = [
  /^Unsupported (?:[\w/]+ )?conversion from /,
  /^Unsupported office conversion: target iWork format /,
  /^Unsupported (?:SVG|DXF) target conversion: /,
  /^Unsupported 3D CAD target: /,
  /^Unsupported image target format: /,
  /^Unsupported target font format: /,
  /^Unsupported archive target format /,
  /^Unsupported binary or compressed format '\.[^']+' for text extraction/,
  /^Unsupported CAD format: DWG binary encoder unavailable/,
];

function isRoutingError(err: unknown): boolean {
  if (err instanceof UnsupportedTargetError) return true;
  const message = err instanceof Error ? err.message : String(err);
  return ROUTING_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * The dispatcher sends any pair with an audio or video target to the media transcoder. A
 * document, office or archive source has no stream it could demux, and an image has no audio
 * stream, so such pairs reach FFmpeg with nothing to transcode. Judged from registry
 * categories alone, before any probe runs.
 */
function isMediaTranscoderMisroute(source: string, target: string): boolean {
  const sourceCategory = FORMAT_REGISTRY[source].category;
  const targetCategory = FORMAT_REGISTRY[target].category;
  if (MEDIA_CATEGORIES.has(sourceCategory)) return false;
  if (targetCategory === 'audio') return true;
  return targetCategory === 'video' && sourceCategory !== 'image';
}

const PROBE_TIMEOUT_MS = 20_000;
/** Decoding a 39-megapixel RAW sensor and encoding it (AVIF, GIF, PDF) takes far longer than a probe seed. */
const RAW_PROBE_TIMEOUT_MS = 180_000;
const RATCHET_TIMEOUT_MS = 1_800_000;
const CATEGORY_TIMEOUT_MS = 600_000;
/** Per RAW source: its targets at the probe's per-pair ceiling, with headroom. */
const RAW_SOURCE_TIMEOUT_MS = 900_000;
const MEDIA_CATEGORIES = new Set(['audio', 'video']);
const FIXTURE_ROOT = path.resolve(__dirname, 'fixtures');
// Real camera-RAW samples are loaded explicitly below from the fetched cache, never by extension.
const FIXTURE_SKIP_DIRS = new Set(['sigv4', 'raw']);
const FIXTURE_SKIP_FILES = new Set(['reference-formats.json', 'corpus-manifest.json']);

const PLAIN_TEXT = Buffer.from('# Probe heading\n\nFirst probe paragraph.\n\nSecond probe paragraph.\n', 'utf-8');
const CSV_TEXT = Buffer.from('name,count\nalpha,1\nbeta,2\n', 'utf-8');
const SVG_TEXT = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">' +
    '<rect x="4" y="4" width="24" height="24" fill="#336699"/><line x1="0" y1="0" x2="32" y2="32" stroke="#000"/></svg>',
  'utf-8'
);

function collectFixtures(dir: string, out: Map<string, Buffer[]>): void {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!FIXTURE_SKIP_DIRS.has(name)) collectFixtures(full, out);
      continue;
    }
    if (FIXTURE_SKIP_FILES.has(name)) continue;
    const ext = path.extname(name).slice(1).toLowerCase();
    if (!ext) continue;
    const list = out.get(ext) ?? [];
    list.push(readFileSync(full));
    out.set(ext, list);
  }
}

const FIXTURES = new Map<string, Buffer[]>();
collectFixtures(FIXTURE_ROOT, FIXTURES);
const PNG_SEED = FIXTURES.get('png')![0];
const TAR_SEED = FIXTURES.get('tar')![0];
const ZIP_SEED = FIXTURES.get('zip')![0];
const STEP_SEED = FIXTURES.get('step')![0];
const DXF_SEED = FIXTURES.get('dxf')![0];
const VECTOR_PROBE_CATEGORIES = new Set(['image', 'vector', 'cad']);

/**
 * Real camera-RAW samples fetched by `npm run fixtures:raw` (public-domain files, verified by
 * size and SHA-256). A present but corrupt file is a hard error; an absent one is reported
 * through RAW_SAMPLES_MISSING so the RAW checks skip locally and fail under strict mode.
 */
const RAW_FIXTURE_DIR = path.join(FIXTURE_ROOT, 'raw');
const RAW_MANIFEST: readonly { format: string; filename: string; sha256: string; bytes: number }[] = JSON.parse(
  readFileSync(path.join(RAW_FIXTURE_DIR, 'manifest.json'), 'utf-8')
);
const RAW_SAMPLES = new Map<string, Buffer>();
const RAW_SAMPLES_MISSING: string[] = [];

/** Reads a cached sample, failing hard when it is present but does not match its manifest entry. */
function loadRawSample(name: string, entry: { format: string; sha256: string; bytes: number }): Buffer | null {
  const cached = path.join(RAW_FIXTURE_DIR, '.cache', `${name}.${entry.format}`);
  if (!existsSync(cached)) return null;
  const bytes = readFileSync(cached);
  if (bytes.length !== entry.bytes || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
    throw new Error(`RAW sample ${name} does not match its manifest entry; delete tests/fixtures/raw/.cache and rerun npm run fixtures:raw`);
  }
  return bytes;
}

for (const entry of RAW_MANIFEST) {
  const bytes = loadRawSample(entry.format, entry);
  if (bytes) RAW_SAMPLES.set(entry.format, bytes);
  else RAW_SAMPLES_MISSING.push(entry.format);
}

/**
 * Further public-domain samples of formats whose sensor data comes in several encodings (older and newer
 * Sigma generations, more Raspberry Pi sensors), cached as `<format>-<variant>.<format>`.
 */
const RAW_VARIANT_MANIFEST: readonly { format: string; variant: string; sha256: string; bytes: number }[] = JSON.parse(
  readFileSync(path.join(RAW_FIXTURE_DIR, 'variants.json'), 'utf-8')
);
const RAW_VARIANT_SAMPLES = new Map<string, Buffer>();
for (const entry of RAW_VARIANT_MANIFEST) {
  const name = `${entry.format}-${entry.variant}`;
  const bytes = loadRawSample(name, entry);
  if (bytes) RAW_VARIANT_SAMPLES.set(name, bytes);
  else RAW_SAMPLES_MISSING.push(name);
}
const STRICT_MODE = process.env.ORACLE_STRICT_MODE === '1';
/** Strict mode keeps the RAW checks enabled so that missing samples fail instead of skipping. */
const RAW_CHECKS_ENABLED = STRICT_MODE || RAW_SAMPLES_MISSING.length === 0;
/** Hand-authored from the camera families the registry advertises; the manifest must cover exactly these. */
const RAW_SOURCES = ['3fr', 'arw', 'cr2', 'cr3', 'crw', 'dcr', 'dng', 'erf', 'mos', 'mrw', 'nef', 'orf', 'pef', 'raf', 'raw', 'rw2', 'x3f'];
const RAW_SOURCE_SET: ReadonlySet<string> = new Set(RAW_SOURCES);
/**
 * Camera files LibRaw's distribution build cannot open (a Raspberry Pi frame, Sigma Foveon X3F) are decoded
 * in-process from their sensor data, so they convert with plain options and need no external engine.
 */
const IN_PROCESS_RAW_SOURCES: ReadonlySet<string> = new Set(['raw', 'x3f']);
/** Whether the native RAW engine (LibRaw `dcraw_emu`) is installed. */
const HAS_NATIVE_RAW_ENGINE = probeNativeEngines().dcrawEmu;

/** Plain options whenever a sensor decoder is available, so only real sensor decode resolves a pair. */
function rawSampleOptions(source: string): Record<string, unknown> {
  return HAS_NATIVE_RAW_ENGINE || IN_PROCESS_RAW_SOURCES.has(source) ? {} : { allowEmbeddedPreview: true };
}

/** Seed formats used to derive a structurally valid probe input for a source format. */
const DERIVATION_SEEDS: readonly { format: string; buffer: Buffer }[] = [
  { format: 'txt', buffer: PLAIN_TEXT },
  { format: 'md', buffer: PLAIN_TEXT },
  { format: 'csv', buffer: CSV_TEXT },
  { format: 'svg', buffer: SVG_TEXT },
  { format: 'png', buffer: PNG_SEED },
  { format: 'tar', buffer: TAR_SEED },
  { format: 'zip', buffer: ZIP_SEED },
  { format: 'step', buffer: STEP_SEED },
];

const NDJSON_TEXT = Buffer.from('{"name":"alpha","count":1}\n{"name":"beta","count":2}\n', 'utf-8');
const STL_TEXT = Buffer.from(
  [
    'solid probe',
    ...[
      ['0 0 0', '1 0 0', '0 1 0'],
      ['0 0 0', '0 1 0', '0 0 1'],
      ['0 0 0', '0 0 1', '1 0 0'],
      ['1 0 0', '0 0 1', '0 1 0'],
    ].map((tri) => ['facet normal 0 0 0', 'outer loop', ...tri.map((v) => `vertex ${v}`), 'endloop', 'endfacet'].join('\n')),
    'endsolid probe',
    '',
  ].join('\n'),
  'utf-8'
);
const OBJ_TEXT = Buffer.from(
  'v 0 0 0\nv 1 0 0\nv 0 1 0\nv 0 0 1\nf 1 2 3\nf 1 3 4\nf 1 4 2\nf 2 4 3\n',
  'utf-8'
);

async function buildCbz(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('page-001.png', PNG_SEED);
  zip.file('page-002.png', PNG_SEED);
  return zip.generateAsync({ type: 'nodebuffer' });
}

/** Small hand-built inputs for source families with no fixture and no derivation seed. */
const EXTRA_PROBES: Readonly<Record<string, () => Buffer | Promise<Buffer>>> = {
  ndjson: () => NDJSON_TEXT,
  jsonl: () => NDJSON_TEXT,
  stl: () => STL_TEXT,
  obj: () => OBJ_TEXT,
  gz: () => gzipSync(PLAIN_TEXT),
  // SVGZ is gzip-compressed SVG; plain SVG text is not a valid .svgz input.
  svgz: () => gzipSync(SVG_TEXT),
  tgz: () => gzipSync(TAR_SEED),
  'tar.gz': () => gzipSync(TAR_SEED),
  cbz: buildCbz,
  // A tar.bz2 is a valid bzip2 stream, and a zst archive a valid Zstandard frame.
  bz: () => requireDerived('tar.bz2'),
  bz2: () => requireDerived('tar.bz2'),
  tbz: () => requireDerived('tar.bz2'),
  tbz2: () => requireDerived('tar.bz2'),
  zstd: () => requireDerived('zst'),
  xz: () => compressXz(PLAIN_TEXT),
  txz: () => compressXz(TAR_SEED),
  'tar.xz': () => compressXz(TAR_SEED),
  'tar.7z': () => create7zArchive([{ filename: 'probe.tar', buffer: TAR_SEED }]).buffer,
  rar: () => buildStoredRar4([{ name: 'probe.txt', data: PLAIN_TEXT }]),
  // LHA is LZH under its other name. The ISO, CAB, ARJ, RPM, DEB, CPIO, DMG, IMG, LZMA and Z sources are
  // seeded by the same-extension files in fixtures/archive-sources, all written by tools other than 7-Zip.
  lha: () => readFileSync(path.join(FIXTURE_ROOT, 'archive-sources', 'probe.lzh')),
  // Macintosh font containers wrapping a hand-built TrueType font.
  dfont: () => buildDfont([buildTrueTypeFont({ family: 'Probe Sans' })]),
  bin: () => buildMacBinary({ resourceFork: buildDfont([buildTrueTypeFont({ family: 'Probe Sans' })]) }),
  // HDR sources need a structurally valid OpenEXR file and an Ultra HDR JPEG with a gain map; both
  // come from independent writers in tests/helpers, not from the engine's own encoders.
  exr: () => buildPatchExr('half'),
  ultrahdr: () => buildPatchUltraHdr(),
};

async function requireDerived(format: string): Promise<Buffer> {
  const derived = await deriveProbeInput(format);
  if (!derived) throw new Error(`no probe input could be derived for .${format}`);
  return derived;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs = PROBE_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('probe timed out')), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const derivedCache = new Map<string, Buffer | null>();

async function deriveProbeInput(source: string): Promise<Buffer | null> {
  if (derivedCache.has(source)) return derivedCache.get(source)!;
  let derived: Buffer | null = null;
  for (const seed of DERIVATION_SEEDS) {
    if (seed.format === source || !FORMAT_REGISTRY[seed.format]?.targetFormats.includes(source)) continue;
    try {
      const result = await withTimeout(convertFile(seed.buffer, seed.format, source, {}, `probe.${seed.format}`));
      if (Buffer.isBuffer(result.buffer) && result.buffer.length > 0) {
        derived = result.buffer;
        break;
      }
    } catch {
      // Try the next seed; a seed that cannot produce this format is not evidence either way.
    }
  }
  derivedCache.set(source, derived);
  return derived;
}

async function probeInputs(source: string): Promise<Buffer[]> {
  const inputs: Buffer[] = [...(FIXTURES.get(source) ?? [])];
  const extra = EXTRA_PROBES[source];
  if (extra) {
    // A builder that needs a missing native tool leaves the pair to the remaining inputs.
    const built = await Promise.resolve()
      .then(extra)
      .catch(() => null);
    if (built) inputs.push(built);
  }
  const derived = await deriveProbeInput(source);
  if (derived) inputs.push(derived);
  const category = FORMAT_REGISTRY[source].category;
  if (category === 'image') inputs.push(PNG_SEED);
  // Vector and CAD readers without a native decoder accept embedded SVG or ASCII DXF entities.
  if (VECTOR_PROBE_CATEGORIES.has(category)) inputs.push(SVG_TEXT, DXF_SEED);
  inputs.push(PLAIN_TEXT);
  return inputs;
}

/**
 * Pairs with no in-process path that the dispatcher must route to a native engine: LibreOffice
 * for Office-to-Office targets, LibreOffice chained with Poppler pdftoppm for raster targets,
 * Poppler pdftoppm for PDF pages to raster images, and Poppler pdftocairo for pdf->svg. Authored by
 * hand from the native tools' capabilities.
 */
const NATIVE_ENGINE_PAIRS: Readonly<Record<string, readonly string[]>> = {
  doc: ['jpg', 'png', 'rtf'],
  docx: ['doc', 'jpg', 'png', 'rtf'],
  odp: ['jpg', 'png', 'ppt'],
  ods: ['jpg', 'png'],
  odt: ['doc', 'jpg', 'png', 'rtf'],
  pdf: ['jpg', 'png', 'svg', 'tiff'],
  ppt: ['jpg', 'odp', 'png'],
  pptx: ['jpg', 'png', 'ppt'],
  rtf: ['doc', 'jpg', 'png'],
  xls: ['jpg', 'png'],
  xlsx: ['jpg', 'png'],
};

function isNativeEnginePair(source: string, target: string): boolean {
  return NATIVE_ENGINE_PAIRS[source]?.includes(target) ?? false;
}

type PairOutcome = 'routed' | 'unrouted' | 'inconclusive' | 'native';

async function probePair(source: string, target: string): Promise<{ outcome: PairOutcome; detail: string }> {
  if (isNativeEnginePair(source, target)) {
    return { outcome: 'native', detail: 'proven by the native-engine pair suite' };
  }
  if (isMediaTranscoderMisroute(source, target)) {
    return { outcome: 'unrouted', detail: 'non-media source routed to the media transcoder' };
  }
  let lastError = '';
  const attempts = (await probeInputs(source)).map((input) => ({ input, options: {} as Record<string, unknown> }));
  const rawSample = RAW_SAMPLES.get(source);
  if (rawSample) attempts.push({ input: rawSample, options: rawSampleOptions(source) });
  for (const { input, options } of attempts) {
    try {
      // Camera RAW goes through the dispatcher so the native sensor decode is what resolves the pair.
      const run = RAW_SAMPLES.has(source) && input === rawSample
        ? dispatchConversion(input, source, target, options, `probe.${source}`)
        : convertFile(input, source, target, options, `probe.${source}`);
      await withTimeout(run, RAW_SAMPLES.has(source) ? RAW_PROBE_TIMEOUT_MS : PROBE_TIMEOUT_MS);
      return { outcome: 'routed', detail: '' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isRoutingError(err)) return { outcome: 'unrouted', detail: message };
      lastError = message;
    }
  }
  return { outcome: 'inconclusive', detail: lastError };
}

function pairsFor(predicate: (category: string, target: string) => boolean): [string, string][] {
  const pairs: [string, string][] = [];
  for (const [source, def] of Object.entries(FORMAT_REGISTRY)) {
    for (const target of def.targetFormats) {
      if (predicate(def.category, target)) pairs.push([source, target]);
    }
  }
  return pairs;
}

const probeCache = new Map<string, Promise<{ outcome: PairOutcome; detail: string }>>();

function probePairCached(source: string, target: string): Promise<{ outcome: PairOutcome; detail: string }> {
  const key = `${source}->${target}`;
  let pending = probeCache.get(key);
  if (!pending) {
    pending = probePair(source, target);
    probeCache.set(key, pending);
  }
  return pending;
}

async function findUnroutedPairs(pairs: [string, string][]): Promise<string[]> {
  const unrouted: string[] = [];
  for (const [source, target] of pairs) {
    const { outcome, detail } = await probePairCached(source, target);
    if (outcome === 'unrouted') unrouted.push(`${source} -> ${target}: ${detail}`);
  }
  return unrouted;
}

async function findInconclusivePairs(pairs: [string, string][]): Promise<string[]> {
  const inconclusive: string[] = [];
  for (const [source, target] of pairs) {
    if ((await probePairCached(source, target)).outcome === 'inconclusive') inconclusive.push(`${source}->${target}`);
  }
  return inconclusive.sort();
}

/** Media pairs that reach FFmpeg are opt-in; every other advertised pair is always probed. */
function isTranscoderPair(category: string, target: string): boolean {
  return MEDIA_CATEGORIES.has(category) && FORMAT_REGISTRY[target].category !== 'archive';
}

const INCONCLUSIVE_ALLOWLIST: readonly string[] = JSON.parse(
  readFileSync(path.resolve(__dirname, 'registry-engine-conformance.inconclusive.json'), 'utf-8')
);

function hasBinary(name: string): boolean {
  try {
    execFileSync(name, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const HAS_FFMPEG = hasBinary('ffmpeg');

function onPath(name: string): boolean {
  try {
    execFileSync('which', [name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const TESSDATA_DIRS = [
  ...(process.env.TESSDATA_PREFIX ? [process.env.TESSDATA_PREFIX] : []),
  process.cwd(),
  '/usr/share/tesseract-ocr/5/tessdata',
  '/usr/share/tesseract-ocr/4.00/tessdata',
  '/usr/share/tessdata',
];
const HAS_OCR_DATA = TESSDATA_DIRS.some(
  (dir) => existsSync(path.join(dir, 'eng.traineddata')) || existsSync(path.join(dir, 'eng.traineddata.gz'))
);
/** Whether a pair is decidable depends on the native tools, so the ratchet needs the CI toolchain. */
const HAS_CI_TOOLCHAIN =
  HAS_FFMPEG && HAS_OCR_DATA && ['7z', 'soffice', 'pdftoppm', 'tesseract', 'dcraw_emu'].every(onPath);
const RUN_MEDIA_TRANSCODER_PAIRS = process.env.REGISTRY_CONFORMANCE_MEDIA === '1';

describe('routing-error classifier', () => {
  it('recognizes engine routing rejections and ignores input errors', async () => {
    const routing = await convertOffice(PLAIN_TEXT, 'pages', 'doc', {}, 'probe.pages').catch((e: unknown) => e);
    expect((routing as Error).message).toMatch(/^Unsupported office conversion from pages to doc$/);
    expect(isRoutingError(routing)).toBe(true);

    const pdfSeed = FIXTURES.get('pdf')![0];
    const encoder = await convertDocument(pdfSeed, 'pdf', 'svg', {}, 'probe.pdf').catch((e: unknown) => e);
    expect(encoder).toBeInstanceOf(UnsupportedTargetError);
    expect(isRoutingError(encoder)).toBe(true);

    const parse = await convertFile(PLAIN_TEXT, 'pdf', 'txt', {}, 'probe.pdf').catch((e: unknown) => e);
    expect((parse as Error).message).toMatch(/missing %PDF- header/);
    expect(isRoutingError(parse)).toBe(false);
  });

  it('flags non-media sources that the dispatcher would send to the media transcoder', () => {
    expect(isMediaTranscoderMisroute('pptx', 'swf')).toBe(true);
    expect(isMediaTranscoderMisroute('gif', 'mp3')).toBe(true);
    expect(isMediaTranscoderMisroute('gif', 'webm')).toBe(false);
    expect(isMediaTranscoderMisroute('mp4', 'mp3')).toBe(false);
    expect(isMediaTranscoderMisroute('mp3', 'zip')).toBe(false);
  });

  it('rejects pairs the registry does not advertise before any engine runs', async () => {
    await expect(convertFile(PLAIN_TEXT, 'txt', 'dwg', {}, 'probe.txt')).rejects.toThrow(
      /^Cannot convert from .+ \(\.txt\) to target format \.dwg\. Available targets: /
    );
  });
});

describe('withdrawn pairs stay withdrawn', () => {
  // Recorded list of pairs whose dispatch ended in an engine routing error when this gate was
  // introduced. Kept separately from the live probe so a
  // re-advertised pair fails here even if its probe input stops reaching the routing step.
  // Pairs that the dispatcher routes to a native engine moved to NATIVE_ENGINE_PAIRS.
  const WITHDRAWN: Readonly<Record<string, readonly string[]>> = {
    abw: ['doc', 'jpg', 'png', 'rtf'],
    ai: ['dxf', 'emf', 'svg', 'wmf'],
    azw: ['rtf'],
    azw3: ['docx', 'rtf'],
    bmp: ['svg'],
    cb7: ['cbz'],
    cbr: ['azw3', 'cbz', 'epub', 'lrf', 'mobi', 'oeb', 'pdb', 'pdf', 'rtf', 'txt'],
    cbt: ['cbz'],
    cbz: ['azw3', 'cbr', 'epub', 'lrf', 'mobi', 'oeb', 'pdb', 'rtf', 'txt'],
    cdr: ['emf', 'wmf'],
    cgm: ['dxf', 'emf', 'eps', 'pdf', 'png', 'ps', 'svg', 'wmf'],
    chm: ['azw3', 'epub', 'html', 'lrf', 'mobi', 'oeb', 'pdb', 'pdf', 'rtf', 'txt'],
    csv: ['jpg', 'png'],
    dbf: ['json', 'tsv'],
    dds: ['tga'],
    dif: ['json', 'tsv'],
    djvu: ['docx'],
    dmg: ['iso'],
    docm: ['doc', 'docx', 'jpg', 'odt', 'png', 'rtf'],
    docx: ['azw3', 'hwp', 'hwpx', 'lrf', 'mobi', 'oeb', 'pages', 'pdb', 'xps'],
    dot: ['doc', 'jpg', 'png', 'rtf'],
    dotx: ['doc', 'jpg', 'png', 'rtf'],
    dps: ['eps', 'jpg', 'md', 'png', 'ppt', 'swf'],
    dwf: ['cgm', 'dwg', 'wmf'],
    dwg: ['bmp', 'cgm', 'dwg', 'eps', 'gif', 'tiff', 'wmf'],
    dxf: ['bmp', 'cgm', 'dwg', 'eps', 'gif', 'tiff', 'wmf'],
    emf: ['avif', 'bmp', 'dxf', 'emf', 'eps', 'gif', 'ico', 'jpg', 'odd', 'pdf', 'png', 'ps', 'psd', 'svg', 'tiff', 'webp', 'wmf'],
    eps: ['emf', 'ico', 'odd', 'psd', 'wmf'],
    fb2: ['azw3', 'lrf', 'mobi', 'oeb', 'pdb', 'rtf'],
    fods: ['json'],
    gif: ['aac', 'aiff', 'flac', 'm4a', 'mp3', 'svg', 'wav', 'wma'],
    htm: ['doc', 'jpg', 'png', 'rtf'],
    html: ['doc', 'jpg', 'png', 'rtf', 'tex'],
    ibooks: ['epub', 'pdf', 'txt'],
    jpeg: ['svg'],
    jpg: ['svg'],
    key: ['doc', 'jpg', 'png', 'ppt', 'xls'],
    lit: ['azw3', 'epub', 'lrf', 'mobi', 'oeb', 'pdb', 'pdf', 'rtf', 'txt'],
    md: ['doc', 'jpg', 'png', 'rst', 'rtf', 'tex'],
    mobi: ['docx', 'rtf'],
    msg: ['eml'],
    numbers: ['doc', 'jpg', 'pdf', 'png', 'ppt', 'tsv'],
    odp: ['eps', 'md', 'swf'],
    odt: ['azw3', 'hwp', 'hwpx', 'lrf', 'mobi', 'oeb', 'pdb', 'xps'],
    oxps: ['docx'],
    pages: ['doc', 'docx', 'epub', 'html', 'jpg', 'pdf', 'png', 'ppt', 'txt'],
    pdb: ['rtf'],
    pdf: ['avif', 'bmp', 'doc', 'dxf', 'emf', 'eps', 'gif', 'ico', 'odd', 'ppt', 'ps', 'psd', 'webp', 'wmf'],
    png: ['svg'],
    pot: ['emf', 'jpg', 'png', 'ppt'],
    potx: ['emf', 'jpg', 'odp', 'png', 'ppt', 'xps'],
    pps: ['eps', 'jpg', 'md', 'png', 'ppt', 'swf'],
    ppsx: ['eps', 'jpg', 'md', 'png', 'ppt', 'swf'],
    ppt: ['emf', 'eps', 'md', 'swf', 'xps'],
    pptm: ['emf', 'eps', 'html', 'jpg', 'md', 'odp', 'pdf', 'png', 'ppt', 'pptx', 'swf', 'txt', 'xps'],
    pptx: ['emf', 'eps', 'key', 'md', 'swf', 'xps'],
    prc: ['azw3', 'epub', 'lrf', 'mobi', 'oeb', 'pdb', 'pdf', 'rtf', 'txt'],
    prn: ['tsv'],
    ps: ['emf', 'ico', 'odd', 'psd', 'wmf'],
    qpw: ['tsv'],
    rst: ['rtf'],
    sk: ['emf', 'wmf'],
    sk1: ['emf', 'wmf'],
    slk: ['tsv'],
    snb: ['azw3', 'epub', 'lrf', 'mobi', 'oeb', 'pdb', 'pdf', 'rtf', 'txt'],
    svg: ['ico', 'odd', 'psd'],
    svgz: ['ico', 'odd', 'psd'],
    tcr: ['azw3', 'epub', 'lrf', 'mobi', 'oeb', 'pdb', 'pdf', 'rtf', 'txt'],
    tif: ['svg'],
    tiff: ['svg'],
    txt: ['doc', 'jpg', 'png', 'rtf', 'tex'],
    vsd: ['emf', 'wmf'],
    webp: ['aac', 'aiff', 'flac', 'm4a', 'mp3', 'svg', 'wav', 'wma'],
    wk1: ['tsv'],
    wks: ['tsv'],
    wmf: ['dxf', 'emf', 'eps', 'pdf', 'png', 'ps', 'svg', 'wmf'],
    wpd: ['doc', 'jpg', 'png', 'rtf'],
    wps: ['doc', 'jpg', 'png', 'rtf'],
    xls: ['xps'],
    xlsm: ['jpg', 'json', 'png'],
    xlsx: ['numbers', 'xps'],
    xps: ['avif', 'bmp', 'docx', 'eps', 'gif', 'ico', 'jpg', 'odd', 'png', 'ps', 'psd', 'svg', 'tiff', 'webp'],
    yaml: ['xml'],
    yml: ['xml'],
    zabw: ['doc', 'jpg', 'png', 'rtf'],
  };

  it.each(Object.entries(WITHDRAWN))('%s advertises none of its withdrawn targets', (source, targets) => {
    const advertised = FORMAT_REGISTRY[source].targetFormats;
    expect(targets.filter((target) => advertised.includes(target))).toEqual([]);
  });
});

describe('every advertised registry pair has an engine path', () => {
  const categories = [...new Set(Object.values(FORMAT_REGISTRY).map((def) => def.category))].sort();

  for (const category of categories.filter((c) => !MEDIA_CATEGORIES.has(c))) {
    // Camera RAW sources decode real sensor data per pair, so each gets its own test below.
    it(`${category} sources`, async () => {
      const pairs = pairsFor((c) => c === category).filter(([source]) => !RAW_CHECKS_ENABLED || !RAW_SOURCE_SET.has(source));
      expect(await findUnroutedPairs(pairs)).toEqual([]);
    }, CATEGORY_TIMEOUT_MS);
  }

  // The probe still dispatches every pair through the real engine; only the grouping differs, so a
  // slow decode (3FR is 39 megapixels) cannot exhaust the timeout of the whole image category.
  it.skipIf(!RAW_CHECKS_ENABLED).each(RAW_SOURCES)(
    'camera RAW source %s',
    async (source) => {
      expect(await findUnroutedPairs(pairsFor(() => true).filter(([pairSource]) => pairSource === source))).toEqual([]);
    },
    RAW_SOURCE_TIMEOUT_MS
  );

  it('audio and video sources routed outside the media transcoder', async () => {
    const mediaPairs = pairsFor((c, target) => MEDIA_CATEGORIES.has(c) && FORMAT_REGISTRY[target].category === 'archive');
    expect(mediaPairs).toContainEqual(['mp3', 'zip']);
    expect(await findUnroutedPairs(mediaPairs)).toEqual([]);
  }, CATEGORY_TIMEOUT_MS);

  // The media transcoder hands every non-archive target to FFmpeg without a routing table, so
  // these pairs carry no routing signal and cost one FFmpeg spawn each. Opt in explicitly.
  it.skipIf(!HAS_FFMPEG || !RUN_MEDIA_TRANSCODER_PAIRS)(
    'audio and video sources routed through the media transcoder (REGISTRY_CONFORMANCE_MEDIA=1, needs ffmpeg)',
    async () => {
      const transcoderPairs = pairsFor(isTranscoderPair);
      expect(await findUnroutedPairs(transcoderPairs)).toEqual([]);
    },
    CATEGORY_TIMEOUT_MS
  );
});

describe('inconclusive pairs ratchet', () => {
  // Pairs whose every probe input is rejected before the engine's routing step. They are not
  // proven routable, so each one is listed explicitly; the list may only shrink.
  it('lists the allowlist sorted and without duplicates', () => {
    expect([...new Set(INCONCLUSIVE_ALLOWLIST)].sort()).toEqual(INCONCLUSIVE_ALLOWLIST);
  });

  it.skipIf(!HAS_CI_TOOLCHAIN || !RAW_CHECKS_ENABLED)('allows no new inconclusive pair and keeps no pair that became decidable (needs CI toolchain and RAW samples)', async () => {
    const inconclusive = await findInconclusivePairs(pairsFor((c, t) => !isTranscoderPair(c, t)));
    const allowed = new Set(INCONCLUSIVE_ALLOWLIST);
    const current = new Set(inconclusive);
    expect(inconclusive.filter((pair) => !allowed.has(pair))).toEqual([]);
    expect(INCONCLUSIVE_ALLOWLIST.filter((pair) => !current.has(pair))).toEqual([]);
  }, RATCHET_TIMEOUT_MS);
});

describe('real camera RAW samples', () => {
  const RAW_TIMEOUT_MS = 300_000;
  const SDR_TARGETS = ['avif', 'bmp', 'eps', 'gif', 'ico', 'jpg', 'odd', 'png', 'ps', 'psd', 'tiff', 'webp'];
  const HDR_TARGETS = ['exr', 'ultrahdr'];
  const PACKAGING_TARGETS = ['pdf', 'zip'];
  /** Every target a RAW source advertises needs a validator below; a new target must add one. */
  const VALIDATED_TARGETS = new Set([...SDR_TARGETS, ...HDR_TARGETS, ...PACKAGING_TARGETS]);
  /** Every advertised pair is checked: the real sample must convert to a valid file. */
  const rawPairs = RAW_SOURCES.flatMap((source) =>
    FORMAT_REGISTRY[source].targetFormats.map((target) => [source, target] as [string, string])
  );

  const MAX_PLAUSIBLE_SIDE = 20_000;
  const MAX_ICO_SIDE = 256;
  const ICO_DIR_ENTRY_BYTES = 16;
  const BMP_DIB_MIN_BYTES = 40;
  const PSD_HEIGHT_OFFSET = 14;
  const PSD_WIDTH_OFFSET = 18;
  const PSD_DEPTH_OFFSET = 22;
  const BYTE_DEPTH_8 = 8;
  const EXR_MAGIC = Buffer.from([0x76, 0x2f, 0x31, 0x01]);
  const EXR_FIRST_ATTRIBUTE_OFFSET = 8;
  const EXR_BOX2I_BYTES = 16;
  const ODG_MIMETYPE = 'application/vnd.oasis.opendocument.graphics';
  const SHARP_FORMATS: Readonly<Record<string, string>> = { jpg: 'jpeg', png: 'png', tiff: 'tiff', webp: 'webp', avif: 'heif', gif: 'gif', ultrahdr: 'jpeg' };
  const JPEG_START = Buffer.from([0xff, 0xd8, 0xff]);
  const PDF_MAGIC = '%PDF-';
  const ASPECT_TOLERANCE = 0.01;

  interface Dimensions {
    width: number;
    height: number;
  }

  function expectPlausible({ width, height }: Dimensions): void {
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
    expect(width).toBeLessThanOrEqual(MAX_PLAUSIBLE_SIDE);
    expect(height).toBeLessThanOrEqual(MAX_PLAUSIBLE_SIDE);
  }

  /** Reads the dataWindow box2i from the EXR header attribute list. */
  function exrDimensions(buffer: Buffer): Dimensions {
    let offset = EXR_FIRST_ATTRIBUTE_OFFSET;
    while (buffer[offset] !== 0) {
      const nameEnd = buffer.indexOf(0, offset);
      const typeEnd = buffer.indexOf(0, nameEnd + 1);
      const name = buffer.toString('latin1', offset, nameEnd);
      const size = buffer.readUInt32LE(typeEnd + 1);
      const valueStart = typeEnd + 5;
      if (name === 'dataWindow') {
        expect(size).toBe(EXR_BOX2I_BYTES);
        const [xMin, yMin, xMax, yMax] = [0, 4, 8, 12].map((delta) => buffer.readInt32LE(valueStart + delta));
        return { width: xMax - xMin + 1, height: yMax - yMin + 1 };
      }
      offset = valueStart + size;
    }
    throw new Error('EXR header has no dataWindow attribute');
  }

  async function decodedDimensions(buffer: Buffer, format: string): Promise<Dimensions> {
    const meta = await sharp(buffer).metadata();
    expect(meta.format).toBe(SHARP_FORMATS[format]);
    return { width: meta.width ?? 0, height: meta.height ?? 0 };
  }

  /** Output must carry real image content: a uniform raster would pass every header check. */
  async function expectNonUniform(buffer: Buffer): Promise<void> {
    const { channels } = await sharp(buffer).stats();
    expect(Math.max(...channels.map((c) => c.stdev))).toBeGreaterThan(0);
  }

  const RAW_IDENTIFY = getOracleToolPath('raw-identify');
  const OUTPUT_SIZE_PATTERN = /Output size:\s+(\d+) x (\d+)/;
  const rawSamplePath = (source: string) => path.join(RAW_FIXTURE_DIR, '.cache', `${source}.${source}`);

  /** Frame size declared by the container of an in-process source, from the independent parsers. */
  function declaredFrameSize(source: string, bytes: Buffer): Dimensions {
    const info = source === 'x3f' ? readX3fContainer(bytes) : readPiFrame(bytes);
    return { width: info.declaredWidth, height: info.declaredHeight };
  }

  const referenceCache = new Map<string, Promise<Dimensions>>();
  /**
   * Expected size of the decoded image: the output size LibRaw's own identify tool reports; for the
   * in-process sources, the frame size the file's container declares (read by an independent parser);
   * without the tool, the size of the dispatcher's PNG, which the sharp decode of that PNG reports independently.
   */
  function referenceDimensions(source: string): Promise<Dimensions> {
    let pending = referenceCache.get(source);
    if (!pending) {
      pending = resolveReferenceDimensions(source);
      referenceCache.set(source, pending);
    }
    return pending;
  }

  async function resolveReferenceDimensions(source: string): Promise<Dimensions> {
    if (IN_PROCESS_RAW_SOURCES.has(source)) return declaredFrameSize(source, RAW_SAMPLES.get(source)!);
    if (HAS_NATIVE_RAW_ENGINE && RAW_IDENTIFY) {
      const match = OUTPUT_SIZE_PATTERN.exec(execFileSync(RAW_IDENTIFY, ['-v', rawSamplePath(source)], { encoding: 'utf-8' }));
      if (!match) throw new Error(`raw-identify reported no output size for ${source}`);
      return { width: Number(match[1]), height: Number(match[2]) };
    }
    const decoded = await dispatchConversion(RAW_SAMPLES.get(source)!, source, 'png', rawSampleOptions(source), `probe.${source}`);
    return decodedDimensions(decoded.buffer, 'png');
  }

  async function expectValidOutput(buffer: Buffer, target: string, reference: Dimensions, sourceBytes: Buffer): Promise<void> {
    expect(buffer.length).toBeGreaterThan(0);
    if (SHARP_FORMATS[target]) {
      const dims = await decodedDimensions(buffer, target);
      expectPlausible(dims);
      expect(dims).toEqual(reference);
      await expectNonUniform(buffer);
      if (target === 'ultrahdr') {
        // A gain-map JPEG: primary image plus a second embedded JPEG, announced by XMP and an MPF index.
        expect(buffer.toString('latin1')).toContain('hdrgm');
        expect(buffer.includes(Buffer.from('MPF\0', 'latin1'))).toBe(true);
        expect(buffer.indexOf(JPEG_START, JPEG_START.length)).toBeGreaterThan(0);
      }
      return;
    }
    if (target === 'bmp') {
      expect(buffer.subarray(0, 2).toString('latin1')).toBe('BM');
      expect(buffer.readUInt32LE(14)).toBeGreaterThanOrEqual(BMP_DIB_MIN_BYTES);
      const dims = { width: buffer.readInt32LE(18), height: Math.abs(buffer.readInt32LE(22)) };
      expectPlausible(dims);
      expect(dims).toEqual(reference);
      expect(buffer.length).toBeGreaterThanOrEqual(buffer.readUInt32LE(10) + dims.width * dims.height);
      return;
    }
    if (target === 'ico') {
      expect([buffer.readUInt16LE(0), buffer.readUInt16LE(2)]).toEqual([0, 1]);
      const count = buffer.readUInt16LE(4);
      expect(count).toBeGreaterThan(0);
      for (let index = 0; index < count; index += 1) {
        const entry = 6 + index * ICO_DIR_ENTRY_BYTES;
        // A zero width or height byte encodes 256 in the ICO directory.
        const entryWidth = buffer[entry] || MAX_ICO_SIDE;
        const entryHeight = buffer[entry + 1] || MAX_ICO_SIDE;
        const image = buffer.subarray(buffer.readUInt32LE(entry + 12), buffer.readUInt32LE(entry + 12) + buffer.readUInt32LE(entry + 8));
        expect(image.length).toBe(buffer.readUInt32LE(entry + 8));
        const embedded = await decodedDimensions(image, 'png');
        expect(embedded).toEqual({ width: entryWidth, height: entryHeight });
      }
      return;
    }
    if (target === 'psd') {
      expect(buffer.subarray(0, 4).toString('latin1')).toBe('8BPS');
      expect(buffer.readUInt16BE(4)).toBe(1);
      const dims = { width: buffer.readUInt32BE(PSD_WIDTH_OFFSET), height: buffer.readUInt32BE(PSD_HEIGHT_OFFSET) };
      expectPlausible(dims);
      expect(dims).toEqual(reference);
      expect(buffer.readUInt16BE(PSD_DEPTH_OFFSET)).toBe(BYTE_DEPTH_8);
      return;
    }
    if (target === 'eps' || target === 'ps') {
      const text = buffer.toString('latin1');
      expect(text.startsWith(target === 'eps' ? '%!PS-Adobe-3.0 EPSF-3.0' : '%!PS-Adobe-3.0')).toBe(true);
      const box = /^%%BoundingBox: 0 0 (\d+) (\d+)$/m.exec(text);
      expect(box).not.toBeNull();
      expect({ width: Number(box![1]), height: Number(box![2]) }).toEqual(reference);
      expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
      return;
    }
    if (target === 'exr') {
      expect(buffer.subarray(0, EXR_MAGIC.length).equals(EXR_MAGIC)).toBe(true);
      const dims = exrDimensions(buffer);
      expectPlausible(dims);
      expect(dims).toEqual(reference);
      return;
    }
    if (target === 'pdf') {
      expect(buffer.subarray(0, PDF_MAGIC.length).toString('latin1')).toBe(PDF_MAGIC);
      const pdf = await PDFDocument.load(buffer);
      expect(pdf.getPageCount()).toBe(1);
      const { width, height } = pdf.getPage(0).getSize();
      expect(Math.abs(width / height - reference.width / reference.height)).toBeLessThan(ASPECT_TOLERANCE);
      return;
    }
    if (target === 'zip') {
      const zip = await JSZip.loadAsync(buffer);
      const entries = Object.values(zip.files).filter((entry) => !entry.dir);
      expect(entries).toHaveLength(1);
      expect((await entries[0].async('nodebuffer')).equals(sourceBytes)).toBe(true);
      return;
    }
    // odd: an OpenDocument graphics package whose page frame references the embedded picture.
    const zip = await JSZip.loadAsync(buffer);
    expect(await zip.file('mimetype')?.async('string')).toBe(ODG_MIMETYPE);
    const content = await zip.file('content.xml')!.async('string');
    const href = /<draw:frame[^>]*>\s*<draw:image[^>]*xlink:href="([^"]+)"/.exec(content);
    expect(href).not.toBeNull();
    const picture = await zip.file(href![1])!.async('nodebuffer');
    expect(await decodedDimensions(picture, 'png')).toEqual(reference);
    expect(await zip.file('META-INF/manifest.xml')!.async('string')).toContain(`manifest:full-path="${href![1]}"`);
  }

  it.skipIf(!RAW_CHECKS_ENABLED)('has an intact sample for every RAW source', () => {
    if (RAW_SAMPLES_MISSING.length > 0) {
      throw new OracleToolMissingError(
        'raw-fixtures',
        `RAW samples missing for: ${RAW_SAMPLES_MISSING.join(', ')}. Run npm run fixtures:raw.`
      );
    }
    expect(RAW_MANIFEST.map((entry) => entry.format).sort()).toEqual(RAW_SOURCES);
    expect([...RAW_SAMPLES.keys()].sort()).toEqual(RAW_SOURCES);
  });

  it.skipIf(!RAW_CHECKS_ENABLED)('has an intact sample for every RAW sensor variant', () => {
    expect(RAW_VARIANT_MANIFEST.length).toBeGreaterThanOrEqual(MIN_VARIANT_SAMPLES);
    expect(RAW_SAMPLES_MISSING).toEqual([]);
    expect([...RAW_VARIANT_SAMPLES.keys()].sort()).toEqual(RAW_VARIANT_MANIFEST.map((entry) => `${entry.format}-${entry.variant}`).sort());
  });

  it('has a validator for every target the RAW sources advertise', () => {
    expect(rawPairs.filter(([, target]) => !VALIDATED_TARGETS.has(target))).toEqual([]);
  });

  it.skipIf(!RAW_CHECKS_ENABLED).each(rawPairs)(
    '%s -> %s converts the real sample to a valid file',
    async (source, target) => {
      if (!RAW_SAMPLES.has(source)) {
        throw new OracleToolMissingError('raw-fixtures', `RAW sample for ${source} is missing. Run npm run fixtures:raw.`);
      }
      const sample = RAW_SAMPLES.get(source)!;
      const result = await dispatchConversion(sample, source, target, rawSampleOptions(source), `probe.${source}`);
      if (IN_PROCESS_RAW_SOURCES.has(source) && target !== 'zip') {
        expect(result.engineUsed).toBe('in-process-raw');
      } else if (HAS_NATIVE_RAW_ENGINE && target !== 'zip') {
        expect(result.engineUsed).toBe('native-raw');
      }
      expectPlausible(await referenceDimensions(source));
      await expectValidOutput(result.buffer, target, await referenceDimensions(source), sample);
    },
    RAW_TIMEOUT_MS
  );

  const VARIANT_TIMEOUT_MS = 600_000;
  const MIN_VARIANT_SAMPLES = 5;
  /** Sigma SD14, Merrill and Quattro generations, Raspberry Pi imx219 and imx477. */
  const variantPairs = RAW_VARIANT_MANIFEST.flatMap((entry) =>
    FORMAT_REGISTRY[entry.format].targetFormats.map((target) => [`${entry.format}-${entry.variant}`, target] as [string, string])
  );

  it.skipIf(!RAW_CHECKS_ENABLED).each(variantPairs)(
    '%s -> %s converts the real sample to a valid file',
    async (name, target) => {
      const sample = RAW_VARIANT_SAMPLES.get(name);
      if (!sample) throw new OracleToolMissingError('raw-fixtures', `RAW sample ${name} is missing. Run npm run fixtures:raw.`);
      const source = name.split('-')[0];
      const result = await dispatchConversion(sample, source, target, {}, `probe.${source}`);
      if (target !== 'zip') expect(result.engineUsed).toBe('in-process-raw');
      const declared = source === 'x3f' ? readX3fContainer(sample) : readPiFrame(sample);
      const reference = { width: declared.declaredWidth, height: declared.declaredHeight };
      expectPlausible(reference);
      await expectValidOutput(result.buffer, target, reference, sample);
    },
    VARIANT_TIMEOUT_MS
  );
});

describe('native-engine pairs route through the dispatcher', () => {
  const NATIVE_TIMEOUT_MS = 120_000;
  const OFFICE_DOC_TEXT = 'deterministic regression fixture text';
  const OLE_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const JPEG_SOI = Buffer.from([0xff, 0xd8, 0xff]);
  const OLE_SECTOR_BYTES = 512;
  const DARK_CHANNEL_MAX = 128;
  /** The CFB stream that holds the main body of a Word or PowerPoint binary file. */
  const OLE_BODY_STREAM: Readonly<Record<string, string>> = { doc: 'WordDocument', ppt: 'PowerPoint Document' };
  const ODF_MIMETYPE: Readonly<Record<string, string>> = { odp: 'application/vnd.oasis.opendocument.presentation' };
  const IMAGE_TARGETS = new Set(['jpg', 'png']);
  const PDF_SOURCE = 'pdf';
  const SVG_TARGET = 'svg';
  /** Resolution requested from the PDF rasterizer, and the PostScript points per inch of PDF page sizes. */
  const PDF_RASTER_DPI = 100;
  const POINTS_PER_INCH = 72;
  /** Mean absolute 8-bit difference allowed between two independent rasterizers of the same page. */
  const RENDERER_MEAN_DIFF_MAX = 12;

  const pairs = Object.entries(NATIVE_ENGINE_PAIRS).flatMap(([source, targets]) =>
    targets.map((target) => [source, target] as [string, string])
  );
  const officeToOffice = pairs.filter(([source, target]) => source !== PDF_SOURCE && !IMAGE_TARGETS.has(target));
  const officeToImage = pairs.filter(([source, target]) => source !== PDF_SOURCE && IMAGE_TARGETS.has(target));
  const pdfToSvg = pairs.filter(([source, target]) => source === PDF_SOURCE && target === SVG_TARGET);
  const pdfToImage = pairs.filter(([source, target]) => source === PDF_SOURCE && target !== SVG_TARGET);

  /** Native engine (and the environment variable that points to it) that converts a pair. */
  function engineOf(source: string, target: string): { envVar: string; engineName: string } {
    if (source !== PDF_SOURCE) return { envVar: 'SOFFICE_PATH', engineName: 'soffice' };
    if (target === SVG_TARGET) return { envVar: 'PDFTOCAIRO_PATH', engineName: 'pdftocairo' };
    return { envVar: 'PDFTOPPM_PATH', engineName: 'pdftoppm' };
  }

  const fixture = (rel: string) => readFileSync(path.join(FIXTURE_ROOT, rel));
  const SEEDS: Readonly<Record<string, string>> = {
    docx: 'sample.docx',
    xlsx: 'golden/office/multi-sheet-enterprise.xlsx',
    ods: 'golden/office/multi-sheet-enterprise.ods',
    pptx: 'golden/office/drawingml-shapes-presentation.pptx',
    pdf: 'sample.pdf',
  };
  /** Sources without a fixture, converted from a seed by the LibreOffice CLI itself. */
  const DERIVED_FROM: Readonly<Record<string, string>> = { doc: 'docx', rtf: 'docx', odt: 'docx', xls: 'xlsx', ppt: 'pptx', odp: 'pptx' };

  /** Converts with the soffice CLI directly, outside the engines under test. */
  function sofficeConvert(input: Buffer, from: string, to: string): Buffer {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'native-pair-seed-'));
    try {
      writeFileSync(path.join(dir, `seed.${from}`), input);
      execFileSync('soffice', ['--headless', `-env:UserInstallation=file://${dir}/profile`, '--convert-to', to, '--outdir', dir, path.join(dir, `seed.${from}`)], {
        stdio: 'ignore',
        env: { ...process.env, HOME: dir },
        timeout: NATIVE_TIMEOUT_MS,
      });
      return readFileSync(path.join(dir, `seed.${to}`));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const realInputs = new Map<string, Buffer>();
  function realInput(source: string): Buffer {
    let input = realInputs.get(source);
    if (!input) {
      const from = DERIVED_FROM[source];
      input = from ? sofficeConvert(fixture(SEEDS[from]), from, source) : fixture(SEEDS[source]);
      realInputs.set(source, input);
    }
    return input;
  }

  async function headerOnlyOdf(mimetype: string): Promise<Buffer> {
    const zip = new JSZip();
    zip.file('mimetype', mimetype, { compression: 'STORE' });
    zip.file('content.xml', '<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"/>');
    return zip.generateAsync({ type: 'nodebuffer' });
  }

  /** Input that passes the magic-byte check; the missing engine rejects it before any parsing. */
  async function missingEngineInput(source: string): Promise<Buffer> {
    if (SEEDS[source]) return fixture(SEEDS[source]);
    if (source === 'rtf') return Buffer.from('{\\rtf1\\ansi Probe paragraph.\\par}', 'latin1');
    if (source === 'odt') return headerOnlyOdf('application/vnd.oasis.opendocument.text');
    if (source === 'odp') return headerOnlyOdf(ODF_MIMETYPE.odp);
    return Buffer.concat([OLE_SIGNATURE, Buffer.alloc(OLE_SECTOR_BYTES - OLE_SIGNATURE.length)]);
  }

  async function expectPageImage(buffer: Buffer, target: string): Promise<void> {
    const signature = target === 'png' ? PNG_SIGNATURE : JPEG_SOI;
    expect(buffer.subarray(0, signature.length).equals(signature)).toBe(true);
    const meta = await sharp(buffer).metadata();
    expect(meta.format).toBe(target === 'png' ? 'png' : 'jpeg');
    const { channels } = await sharp(buffer).stats();
    expect(Math.min(...channels.map((c) => c.min))).toBeLessThan(DARK_CHANNEL_MAX);
  }

  async function expectOfficeDocument(buffer: Buffer, target: string): Promise<void> {
    if (target === 'rtf') {
      expect(buffer.subarray(0, 6).toString('latin1')).toBe('{\\rtf1');
      expect(buffer.toString('latin1').replace(/\s+/g, ' ')).toContain(OFFICE_DOC_TEXT);
      return;
    }
    if (OLE_BODY_STREAM[target]) {
      expect(buffer.subarray(0, OLE_SIGNATURE.length).equals(OLE_SIGNATURE)).toBe(true);
      expect(buffer.includes(Buffer.from(OLE_BODY_STREAM[target], 'utf16le'))).toBe(true);
      return;
    }
    const zip = await JSZip.loadAsync(buffer);
    expect(await zip.file('mimetype')?.async('string')).toBe(ODF_MIMETYPE[target]);
    expect(zip.file('content.xml')).not.toBeNull();
  }

  it('lists only pairs the registry advertises', () => {
    expect(pairs.filter(([source, target]) => !FORMAT_REGISTRY[source].targetFormats.includes(target))).toEqual([]);
  });

  it.each(pairs)('%s -> %s fails with EngineUnavailableError when its engine is missing', async (source, target) => {
    const { envVar, engineName } = engineOf(source, target);
    const input = await missingEngineInput(source);
    const run = withMissingBinary(envVar, () => dispatchConversion(input, source, target, {}, `probe.${source}`));
    await expect(run).rejects.toBeInstanceOf(EngineUnavailableError);
    await expect(run).rejects.toMatchObject({ engineName });
  });

  it.skipIf(!HAS_SOFFICE).each(officeToOffice)(
    '%s -> %s converts with LibreOffice (needs soffice)',
    async (source, target) => {
      const result = await dispatchConversion(realInput(source), source, target, {}, `probe.${source}`);
      expect(result.engineUsed).toMatch(/^native-soffice/);
      await expectOfficeDocument(result.buffer, target);
    },
    NATIVE_TIMEOUT_MS
  );

  it.skipIf(!HAS_SOFFICE || !HAS_PDFTOPPM).each(officeToImage)(
    '%s -> %s renders with LibreOffice and Poppler (needs soffice, pdftoppm)',
    async (source, target) => {
      const result = await dispatchConversion(realInput(source), source, target, { multiPageOutput: 'first' }, `probe.${source}`);
      expect(result.engineUsed).toBe('native-poppler');
      await expectPageImage(result.buffer, target);
    },
    NATIVE_TIMEOUT_MS
  );

  /** Page size in pixels at `dpi`, from the page size in points that pdfinfo reports. */
  function pdfinfoPagePixels(pdf: Buffer, dpi: number): { width: number; height: number } {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'pdf-raster-oracle-'));
    try {
      const file = path.join(dir, 'page.pdf');
      writeFileSync(file, pdf);
      const info = execFileSync('pdfinfo', [file], { encoding: 'utf-8' });
      const size = /Page size:\s+([\d.]+) x ([\d.]+) pts/.exec(info);
      if (!size) throw new Error(`pdfinfo reported no page size: ${info}`);
      return { width: (Number(size[1]) * dpi) / POINTS_PER_INCH, height: (Number(size[2]) * dpi) / POINTS_PER_INCH };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Renders the first page with pdftocairo, a rasterizer separate from the pdftoppm engine under test. */
  function cairoRender(pdf: Buffer, dpi: number): Buffer {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'pdf-cairo-oracle-'));
    try {
      writeFileSync(path.join(dir, 'page.pdf'), pdf);
      execFileSync('pdftocairo', ['-png', '-r', String(dpi), '-f', '1', '-l', '1', '-singlefile', path.join(dir, 'page.pdf'), path.join(dir, 'oracle')]);
      return readFileSync(path.join(dir, 'oracle.png'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it.skipIf(!HAS_PDFTOPPM || !HAS_PDFTOCAIRO || !HAS_PDFINFO).each(pdfToImage)(
    '%s -> %s renders the page with Poppler (needs pdftoppm, pdftocairo, pdfinfo)',
    async (source, target) => {
      const pdf = realInput(source);
      const result = await dispatchConversion(pdf, source, target, { dpi: PDF_RASTER_DPI, multiPageOutput: 'first' }, `probe.${source}`);
      expect(result.engineUsed).toBe('native-poppler');
      const meta = await sharp(result.buffer).metadata();
      expect(meta.format).toBe(target === 'jpg' ? 'jpeg' : target);
      const { width, height } = meta;
      if (width === undefined || height === undefined) throw new Error(`the ${target} render reports no dimensions`);
      const expected = pdfinfoPagePixels(pdf, PDF_RASTER_DPI);
      expect(Math.abs(width - expected.width)).toBeLessThanOrEqual(1);
      expect(Math.abs(height - expected.height)).toBeLessThanOrEqual(1);
      // Same page from an independent rasterizer: the two renders must agree pixel for pixel on average.
      const oracleRender = cairoRender(pdf, PDF_RASTER_DPI);
      const oracleMeta = await sharp(oracleRender).metadata();
      expect(Math.abs((oracleMeta.width ?? 0) - expected.width)).toBeLessThanOrEqual(1);
      expect(Math.abs((oracleMeta.height ?? 0) - expected.height)).toBeLessThanOrEqual(1);
      const size = { width, height };
      const rendered = await sharp(result.buffer).removeAlpha().resize(size).raw().toBuffer();
      const oracle = await sharp(oracleRender).removeAlpha().resize({ ...size, fit: 'fill' }).raw().toBuffer();
      let total = 0;
      for (let i = 0; i < rendered.length; i += 1) total += Math.abs(rendered[i] - oracle[i]);
      expect(total / rendered.length).toBeLessThan(RENDERER_MEAN_DIFF_MAX);
      const { channels } = await sharp(result.buffer).stats();
      expect(Math.min(...channels.map((c) => c.min))).toBeLessThan(DARK_CHANNEL_MAX);
    },
    NATIVE_TIMEOUT_MS
  );

  it.skipIf(!HAS_PDFTOCAIRO).each(pdfToSvg)(
    '%s -> %s renders with Poppler (needs pdftocairo)',
    async (source, target) => {
      const result = await dispatchConversion(realInput(source), source, target, {}, `probe.${source}`);
      expect(result.engineUsed).toBe('native-poppler');
      const svg = result.buffer.toString('utf-8');
      expect(svg).toMatch(/<svg[^>]+xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
      expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
    },
    NATIVE_TIMEOUT_MS
  );
});
