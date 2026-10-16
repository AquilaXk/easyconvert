import fs from 'node:fs';
import path from 'node:path';

/**
 * Running Ghostscript for PostScript sources without the `ps2pdf` shell scripts in front of it.
 *
 * `ps2pdf` is three nested `/bin/sh` scripts (`ps2pdf`, `ps2pdf14`, `ps2pdfwr`) that end in `exec gs ...`; the last one
 * finds `gs` next to itself. Starting the scripts costs about 2 ms before the interpreter even loads (23 ms in all for a
 * small figure), so when the interpreter sits next to the configured `ps2pdf` the worker starts it with the arguments the
 * scripts would have built. When it does not (a stand-in script, an unusual layout), the configured `ps2pdf` runs as before.
 *
 * An EPS that becomes a PNG is drawn by the interpreter itself, once, straight to pixels: the PDF in between (and the
 * second program that read it) added a full interpreter start and a page description the figure did not need.
 */

const GHOSTSCRIPT_NAME = 'gs';
/** Sub-sample anti-aliasing of vector graphics and of text: the highest the interpreter offers (a value of 4). */
const ALPHA_BITS = '4';
/** The PDF level `ps2pdf` writes (the `ps2pdf14` script). */
const PDF_COMPATIBILITY_LEVEL = '1.4';

/** The `gs` that `ps2pdf` would start: the one in the same directory, as the last script of `ps2pdf` looks for it. */
export function siblingGhostscript(ps2pdfPath: string): string | null {
  const candidate = path.join(path.dirname(ps2pdfPath), GHOSTSCRIPT_NAME);
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return candidate;
  } catch {
    return null;
  }
}

/**
 * Input size up to which the interpreter runs without its garbage collector. The collector's first pass runs while the
 * interpreter starts and takes about 2 ms of a 22 ms run; a small figure never allocates enough for it to matter. A
 * program that does allocate without end is stopped by the memory limit, and the worker then runs it again with the
 * collector on (see `isInterpreterMemoryExhaustion` in engines.ts).
 */
export const NO_GARBAGE_COLLECTION_MAX_INPUT_BYTES = 128 * 1024;

export function skipsGarbageCollection(inputBytes: number): boolean {
  return inputBytes <= NO_GARBAGE_COLLECTION_MAX_INPUT_BYTES;
}

const NO_GARBAGE_COLLECTION_FLAG = '-dNOGC';

/** The command line `ps2pdf -dSAFER [-dEPSCrop] input output` ends in, minus the repeated options. */
export function ghostscriptPdfArguments(cropToBoundingBox: boolean, inputPath: string, outputPath: string, noGarbageCollection = false): string[] {
  return [
    '-P-',
    '-dSAFER',
    `-dCompatibilityLevel=${PDF_COMPATIBILITY_LEVEL}`,
    ...(cropToBoundingBox ? ['-dEPSCrop'] : []),
    '-q',
    '-dNOPAUSE',
    '-dBATCH',
    ...(noGarbageCollection ? [NO_GARBAGE_COLLECTION_FLAG] : []),
    '-sDEVICE=pdfwrite',
    '-sstdout=%stderr',
    `-sOutputFile=${outputPath}`,
    inputPath,
  ];
}

/** Pages as binary PPM, written to `output` (a file name pattern with `%d`, or `-` for the standard output), drawn at `dpi` with anti-aliasing. */
export function ghostscriptRasterArguments(cropToBoundingBox: boolean, dpi: number, inputPath: string, output: string, noGarbageCollection = false): string[] {
  return [
    '-P-',
    '-dSAFER',
    '-q',
    '-dNOPAUSE',
    '-dBATCH',
    ...(noGarbageCollection ? [NO_GARBAGE_COLLECTION_FLAG] : []),
    ...(cropToBoundingBox ? ['-dEPSCrop'] : []),
    '-sDEVICE=ppmraw',
    `-dGraphicsAlphaBits=${ALPHA_BITS}`,
    `-dTextAlphaBits=${ALPHA_BITS}`,
    `-r${dpi}`,
    '-sstdout=%stderr',
    `-sOutputFile=${output}`,
    inputPath,
  ];
}
