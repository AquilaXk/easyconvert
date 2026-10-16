import { execFileSync } from 'node:child_process';
import { MAGICK_BINARY } from './imagemagick';

/** Whether the installed ImageMagick lists a coder that reads `format` (a Homebrew build without the HEIF module lists none). */
export function magickReads(format: string): boolean {
  if (MAGICK_BINARY === null) return false;
  try {
    const listing = execFileSync(MAGICK_BINARY, ['-list', 'format'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    // Version 7 lists `NAME* MODULE mode`, version 6 lists `NAME mode`; a coder that reads has a mode starting with `r`.
    return new RegExp(`^\\s*${format}\\*?\\s+(?:[A-Z0-9]+\\s+)?r[w-][+-]`, 'm').test(listing);
  } catch {
    return false;
  }
}
