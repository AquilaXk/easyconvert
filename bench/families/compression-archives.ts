import fs from 'node:fs';
import path from 'node:path';
import { IN_PROCESS_REPEATS } from '../config';
import { convertWithProject } from '../convert';
import type { FamilyContext, FamilyRunner } from '../context';
import { OutputIntegrityError, ToolRunError } from '../errors';
import type { BenchRow } from '../report';
import { measuredRow, type MetricSpec, skippedRow, SPEC, speedRowId, throughputRow } from '../rows';
import { runTool } from '../tools';
import { buildStoredRar4 } from '../../tests/helpers/rar4-stored';
import { buildMixedFixture, type MixedFixture, streamTarMember, tarMember, timeBoth } from './compression-fixture';

/**
 * The other archive formats of the compression family: ZIP, gzip, bzip2 and RAR, on the tar of one file that the Zstandard,
 * xz and 7z rows use. Compression: ratio and speed against the standard command-line tool at its default level (Info-ZIP
 * `zip -6`, `gzip -6`, `bzip2 -9`); extraction: speed against the standard extractor (`unzip`, `gzip -d`, `bzip2 -d`, `unrar`).
 *
 * The oracle is the tool that is not the product's: an output is unpacked by the reference tool of its format (the product's
 * ZIP and gzip are written by 7-Zip, so Info-ZIP and gzip read them, and bzip2 reads the bzip2 output) and must be the original
 * bytes, and every extraction must give the original bytes, which a row records as `lossless_exact` (1 when it does).
 * RAR has no open-source writer (and the product offers RAR as a source only), so the RAR input is a stored RAR 4.x archive written
 * by the independent helper of the tests (tests/helpers/rar4-stored.ts, verified here by `unrar` extracting it to the original bytes).
 */

const ZIP_LEVEL = '6';
const GZIP_LEVEL = '6';
const BZIP2_LEVEL = '9';
const COMPRESS_SPECS: readonly MetricSpec[] = [SPEC.ratio, SPEC.losslessExact, SPEC.throughput];
const EXTRACT_SPECS: readonly MetricSpec[] = [SPEC.losslessExact, SPEC.throughput];

interface Pack {
  /** Registry name of the target and the tool that is the reference. */
  target: 'zip' | 'gz' | 'tar.bz2';
  tool: string;
  label: string;
  /** Reference tool and oracle command lines, given the fixture. */
  reference: (tools: Readonly<Record<string, string>>, fixture: MixedFixture, work: string) => Buffer;
  unpack: (tools: Readonly<Record<string, string>>, archive: string, fixture: MixedFixture) => Buffer;
  /** What the unpacked bytes are compared with: the member (zip, gzip) or the tar (bzip2 of a tar). */
  unpacksTo: 'member' | 'tar';
}

const PACKS: readonly Pack[] = [
  {
    target: 'zip',
    tool: 'zip',
    label: `zip -${ZIP_LEVEL}`,
    reference: (tools, fixture, work) => {
      const file = path.join(work, 'reference.zip');
      fs.rmSync(file, { force: true });
      runTool(tools.zip, ['-q', `-${ZIP_LEVEL}`, '-X', file, fixture.member], { cwd: fixture.dir });
      return fs.readFileSync(file);
    },
    unpack: (tools, archive, fixture) => runTool(tools.unzip, ['-p', archive, fixture.member]).stdout,
    unpacksTo: 'member',
  },
  {
    target: 'gz',
    tool: 'gzip',
    label: `gzip -${GZIP_LEVEL}`,
    reference: (tools, fixture) => runTool(tools.gzip, [`-${GZIP_LEVEL}`, '-n', '-c', fixture.path]).stdout,
    unpack: (tools, archive) => runTool(tools.gzip, ['-d', '-c', archive]).stdout,
    unpacksTo: 'member',
  },
  {
    target: 'tar.bz2',
    tool: 'bzip2',
    label: `bzip2 -${BZIP2_LEVEL}`,
    reference: (tools, fixture, work) => {
      const tarFile = path.join(work, 'mixed.tar');
      fs.writeFileSync(tarFile, fixture.tar);
      return runTool(tools.bzip2, [`-${BZIP2_LEVEL}`, '-c', tarFile]).stdout;
    },
    unpack: (tools, archive) => runTool(tools.bzip2, ['-d', '-c', archive]).stdout,
    unpacksTo: 'tar',
  },
];

interface Extract {
  /** Registry name of the source, and the stream the reference tool writes of the member. */
  source: 'zip' | 'gz' | 'bz2' | 'rar';
  tool: string;
  label: string;
  stream: (tools: Readonly<Record<string, string>>, fixture: MixedFixture, work: string) => Buffer;
  extract: (tools: Readonly<Record<string, string>>, archive: string, fixture: MixedFixture) => Buffer;
}

const EXTRACTS: readonly Extract[] = [
  { source: 'zip', tool: 'unzip', label: 'unzip', stream: (tools, fixture, work) => PACKS[0].reference(tools, fixture, work), extract: (tools, archive, fixture) => runTool(tools.unzip, ['-p', archive, fixture.member]).stdout },
  { source: 'gz', tool: 'gzip', label: 'gzip -d', stream: (tools, fixture, work) => PACKS[1].reference(tools, fixture, work), extract: (tools, archive) => runTool(tools.gzip, ['-d', '-c', archive]).stdout },
  {
    source: 'bz2',
    tool: 'bzip2',
    label: 'bzip2 -d',
    stream: (tools, fixture) => runTool(tools.bzip2, [`-${BZIP2_LEVEL}`, '-c', fixture.path]).stdout,
    extract: (tools, archive) => runTool(tools.bzip2, ['-d', '-c', archive]).stdout,
  },
  {
    source: 'rar',
    tool: 'unrar',
    label: 'unrar',
    stream: (_tools, fixture) => buildStoredRar4([{ name: fixture.member, data: fixture.original }]),
    extract: (tools, archive, fixture) => runTool(tools.unrar, ['p', '-inul', archive, fixture.member]).stdout,
  },
];

/** The subject of the archive rows: the generated mixed input (label `mixed`) or a public sample (its id). */
export interface ArchiveSubject {
  label: string;
  /** The fixture, built when the first row needs it (with the tar tool the rows will use). */
  fixture: (tarBin: string) => MixedFixture;
  /** Public samples: a product output that the reference tool does not read back to the original is a row at 0, and the run goes on. */
  soft: boolean;
  /** Public samples: whether the sample has throughput rows (the nightly run times a few of them). */
  timed: boolean;
  /** Reports the class the sample's ratios and sizes are pooled in, or null. */
  onRatio?: (target: string, oursBytes: number, referenceBytes: number, originalBytes: number) => void;
}

const packCase = (subject: ArchiveSubject, pack: Pack): string => `${subject.label}.tar->${pack.target}`;
const extractCase = (subject: ArchiveSubject, extract: Extract): string => `${subject.label}.${extract.source}->tar`;

function exactRow(caseName: string, exact: boolean, referenceTool: string): BenchRow {
  return measuredRow('compression', caseName, SPEC.losslessExact, exact ? 1 : 0, 1, referenceTool);
}

async function runPack(ctx: FamilyContext, tools: Readonly<Record<string, string>>, subject: ArchiveSubject, fixture: MixedFixture, pack: Pack): Promise<BenchRow[]> {
  const caseName = packCase(subject, pack);
  ctx.log(`compression ${caseName}`);
  const work = ctx.scratch(`${pack.target}-reference`);
  fs.mkdirSync(work);
  const ours = async (): Promise<Buffer> => (await convertWithProject(fixture.tar, 'tar', pack.target, {}, `${subject.label}.tar`)).buffer;
  const reference = (): Buffer => pack.reference(tools, fixture, work);
  const rows: BenchRow[] = [];
  if (ctx.quality) {
    const oursBytes = await ours();
    const archive = ctx.scratch(`ours.${pack.target}`);
    fs.writeFileSync(archive, oursBytes);
    const exact = unpackedIsOriginal(subject, () => {
      const unpacked = pack.unpack(tools, archive, fixture);
      return (pack.unpacksTo === 'tar' ? tarMember(unpacked, tools.tar) : unpacked).equals(fixture.original);
    });
    const referenceBytes = reference().length;
    rows.push(measuredRow('compression', caseName, SPEC.ratio, oursBytes.length / fixture.original.length, referenceBytes / fixture.original.length, pack.label), exactRow(caseName, exact, pack.label));
    if (!exact) return rows;
    subject.onRatio?.(pack.target, oursBytes.length, referenceBytes, fixture.original.length);
  }
  if (ctx.speed && subject.timed) {
    rows.push(throughputRow('compression', caseName, fixture.original.length, await timeBoth(ctx, speedRowId('compression', caseName), ours, reference), pack.label));
  }
  return rows;
}

/** The verdict of an integrity check: a public sample's failure (a tool that cannot read our output) is a row at 0; the generated corpus keeps ending the run. */
function unpackedIsOriginal(subject: ArchiveSubject, check: () => boolean): boolean {
  if (!subject.soft) return check();
  try {
    return check();
  } catch (error) {
    if (error instanceof ToolRunError) return false;
    throw error;
  }
}

async function runExtract(ctx: FamilyContext, tools: Readonly<Record<string, string>>, subject: ArchiveSubject, fixture: MixedFixture, extract: Extract): Promise<BenchRow[]> {
  const caseName = extractCase(subject, extract);
  ctx.log(`compression ${caseName}`);
  const work = ctx.scratch(`${extract.source}-reference`);
  fs.mkdirSync(work);
  const stream = extract.stream(tools, fixture, work);
  const archive = ctx.scratch(`stream.${extract.source}`);
  fs.writeFileSync(archive, stream);
  // A stream the reference extractor does not read back to the original bytes is a fault of the benchmark, not of the product.
  if (!extract.extract(tools, archive, fixture).equals(fixture.original)) throw new OutputIntegrityError(`the ${extract.label} extraction of the ${extract.source} input is not the original ${fixture.original.length} bytes`);
  const ours = async (): Promise<Buffer> => (await convertWithProject(stream, extract.source, 'tar', {}, `${subject.label}.${extract.source}`)).buffer;
  const rows: BenchRow[] = [];
  if (ctx.quality) {
    const exact = await oursIsOriginal(subject, async () => (extract.source === 'gz' || extract.source === 'bz2' ? streamTarMember(ctx, await ours(), fixture.original, tools.tar) : tarMember(await ours(), tools.tar)).equals(fixture.original));
    rows.push(exactRow(caseName, exact, extract.label));
    if (!exact) return rows;
  }
  if (ctx.speed && subject.timed) {
    rows.push(
      throughputRow('compression', caseName, fixture.original.length, await timeBoth(ctx, speedRowId('compression', caseName), ours, () => extract.extract(tools, archive, fixture), IN_PROCESS_REPEATS), extract.label)
    );
  }
  return rows;
}

/** As unpackedIsOriginal, for a conversion that itself may reject the stream. */
async function oursIsOriginal(subject: ArchiveSubject, check: () => Promise<boolean>): Promise<boolean> {
  if (!subject.soft) return check();
  try {
    return await check();
  } catch (error) {
    if (error instanceof Error) return false;
    throw error;
  }
}

/** The generated corpus' subject: the mixed input. */
const mixedSubject = (ctx: FamilyContext): ArchiveSubject => {
  let fixture: MixedFixture | undefined;
  return { label: 'mixed', fixture: (tarBin) => (fixture ??= buildMixedFixture(ctx, tarBin)), soft: false, timed: true };
};

/** Runs the archive rows of one subject whose cases are in scope. */
export async function runArchiveRows(ctx: FamilyContext, subject: ArchiveSubject): Promise<BenchRow[]> {
  const packs = PACKS.filter((pack) => ctx.inScope('compression', packCase(subject, pack)));
  const extracts = EXTRACTS.filter((extract) => ctx.inScope('compression', extractCase(subject, extract)));
  if (packs.length + extracts.length === 0) return [];
  const plan = ctx.plan(['tar', 'zip', 'unzip', 'gzip', 'bzip2', 'unrar'], 'compression archives');
  if (!plan.ok) {
    const kind = plan.optional ? 'optional-tool' : 'missing-tool';
    return [
      ...packs.flatMap((pack) => COMPRESS_SPECS.map((spec) => skippedRow('compression', packCase(subject, pack), spec, pack.label, kind, plan.reason))),
      ...extracts.flatMap((extract) => EXTRACT_SPECS.map((spec) => skippedRow('compression', extractCase(subject, extract), spec, extract.label, kind, plan.reason))),
    ];
  }
  const fixture = subject.fixture(plan.paths.tar);
  const rows: BenchRow[] = [];
  for (const pack of packs) rows.push(...(await runPack(ctx, plan.paths, subject, fixture, pack)));
  for (const extract of extracts) rows.push(...(await runExtract(ctx, plan.paths, subject, fixture, extract)));
  return rows;
}

export const runArchives: FamilyRunner = (ctx) => runArchiveRows(ctx, mixedSubject(ctx));
