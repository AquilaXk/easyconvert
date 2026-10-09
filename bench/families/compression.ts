import fs from 'node:fs';
import path from 'node:path';
import { convertWithProject } from '../convert';
import type { FamilyContext, FamilyRunner } from '../context';
import { OutputIntegrityError } from '../errors';
import { numberRecord } from '../ref-cache';
import type { BenchRow } from '../report';
import { measuredRow, type MetricSpec, skippedGroup, skippedRow, SPEC, throughputRow } from '../rows';
import { runTool } from '../tools';

/**
 * Compression family: a tar holding one file is converted to zst and 7z, which compress the member; size ratio, compress speed and decompress speed of the project's Zstandard and 7z paths
 * against the zstd, 7z and xz command-line tools at the same level. Every output is decoded by the reference
 * tool and every decode is compared with the original bytes, so a fast path that corrupts data fails the run.
 */

const ZSTD_LEVEL = '3';
const SEVEN_ZIP_LEVEL = '6';
const XZ_LEVEL = '6';
const MIXED_NAME = 'mixed.bin';
const MIXED_INPUT_FILES = ['data/records.jsonl', 'speech.wav'];
const COMPRESS_SPECS: readonly MetricSpec[] = [SPEC.ratio, SPEC.throughput];
const DECOMPRESS_SPECS: readonly MetricSpec[] = [SPEC.throughput];
const parseSize = numberRecord(['bytes']);

/** The single member of a tar, read with the system tar. */
function tarMember(tar: Buffer, tarBin: string): Buffer {
  return runTool(tarBin, ['-xOf', '-'], { input: tar }).stdout;
}

function assertSame(label: string, actual: Buffer, expected: Buffer): void {
  if (!actual.equals(expected)) throw new OutputIntegrityError(`${label} does not decode to the original ${expected.length} bytes (got ${actual.length})`);
}

export const runCompression: FamilyRunner = async (ctx) => {
  const rows: BenchRow[] = [];
  const compressCases = ['zst', '7z', 'xz'].map((name) => `mixed.tar->${name}`);
  const decompressCases = ['zst', 'xz', '7z'].map((name) => `mixed.${name}->tar`);
  const wanted = (caseName: string): boolean => ctx.inScope('compression', caseName);
  if (![...compressCases, ...decompressCases].some(wanted)) return rows;
  const plan = ctx.plan(['zstd', 'xz', '7z', 'tar'], 'compression');
  if (!plan.ok) {
    for (const [name, ref] of [['zst', 'zstd'], ['7z', '7z'], ['xz', 'xz']] as const) {
      if (wanted(`mixed.tar->${name}`)) rows.push(...skippedGroup('compression', `mixed.tar->${name}`, COMPRESS_SPECS, ref, plan));
      if (wanted(`mixed.${name}->tar`)) rows.push(...skippedGroup('compression', `mixed.${name}->tar`, DECOMPRESS_SPECS, ref, plan));
    }
    return rows;
  }
  ctx.log('compression');
  const { zstd, xz, tar: tarBin } = plan.paths;
  const sevenZip = plan.paths['7z'];

  const mixedDir = ctx.scratch('mixed');
  fs.mkdirSync(mixedDir);
  const mixedPath = path.join(mixedDir, MIXED_NAME);
  const original = Buffer.concat(MIXED_INPUT_FILES.map((file) => ctx.corpusBuffer(file)));
  fs.writeFileSync(mixedPath, original);
  const tarFile = ctx.scratch('mixed.tar');
  runTool(tarBin, ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-cf', tarFile, '-C', mixedDir, MIXED_NAME]);
  const tar = fs.readFileSync(tarFile);

  /** Size of the reference tool's output for the mixed input, cached: a function of the tool, its level and the input files. */
  const referenceSize = (tool: string, level: string, compute: () => number): Promise<number> =>
    ctx.refCache
      .value('compression', { kind: `${tool}-size`, tools: [tool], files: MIXED_INPUT_FILES, settings: { level, member: MIXED_NAME } }, parseSize, () => ({ bytes: compute() }))
      .then((entry) => entry.bytes);

  // Zstandard compress: ours against zstd, both decoded by the zstd tool.
  const zstdCase = 'mixed.tar->zst';
  if (wanted(zstdCase)) {
    const zstdOurs = async (): Promise<Buffer> => (await convertWithProject(tar, 'tar', 'zst', {}, 'mixed.tar')).buffer;
    const zstdRef = (): Buffer => runTool(zstd, [`-${ZSTD_LEVEL}`, '-q', '-c', mixedPath]).stdout;
    const zstdOursBytes = await zstdOurs();
    assertSame('our zst output', runTool(zstd, ['-d', '-q', '-c'], { input: zstdOursBytes }).stdout, original);
    if (ctx.quality) {
      const refBytes = await referenceSize('zstd', ZSTD_LEVEL, () => zstdRef().length);
      rows.push(measuredRow('compression', zstdCase, SPEC.ratio, zstdOursBytes.length / original.length, refBytes / original.length, `zstd -${ZSTD_LEVEL}`));
    }
    if (ctx.speed) {
      rows.push(throughputRow('compression', zstdCase, original.length, await timeBoth(ctx, zstdOurs, zstdRef), `zstd -${ZSTD_LEVEL}`));
    }
  }

  // 7z compress: ours against 7z at the same level, both extracted by the 7z tool.
  const sevenOurs = async (): Promise<Buffer> => (await convertWithProject(tar, 'tar', '7z', { compressionLevel: Number(SEVEN_ZIP_LEVEL) }, 'mixed.tar')).buffer;
  const sevenRefFile = ctx.scratch('ref.7z');
  const sevenRef = (): Buffer => {
    fs.rmSync(sevenRefFile, { force: true });
    runTool(sevenZip, ['a', '-t7z', `-mx=${SEVEN_ZIP_LEVEL}`, '-y', sevenRefFile, MIXED_NAME], { cwd: mixedDir });
    return fs.readFileSync(sevenRefFile);
  };
  const sevenCase = 'mixed.tar->7z';
  if (wanted(sevenCase)) {
    const sevenOursBytes = await sevenOurs();
    const sevenOursFile = ctx.scratch('ours.7z');
    fs.writeFileSync(sevenOursFile, sevenOursBytes);
    assertSame('our 7z output', runTool(sevenZip, ['x', '-so', '-y', sevenOursFile]).stdout, original);
    if (ctx.quality) {
      const refBytes = await referenceSize('7z', SEVEN_ZIP_LEVEL, () => sevenRef().length);
      rows.push(measuredRow('compression', sevenCase, SPEC.ratio, sevenOursBytes.length / original.length, refBytes / original.length, `7z -mx=${SEVEN_ZIP_LEVEL}`));
    }
    if (ctx.speed) {
      rows.push(throughputRow('compression', sevenCase, original.length, await timeBoth(ctx, sevenOurs, sevenRef), `7z -mx=${SEVEN_ZIP_LEVEL}`));
    }
  }

  // xz compress: the registry offers no xz output target, so only the reference exists for this row.
  if (wanted('mixed.tar->xz')) {
    const unsupported = 'the format registry offers no xz output target; the reference xz tool is the only producer';
    for (const spec of COMPRESS_SPECS) {
      if ((spec.kind === 'throughput' && ctx.speed) || (spec.kind !== 'throughput' && ctx.quality)) {
        rows.push(skippedRow('compression', 'mixed.tar->xz', spec, `xz -${XZ_LEVEL}`, 'unsupported', unsupported));
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
    },
    {
      name: 'xz',
      tool: `xz -${XZ_LEVEL}`,
      stream: (): Buffer => runTool(xz, [`-${XZ_LEVEL}`, '-c', mixedPath]).stdout,
      reference: (stream: string): Buffer => runTool(xz, ['-d', '-c', stream]).stdout,
    },
    {
      name: '7z',
      tool: `7z -mx=${SEVEN_ZIP_LEVEL}`,
      stream: sevenRef,
      reference: (stream: string): Buffer => runTool(sevenZip, ['x', '-so', '-y', stream]).stdout,
    },
  ];
  for (const item of decompress) {
    const caseName = `mixed.${item.name}->tar`;
    if (!wanted(caseName)) continue;
    const stream = item.stream();
    const streamFile = ctx.scratch(`stream.${item.name}`);
    fs.writeFileSync(streamFile, stream);
    const ours = async (): Promise<Buffer> => (await convertWithProject(stream, item.name, 'tar', {}, `mixed.${item.name}`)).buffer;
    assertSame(`our ${item.name} decode`, tarMember(await ours(), tarBin), original);
    assertSame(`the ${item.tool} decode`, item.reference(streamFile), original);
    if (ctx.speed) {
      rows.push(throughputRow('compression', caseName, original.length, await timeBoth(ctx, ours, () => item.reference(streamFile)), item.tool));
    }
  }
  return rows;
};

/** Interleaved timing of two actions whose results are not needed. */
function timeBoth(ctx: FamilyContext, ours: () => Promise<unknown>, reference: () => unknown): ReturnType<FamilyContext['time']> {
  return ctx.time(
    async () => {
      await ours();
    },
    () => {
      reference();
    },
    'light'
  );
}
