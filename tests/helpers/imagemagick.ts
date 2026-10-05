import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * ImageMagick oracle for the image conversion tests. Expected values come from this standard CLI decoder
 * (`-auto-orient`, `identify`, raw RGBA decode), never from the converter under test.
 */

const RGBA_CHANNELS = 4;
const MAX_DECODE_BYTES = 64 * 1024 * 1024;

export interface DecodedRgba {
  width: number;
  height: number;
  /** Interleaved 8-bit R,G,B,A samples, row-major, top row first. */
  data: Buffer;
}

function detectBinary(): 'magick' | 'convert' | null {
  for (const candidate of ['magick', 'convert'] as const) {
    const probe = spawnSync(candidate, ['-version'], { encoding: 'utf-8' });
    if (probe.status === 0 && /ImageMagick/.test(probe.stdout)) return candidate;
  }
  return null;
}

export const MAGICK_BINARY = detectBinary();

/** Tests skip locally when ImageMagick is missing; CI runs them with ORACLE_STRICT_MODE=1, where absence fails. */
export const SKIP_WITHOUT_MAGICK = MAGICK_BINARY === null && process.env.ORACLE_STRICT_MODE !== '1';

export function requireMagick(): 'magick' | 'convert' {
  if (!MAGICK_BINARY) {
    throw new Error('ImageMagick is required by this oracle test but is not installed (ORACLE_STRICT_MODE=1)');
  }
  return MAGICK_BINARY;
}

function convertArgs(args: string[]): string[] {
  return requireMagick() === 'magick' ? ['convert', ...args] : args;
}

function identifyCommand(args: string[]): { file: string; args: string[] } {
  return requireMagick() === 'magick' ? { file: 'magick', args: ['identify', ...args] } : { file: 'identify', args };
}

/** Runs ImageMagick `convert` with the given arguments and returns stdout. */
export function runConvert(args: string[], input?: Buffer): Buffer {
  return execFileSync(requireMagick(), convertArgs(args), { input, maxBuffer: MAX_DECODE_BYTES });
}

/** Runs ImageMagick `identify` on a file and returns stdout. */
export function runIdentify(args: string[]): string {
  const command = identifyCommand(args);
  return execFileSync(command.file, command.args, { encoding: 'utf-8', maxBuffer: MAX_DECODE_BYTES });
}

/** Writes `encoded` to a temp file named `input.<extension>`, runs `run` on it and removes the file. */
export function withTempImage<T>(encoded: Buffer, extension: string, run: (file: string) => T): T {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'img-oracle-'));
  try {
    const file = path.join(dir, `input.${extension}`);
    writeFileSync(file, encoded);
    return run(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Decodes frame `frame` (0-based) of an encoded image to 8-bit RGBA with ImageMagick. */
export function decodeRgba(encoded: Buffer, extension: string, frame = 0): DecodedRgba {
  return withTempImage(encoded, extension, (file) => {
    const target = `${file}[${frame}]`;
    const size = runIdentify(['-format', '%w %h', target]).trim().split(' ').map(Number);
    const [width, height] = size;
    const data = execFileSync(requireMagick(), convertArgs([target, '-depth', '8', 'rgba:-']), {
      maxBuffer: MAX_DECODE_BYTES,
    });
    if (data.length !== width * height * RGBA_CHANNELS) {
      throw new Error(`ImageMagick decoded ${data.length} bytes for a ${width}x${height} frame`);
    }
    return { width, height, data };
  });
}

/** Number of frames (scenes) in an encoded image, as `identify` counts them. */
export function countFrames(encoded: Buffer, extension: string): number {
  return withTempImage(encoded, extension, (file) => runIdentify(['-format', '%n\n', file]).trim().split('\n').length);
}

/** Per-frame delay in milliseconds as `identify` reports it (`%T` is hundredths of a second). */
export function frameDelaysMs(encoded: Buffer, extension: string): number[] {
  const MS_PER_CENTISECOND = 10;
  return withTempImage(encoded, extension, (file) =>
    runIdentify(['-format', '%T\n', file])
      .trim()
      .split('\n')
      .map((value) => Number(value) * MS_PER_CENTISECOND)
  );
}

/** Decodes every frame of an animated image, composited onto the full canvas (`-coalesce`), to RGBA. */
export function decodeCoalescedFrames(encoded: Buffer, extension: string): DecodedRgba[] {
  return withTempImage(encoded, extension, (file) => {
    const dir = path.dirname(file);
    execFileSync(requireMagick(), convertArgs([file, '-coalesce', '+adjoin', path.join(dir, 'frame-%d.png')]), {
      maxBuffer: MAX_DECODE_BYTES,
    });
    const frames: DecodedRgba[] = [];
    for (let index = 0; existsSync(path.join(dir, `frame-${index}.png`)); index += 1) {
      frames.push(decodeRgba(readFileSync(path.join(dir, `frame-${index}.png`)), 'png'));
    }
    return frames;
  });
}

export type Rgb = readonly [number, number, number];

/** Reads the RGBA sample at (x, y). */
export function sampleAt(image: DecodedRgba, x: number, y: number): [number, number, number, number] {
  const offset = (y * image.width + x) * RGBA_CHANNELS;
  return [image.data[offset], image.data[offset + 1], image.data[offset + 2], image.data[offset + 3]];
}
