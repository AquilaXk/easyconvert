import fs from 'node:fs';
import { ClassRows } from '../class-rows';
import { convertWithProject } from '../convert';
import { IN_PROCESS_REPEATS, PUBLIC_SPEED_SAMPLES } from '../config';
import type { FamilyContext, FamilyRunner } from '../context';
import { type RemoteSample, remoteSamples } from '../corpora';
import { numberRecord } from '../ref-cache';
import type { BenchRow } from '../report';
import { measuredRow, type MetricSpec, skippedGroup, skippedRow, SPEC, throughputRow, speedRowId } from '../rows';
import { runTool } from '../tools';
import { type ArchiveSubject, runArchiveRows } from './compression-archives';
import { assertSame, buildFixture, buildMixedFixture, MIXED_INPUT_FILES, type MixedFixture, streamTarMember, tarMember, timeBoth } from './compression-fixture';

/**
 * Compression family: a tar holding one file is converted to zst and 7z, which compress the member; size ratio, compress speed and decompress speed of the project's Zstandard and 7z paths
 * against the zstd, 7z and xz command-line tools at the same level. Every output is decoded by the reference
 * tool and every decode is compared with the original bytes, so a fast path that corrupts data fails the run.
 *
 * The generated corpus supplies one input (`mixed`). The public sample sets (bench/corpus/remote-manifest.json: the Silesia
 * corpus of text, markup, source code, executables, databases, medical images and already compressed data, and two
 * already compressed media files) add the same cases for each sample, named `<sample id>.tar-><format>`. A product output that
 * the reference tool does not read back to the original is a `lossless_exact` row at 0 there instead of an ended run, so
 * one sample cannot hide the others; each class has rows that pool the ratios of its samples (bench/class-rows.ts).
 */

const ZSTD_LEVEL = '3';
const SEVEN_ZIP_LEVEL = '6';
const XZ_LEVEL = '6';
const COMPRESS_SPECS: readonly MetricSpec[] = [SPEC.ratio, SPEC.throughput];
const DECOMPRESS_SPECS: readonly MetricSpec[] = [SPEC.throughput];
const PUBLIC_COMPRESS_SPECS: readonly MetricSpec[] = [SPEC.ratio, SPEC.losslessExact, SPEC.throughput];
const PUBLIC_DECOMPRESS_SPECS: readonly MetricSpec[] = [SPEC.losslessExact, SPEC.throughput];
const parseSize = numberRecord(['bytes']);

async function runCodecs(ctx: FamilyContext, subject: ArchiveSubject, inputFiles: readonly string[]): Promise<BenchRow[]> {
  const rows: BenchRow[] = [];
  const label = subject.label;
  const publicSample = subject.soft;
  const compressSpecs = publicSample ? PUBLIC_COMPRESS_SPECS : COMPRESS_SPECS;
  const decompressSpecs = publicSample ? PUBLIC_DECOMPRESS_SPECS : DECOMPRESS_SPECS;
  const compressCases = ['zst', '7z', 'xz'].map((name) => `${label}.tar->${name}`);
  const decompressCases = ['zst', 'xz', '7z'].map((name) => `${label}.${name}->tar`);
  const wanted = (caseName: string): boolean => ctx.inScope('compression', caseName);
  if (![...compressCases, ...decompressCases].some(wanted)) return rows;
  const plan = ctx.plan(['zstd', 'xz', '7z', 'tar'], 'compression');
  if (!plan.ok) {
    for (const [name, ref] of [['zst', 'zstd'], ['7z', '7z'], ['xz', 'xz']] as const) {
      if (wanted(`${label}.tar->${name}`) && (name !== 'xz' || !publicSample)) rows.push(...skippedGroup('compression', `${label}.tar->${name}`, compressSpecs, ref, plan));
      if (wanted(`${label}.${name}->tar`)) rows.push(...skippedGroup('compression', `${label}.${name}->tar`, decompressSpecs, ref, plan));
    }
    return rows;
  }
  ctx.log(`compression ${label}`);
  const { zstd, xz, tar: tarBin } = plan.paths;
  const sevenZip = plan.paths['7z'];

  const { dir: mixedDir, path: mixedPath, original, tar, member } = subject.fixture(tarBin);
  const timed = subject.timed;

  /** Size of the reference tool's output for the input, cached: a function of the tool, its level and the input files. */
  const referenceSize = (tool: string, level: string, compute: () => number): Promise<number> =>
    ctx.refCache
      .value('compression', { kind: `${tool}-size`, tools: [tool], files: inputFiles, settings: { level, member } }, parseSize, () => ({ bytes: compute() }))
      .then((entry) => entry.bytes);

  /** Whether `produce()` decodes to the original: a failed check ends the run for the generated corpus and is a row at 0 for a public sample. */
  const verified = async (what: string, produce: () => Buffer | Promise<Buffer>): Promise<boolean> => {
    if (!publicSample) {
      assertSame(what, await produce(), original);
      return true;
    }
    try {
      return (await produce()).equals(original);
    } catch (error) {
      if (error instanceof Error) return false;
      throw error;
    }
  };
  const exactRow = (caseName: string, exact: boolean, tool: string): BenchRow => measuredRow('compression', caseName, SPEC.losslessExact, exact ? 1 : 0, 1, tool);

  // Zstandard compress: ours against zstd, both decoded by the zstd tool.
  const zstdCase = `${label}.tar->zst`;
  if (wanted(zstdCase)) {
    const zstdOurs = async (): Promise<Buffer> => (await convertWithProject(tar, 'tar', 'zst', {}, `${label}.tar`)).buffer;
    const zstdRef = (): Buffer => runTool(zstd, [`-${ZSTD_LEVEL}`, '-q', '-c', mixedPath]).stdout;
    let zstdOursBytes: Buffer | null = null;
    const exact = await verified('our zst output', async () => {
      zstdOursBytes = await zstdOurs();
      return runTool(zstd, ['-d', '-q', '-c'], { input: zstdOursBytes }).stdout;
    });
    if (ctx.quality) {
      if (publicSample) rows.push(exactRow(zstdCase, exact, `zstd -${ZSTD_LEVEL}`));
      if (exact && zstdOursBytes !== null) {
        const refBytes = await referenceSize('zstd', ZSTD_LEVEL, () => zstdRef().length);
        const ours = (zstdOursBytes as Buffer).length;
        rows.push(measuredRow('compression', zstdCase, SPEC.ratio, ours / original.length, refBytes / original.length, `zstd -${ZSTD_LEVEL}`));
        subject.onRatio?.('zst', ours, refBytes, original.length);
      }
    }
    if (ctx.speed && exact && timed) {
      rows.push(throughputRow('compression', zstdCase, original.length, await timeBoth(ctx, speedRowId('compression', zstdCase), zstdOurs, zstdRef), `zstd -${ZSTD_LEVEL}`));
    }
  }

  // 7z compress: ours against 7z at the same level, both extracted by the 7z tool.
  const sevenOurs = async (): Promise<Buffer> => (await convertWithProject(tar, 'tar', '7z', { compressionLevel: Number(SEVEN_ZIP_LEVEL) }, `${label}.tar`)).buffer;
  const sevenRefFile = ctx.scratch('ref.7z');
  const sevenRef = (): Buffer => {
    fs.rmSync(sevenRefFile, { force: true });
    runTool(sevenZip, ['a', '-t7z', `-mx=${SEVEN_ZIP_LEVEL}`, '-y', sevenRefFile, member], { cwd: mixedDir });
    return fs.readFileSync(sevenRefFile);
  };
  const sevenCase = `${label}.tar->7z`;
  if (wanted(sevenCase)) {
    let sevenOursBytes: Buffer | null = null;
    const exact = await verified('our 7z output', async () => {
      sevenOursBytes = await sevenOurs();
      const sevenOursFile = ctx.scratch('ours.7z');
      fs.writeFileSync(sevenOursFile, sevenOursBytes);
      return runTool(sevenZip, ['x', '-so', '-y', sevenOursFile]).stdout;
    });
    if (ctx.quality) {
      if (publicSample) rows.push(exactRow(sevenCase, exact, `7z -mx=${SEVEN_ZIP_LEVEL}`));
      if (exact && sevenOursBytes !== null) {
        const refBytes = await referenceSize('7z', SEVEN_ZIP_LEVEL, () => sevenRef().length);
        const ours = (sevenOursBytes as Buffer).length;
        rows.push(measuredRow('compression', sevenCase, SPEC.ratio, ours / original.length, refBytes / original.length, `7z -mx=${SEVEN_ZIP_LEVEL}`));
        subject.onRatio?.('7z', ours, refBytes, original.length);
      }
    }
    if (ctx.speed && exact && timed) {
      rows.push(throughputRow('compression', sevenCase, original.length, await timeBoth(ctx, speedRowId('compression', sevenCase), sevenOurs, sevenRef), `7z -mx=${SEVEN_ZIP_LEVEL}`));
    }
  }

  // xz compress: the registry offers no xz output target, so only the reference exists for this row.
  if (wanted(`${label}.tar->xz`) && !publicSample) {
    const unsupported = 'the format registry offers no xz output target; the reference xz tool is the only producer';
    for (const spec of COMPRESS_SPECS) {
      if ((spec.kind === 'throughput' && ctx.speed) || (spec.kind !== 'throughput' && ctx.quality)) {
        rows.push(skippedRow('compression', `${label}.tar->xz`, spec, `xz -${XZ_LEVEL}`, 'unsupported', unsupported));
      }
    }
  }

  // Decompress: both sides read the reference tool's stream and the output is checked against the original.
  const decompress = [
    {
      name: 'zst',
      tool: `zstd -${ZSTD_LEVEL}`,
      stream: (): Buffer => runTool(zstd, [`-${ZSTD_LEVEL}`, '-q', '-c', mixedPath]).stdout,
      reference: (stream: string): Buffer => runTool(zstd, ['-d', '-q', '-c', stream]).stdout,
      // Our Zstandard decode takes milliseconds, so one call per sample is decided by scheduler jitter.
      oursRepeats: IN_PROCESS_REPEATS,
      singleStream: true,
    },
    {
      name: 'xz',
      tool: `xz -${XZ_LEVEL}`,
      stream: (): Buffer => runTool(xz, [`-${XZ_LEVEL}`, '-c', mixedPath]).stdout,
      reference: (stream: string): Buffer => runTool(xz, ['-d', '-c', stream]).stdout,
      oursRepeats: 1,
      singleStream: true,
    },
    {
      name: '7z',
      tool: `7z -mx=${SEVEN_ZIP_LEVEL}`,
      stream: sevenRef,
      reference: (stream: string): Buffer => runTool(sevenZip, ['x', '-so', '-y', stream]).stdout,
      oursRepeats: 1,
      singleStream: false,
    },
  ];
  for (const item of decompress) {
    const caseName = `${label}.${item.name}->tar`;
    if (!wanted(caseName)) continue;
    const stream = item.stream();
    const streamFile = ctx.scratch(`stream.${item.name}`);
    fs.writeFileSync(streamFile, stream);
    const ours = async (): Promise<Buffer> => (await convertWithProject(stream, item.name, 'tar', {}, `${label}.${item.name}`)).buffer;
    const exact = await verified(`our ${item.name} decode`, async () => (item.singleStream ? streamTarMember(ctx, await ours(), original, tarBin) : tarMember(await ours(), tarBin)));
    assertSame(`the ${item.tool} decode`, item.reference(streamFile), original);
    if (ctx.quality && publicSample) rows.push(exactRow(caseName, exact, item.tool));
    if (ctx.speed && exact && timed) {
      rows.push(throughputRow('compression', caseName, original.length, await timeBoth(ctx, speedRowId('compression', caseName), ours, () => item.reference(streamFile), item.oursRepeats), item.tool));
    }
  }
  return rows;
}

/** The compression subject of a public sample: its bytes as the one member of a tar, with its class's ratios pooled. */
function publicSubject(ctx: FamilyContext, sample: RemoteSample, file: string, classes: ClassRows): ArchiveSubject {
  let fixture: MixedFixture | undefined;
  return {
    label: sample.id,
    fixture: (tarBin) => (fixture ??= buildFixture(ctx, tarBin, sample.id, fs.readFileSync(file))),
    soft: true,
    timed: PUBLIC_SPEED_SAMPLES.compression.includes(sample.id),
    onRatio: (target, oursBytes, referenceBytes, originalBytes) => {
      classes.add(sample.class, `.tar->${target}`, SPEC.ratio, oursBytes, referenceBytes, originalBytes);
    },
  };
}

const PACKED_TARGETS = ['zst', '7z', 'zip', 'gz', 'tar.bz2'] as const;
const EXTRACTED_SOURCES = ['zst', 'xz', '7z', 'zip', 'gz', 'bz2', 'rar'] as const;
const FORMAT_REFERENCE: Readonly<Record<string, string>> = { zst: `zstd -${ZSTD_LEVEL}`, '7z': `7z -mx=${SEVEN_ZIP_LEVEL}`, zip: 'zip -6', gz: 'gzip -6', 'tar.bz2': 'bzip2 -9' };

/** Every case of a public sample, with the rows each states. */
function publicCases(sample: RemoteSample): Array<{ caseName: string; specs: readonly MetricSpec[] }> {
  return [
    ...PACKED_TARGETS.map((target) => ({ caseName: `${sample.id}.tar->${target}`, specs: PUBLIC_COMPRESS_SPECS })),
    ...EXTRACTED_SOURCES.map((source) => ({ caseName: `${sample.id}.${source}->tar`, specs: PUBLIC_DECOMPRESS_SPECS })),
  ];
}

export const runCompression: FamilyRunner = async (ctx) => {
  const rows: BenchRow[] = [];
  let mixed: MixedFixture | undefined;
  const mixedSubject: ArchiveSubject = {
    label: 'mixed',
    fixture: (tarBin) => (mixed ??= buildMixedFixture(ctx, tarBin)),
    soft: false,
    timed: true,
  };
  rows.push(...(await runCodecs(ctx, mixedSubject, MIXED_INPUT_FILES)));
  rows.push(...(await runArchiveRows(ctx, mixedSubject)));

  const classes = new ClassRows();
  const samples = remoteSamples('compression');
  for (const sample of samples) for (const target of PACKED_TARGETS) classes.expect(sample.class, `.tar->${target}`, [SPEC.ratio.metric]);
  for (const sample of samples) {
    const cases = publicCases(sample).filter((item) => ctx.inScope('compression', item.caseName));
    // A speed-only run times a few public samples; the others have only quality rows, which it does not measure.
    if (cases.length === 0 || (!ctx.quality && !PUBLIC_SPEED_SAMPLES.compression.includes(sample.id))) continue;
    const file = await ctx.remote(sample);
    if (file === null) {
      for (const item of cases) for (const spec of item.specs) rows.push(skippedRow('compression', item.caseName, spec, 'reference tool', 'optional-tool', `public sample ${sample.id} could not be fetched`));
      continue;
    }
    const subject = publicSubject(ctx, sample, file, classes);
    rows.push(...(await runCodecs(ctx, subject, [sample.id])));
    rows.push(...(await runArchiveRows(ctx, subject)));
  }
  rows.push(...classes.rows('compression', (suffix) => FORMAT_REFERENCE[suffix.slice('.tar->'.length)] ?? 'reference tool').filter((row) => ctx.inScope('compression', row.case)));
  return rows;
};
