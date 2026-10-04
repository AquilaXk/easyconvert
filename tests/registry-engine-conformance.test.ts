import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { FORMAT_REGISTRY } from '../src/lib/registry';
import { convertFile } from '../src/lib/conversions';
import { convertOffice } from '../src/lib/conversions/office';
import { convertVectorCad } from '../src/lib/conversions/vector-cad';
import { UnsupportedTargetError } from '../src/lib/types';

/**
 * Registry/engine conformance gate.
 *
 * Every source -> target pair advertised by FORMAT_REGISTRY must reach a real engine path.
 * Each pair is dispatched through convertFile with small probe inputs; a pair fails only when
 * the engine rejects it with a routing error ("no code path for this pair"). Parse errors,
 * missing native tools, and other input-dependent failures do not count either way.
 *
 * The sync convert API, batch API and graph executor call convertFile in-process, so a native
 * route that exists only in the OCI worker does not make a pair routable.
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
const DXF_SEED = FIXTURES.get('dxf')![0];
const VECTOR_PROBE_CATEGORIES = new Set(['image', 'vector', 'cad']);

/** Seed formats used to derive a structurally valid probe input for a source format. */
const DERIVATION_SEEDS: readonly { format: string; buffer: Buffer }[] = [
  { format: 'txt', buffer: PLAIN_TEXT },
  { format: 'md', buffer: PLAIN_TEXT },
  { format: 'csv', buffer: CSV_TEXT },
  { format: 'svg', buffer: SVG_TEXT },
  { format: 'png', buffer: PNG_SEED },
];

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
  const derived = await deriveProbeInput(source);
  if (derived) inputs.push(derived);
  const category = FORMAT_REGISTRY[source].category;
  if (category === 'image') inputs.push(PNG_SEED);
  // Vector and CAD readers without a native decoder accept embedded SVG or ASCII DXF entities.
  if (VECTOR_PROBE_CATEGORIES.has(category)) inputs.push(SVG_TEXT, DXF_SEED);
  inputs.push(PLAIN_TEXT);
  return inputs;
}

type PairOutcome = 'routed' | 'unrouted' | 'inconclusive';

async function probePair(source: string, target: string): Promise<{ outcome: PairOutcome; detail: string }> {
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

async function findUnroutedPairs(pairs: [string, string][]): Promise<string[]> {
  const unrouted: string[] = [];
  let inconclusive = 0;
  for (const [source, target] of pairs) {
    const { outcome, detail } = await probePair(source, target);
    if (outcome === 'unrouted') unrouted.push(`${source} -> ${target}: ${detail}`);
    if (outcome === 'inconclusive') inconclusive += 1;
  }
  if (inconclusive > 0) {
    console.info(`[registry-conformance] ${inconclusive}/${pairs.length} pairs inconclusive (input rejected before routing)`);
  }
  return unrouted;
}

function hasBinary(name: string): boolean {
  try {
    execFileSync(name, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const HAS_FFMPEG = hasBinary('ffmpeg');
const RUN_MEDIA_TRANSCODER_PAIRS = process.env.REGISTRY_CONFORMANCE_MEDIA === '1';

describe('routing-error classifier', () => {
  it('recognizes engine routing rejections and ignores input errors', async () => {
    const routing = await convertOffice(PLAIN_TEXT, 'pages', 'doc', {}, 'probe.pages').catch((e: unknown) => e);
    expect((routing as Error).message).toMatch(/^Unsupported office conversion from pages to doc$/);
    expect(isRoutingError(routing)).toBe(true);

    const encoder = await convertVectorCad(SVG_TEXT, 'svg', 'emf', {}, 'probe.svg').catch((e: unknown) => e);
    expect(encoder).toBeInstanceOf(UnsupportedTargetError);
    expect(isRoutingError(encoder)).toBe(true);

    const parse = await convertFile(PLAIN_TEXT, 'pdf', 'txt', {}, 'probe.pdf').catch((e: unknown) => e);
    expect((parse as Error).message).toMatch(/missing %PDF- header/);
    expect(isRoutingError(parse)).toBe(false);
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
  const WITHDRAWN: Readonly<Record<string, readonly string[]>> = {
    abw: ['doc', 'jpg', 'png', 'rtf'],
    ai: ['dxf', 'emf', 'svg', 'wmf'],
    azw: ['rtf'],
    azw3: ['docx', 'rtf'],
    bmp: ['svg'],
    cb7: ['cbz'],
    cbr: ['azw3', 'cbz', 'epub', 'lrf', 'mobi', 'oeb', 'pdb', 'pdf', 'rtf', 'txt'],
    cbt: ['cbz'],
    cdr: ['emf', 'wmf'],
    cgm: ['emf', 'wmf'],
    chm: ['azw3', 'epub', 'html', 'lrf', 'mobi', 'oeb', 'pdb', 'pdf', 'rtf', 'txt'],
    csv: ['jpg', 'png'],
    dbf: ['json', 'tsv'],
    dds: ['tga'],
    dif: ['json', 'tsv'],
    djvu: ['docx'],
    dmg: ['iso'],
    doc: ['jpg', 'png', 'rtf'],
    docm: ['doc', 'docx', 'jpg', 'odt', 'png', 'rtf'],
    docx: ['azw3', 'doc', 'hwp', 'hwpx', 'jpg', 'lrf', 'mobi', 'oeb', 'pages', 'pdb', 'png', 'rtf', 'xps'],
    dot: ['doc', 'jpg', 'png', 'rtf'],
    dotx: ['doc', 'jpg', 'png', 'rtf'],
    dps: ['eps', 'jpg', 'md', 'png', 'ppt'],
    dwf: ['cgm', 'dwg', 'wmf'],
    dwg: ['bmp', 'cgm', 'dwg', 'eps', 'gif', 'tiff', 'wmf'],
    dxf: ['bmp', 'cgm', 'dwg', 'eps', 'gif', 'tiff', 'wmf'],
    emf: ['emf', 'ico', 'odd', 'psd', 'wmf'],
    eps: ['emf', 'ico', 'odd', 'psd', 'wmf'],
    fb2: ['azw3', 'lrf', 'mobi', 'oeb', 'pdb', 'rtf'],
    fods: ['json'],
    gif: ['svg'],
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
    odp: ['eps', 'jpg', 'md', 'png', 'ppt'],
    ods: ['jpg', 'png'],
    odt: ['azw3', 'doc', 'hwp', 'hwpx', 'jpg', 'lrf', 'mobi', 'oeb', 'pdb', 'png', 'rtf', 'xps'],
    oxps: ['docx'],
    pages: ['doc', 'docx', 'epub', 'html', 'jpg', 'pdf', 'png', 'ppt', 'txt'],
    pdb: ['rtf'],
    pdf: ['avif', 'bmp', 'doc', 'dxf', 'emf', 'eps', 'gif', 'ico', 'odd', 'ppt', 'ps', 'psd', 'svg', 'webp', 'wmf'],
    png: ['svg'],
    pot: ['emf', 'jpg', 'png', 'ppt'],
    potx: ['emf', 'jpg', 'odp', 'png', 'ppt', 'xps'],
    pps: ['eps', 'jpg', 'md', 'png', 'ppt'],
    ppsx: ['eps', 'jpg', 'md', 'png', 'ppt'],
    ppt: ['emf', 'eps', 'jpg', 'md', 'odp', 'png', 'xps'],
    pptm: ['emf', 'eps', 'html', 'jpg', 'md', 'odp', 'pdf', 'png', 'ppt', 'pptx', 'txt', 'xps'],
    pptx: ['emf', 'eps', 'jpg', 'key', 'md', 'png', 'ppt', 'xps'],
    prc: ['azw3', 'epub', 'lrf', 'mobi', 'oeb', 'pdb', 'pdf', 'rtf', 'txt'],
    prn: ['tsv'],
    ps: ['emf', 'ico', 'odd', 'psd', 'wmf'],
    qpw: ['tsv'],
    rst: ['rtf'],
    rtf: ['doc', 'jpg', 'png'],
    sk: ['emf', 'wmf'],
    sk1: ['emf', 'wmf'],
    slk: ['tsv'],
    snb: ['azw3', 'epub', 'lrf', 'mobi', 'oeb', 'pdb', 'pdf', 'rtf', 'txt'],
    svg: ['emf', 'ico', 'odd', 'psd', 'wmf'],
    svgz: ['emf', 'ico', 'odd', 'psd', 'wmf'],
    tcr: ['azw3', 'epub', 'lrf', 'mobi', 'oeb', 'pdb', 'pdf', 'rtf', 'txt'],
    tif: ['svg'],
    tiff: ['svg'],
    txt: ['doc', 'jpg', 'png', 'rtf', 'tex'],
    vsd: ['emf', 'wmf'],
    webp: ['svg'],
    wk1: ['tsv'],
    wks: ['tsv'],
    wmf: ['emf', 'wmf'],
    wpd: ['doc', 'jpg', 'png', 'rtf'],
    wps: ['doc', 'jpg', 'png', 'rtf'],
    xls: ['jpg', 'png', 'xps'],
    xlsm: ['jpg', 'json', 'png'],
    xlsx: ['jpg', 'numbers', 'png', 'xps'],
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
      const transcoderPairs = pairsFor(
        (c, target) => MEDIA_CATEGORIES.has(c) && FORMAT_REGISTRY[target].category !== 'archive'
      );
      expect(await findUnroutedPairs(transcoderPairs)).toEqual([]);
    },
    CATEGORY_TIMEOUT_MS
  );
});
