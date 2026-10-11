import fs from 'node:fs';
import path from 'node:path';
import { IN_PROCESS_REPEATS } from '../config';
import type { FamilyContext, FamilyRunner } from '../context';
import { convertWithProject } from '../convert';
import { ToolRunError } from '../errors';
import { PublicClassRows } from '../public-classes';
import { publicFile, publicSamples, type PublicSample } from '../public-samples';
import { publicSpeedSample } from '../public-scope';
import { attemptOurs, CONVERTS_SPEC, convertsRow, unavailableRows } from '../public-support';
import { ReferenceServer } from '../reference-server';
import type { BenchRow } from '../report';
import { measuredRow, type MetricSpec, skippedGroup, skippedRow, SPEC, speedRowId, throughputRow } from '../rows';
import { FONTTOOLS_PSEUDO_TOOL, runTool } from '../tools';

/**
 * Font family: the web font conversions between TrueType and OpenType (CFF) sources and WOFF and WOFF2, on a text face of
 * about 800 glyphs (DejaVu Sans, subset, once with TrueType outlines and hinting and once as the same glyphs in CFF).
 *
 * References, all open-source command-line tools: the WOFF2 reference implementation (`woff2_compress`, `woff2_decompress`) and
 * the WOFF 1.0 tools (`sfnt2woff`, `woff2sfnt`). Quality oracles: a WOFF2 output is decoded by the reference decoder and its
 * tables compared, byte for byte, with the tables the reference decoder gets from the reference encoder's file; a WOFF output
 * is read by fontTools and compared with the source font; a decode is compared with the reference decoder's output (WOFF2) or
 * the source font (WOFF). A table that differs is counted, and the size of an encoded file is measured against the reference's.
 *
 * TrueType to CFF and back have no reference converter among the open-source command-line tools (the converters are font
 * editors and library recipes, not conversions with a fixed contract), so those rows use spec conformance as the bar: the
 * output opens in fontTools, keeps the glyph count, the character map, the advance widths, the vertical metrics and the
 * required tables, and each outline keeps its shape, which is read as the exact area, centroid and second moments of the
 * curves (a converter that moves a curve by a thousandth of the em moves them by far less than the tolerance, a wrong
 * contour moves them by far more; converting cubic curves to quadratic ones, which approximates, stays well inside it). They have no speed row.
 *
 * The public samples (bench/corpus/public-manifest.json) are open-licence families that the committed pair does not cover:
 * hinted TrueType, a face with Arabic shaping tables, variable fonts, OpenType/CFF, CJK faces of 2 to 4.5 MB, and colour
 * fonts (COLR/CPAL and CBDT/CBLC). Each one goes through the wrapper cases; the outline conversion runs on the static Latin and
 * Arabic faces only, since the check reads every glyph and has no reference for variation or colour tables. A file the product
 * refuses, or one the reference tool cannot wrap, is a `converts` row instead of a stopped run. The per-class rows pool the size
 * ratio and average the table mismatches over a class.
 */

const WOFF2_TOOLS = { encode: 'woff2_compress', decode: 'woff2_decompress' } as const;
const WOFF_TOOLS = { encode: 'sfnt2woff', decode: 'woff2sfnt' } as const;
const REFERENCE: Readonly<Record<Wrapper, string>> = { woff2: 'woff2 (woff2_compress, woff2_decompress)', woff: 'woff-tools (sfnt2woff, woff2sfnt)' };
const REFERENCE_SPEC = 'spec conformance (fontTools)';
const NO_REFERENCE_CONVERTER = 'no open-source command-line converter between TrueType and CFF outlines exists; spec conformance is the quality bar';
/** What may differ between two outlines of one glyph before the glyph counts as different: relative area, centroid in em, relative second moments. */
const OUTLINE_TOLERANCE = { area: 0.01, centroid: 0.002, moment: 0.02 } as const;

type Wrapper = 'woff' | 'woff2';
type Sfnt = 'ttf' | 'otf';

interface Face {
  name: string;
  sfnt: Sfnt;
  /** Path in the generated corpus, or the file name of a public sample. */
  file: string;
  sample: PublicSample | null;
  /** Whether the outline conversion is measured on it. */
  outlines: boolean;
}
const FIXTURE_FACES: readonly Face[] = [
  { name: 'sans', sfnt: 'ttf', file: 'fonts/sans.ttf', sample: null, outlines: true },
  { name: 'sans-cff', sfnt: 'otf', file: 'fonts/sans-cff.otf', sample: null, outlines: true },
];
const publicFace = (sample: PublicSample): Face => ({
  name: path.parse(sample.id).name,
  sfnt: sample.meta.sfnt === 'otf' ? 'otf' : 'ttf',
  file: sample.id,
  sample,
  outlines: sample.meta.outlines === true,
});
const faces = (): readonly Face[] => [...FIXTURE_FACES, ...publicSamples('font').map(publicFace)];

/** The case names of a face. A public sample's start with its id, which is what puts them in the scope of the public sets. */
const compressCase = (face: Face, wrapper: Wrapper): string => (face.sample ? `${face.sample.id}->${wrapper}` : `${face.name}.${face.sfnt}->${wrapper}`);
const decompressCase = (face: Face, wrapper: Wrapper): string => (face.sample ? `${face.sample.id}.${wrapper}->${face.sfnt}` : `${face.name}.${wrapper}->${face.sfnt}`);
const outlineCase = (face: Face): string => (face.sample ? `${face.sample.id}->${OTHER_SFNT[face.sfnt]}` : `${face.name}.${face.sfnt}->${OTHER_SFNT[face.sfnt]}`);

/** Where the face is, once fetched: a path in the generated corpus, or the verified cache file of a public sample. */
interface Located {
  face: Face;
  path: string;
}
const faceBytes = (located: Located): Buffer => fs.readFileSync(located.path);
const OTHER_SFNT: Readonly<Record<Sfnt, Sfnt>> = { ttf: 'otf', otf: 'ttf' };

interface CompareResult {
  tables: number;
  differing: string[];
}

interface ValidateResult {
  failures: string[];
  glyphs: number;
  mismatchedGlyphs: number;
}

interface Tools {
  server: ReferenceServer;
  paths: Readonly<Record<string, string>>;
}

const toolsOf = (wrapper: Wrapper): typeof WOFF2_TOOLS | typeof WOFF_TOOLS => (wrapper === 'woff2' ? WOFF2_TOOLS : WOFF_TOOLS);

async function differingTables(server: ReferenceServer, file: string, expected: string): Promise<number> {
  return (await server.call<CompareResult>('font.compare', { file, expected })).differing.length;
}

/** Our side of a conversion, through the product's dispatcher. */
async function convertOurs(input: Buffer, from: string, to: string, filename: string): Promise<Buffer> {
  return (await convertWithProject(input, from, to, {}, filename)).buffer;
}

/** A directory of its own holding `bytes` under `name`: the reference tools write next to their input. */
function stage(ctx: FamilyContext, label: string, name: string, bytes: Buffer): { dir: string; file: string } {
  const dir = ctx.scratch(label);
  fs.mkdirSync(dir);
  const file = path.join(dir, name);
  fs.writeFileSync(file, bytes);
  return { dir, file };
}

/** The decoded sfnt of a WOFF2 file, by the reference decoder, in a directory of its own. It names its output `.ttf` whatever the outlines. */
function decodeWoff2(ctx: FamilyContext, tools: Tools, wrapped: Buffer, name: string): string {
  const staged = stage(ctx, 'woff2-decode', `${name}.woff2`, wrapped);
  runTool(tools.paths[WOFF2_TOOLS.decode], [staged.file]);
  return path.join(staged.dir, `${name}.ttf`);
}

const COMPRESS_METRICS: readonly MetricSpec[] = [SPEC.ratio, SPEC.tableMismatches];
const DECOMPRESS_METRICS: readonly MetricSpec[] = [SPEC.tableMismatches];

/** Runs a reference tool on a public sample; a tool that refuses the file is a reference that does not convert it, which the sample's `converts` row says. */
function referenceAttempt(face: Face, action: () => void): boolean {
  try {
    action();
    return true;
  } catch (error) {
    if (face.sample === null || !(error instanceof ToolRunError)) throw error;
    return false;
  }
}

/** The sfnt to a wrapper: ours against the reference encoder, size and tables. */
async function runCompress(ctx: FamilyContext, tools: Tools, located: Located, wrapper: Wrapper, classRows: PublicClassRows): Promise<BenchRow[]> {
  const { face } = located;
  const caseName = compressCase(face, wrapper);
  if (!ctx.inScope('font', caseName)) return [];
  ctx.log(`font ${caseName}`);
  const source = faceBytes(located);
  const filename = path.basename(face.file);
  const staged = stage(ctx, `${caseName}-reference`, filename, source);
  const referenceFile = path.join(staged.dir, `${face.name}.${wrapper}`);
  const encode = (): void => {
    runTool(tools.paths[toolsOf(wrapper).encode], [staged.file]);
  };
  const rows: BenchRow[] = [];
  const classKey = `->${wrapper}`;
  if (ctx.quality) {
    if (face.sample) classRows.expect(face.sample.class, classKey, [...COMPRESS_METRICS, CONVERTS_SPEC].map((spec) => spec.metric));
    const referenceConverted = referenceAttempt(face, encode);
    const attempt = await attemptOurs(() => convertOurs(source, face.sfnt, wrapper, filename), face.sample !== null);
    if (face.sample) {
      if (!attempt.ok) ctx.log(`font ${caseName}: the product does not convert it (${attempt.reason})`);
      rows.push(convertsRow('font', caseName, attempt.ok, referenceConverted, REFERENCE[wrapper]));
    }
    if (attempt.ok && referenceConverted) {
      const oursBytes = attempt.value;
      const referenceBytes = fs.readFileSync(referenceFile);
      let oursTables: number;
      let referenceTables: number;
      if (wrapper === 'woff2') {
        // Both files go through the one reference decoder, so a table that differs was encoded differently.
        oursTables = await differingTables(tools.server, decodeWoff2(ctx, tools, oursBytes, face.name), decodeWoff2(ctx, tools, referenceBytes, face.name));
        referenceTables = 0;
      } else {
        oursTables = await differingTables(tools.server, stage(ctx, 'ours-woff', `${face.name}.woff`, oursBytes).file, staged.file);
        referenceTables = await differingTables(tools.server, referenceFile, staged.file);
      }
      rows.push(
        measuredRow('font', caseName, SPEC.ratio, oursBytes.length / source.length, referenceBytes.length / source.length, REFERENCE[wrapper]),
        measuredRow('font', caseName, SPEC.tableMismatches, oursTables, referenceTables, REFERENCE[wrapper])
      );
    }
    if (face.sample) classRows.addRows(face.sample.class, classKey, rows, [...COMPRESS_METRICS, CONVERTS_SPEC], (spec) => (spec.metric === SPEC.ratio.metric ? source.length : 1));
  }
  if (ctx.speed && (face.sample === null || publicSpeedSample('font', face.sample.id))) {
    const timing = await ctx.time(
      speedRowId('font', caseName),
      async () => {
        await convertOurs(source, face.sfnt, wrapper, filename);
      },
      encode,
      'light',
      wrapper === 'woff' ? IN_PROCESS_REPEATS : 1
    );
    rows.push(throughputRow('font', caseName, source.length, timing, REFERENCE[wrapper]));
  }
  return rows;
}

/** A wrapper to its sfnt: ours against the reference decoder, tables. The wrapped file is the reference encoder's. */
async function runDecompress(ctx: FamilyContext, tools: Tools, located: Located, wrapper: Wrapper, classRows: PublicClassRows): Promise<BenchRow[]> {
  const { face } = located;
  const caseName = decompressCase(face, wrapper);
  if (!ctx.inScope('font', caseName)) return [];
  ctx.log(`font ${caseName}`);
  const source = stage(ctx, `${caseName}-source`, path.basename(face.file), faceBytes(located));
  if (!referenceAttempt(face, () => runTool(tools.paths[toolsOf(wrapper).encode], [source.file]))) {
    // The reference encoder refuses the file, so there is no wrapped file to decode; the compress case carries the row.
    return face.sample && ctx.quality ? [convertsRow('font', caseName, false, false, REFERENCE[wrapper])] : [];
  }
  const wrapped = fs.readFileSync(path.join(source.dir, `${face.name}.${wrapper}`));
  const filename = `${face.name}.${wrapper}`;
  // The reference decoder's output: WOFF2 is rebuilt by it next to the file it reads, WOFF is printed.
  const decoding = stage(ctx, `${caseName}-decode`, filename, wrapped);
  const decodedFile = path.join(decoding.dir, wrapper === 'woff2' ? `${face.name}.ttf` : `decoded.${face.sfnt}`);
  const decode = (): void => {
    if (wrapper === 'woff2') runTool(tools.paths[WOFF2_TOOLS.decode], [decoding.file]);
    else fs.writeFileSync(decodedFile, runTool(tools.paths[WOFF_TOOLS.decode], [decoding.file]).stdout);
  };
  const rows: BenchRow[] = [];
  const classKey = `.${wrapper}->${face.sfnt}`;
  if (ctx.quality) {
    if (face.sample) classRows.expect(face.sample.class, classKey, [...DECOMPRESS_METRICS, CONVERTS_SPEC].map((spec) => spec.metric));
    const referenceConverted = referenceAttempt(face, decode);
    const attempt = await attemptOurs(() => convertOurs(wrapped, wrapper, face.sfnt, filename), face.sample !== null);
    if (face.sample) {
      if (!attempt.ok) ctx.log(`font ${caseName}: the product does not convert it (${attempt.reason})`);
      rows.push(convertsRow('font', caseName, attempt.ok, referenceConverted, REFERENCE[wrapper]));
    }
    if (attempt.ok && referenceConverted) {
      const oursFile = stage(ctx, 'ours-sfnt', `${face.name}.${face.sfnt}`, attempt.value).file;
      // WOFF2 is judged against the reference decoder's output, WOFF (whose tables are stored as they were) against the source font.
      const expected = wrapper === 'woff2' ? decodedFile : source.file;
      rows.push(measuredRow('font', caseName, SPEC.tableMismatches, await differingTables(tools.server, oursFile, expected), await differingTables(tools.server, decodedFile, expected), REFERENCE[wrapper]));
    }
    if (face.sample) classRows.addRows(face.sample.class, classKey, rows, [...DECOMPRESS_METRICS, CONVERTS_SPEC]);
  }
  if (ctx.speed && (face.sample === null || publicSpeedSample('font', face.sample.id))) {
    const timing = await ctx.time(
      speedRowId('font', caseName),
      async () => {
        await convertOurs(wrapped, wrapper, face.sfnt, filename);
      },
      decode,
      'light',
      IN_PROCESS_REPEATS
    );
    rows.push(throughputRow('font', caseName, wrapped.length, timing, REFERENCE[wrapper]));
  }
  return rows;
}

/** TrueType to CFF and back: spec conformance of the output, no reference converter. */
async function runOutlines(ctx: FamilyContext, tools: Tools, located: Located, classRows: PublicClassRows): Promise<BenchRow[]> {
  const { face } = located;
  const to = OTHER_SFNT[face.sfnt];
  const caseName = outlineCase(face);
  if (!face.outlines || !ctx.inScope('font', caseName)) return [];
  ctx.log(`font ${caseName}`);
  const rows: BenchRow[] = [];
  const classKey = `->${to}`;
  if (ctx.quality) {
    if (face.sample) classRows.expect(face.sample.class, classKey, [SPEC.fontValidationFailures, SPEC.outlineMismatches, CONVERTS_SPEC].map((spec) => spec.metric));
    const attempt = await attemptOurs(() => convertOurs(faceBytes(located), face.sfnt, to, path.basename(face.file)), face.sample !== null);
    if (face.sample) {
      if (!attempt.ok) ctx.log(`font ${caseName}: the product does not convert it (${attempt.reason})`);
      rows.push(convertsRow('font', caseName, attempt.ok, true, REFERENCE_SPEC));
    }
    if (attempt.ok) {
      const oursFile = stage(ctx, 'ours-outlines', `${face.name}.${to}`, attempt.value).file;
      const result = await tools.server.call<ValidateResult>('font.validate', { file: oursFile, expected: located.path, tolerance: OUTLINE_TOLERANCE });
      rows.push(
        measuredRow('font', caseName, SPEC.fontValidationFailures, result.failures.length, 0, REFERENCE_SPEC),
        measuredRow('font', caseName, SPEC.outlineMismatches, result.mismatchedGlyphs, 0, REFERENCE_SPEC)
      );
    }
    if (face.sample) classRows.addRows(face.sample.class, classKey, rows, [SPEC.fontValidationFailures, SPEC.outlineMismatches, CONVERTS_SPEC]);
  }
  if (ctx.speed) rows.push(skippedRow('font', caseName, SPEC.throughput, REFERENCE_SPEC, 'unsupported', NO_REFERENCE_CONVERTER));
  return rows;
}

interface CaseSummary {
  name: string;
  metrics: readonly MetricSpec[];
  reference: string;
}

function summariesOf(face: Face): CaseSummary[] {
  const wrapped = (wrapper: Wrapper): CaseSummary[] => [
    { name: compressCase(face, wrapper), metrics: [SPEC.ratio, SPEC.tableMismatches, SPEC.throughput], reference: REFERENCE[wrapper] },
    { name: decompressCase(face, wrapper), metrics: [SPEC.tableMismatches, SPEC.throughput], reference: REFERENCE[wrapper] },
  ];
  return [
    ...wrapped('woff2'),
    ...wrapped('woff'),
    ...(face.outlines ? [{ name: outlineCase(face), metrics: [SPEC.fontValidationFailures, SPEC.outlineMismatches, SPEC.throughput], reference: REFERENCE_SPEC }] : []),
  ];
}

/** The reference of a class row, from the part of the case name after the class (`->woff2`, `.woff->ttf`, `->otf`). */
function referenceOfSuffix(suffix: string): string {
  if (suffix.includes('woff2')) return REFERENCE.woff2;
  if (suffix.includes('woff')) return REFERENCE.woff;
  return REFERENCE_SPEC;
}

/** The path of a face: the generated corpus, or the verified download of a public sample (null when the host did not deliver it). */
async function locate(ctx: FamilyContext, face: Face): Promise<Located | null> {
  if (face.sample === null) return { face, path: ctx.corpusPath(face.file) };
  const file = await publicFile(ctx, face.sample);
  return file === null ? null : { face, path: file };
}

export const runFont: FamilyRunner = async (ctx) => {
  const all = faces();
  const wanted = all.flatMap(summariesOf).filter((item) => ctx.inScope('font', item.name));
  if (wanted.length === 0) return [];
  const plan = ctx.plan([...Object.values(WOFF2_TOOLS), ...Object.values(WOFF_TOOLS), 'python3', FONTTOOLS_PSEUDO_TOOL], 'font');
  if (!plan.ok) return wanted.flatMap((item) => skippedGroup('font', item.name, item.metrics, item.reference, plan));
  const server = ReferenceServer.start(plan.paths.python3);
  try {
    const tools: Tools = { server, paths: plan.paths };
    const rows: BenchRow[] = [];
    const classRows = new PublicClassRows();
    for (const face of all) {
      const mine = summariesOf(face).filter((item) => ctx.inScope('font', item.name));
      if (mine.length === 0) continue;
      const located = await locate(ctx, face);
      if (located === null) {
        for (const item of mine) rows.push(...unavailableRows('font', item.name, item.metrics, item.reference, `public sample ${face.file} is not available`));
        continue;
      }
      for (const wrapper of ['woff2', 'woff'] as const) {
        rows.push(...(await runCompress(ctx, tools, located, wrapper, classRows)), ...(await runDecompress(ctx, tools, located, wrapper, classRows)));
      }
      rows.push(...(await runOutlines(ctx, tools, located, classRows)));
    }
    if (ctx.quality) {
      for (const row of classRows.rows('font', referenceOfSuffix)) {
        if (ctx.inScope('font', row.case)) rows.push(row);
      }
    }
    return rows;
  } finally {
    await server.close();
  }
};
