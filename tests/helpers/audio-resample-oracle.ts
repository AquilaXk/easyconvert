import { execFileSync } from 'node:child_process';
import { getOracleToolPath, OracleToolMissingError } from './differential-oracle';

/**
 * ffmpeg as an independent audio resampling oracle. Prefers the soxr engine at its
 * highest precision; builds without soxr fall back to the native swr filter bank with a
 * long, sharp filter (`filter_size=64:phase_shift=10:cutoff=0.95`).
 */

const MAX_ORACLE_OUTPUT_BYTES = 256 * 1024 * 1024;
const SOXR_PRECISION_BITS = 28;
const NATIVE_FILTER_SIZE = 64;
const NATIVE_PHASE_SHIFT = 10;
const NATIVE_CUTOFF = 0.95;

export type OracleSampleFormat = 'f32le' | 's16le';

export interface OracleResampleOptions {
  inRate: number;
  outRate: number;
  channels: number;
  /** Interleaved input bytes in the `inFormat` layout. */
  input: Buffer;
  inFormat: OracleSampleFormat;
  outFormat: OracleSampleFormat;
  /** Apply triangular dither when converting to a 16-bit integer output. */
  dither?: boolean;
}

let soxrSupport: boolean | null = null;

export function ffmpegHasSoxr(): boolean {
  if (soxrSupport !== null) return soxrSupport;
  const ffmpeg = getOracleToolPath('ffmpeg');
  if (!ffmpeg) throw new OracleToolMissingError('ffmpeg');
  const conf = execFileSync(ffmpeg, ['-hide_banner', '-buildconf'], { encoding: 'utf-8' });
  soxrSupport = conf.includes('--enable-libsoxr');
  return soxrSupport;
}

export function oracleEngineName(): string {
  return ffmpegHasSoxr() ? `soxr precision=${SOXR_PRECISION_BITS}` : 'swr filter_size=64';
}

export function ffmpegResample(opts: OracleResampleOptions): Buffer {
  const ffmpeg = getOracleToolPath('ffmpeg');
  if (!ffmpeg) throw new OracleToolMissingError('ffmpeg');
  const engine = ffmpegHasSoxr()
    ? `resampler=soxr:precision=${SOXR_PRECISION_BITS}`
    : `filter_size=${NATIVE_FILTER_SIZE}:phase_shift=${NATIVE_PHASE_SHIFT}:cutoff=${NATIVE_CUTOFF}`;
  const dither = opts.dither ? ':dither_method=triangular' : '';
  const filter = `aresample=${engine}:osr=${opts.outRate}${dither}`;
  return execFileSync(
    ffmpeg,
    [
      '-v', 'error',
      '-f', opts.inFormat, '-ar', String(opts.inRate), '-ac', String(opts.channels), '-i', 'pipe:0',
      '-af', filter,
      '-f', opts.outFormat, '-ar', String(opts.outRate), '-ac', String(opts.channels), 'pipe:1',
    ],
    { input: opts.input, maxBuffer: MAX_ORACLE_OUTPUT_BYTES }
  );
}
