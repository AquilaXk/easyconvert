import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { PSNR_CAP_DB, REPO_ROOT } from '../config';
import type { FamilyContext, FamilyRunner } from '../context';
import { convertWithProject } from '../convert';
import { OutputIntegrityError } from '../errors';
import { measureSsimPsnr } from '../measure';
import { numberRecord, sha256Hex } from '../ref-cache';
import type { BenchRow } from '../report';
import { capPsnr, measuredRow, type MetricSpec, skippedGroup, SPEC, speedRowId, throughputRow } from '../rows';
import { runTool } from '../tools';

/**
 * HDR still-image family: OpenEXR radiance inputs (scanline 16-bit half PIZ with >14-bit Huffman codes, scanline
 * 32-bit float PIZ, and tiled 16-bit half ZIP from tests/fixtures/exr) transcoded to half-float ZIP16 OpenEXR and
 * rendered to 8-bit sRGB PNG (`toneMap: "clip"`), compared against FFmpeg's OpenEXR decoder, encoder and 1D LUT
 * transfer pipeline.
 *
 * Neither the inputs nor the ground-truth pixels come from this repository's conversion code: the fixtures and their
 * `golden-*.f32` linear RGB arrays were written and read back by the OpenEXR C++ reference library and are verified
 * against the SHA-256 digests in tests/fixtures/exr/manifest.json. Half-float decoding in the harness uses V8's
 * built-in `DataView.prototype.getFloat16` and `Math.f16round`, and sRGB truth uses IEC 61966-2-1 directly.
 */

const FAMILY = 'hdr-image';
const REFERENCE = 'ffmpeg';
const TOOLS = ['ffmpeg', 'ffprobe'] as const;
const EXR_DIR = path.join(REPO_ROOT, 'tests', 'fixtures', 'exr');
const MANIFEST_PATH = path.join(EXR_DIR, 'manifest.json');

const RGB_CHANNELS = 3;
const INT32_BYTES = 4;
const FLOAT32_BYTES = 4;
const FLOAT16_BYTES = 2;
const OFFSET_BYTES = 8;
const EXR_PREAMBLE_BYTES = 8;
const BYTE_MAX = 255;
const LUT_1D_SIZE = 4096;
const SRGB_LINEAR_CUTOFF = 0.0031308;
const SRGB_LINEAR_SLOPE = 12.92;
const SRGB_GAMMA_SCALE = 1.055;
const SRGB_GAMMA_OFFSET = 0.055;
const SRGB_GAMMA_EXP = 1 / 2.4;

const FLOAT_PIX_FMT = 'gbrpf32le';
const HALF_PIX_FMT = 'gbrpf16le';

const EXR_QUALITY_SPECS: readonly MetricSpec[] = [SPEC.psnr, SPEC.losslessExact];
const PNG_QUALITY_SPECS: readonly MetricSpec[] = [SPEC.ssim, SPEC.psnr];
const parseExrScore = numberRecord(['psnr', 'losslessExact']);
const parsePngScore = numberRecord(['ssim', 'psnr']);

interface ManifestFixture {
  file: string;
  golden: string;
  layout: 'scanline' | 'tiled';
  width?: number;
  height?: number;
}

interface Manifest {
  width: number;
  height: number;
  fixtures: ManifestFixture[];
  goldens: Record<string, string>;
}

const SAMPLES = [
  'scanline-piz-half-wide-values.exr',
  'scanline-piz-float.exr',
  'tiled-zip-half-one-level.exr',
] as const;

/** Moves an OpenEXR file's dataWindow and displayWindow to (0, 0) in a copy so FFmpeg's exr decoder reads the exact window. */
function moveWindowToOrigin(file: Buffer, scanline: boolean): Buffer {
  const copy = Buffer.from(file);
  const attrs = new Map<string, number>();
  let pos = EXR_PREAMBLE_BYTES;
  while (copy[pos] !== 0) {
    const nameEnd = copy.indexOf(0, pos);
    const typeEnd = copy.indexOf(0, nameEnd + 1);
    const size = copy.readUInt32LE(typeEnd + 1);
    attrs.set(copy.toString('latin1', pos, nameEnd), typeEnd + 1 + INT32_BYTES);
    pos = typeEnd + 1 + INT32_BYTES + size;
  }
  const dataAt = attrs.get('dataWindow');
  const displayAt = attrs.get('displayWindow');
  if (dataAt === undefined || displayAt === undefined) {
    throw new OutputIntegrityError('OpenEXR fixture is missing dataWindow or displayWindow');
  }
  const xMin = copy.readInt32LE(dataAt);
  const yMin = copy.readInt32LE(dataAt + INT32_BYTES);
  const xMax = copy.readInt32LE(dataAt + INT32_BYTES * 2);
  const yMax = copy.readInt32LE(dataAt + INT32_BYTES * 3);
  if (xMin === 0 && yMin === 0) return copy;
  for (const at of [dataAt, displayAt]) {
    copy.writeInt32LE(0, at);
    copy.writeInt32LE(0, at + INT32_BYTES);
    copy.writeInt32LE(xMax - xMin, at + INT32_BYTES * 2);
    copy.writeInt32LE(yMax - yMin, at + INT32_BYTES * 3);
  }
  if (scanline) {
    const tableStart = pos + 1;
    const count = (Number(copy.readBigUInt64LE(tableStart)) - tableStart) / OFFSET_BYTES;
    for (let i = 0; i < count; i += 1) {
      const chunkAt = Number(copy.readBigUInt64LE(tableStart + i * OFFSET_BYTES));
      copy.writeInt32LE(copy.readInt32LE(chunkAt) - yMin, chunkAt);
    }
  }
  return copy;
}

function loadGolden(manifest: Manifest, goldenName: string): { rgb: Float32Array; sha256: string } {
  const bytes = fs.readFileSync(path.join(EXR_DIR, goldenName));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== manifest.goldens[goldenName]) {
    throw new OutputIntegrityError(`${goldenName} does not match the SHA-256 in tests/fixtures/exr/manifest.json`);
  }
  const slice = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length);
  return { rgb: new Float32Array(slice), sha256 };
}

function iecSrgbTransfer(linear: number): number {
  if (!(linear > 0)) return 0;
  if (linear >= 1) return 1;
  return linear <= SRGB_LINEAR_CUTOFF
    ? SRGB_LINEAR_SLOPE * linear
    : SRGB_GAMMA_SCALE * Math.pow(linear, SRGB_GAMMA_EXP) - SRGB_GAMMA_OFFSET;
}

function writeSrgbLutCube(filePath: string): void {
  const lines = [
    'TITLE "IEC61966-2-1"',
    `LUT_1D_SIZE ${LUT_1D_SIZE}`,
    'DOMAIN_MIN 0.0 0.0 0.0',
    'DOMAIN_MAX 1.0 1.0 1.0',
  ];
  for (let i = 0; i < LUT_1D_SIZE; i += 1) {
    const encoded = iecSrgbTransfer(i / (LUT_1D_SIZE - 1)).toFixed(8);
    lines.push(`${encoded} ${encoded} ${encoded}`);
  }
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
}

function escapeFilterPath(filePath: string): string {
  return filePath.replace(/\\/g, '\\\\').replace(/:/g, '\\:');
}

/** Decodes an OpenEXR file with FFmpeg into interleaved linear RGB floats using V8's built-in binary16 reader. */
function decodeExrViaFfmpeg(ffmpeg: string, ffprobe: string, exrFile: string): Float32Array {
  const probeJson = runTool(ffprobe, [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height,pix_fmt',
    '-of',
    'json',
    exrFile,
  ]).stdout.toString('utf8');
  const stream = (JSON.parse(probeJson) as { streams: Array<{ width: number; height: number; pix_fmt: string }> }).streams[0];
  if (!stream) throw new OutputIntegrityError(`ffprobe found no stream in ${path.basename(exrFile)}`);
  const half = stream.pix_fmt === HALF_PIX_FMT;
  const sampleBytes = half ? FLOAT16_BYTES : FLOAT32_BYTES;
  const raw = runTool(ffmpeg, [
    '-v',
    'error',
    '-i',
    exrFile,
    '-frames:v',
    '1',
    '-f',
    'rawvideo',
    '-pix_fmt',
    half ? HALF_PIX_FMT : FLOAT_PIX_FMT,
    '-',
  ]).stdout;
  const pixels = stream.width * stream.height;
  const expectedBytes = pixels * RGB_CHANNELS * sampleBytes;
  if (raw.length !== expectedBytes) {
    throw new OutputIntegrityError(`ffmpeg decoded ${raw.length} bytes for ${path.basename(exrFile)}, expected ${expectedBytes}`);
  }
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const readPlaneSample = (plane: number, pixel: number): number => {
    const byteAt = (plane * pixels + pixel) * sampleBytes;
    return half ? view.getFloat16(byteAt, true) : view.getFloat32(byteAt, true);
  };
  const rgb = new Float32Array(pixels * RGB_CHANNELS);
  for (let i = 0; i < pixels; i += 1) {
    // FFmpeg's gbrpf16le / gbrpf32le pixel formats store planes in G, B, R order.
    rgb[i * RGB_CHANNELS] = readPlaneSample(2, i);
    rgb[i * RGB_CHANNELS + 1] = readPlaneSample(0, i);
    rgb[i * RGB_CHANNELS + 2] = readPlaneSample(1, i);
  }
  return rgb;
}

function scoreExrAgainstGolden(decoded: Float32Array, golden: Float32Array): { psnr: number; losslessExact: number } {
  if (decoded.length !== golden.length) {
    throw new OutputIntegrityError(`decoded EXR sample count ${decoded.length} does not match golden ${golden.length}`);
  }
  let sumSqErr = 0;
  let peak = 1;
  let exactHalf = 1;
  for (let i = 0; i < golden.length; i += 1) {
    const truth = golden[i];
    const absTruth = Math.abs(truth);
    if (absTruth > peak) peak = absTruth;
    const diff = decoded[i] - truth;
    sumSqErr += diff * diff;
    if (!Object.is(decoded[i], Math.f16round(truth))) exactHalf = 0;
  }
  const mse = sumSqErr / golden.length;
  const psnr = mse === 0 ? PSNR_CAP_DB : capPsnr(10 * Math.log10((peak * peak) / mse));
  return { psnr, losslessExact: exactHalf };
}

async function writeClippedSrgbTruthPng(golden: Float32Array, width: number, height: number, outFile: string): Promise<void> {
  const rgb8 = Buffer.allocUnsafe(golden.length);
  for (let i = 0; i < golden.length; i += 1) {
    rgb8[i] = Math.round(iecSrgbTransfer(golden[i]) * BYTE_MAX);
  }
  await sharp(rgb8, { raw: { width, height, channels: RGB_CHANNELS } }).png().toFile(outFile);
}

interface SampleContext {
  ctx: FamilyContext;
  paths: Readonly<Record<string, string>>;
  sampleName: string;
  input: Buffer;
  inputFile: string;
  inputSha256: string;
  golden: Float32Array;
  goldenSha256: string;
  width: number;
  height: number;
  lutFile: string;
}

async function measureExrTarget(s: SampleContext): Promise<BenchRow[]> {
  const caseName = `${s.sampleName}->exr`;
  if (!s.ctx.inScope(FAMILY, caseName)) return [];
  s.ctx.log(`${FAMILY} ${caseName}`);
  const ours = async (): Promise<Buffer> => (await convertWithProject(s.input, 'exr', 'exr', {}, s.sampleName)).buffer;
  const reference = (out: string): void => {
    runTool(s.paths.ffmpeg, ['-v', 'error', '-y', '-i', s.inputFile, '-frames:v', '1', '-c:v', 'exr', '-compression', 'zip16', '-format', 'half', out]);
  };
  const rows: BenchRow[] = [];
  if (s.ctx.quality) {
    const oursFile = s.ctx.scratch(`ours-${s.sampleName}`);
    fs.writeFileSync(oursFile, await ours());
    const oursScore = scoreExrAgainstGolden(decodeExrViaFfmpeg(s.paths.ffmpeg, s.paths.ffprobe, oursFile), s.golden);
    const refScore = await s.ctx.refCache.value(
      FAMILY,
      { kind: 'ffmpeg-exr-half-zip16', tools: [...TOOLS], files: [], settings: { case: caseName, inputSha256: s.inputSha256, goldenSha256: s.goldenSha256 } },
      parseExrScore,
      () => {
        const refFile = s.ctx.scratch(`ref-${s.sampleName}`);
        reference(refFile);
        return scoreExrAgainstGolden(decodeExrViaFfmpeg(s.paths.ffmpeg, s.paths.ffprobe, refFile), s.golden);
      },
    );
    rows.push(
      measuredRow(FAMILY, caseName, SPEC.psnr, oursScore.psnr, refScore.psnr, REFERENCE),
      measuredRow(FAMILY, caseName, SPEC.losslessExact, oursScore.losslessExact, refScore.losslessExact, REFERENCE),
    );
  }
  if (s.ctx.speed) {
    const timingOut = s.ctx.scratch(`timing-${s.sampleName}`);
    const timing = await s.ctx.time(
      speedRowId(FAMILY, caseName),
      async () => {
        await ours();
      },
      () => reference(timingOut),
      'light',
    );
    rows.push(throughputRow(FAMILY, caseName, s.input.length, timing, REFERENCE));
  }
  return rows;
}

async function measurePngTarget(s: SampleContext): Promise<BenchRow[]> {
  const caseName = `${s.sampleName}->png`;
  if (!s.ctx.inScope(FAMILY, caseName)) return [];
  s.ctx.log(`${FAMILY} ${caseName}`);
  const filter = `format=${FLOAT_PIX_FMT},lut1d=file=${escapeFilterPath(s.lutFile)}:interp=linear,format=rgb24`;
  const ours = async (): Promise<Buffer> => (await convertWithProject(s.input, 'exr', 'png', { toneMap: 'clip' }, s.sampleName)).buffer;
  const reference = (out: string): void => {
    runTool(s.paths.ffmpeg, ['-v', 'error', '-y', '-i', s.inputFile, '-vf', filter, '-frames:v', '1', out]);
  };
  const rows: BenchRow[] = [];
  if (s.ctx.quality) {
    const truthFile = s.ctx.scratch(`truth-${s.sampleName}.png`);
    await writeClippedSrgbTruthPng(s.golden, s.width, s.height, truthFile);
    const oursFile = s.ctx.scratch(`ours-${s.sampleName}.png`);
    fs.writeFileSync(oursFile, await ours());
    const size = { width: s.width, height: s.height };
    const scorePng = (file: string): { ssim: number; psnr: number } => {
      const score = measureSsimPsnr(s.paths.ffmpeg, file, truthFile, size);
      return { ssim: score.ssim, psnr: capPsnr(score.psnr) };
    };
    const oursScore = scorePng(oursFile);
    const refScore = await s.ctx.refCache.value(
      FAMILY,
      { kind: 'ffmpeg-exr-clip-srgb-png', tools: [...TOOLS], files: [], settings: { case: caseName, inputSha256: s.inputSha256, goldenSha256: s.goldenSha256, lutSize: LUT_1D_SIZE } },
      parsePngScore,
      () => {
        const refFile = s.ctx.scratch(`ref-${s.sampleName}.png`);
        reference(refFile);
        return scorePng(refFile);
      },
    );
    rows.push(
      measuredRow(FAMILY, caseName, SPEC.ssim, oursScore.ssim, refScore.ssim, REFERENCE),
      measuredRow(FAMILY, caseName, SPEC.psnr, oursScore.psnr, refScore.psnr, REFERENCE),
    );
  }
  if (s.ctx.speed) {
    const timingOut = s.ctx.scratch(`timing-${s.sampleName}.png`);
    const timing = await s.ctx.time(
      speedRowId(FAMILY, caseName),
      async () => {
        await ours();
      },
      () => reference(timingOut),
      'light',
    );
    rows.push(throughputRow(FAMILY, caseName, s.input.length, timing, REFERENCE));
  }
  return rows;
}

export const runHdrImage: FamilyRunner = async (ctx) => {
  const wantedSamples = SAMPLES.filter(
    (name) => ctx.inScope(FAMILY, `${name}->exr`) || ctx.inScope(FAMILY, `${name}->png`),
  );
  if (wantedSamples.length === 0) return [];
  const plan = ctx.plan([...TOOLS], FAMILY);
  if (!plan.ok) {
    return wantedSamples.flatMap((name) => [
      ...(ctx.inScope(FAMILY, `${name}->exr`) ? skippedGroup(FAMILY, `${name}->exr`, [...EXR_QUALITY_SPECS, SPEC.throughput], REFERENCE, plan) : []),
      ...(ctx.inScope(FAMILY, `${name}->png`) ? skippedGroup(FAMILY, `${name}->png`, [...PNG_QUALITY_SPECS, SPEC.throughput], REFERENCE, plan) : []),
    ]);
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as Manifest;
  const lutFile = ctx.scratch('iec61966-2-1.cube');
  writeSrgbLutCube(lutFile);
  const rows: BenchRow[] = [];
  for (const sampleName of wantedSamples) {
    const entry = manifest.fixtures.find((candidate) => candidate.file === sampleName);
    if (!entry) throw new OutputIntegrityError(`${sampleName} is missing from tests/fixtures/exr/manifest.json`);
    const rawFixture = fs.readFileSync(path.join(EXR_DIR, sampleName));
    const input = moveWindowToOrigin(rawFixture, entry.layout === 'scanline');
    const inputFile = ctx.scratch(`input-${sampleName}`);
    fs.writeFileSync(inputFile, input);
    const { rgb: golden, sha256: goldenSha256 } = loadGolden(manifest, entry.golden);
    const sampleCtx: SampleContext = {
      ctx,
      paths: plan.paths,
      sampleName,
      input,
      inputFile,
      inputSha256: sha256Hex(input),
      golden,
      goldenSha256,
      width: entry.width ?? manifest.width,
      height: entry.height ?? manifest.height,
      lutFile,
    };
    rows.push(...(await measureExrTarget(sampleCtx)), ...(await measurePngTarget(sampleCtx)));
  }
  return rows;
};
