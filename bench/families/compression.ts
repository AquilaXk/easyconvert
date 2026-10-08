import fs from 'node:fs';
import path from 'node:path';
import { convertWithProject } from '../convert';
import type { FamilyRunner } from '../context';
import { OutputIntegrityError } from '../errors';
import type { BenchRow } from '../report';
import { measuredRow, type MetricSpec, skippedGroup, skippedRow, SPEC, throughputRow } from '../rows';
import { interleavedTiming } from '../stats';
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
const COMPRESS_SPECS: readonly MetricSpec[] = [SPEC.ratio, SPEC.throughput];
const DECOMPRESS_SPECS: readonly MetricSpec[] = [SPEC.throughput];

/** Interleaved timing of two actions whose results are not needed. */
function timeBoth(
  ours: () => Promise<unknown>,
  reference: () => unknown,
  ctx: { runs: number; warmup: number }
): ReturnType<typeof interleavedTiming> {
  return interleavedTiming(
    async () => {
      await ours();
    },
    () => {
      reference();
    },
    ctx.runs,
    ctx.warmup
  );
}

/** The single member of a tar, read with the system tar. */
function tarMember(tar: Buffer, tarBin: string): Buffer {
  return runTool(tarBin, ['-xOf', '-'], { input: tar }).stdout;
}

function assertSame(label: string, actual: Buffer, expected: Buffer): void {
  if (!actual.equals(expected)) throw new OutputIntegrityError(`${label} does not decode to the original ${expected.length} bytes (got ${actual.length})`);
}

export const runCompression: FamilyRunner = async (ctx) => {
  const rows: BenchRow[] = [];
  const plan = ctx.plan(['zstd', 'xz', '7z', 'tar'], 'compression');
  if (!plan.ok) {
    for (const [name, ref] of [['zst', 'zstd'], ['7z', '7z'], ['xz', 'xz']] as const) {
      rows.push(...skippedGroup('compression', `mixed.tar->${name}`, COMPRESS_SPECS, ref, plan));
      rows.push(...skippedGroup('compression', `mixed.${name}->tar`, DECOMPRESS_SPECS, ref, plan));
    }
    return rows;
  }
  ctx.log('compression');
  const { zstd, xz, tar: tarBin } = plan.paths;
  const sevenZip = plan.paths['7z'];

  const mixedDir = ctx.scratch('mixed');
  fs.mkdirSync(mixedDir);
  const mixedPath = path.join(mixedDir, MIXED_NAME);
  const original = Buffer.concat([ctx.corpusBuffer('data/records.jsonl'), ctx.corpusBuffer('speech.wav')]);
  fs.writeFileSync(mixedPath, original);
  const tarFile = ctx.scratch('mixed.tar');
  runTool(tarBin, ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-cf', tarFile, '-C', mixedDir, MIXED_NAME]);
  const tar = fs.readFileSync(tarFile);

  // Zstandard compress: ours against zstd, both decoded by the zstd tool.
  const zstdOurs = async (): Promise<Buffer> => (await convertWithProject(tar, 'tar', 'zst', {}, 'mixed.tar')).buffer;
  const zstdRef = (): Buffer => runTool(zstd, [`-${ZSTD_LEVEL}`, '-q', '-c', mixedPath]).stdout;
  const zstdOursBytes = await zstdOurs();
  assertSame('our zst output', runTool(zstd, ['-d', '-q', '-c'], { input: zstdOursBytes }).stdout, original);
  rows.push(measuredRow('compression', 'mixed.tar->zst', SPEC.ratio, zstdOursBytes.length / original.length, zstdRef().length / original.length, `zstd -${ZSTD_LEVEL}`));
  rows.push(
    throughputRow('compression', 'mixed.tar->zst', original.length, await timeBoth(zstdOurs, zstdRef, ctx), `zstd -${ZSTD_LEVEL}`)
  );

  // 7z compress: ours against 7z at the same level, both extracted by the 7z tool.
  const sevenOurs = async (): Promise<Buffer> => (await convertWithProject(tar, 'tar', '7z', { compressionLevel: Number(SEVEN_ZIP_LEVEL) }, 'mixed.tar')).buffer;
  const sevenRefFile = ctx.scratch('ref.7z');
  const sevenRef = (): Buffer => {
    fs.rmSync(sevenRefFile, { force: true });
    runTool(sevenZip, ['a', '-t7z', `-mx=${SEVEN_ZIP_LEVEL}`, '-y', sevenRefFile, MIXED_NAME], { cwd: mixedDir });
    return fs.readFileSync(sevenRefFile);
  };
  const sevenOursBytes = await sevenOurs();
  const sevenOursFile = ctx.scratch('ours.7z');
  fs.writeFileSync(sevenOursFile, sevenOursBytes);
  assertSame('our 7z output', runTool(sevenZip, ['x', '-so', '-y', sevenOursFile]).stdout, original);
  const sevenRefBytes = sevenRef();
  rows.push(measuredRow('compression', 'mixed.tar->7z', SPEC.ratio, sevenOursBytes.length / original.length, sevenRefBytes.length / original.length, `7z -mx=${SEVEN_ZIP_LEVEL}`));
  rows.push(
    throughputRow('compression', 'mixed.tar->7z', original.length, await timeBoth(sevenOurs, sevenRef, ctx), `7z -mx=${SEVEN_ZIP_LEVEL}`)
  );

  // xz compress: the registry offers no xz output target, so only the reference exists for this row.
  const unsupported = 'the format registry offers no xz output target; the reference xz tool is the only producer';
  for (const spec of COMPRESS_SPECS) rows.push(skippedRow('compression', 'mixed.tar->xz', spec, `xz -${XZ_LEVEL}`, 'unsupported', unsupported));

  // Decompress: both sides read the reference tool's stream and the output is checked against the original.
  const decompressCases = [
    {
      name: 'zst',
      tool: `zstd -${ZSTD_LEVEL}`,
      stream: runTool(zstd, [`-${ZSTD_LEVEL}`, '-q', '-c', mixedPath]).stdout,
      reference: (stream: string): Buffer => runTool(zstd, ['-d', '-q', '-c', stream]).stdout,
    },
    {
      name: 'xz',
      tool: `xz -${XZ_LEVEL}`,
      stream: runTool(xz, [`-${XZ_LEVEL}`, '-c', mixedPath]).stdout,
      reference: (stream: string): Buffer => runTool(xz, ['-d', '-c', stream]).stdout,
    },
    {
      name: '7z',
      tool: `7z -mx=${SEVEN_ZIP_LEVEL}`,
      stream: sevenRefBytes,
      reference: (stream: string): Buffer => runTool(sevenZip, ['x', '-so', '-y', stream]).stdout,
    },
  ];
  for (const item of decompressCases) {
    const caseName = `mixed.${item.name}->tar`;
    const streamFile = ctx.scratch(`stream.${item.name}`);
    fs.writeFileSync(streamFile, item.stream);
    const ours = async (): Promise<Buffer> => (await convertWithProject(item.stream, item.name, 'tar', {}, `mixed.${item.name}`)).buffer;
    assertSame(`our ${item.name} decode`, tarMember(await ours(), tarBin), original);
    assertSame(`the ${item.tool} decode`, item.reference(streamFile), original);
    const timing = await timeBoth(ours, () => item.reference(streamFile), ctx);
    rows.push(throughputRow('compression', caseName, original.length, timing, item.tool));
  }
  return rows;
};
