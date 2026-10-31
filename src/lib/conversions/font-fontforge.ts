import { UnprocessableFontInputError } from '../types';
import { SFNT_HEADER_BYTES, runFontProgram, sfntGlyphCount, type FontProgramOptions, type FontProgramSpec } from './font-sandboxed-program';
import { isType1Format, readType1Font, type Type1Font } from './font-type1';

export { isType1Format };

/**
 * PostScript Type 1 input. The in-process font engine reads SFNT containers only, and a Type 1 outline is a different program (a charstring
 * of Type 1 operators with hints and flex), so FontForge (fontforge-nox, GPL-3.0-or-later) reads the font and writes it as an OpenType font
 * with CFF outlines, which the SFNT pipeline then turns into every target. It runs unmodified as a separate process in the worker sandbox
 * with a time, memory, file-size and network limit (font-sandboxed-program.ts); the script is fixed text and the font and the result are named
 * by arguments, so nothing of the uploaded file is ever part of a command. Its absence is an error: there is no other path that reads these files.
 */

const PROGRAM: FontProgramSpec = {
  name: 'fontforge',
  label: 'FontForge',
  pathVariable: 'FONTFORGE_PATH',
  candidates: ['/usr/bin/fontforge', '/usr/local/bin/fontforge', '/opt/homebrew/bin/fontforge'],
  notInstalled: 'FontForge (fontforge-nox) is not installed or not in PATH',
  defaultTimeoutMs: 60_000,
};
/** FontForge's native scripting language, with the font and the result as the script's first and second argument. */
const SCRIPT_LANGUAGE = '-lang=ff';
const SCRIPT = 'Open($1); Generate($2)';
const OTTO = 'OTTO';

export type FontForgeOptions = FontProgramOptions;

/** The OpenType file FontForge wrote, accepted only if it is whole: an OpenType font that holds every glyph the Type 1 font does. */
function checkedResult(sfnt: Buffer, expectedGlyphs: number): Buffer {
  if (sfnt.length < SFNT_HEADER_BYTES || sfnt.toString('latin1', 0, 4) !== OTTO) {
    throw new UnprocessableFontInputError('FontForge wrote something that is not an OpenType font.');
  }
  const written = sfntGlyphCount(sfnt);
  if (written === null) {
    throw new UnprocessableFontInputError('FontForge wrote an OpenType font without a glyph count.');
  }
  // FontForge exits with success on a font it reads as empty or in part: a font with fewer glyphs than the source is a loss, not a result.
  if (written < expectedGlyphs) {
    throw new UnprocessableFontInputError(`FontForge read ${written} of the ${expectedGlyphs} glyphs of this font, so the result would lose glyphs.`);
  }
  return sfnt;
}

/**
 * Converts a Type 1 font to an OpenType font with CFF outlines (a 'OTTO' file). Fails with a typed 422 for a font FontForge cannot read,
 * one it reads with fewer glyphs than the file holds, and a program that crashes or runs out of memory; a typed timeout when it overruns
 * its time; and an engine-unavailable error (503, retried on another worker) when the program is missing. Never returns an estimate.
 */
export async function type1ToOpenType(font: Type1Font, options: FontForgeOptions = {}): Promise<Buffer> {
  const written = await runFontProgram(
    PROGRAM,
    { input: font.fontFile, inputFile: 'input.pfb', outputFile: 'output.otf', args: (input, output) => [SCRIPT_LANGUAGE, '-c', SCRIPT, input, output] },
    options,
  );
  return checkedResult(written, font.glyphCount);
}

/** A PFA or PFB file as an OpenType font with CFF outlines: checked by the Type 1 reader, converted by FontForge, checked again. */
export async function type1FileToOpenType(file: Buffer, options: FontForgeOptions = {}): Promise<Buffer> {
  return type1ToOpenType(readType1Font(file), options);
}
