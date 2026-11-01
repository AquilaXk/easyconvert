/**
 * What the native RAW decoder (`dcraw_emu` of LibRaw) wrote to stderr, read the way LibRaw writes it.
 *
 * LibRaw has two reports for a file it cannot read as it expects (`LibRaw::derror` in `src/utils/utils_libraw.cpp`, printed by
 * `default_data_callback` in the same file):
 * - `<file>: Unexpected end of file`: the stream ended inside the data. `derror` throws, `unpack` returns an error, `dcraw_emu` prints
 *   "Cannot unpack" and writes no image.
 * - `<file>: data corrupted at <offset>`: the stream did not end, but a decoded value broke a limit of the format (for lossless JPEG,
 *   a sample beyond the bit depth of the frame, `ljpeg_row` in `src/decoders/decoders_dcraw.cpp`). `derror` only counts it, the line
 *   is printed for the first one, and the decode goes on, so the image is written whole (dcraw's own `derror` does the same).
 *
 * Only that second line, naming the file the engine passed and an offset inside it, is a warning. Any other text keeps the file refused.
 */

import fs from 'node:fs';
import { RawDecodeError } from '../lib/types';

/** Longest part of the decoder's stderr an error message quotes. */
export const RAW_DECODE_MAX_STDERR_CHARS = 300;
const DATA_CORRUPTED_INFIX = ': data corrupted at ';
const OFFSET_PATTERN = /^\d{1,15}$/;

type RawDecoderReport = { kind: 'silent' } | { kind: 'unexpected-data'; offset: number } | { kind: 'problem' };

/**
 * Classifies the trimmed stderr of one `dcraw_emu` run over `inputPath`, a file of `inputBytes` bytes. A position LibRaw reports lies
 * before the end of the file, because the end of the file is the other report.
 */
function readRawDecoderReport(stderr: string, inputPath: string, inputBytes: number): RawDecoderReport {
  if (stderr === '') return { kind: 'silent' };
  const prefix = `${inputPath}${DATA_CORRUPTED_INFIX}`;
  if (!stderr.startsWith(prefix)) return { kind: 'problem' };
  const digits = stderr.slice(prefix.length);
  if (!OFFSET_PATTERN.test(digits)) return { kind: 'problem' };
  const offset = Number(digits);
  return offset < inputBytes ? { kind: 'unexpected-data', offset } : { kind: 'problem' };
}

/**
 * The warning lines of a developed file (none when the decoder was silent). A report that is not a warning refuses the file, as does
 * a report that names a `tempDir` path (shown as `<tmp>`).
 */
export function rawDecoderWarnings(stderr: string, inputPath: string, tempDir: string, format: string): string[] {
  const report = readRawDecoderReport(stderr, inputPath, fs.statSync(inputPath).size);
  if (report.kind === 'problem') {
    throw new RawDecodeError(
      `Native RAW decoder reported a problem with the .${format} file: ${stderr.slice(0, RAW_DECODE_MAX_STDERR_CHARS).replaceAll(tempDir, '<tmp>')}`
    );
  }
  if (report.kind === 'silent') return [];
  return [`The RAW decoder reported unexpected sample data near byte ${report.offset} of the file and decoded the whole picture.`];
}
