import { execFileSync } from 'node:child_process';
import { OracleToolMissingError } from './differential-oracle';
import { MAGICK_BINARY, runConvert } from './imagemagick';

/**
 * ImageMagick as a pixel oracle for tests that also need other CLIs: `convert` renders the fixtures and
 * `compare -metric AE` counts the pixels that differ. Absence is an OracleToolMissingError, so `oracleTest`
 * skips locally and fails under ORACLE_STRICT_MODE=1.
 */

const COMMAND_TIMEOUT_MS = 120_000;
const MAX_STDERR_BYTES = 1 << 20;
/** `compare` exits 1 when the images differ and 2 when it could not compare them. */
const COMPARE_EXIT_DIFFERENT = 1;

function requireMagickOracle(): 'magick' | 'convert' {
  if (!MAGICK_BINARY) throw new OracleToolMissingError('ImageMagick', 'ImageMagick is not installed');
  return MAGICK_BINARY;
}

/** Renders or converts with ImageMagick `convert`. */
export function magickConvert(args: string[]): void {
  requireMagickOracle();
  runConvert(args);
}

/** Number of pixels that differ between two image files, as `compare -metric AE` counts them; 0 is identical. */
export function magickDifferingPixels(a: string, b: string): number {
  const binary = requireMagickOracle();
  const file = binary === 'magick' ? 'magick' : 'compare';
  const args = binary === 'magick' ? ['compare'] : [];
  try {
    execFileSync(file, [...args, '-metric', 'AE', a, b, 'null:'], {
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: MAX_STDERR_BYTES,
    });
    return 0;
  } catch (error) {
    const failure = error as { status?: number; stderr?: Buffer };
    if (failure.status === COMPARE_EXIT_DIFFERENT && failure.stderr) {
      return Number.parseFloat(failure.stderr.toString('utf-8'));
    }
    throw error;
  }
}
