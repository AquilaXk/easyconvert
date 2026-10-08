import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, symlinkSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { convertMedia } from '../src/lib/conversions/media';
import { buildFfmpegArguments, resetHardwareAccelerationCache } from '../src/lib/conversions/media-ffmpeg-args';
import { planVideoToneMap, resetZscaleCache } from '../src/lib/conversions/media-hdr';
import { EngineUnavailableError, InvalidMediaOptionError } from '../src/lib/types';
import { getOracleToolPath } from './helpers/differential-oracle';
import { runConvert } from './helpers/imagemagick';
import { skipUnless, skipWithoutTools } from './helpers/strict-skip';
import { HAS_ZSCALE, decodeFrameFloat, pqOfNits, psnrDb, renderSdrWithZimg } from './helpers/zimg-oracle';

/**
 * HDR video to 8-bit SDR. The input clips are generated with ffmpeg from 16-bit PQ and HLG test pictures; the
 * reference rendering is the still-image oracle (zscale transfer functions and a lutrgb expression of the ITU-R
 * BT.2390 formula) applied to the input's decoded RGB, and the output's tags are read with ffprobe.
 */

const work = mkdtempSync(path.join(os.tmpdir(), 'hdr-video-'));
const WIDTH = 64;
const HEIGHT = 48;
const MIN_VIDEO_PSNR_DB = 35;
const SDR_NITS = 100;
/** Near-lossless H.264, so the comparison measures the colour chain and not the codec. */
const NEAR_LOSSLESS = { video: { codec: 'h264' as const, rateControl: { mode: 'crf' as const, crf: 1 } } };

/** A smooth gradient field as 16-bit signals: the brightest sample is `top`; `grey` makes all channels equal. */
function gradientPng(top: number, grey: boolean): Buffer {
  const samples = new Uint16Array(WIDTH * HEIGHT * 3);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const i = (y * WIDTH + x) * 3;
      const r = (x / (WIDTH - 1)) * top;
      samples[i] = Math.round(r * 65535);
      samples[i + 1] = Math.round((grey ? r : (y / (HEIGHT - 1)) * top * 0.9) * 65535);
      samples[i + 2] = Math.round((grey ? r : (1 - x / (WIDTH - 1)) * top * 0.7) * 65535);
    }
  }
  const raw = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => raw.writeUInt16BE(v, i * 2));
  const rawFile = path.join(work, `gradient-${grey ? 'grey' : 'colour'}-${top}.rgb`);
  writeFileSync(rawFile, raw);
  return runConvert(['-size', `${WIDTH}x${HEIGHT}`, '-depth', '16', '-endian', 'MSB', `rgb:${rawFile}`, '-depth', '16', 'png:-']);
}

/** A one-second 10-bit clip of the gradient with the given transfer, tagged BT.2020 like a phone's HDR video. */
function hdrClip(name: string, transfer: 'smpte2084' | 'arib-std-b67', top: number, grey: boolean): string {
  const png = path.join(work, `${name}.png`);
  writeFileSync(png, gradientPng(top, grey));
  const clip = path.join(work, `${name}.mp4`);
  execFileSync('ffmpeg', [
    '-v', 'error', '-y', '-loop', '1', '-framerate', '25', '-t', '1', '-i', png,
    '-vf', `setparams=colorspace=gbr:color_primaries=bt2020:color_trc=${transfer}:range=pc,zscale=m=2020_ncl:r=tv,format=yuv420p10le`,
    '-c:v', 'libx264', '-profile:v', 'high10', '-crf', '1', '-pix_fmt', 'yuv420p10le',
    '-color_trc', transfer, '-color_primaries', 'bt2020', '-colorspace', 'bt2020nc', '-color_range', 'tv',
    clip,
  ]);
  return clip;
}

function probe(file: string): Record<string, string> {
  const text = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=color_primaries,color_transfer,color_space,color_range,pix_fmt,codec_name,profile', '-of', 'default=nw=1', file], { encoding: 'utf8' });
  return Object.fromEntries(text.trim().split('\n').map((line) => line.split('=')));
}

async function convert(clip: string, options: Parameters<typeof convertMedia>[3]): Promise<string> {
  const result = await convertMedia(readFileSync(clip), 'mp4', 'mp4', { disableHwaccel: true, ...options }, 'hdr');
  const out = path.join(work, `out-${Math.random().toString(36).slice(2)}.mp4`);
  writeFileSync(out, result.buffer);
  return out;
}

function renderedBytes(file: string): Uint8Array {
  const rgb = decodeFrameFloat(file, WIDTH, HEIGHT, 'zscale=m=gbr:r=pc');
  return Uint8Array.from(rgb, (v) => Math.round(Math.min(1, Math.max(0, v)) * 255));
}

describe.skipIf(skipWithoutTools('ffmpeg', 'ffprobe', 'identify') || skipUnless('ffmpeg with zscale and lutrgb', HAS_ZSCALE))('HDR video to SDR', () => {
  const pq = hdrClip('pq', 'smpte2084', pqOfNits(1000), false);
  const hlg = hdrClip('hlg', 'arib-std-b67', 1, true);

  it('HDR10 (PQ, BT.2020) becomes 8-bit BT.709 mp4 instead of an error, tagged as BT.709', async () => {
    expect(probe(pq)).toMatchObject({ color_transfer: 'smpte2084', color_primaries: 'bt2020', pix_fmt: 'yuv420p10le' });
    const out = await convert(pq, {});
    expect(probe(out)).toMatchObject({ color_transfer: 'bt709', color_primaries: 'bt709', color_space: 'bt709', color_range: 'tv', pix_fmt: 'yuv420p', codec_name: 'h264' });
  }, 120_000);

  it('the PQ picture matches the BT.2390 reference rendering within 35 dB', async () => {
    const out = await convert(pq, NEAR_LOSSLESS);
    const source = decodeFrameFloat(pq, WIDTH, HEIGHT, 'zscale=t=smpte2084:p=bt2020:m=gbr:r=pc');
    const reference = renderSdrWithZimg(source, WIDTH, HEIGHT, 'pq', 'bt2020', 1000, 'bt709');
    expect(psnrDb(renderedBytes(out), reference)).toBeGreaterThanOrEqual(MIN_VIDEO_PSNR_DB);
  }, 120_000);

  it('an HLG picture is rendered the same way (grey ramp, where zscale and BT.2100 agree)', async () => {
    const out = await convert(hlg, NEAR_LOSSLESS);
    expect(probe(out)).toMatchObject({ color_transfer: 'bt709', color_primaries: 'bt709' });
    const source = decodeFrameFloat(hlg, WIDTH, HEIGHT, 'zscale=t=arib-std-b67:p=bt2020:m=gbr:r=pc');
    const reference = renderSdrWithZimg(source, WIDTH, HEIGHT, 'hlg', 'bt2020', 1000, 'bt709');
    expect(psnrDb(renderedBytes(out), reference)).toBeGreaterThanOrEqual(MIN_VIDEO_PSNR_DB);
  }, 120_000);

  it('clip keeps the shadows but loses the highlight roll-off that bt2390 keeps', async () => {
    const mapped = renderedBytes(await convert(pq, {}));
    const clipped = renderedBytes(await convert(pq, { toneMap: 'clip' }));
    // green channel of the right-most column: bt2390 keeps a gradient where clip is flat white
    const column = (rgb: Uint8Array): Set<number> => new Set(Array.from({ length: HEIGHT }, (_, y) => rgb[(y * WIDTH + WIDTH - 1) * 3 + 1]));
    expect(column(mapped).size).toBeGreaterThan(column(clipped).size);
    // dark pixels agree: the EETF is the identity below its knee
    const dark = (WIDTH * 2 + 2) * 3;
    expect(Math.abs(mapped[dark] - clipped[dark])).toBeLessThanOrEqual(2);
  }, 120_000);

  it('toneMap "none" keeps refusing 8-bit output, while a 10-bit profile keeps the PQ stream', async () => {
    await expect(convertMedia(readFileSync(pq), 'mp4', 'mp4', { disableHwaccel: true, toneMap: 'none' }, 'hdr')).rejects.toThrow(/HDR input \(transfer "smpte2084"\)/);
    const kept = await convert(pq, { toneMap: 'none', video: { codec: 'h264', profile: 'high10' } });
    expect(probe(kept)).toMatchObject({ color_transfer: 'smpte2084', pix_fmt: 'yuv420p10le' });
  }, 120_000);

  it('an unknown toneMap is a typed option error', async () => {
    const failure = await convertMedia(readFileSync(pq), 'mp4', 'mp4', { disableHwaccel: true, toneMap: 'filmic' as never }, 'hdr').then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(InvalidMediaOptionError);
    expect((failure as Error).message).toMatch(/toneMap "filmic" is not supported; use one of none, clip, bt2390/);
  }, 120_000);

  it('a build without zscale answers EngineUnavailableError (503), not a wrong picture', () => {
    const dir = path.join(work, 'no-zscale');
    mkdirSync(dir, { recursive: true });
    const fake = path.join(dir, 'ffmpeg');
    writeFileSync(fake, '#!/bin/sh\ncase "$*" in\n  *-filters*) echo " T.. scale             V->V       Scale the input video size and/or convert the image format.";;\n  *-encoders*) echo " V....D libx264              libx264 H.264";;\nesac\n', { mode: 0o755 });
    symlinkSync(getOracleToolPath('ffprobe')!, path.join(dir, 'ffprobe'));
    resetHardwareAccelerationCache();
    resetZscaleCache();
    const build = () => buildFfmpegArguments(pq, path.join(work, 'x.mp4'), 'mp4', 'mp4', { disableHwaccel: true }, fake);
    expect(build).toThrow(EngineUnavailableError);
    expect(build).toThrow(/zscale/);
    resetZscaleCache();
  });

  it('SDR input gets no HDR chain and no forced tags', () => {
    const sdr = path.join(work, 'sdr.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=64x48:rate=25:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', sdr]);
    const args = buildFfmpegArguments(sdr, path.join(work, 'y.mp4'), 'mp4', 'mp4', { disableHwaccel: true }, getOracleToolPath('ffmpeg')!);
    expect(args.join(' ')).not.toMatch(/zscale|lutrgb/);
    expect(args).not.toContain('-color_trc');
  });
});

describe('video tone-map plan', () => {
  it.each([
    ['smpte2084', undefined, 1000],
    ['smpte2084', 4000, 4000],
    ['smpte2084', 50, 100],
    ['smpte2084', 50_000, 10_000],
    ['arib-std-b67', 4000, 1000],
  ])('%s with MaxCLL %s builds the curve for %i cd/m2', (transfer, maxCll, expected) => {
    expect(planVideoToneMap(transfer, 'bt2390', maxCll).sourcePeakNits).toBe(expected);
  });

  it('clip builds a plain conversion without the EETF', () => {
    const plan = planVideoToneMap('smpte2084', 'clip', 4000);
    expect(plan.filter).toBe(`zscale=t=linear:npl=${SDR_NITS},format=gbrpf32le,zscale=p=bt709,zscale=t=bt709:m=bt709:r=tv,format=yuv420p`);
    expect(planVideoToneMap('smpte2084', 'bt2390', 4000).filter).toMatch(/^zscale=t=smpte2084:p=bt2020:m=gbr:r=pc,format=gbrp16le,lutrgb=r='clip\(/);
  });
});
