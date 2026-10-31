import { isMtxCompressedEot } from './font-eot';
import { mtxEotToSfnt } from './font-eot-mtx';
import { isType1Format, type1FileToOpenType } from './font-fontforge';
import type { FontProgramOptions } from './font-sandboxed-program';

/**
 * The sources only a separate program reads: a PostScript Type 1 font (FontForge, into an OpenType font with the same outlines) and an EOT
 * font compressed with MicroType Express (eot2ttf, into a TrueType font). Everything else is read in process by `parseFontToSfnt`.
 */

/** Formats that `parseFontToSfnt` takes before it looks for an EOT signature: Mac containers and WOFF by declared format, WOFF and WOFF2 also by signature. */
const READ_BEFORE_EOT_FORMATS = new Set(['dfont', 'bin', 'woff', 'woff2']);
const READ_BEFORE_EOT_SIGNATURES = new Set(['wOFF', 'wOF2']);

/** The sfnt a program wrote for `file`, or null when `file` is read in process. A failure of the program is thrown, never answered with an estimate. */
export async function readWithExternalProgram(file: Buffer, format: string, options: FontProgramOptions): Promise<Buffer | null> {
  if (isType1Format(format)) return type1FileToOpenType(file, options);
  const readInProcessFirst = READ_BEFORE_EOT_FORMATS.has(format) || READ_BEFORE_EOT_SIGNATURES.has(file.toString('ascii', 0, 4));
  if (!readInProcessFirst && isMtxCompressedEot(file)) return mtxEotToSfnt(file, options);
  return null;
}
