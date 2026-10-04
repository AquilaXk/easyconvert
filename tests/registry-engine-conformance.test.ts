import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import JSZip from 'jszip';
import sharp from 'sharp';
import { FORMAT_REGISTRY } from '../src/lib/registry';
import { convertFile } from '../src/lib/conversions';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { convertOffice } from '../src/lib/conversions/office';
import { convertDocument } from '../src/lib/conversions/document';
import { compressXz, create7zArchive } from '../src/lib/conversions/archive';
import { EngineUnavailableError, UnsupportedTargetError } from '../src/lib/types';
import { HAS_PDFTOCAIRO, HAS_PDFTOPPM, HAS_SOFFICE, withMissingBinary } from './helpers/native-tools';

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
const CATEGORY_TIMEOUT_MS = 600_000;
const MEDIA_CATEGORIES = new Set(['audio', 'video']);
const FIXTURE_ROOT = path.resolve(__dirname, 'fixtures');
const FIXTURE_SKIP_DIRS = new Set(['sigv4']);
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
};

async function requireDerived(format: string): Promise<Buffer> {
  const derived = await deriveProbeInput(format);
  if (!derived) throw new Error(`no probe input could be derived for .${format}`);
  return derived;
}

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('probe timed out')), PROBE_TIMEOUT_MS);
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
 * and Poppler pdftocairo for pdf->svg. Authored by hand from the native tools' capabilities.
 */
const NATIVE_ENGINE_PAIRS: Readonly<Record<string, readonly string[]>> = {
  doc: ['jpg', 'png', 'rtf'],
  docx: ['doc', 'jpg', 'png', 'rtf'],
  odp: ['jpg', 'png', 'ppt'],
  ods: ['jpg', 'png'],
  odt: ['doc', 'jpg', 'png', 'rtf'],
  pdf: ['svg'],
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
  for (const input of await probeInputs(source)) {
    try {
      await withTimeout(convertFile(input, source, target, {}, `probe.${source}`));
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
  HAS_FFMPEG && HAS_OCR_DATA && ['7z', 'soffice', 'pdftoppm', 'tesseract'].every(onPath);
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
    it(`${category} sources`, async () => {
      expect(await findUnroutedPairs(pairsFor((c) => c === category))).toEqual([]);
    }, CATEGORY_TIMEOUT_MS);
  }

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

  it.skipIf(!HAS_CI_TOOLCHAIN)('allows no new inconclusive pair and keeps no pair that became decidable (needs CI toolchain)', async () => {
    const inconclusive = await findInconclusivePairs(pairsFor((c, t) => !isTranscoderPair(c, t)));
    const allowed = new Set(INCONCLUSIVE_ALLOWLIST);
    const current = new Set(inconclusive);
    expect(inconclusive.filter((pair) => !allowed.has(pair))).toEqual([]);
    expect(INCONCLUSIVE_ALLOWLIST.filter((pair) => !current.has(pair))).toEqual([]);
  }, CATEGORY_TIMEOUT_MS);
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
  const POPPLER_SVG_SOURCE = 'pdf';

  const pairs = Object.entries(NATIVE_ENGINE_PAIRS).flatMap(([source, targets]) =>
    targets.map((target) => [source, target] as [string, string])
  );
  const officeToOffice = pairs.filter(([source, target]) => source !== POPPLER_SVG_SOURCE && !IMAGE_TARGETS.has(target));
  const officeToImage = pairs.filter(([source, target]) => source !== POPPLER_SVG_SOURCE && IMAGE_TARGETS.has(target));
  const pdfToSvg = pairs.filter(([source]) => source === POPPLER_SVG_SOURCE);

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
    const envVar = source === POPPLER_SVG_SOURCE ? 'PDFTOCAIRO_PATH' : 'SOFFICE_PATH';
    const engineName = source === POPPLER_SVG_SOURCE ? 'pdftocairo' : 'soffice';
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
