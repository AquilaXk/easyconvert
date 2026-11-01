/**
 * What the native RAW decoder (`dcraw_emu` of LibRaw) wrote to stderr, read the way LibRaw writes it.
 *
 * LibRaw has two reports for a file it cannot read as it expects (`LibRaw::derror` in `src/utils/utils_libraw.cpp`, printed by
 * `default_data_callback` in the same file):
 * - `<file>: Unexpected end of file`: the stream ended inside the data. `derror` throws, `unpack` returns an error, `dcraw_emu` prints
 *   "Cannot unpack" and writes no image.
 * - `<file>: data corrupted at <offset>`: the stream did not end, but a decoded value broke a limit of the format (for lossless JPEG,
 *   a sample beyond the bit depth of the frame, `ljpeg_row` in `src/decoders/decoders_dcraw.cpp`). `derror` counts it, prints it for the
 *   first one only and the decode goes on. After that first report `derror` no longer checks for the end of the stream, so a file cut
 *   later decodes to a full-size image with no other line: whether the image is whole is for the engine's own checks to decide.
 */

/** Longest part of the decoder's stderr an error message quotes. */
const MAX_DETAIL_CHARS = 300;
const DATA_CORRUPTED_INFIX = ': data corrupted at ';
const OFFSET_PATTERN = /^\d{1,15}$/;

/** The offset of the trimmed `stderr` when it is exactly LibRaw's `data corrupted at` line for `inputPath`, else null. */
export function dataCorruptedOffset(stderr: string, inputPath: string): number | null {
  const prefix = `${inputPath}${DATA_CORRUPTED_INFIX}`;
  if (!stderr.startsWith(prefix)) return null;
  const digits = stderr.slice(prefix.length);
  return OFFSET_PATTERN.test(digits) ? Number(digits) : null;
}

/** The decoder's stderr as an error message quotes it: the working directory shown as `<tmp>`, then cut to length. */
export function decoderStderrDetail(stderr: string, tempDir: string): string {
  return stderr.replaceAll(tempDir, '<tmp>').slice(0, MAX_DETAIL_CHARS);
}

/** The warning of a developed file whose decoder reported corrupted data at `offset`. */
export function dataCorruptedWarning(offset: number): string {
  return `The RAW decoder reported corrupted data at byte ${offset} of the file; some samples of the picture may be wrong.`;
}
