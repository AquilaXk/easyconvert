import { UnprocessableFontInputError } from '../types';
import { checkedMtxEot } from './font-eot';
import { runFontProgram, sfntGlyphCount, type FontProgramOptions, type FontProgramSpec } from './font-sandboxed-program';

/**
 * EOT files whose font data is compressed with MicroType Express (MTX, header flag 0x4). The in-process EOT reader takes the last
 * FontDataSize bytes as an sfnt, which holds only for the uncompressed kind; MTX is LZCOMP blocks (adaptive Huffman over a Lempel-Ziv
 * window) around a Compact Table Format that rebuilds glyf, loca and hdmx. libeot (MPL-2.0, W3C member submission code of Monotype under
 * the MTX licence) decodes it, and its `eot2ttf` program runs unmodified as a separate process in the worker sandbox (font-sandboxed-program.ts),
 * which reads the EOT file and writes the TrueType font. FontForge cannot do this: it has no reader for EOT at all (parsettf.c and
 * splinefont.c of 20230101 know no EOT signature, and the file falls through to the Mac resource reader). A missing program is an error.
 */

const PROGRAM: FontProgramSpec = {
  name: 'eot2ttf',
  label: 'eot2ttf',
  pathVariable: 'EOT2TTF_PATH',
  candidates: ['/usr/local/bin/eot2ttf', '/usr/bin/eot2ttf', '/opt/homebrew/bin/eot2ttf'],
  notInstalled: 'eot2ttf (libeot) is not installed or not in PATH',
  defaultTimeoutMs: 60_000,
};

export type MtxEotOptions = FontProgramOptions;

/** The font the program wrote, accepted only if it is an sfnt with a glyph count: whatever else is wrong with it the font reader refuses by name. */
function checkedResult(sfnt: Buffer): Buffer {
  const glyphs = sfntGlyphCount(sfnt);
  if (glyphs === null) throw new UnprocessableFontInputError('eot2ttf wrote something that is not a font with a glyph count.');
  if (glyphs === 0) throw new UnprocessableFontInputError('eot2ttf wrote a font without glyphs.');
  return sfnt;
}

/**
 * Decompresses the MicroType Express font data of an EOT file to an sfnt. Fails with a typed 422 for data the program cannot read or that
 * makes it crash or run out of memory, a typed 413 for a stream past the MTX limits, a typed timeout when the program overruns its time,
 * and an engine-unavailable error (503, retried on another worker) when it is missing. Never returns an estimate.
 */
export async function mtxEotToSfnt(eot: Buffer, options: MtxEotOptions = {}): Promise<Buffer> {
  const written = await runFontProgram(
    PROGRAM,
    { input: checkedMtxEot(eot), inputFile: 'input.eot', outputFile: 'output.ttf', args: (input, output) => [input, output] },
    options,
  );
  return checkedResult(written);
}
