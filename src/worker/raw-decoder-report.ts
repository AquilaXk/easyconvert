import { recordEngineOutput } from '../lib/engine-output';
import { RawDecodeError } from '../lib/types';

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

const DATA_CORRUPTED_INFIX = ': data corrupted at ';
const OFFSET_PATTERN = /^\d{1,15}$/;

/** The offset of the trimmed `stderr` when it is exactly LibRaw's `data corrupted at` line for `inputPath`, else null. */
function dataCorruptedOffset(stderr: string, inputPath: string): number | null {
  const prefix = `${inputPath}${DATA_CORRUPTED_INFIX}`;
  if (!stderr.startsWith(prefix)) return null;
  const digits = stderr.slice(prefix.length);
  return OFFSET_PATTERN.test(digits) ? Number(digits) : null;
}

/** The warning of a developed file whose decoder reported corrupted data at `offset`. */
export function dataCorruptedWarning(offset: number): string {
  return `The RAW decoder reported corrupted data at byte ${offset} of the file; some samples of the picture may be wrong.`;
}

/** Records what the decoder printed when it refused a file; the error that reaches the caller does not carry it. */
export function recordDecoderOutput(stderr: string): void {
  recordEngineOutput('dcraw_emu', 'decode', stderr);
}

export interface DecoderReport {
  src: string;
  /** The decoder's stderr, trimmed. */
  stderr: string;
  inputPath: string;
}

/**
 * What the decoder's report says, read before its image: null when it printed nothing, the offset of LibRaw's `data corrupted at` line
 * when a DNG printed exactly that line, which the engine then checks against the file and the image. Throws a RawDecodeError with the
 * decoder's own words for any other report, and for that line from a format other than DNG.
 */
export function decoderWarningOffset(report: DecoderReport): number | null {
  if (report.stderr === '') return null;
  const offset = report.src === 'dng' ? dataCorruptedOffset(report.stderr, report.inputPath) : null;
  if (offset === null) {
    recordDecoderOutput(report.stderr);
    throw new RawDecodeError(`Native RAW decoder reported a problem with the .${report.src} file.`);
  }
  return offset;
}
