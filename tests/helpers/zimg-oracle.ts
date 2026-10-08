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
