import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getOracleToolPath } from './differential-oracle';

/**
 * Colour transforms by FFmpeg's zscale filter (the zimg library) and lutrgb, as an oracle independent of the
 * project's own transfer-function and tone-mapping code. Pixels go in and out as planar float32 (gbrpf32le).
 */

const FLOAT_BYTES = 4;
const PLANES = 3;

export const FFMPEG_PATH = getOracleToolPath('ffmpeg');

function filterListed(name: string): boolean {
  if (!FFMPEG_PATH) return false;
  const listing = spawnSync(FFMPEG_PATH, ['-hide_banner', '-filters'], { encoding: 'utf8' });
  return listing.status === 0 && new RegExp(`\\s${name}\\s`).test(listing.stdout);
}

/** True when the installed ffmpeg can run zscale (libzimg) and lutrgb. */
export const HAS_ZSCALE = filterListed('zscale') && filterListed('lutrgb');

/** Tags a planar RGB float stream with the given colour description, for the filters that follow. */
export function tagRgb(primaries: string, transfer: string): string {
  return `setparams=colorspace=gbr:color_primaries=${primaries}:color_trc=${transfer}:range=pc`;
}

/** Interleaved RGB floats in, interleaved RGB floats out, after the filter graph `vf`. */
export function runFloatFilter(rgb: Float32Array, width: number, height: number, vf: string): Float32Array {
  if (!FFMPEG_PATH) throw new Error('ffmpeg is not installed');
  const pixels = width * height;
  const planar = Buffer.alloc(pixels * PLANES * FLOAT_BYTES);
  for (let p = 0; p < pixels; p += 1) {
    // gbrp plane order is G, B, R
    planar.writeFloatLE(rgb[p * 3 + 1], (0 * pixels + p) * FLOAT_BYTES);
    planar.writeFloatLE(rgb[p * 3 + 2], (1 * pixels + p) * FLOAT_BYTES);
    planar.writeFloatLE(rgb[p * 3], (2 * pixels + p) * FLOAT_BYTES);
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), 'zimg-oracle-'));
  try {
    const input = path.join(dir, 'in.f32');
    writeFileSync(input, planar);
    const out = execFileSync(
      FFMPEG_PATH,
      ['-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'gbrpf32le', '-s', `${width}x${height}`, '-i', input, '-vf', `${vf},format=gbrpf32le`, '-f', 'rawvideo', '-pix_fmt', 'gbrpf32le', '-'],
      { maxBuffer: 1 << 30 },
    );
    const planes = new Float32Array(out.buffer.slice(out.byteOffset, out.byteOffset + out.length));
    const result = new Float32Array(pixels * PLANES);
    for (let p = 0; p < pixels; p += 1) {
      result[p * 3] = planes[2 * pixels + p];
      result[p * 3 + 1] = planes[p];
      result[p * 3 + 2] = planes[pixels + p];
    }
    return result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// BT.2390 rendering of HDR pictures for an SDR display, assembled from zscale (zimg) and lutrgb.

const M1 = 0.1593017578125;
const M2 = 78.84375;
const C1 = 0.8359375;
const C2 = 18.8515625;
const C3 = 18.6875;
const FULL_SCALE_16 = 65_535;
const PQ_PEAK = 10_000;
const SDR_NITS = 100;
const BYTE_MAX = 255;

/** ST 2084 inverse EOTF with decimal constants, written independently of the project. */
export function pqOfNits(nits: number): number {
  const y = (nits / PQ_PEAK) ** M1;
  return ((C1 + C2 * y) / (1 + C3 * y)) ** M2;
}

/** ST 2084 EOTF: signal to nits. */
export function nitsOfPq(signal: number): number {
  const p = signal ** (1 / M2);
  return PQ_PEAK * (Math.max(p - C1, 0) / (C2 - C3 * p)) ** (1 / M1);
}

/** ITU-R BT.2390-10 section 5.4 EETF as a lutrgb expression over 16-bit PQ code values. */
export function bt2390Expression(sourcePeak: number, targetPeak: number): string {
  const sp = pqOfNits(sourcePeak);
  const maxLum = pqOfNits(targetPeak) / sp;
  const ks = 1.5 * maxLum - 0.5;
  // lutrgb's own `maxval` is not the 16-bit full scale for this pixel format, so the code range is spelled out.
  const e1 = `min(val/${FULL_SCALE_16}/${sp},1)`;
  const t = `((${e1}-${ks})/${1 - ks})`;
  const spline = `((2*pow(${t},3)-3*pow(${t},2)+1)*${ks}+(pow(${t},3)-2*pow(${t},2)+${t})*${1 - ks}+(-2*pow(${t},3)+3*pow(${t},2))*${maxLum})`;
  return `clip(${FULL_SCALE_16}*${sp}*if(lt(${e1},${ks}),${e1},${spline}),0,${FULL_SCALE_16})`;
}

export type HdrInput = 'linear-nits' | 'pq' | 'hlg';

/**
 * 8-bit sRGB rendering of HDR samples by zscale and lutrgb. `rgb` holds nits (linear-nits), PQ signals (pq) or HLG
 * signals (hlg), in the given primaries. `sourcePeak` is the peak the EETF is built for.
 */
export function renderSdrWithZimg(
  rgb: Float32Array,
  width: number,
  height: number,
  input: HdrInput,
  primaries: 'bt709' | 'bt2020',
  sourcePeak: number,
): Uint8Array {
  const expression = bt2390Expression(sourcePeak, SDR_NITS);
  const toPq: Record<HdrInput, string[]> = {
    'linear-nits': [tagRgb(primaries, 'linear'), `zscale=t=smpte2084:npl=${PQ_PEAK}`],
    pq: [tagRgb(primaries, 'smpte2084')],
    hlg: [tagRgb(primaries, 'arib-std-b67'), `zscale=t=linear:npl=${PQ_PEAK}`, `zscale=t=smpte2084:npl=${PQ_PEAK}`],
  };
  const scaled = input === 'linear-nits' ? rgb.map((v) => v / PQ_PEAK) : rgb;
  const out = runFloatFilter(
    scaled,
    width,
    height,
    [
      ...toPq[input],
      'format=gbrp16le',
      `lutrgb=r='${expression}':g='${expression}':b='${expression}'`,
      'setparams=colorspace=gbr:range=pc',
      `zscale=t=linear:npl=${SDR_NITS}:p=bt709`,
      'zscale=t=iec61966-2-1',
    ].join(','),
  );
  return Uint8Array.from(out, (v) => Math.round(Math.min(1, Math.max(0, v)) * BYTE_MAX));
}

/** PSNR in dB between two equally long 8-bit sample arrays. */
export function psnrDb(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) throw new Error('arrays differ in length');
  let squared = 0;
  for (let i = 0; i < a.length; i += 1) squared += (a[i] - b[i]) ** 2;
  const mse = squared / a.length;
  return mse === 0 ? Infinity : 10 * Math.log10((BYTE_MAX * BYTE_MAX) / mse);
}
