import { RawDecodeError } from '../lib/types';
import { endsInRepeatedRows, type DecodedTiffLayout } from './raw-decoded-tiff';
import { dngRawImageData, type DngRawImageData } from './raw-dng-image-data';

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
function dataCorruptedOffset(stderr: string, inputPath: string): number | null {
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

/** The refusal of a RAW file whose decoded image ends in rows that repeat, the filler a decoder leaves past the end of a cut file. */
export function repeatedRowsRefusal(src: string): RawDecodeError {
  return new RawDecodeError(`The .${src} file is truncated: the decoded image ends in repeated filler rows`);
}

/** Why a DNG that printed the line is refused, for each finding of `dngRawImageData` but `whole`. */
const UNCHECKED_DNG_REASONS: Readonly<Record<Exclude<DngRawImageData, 'whole' | 'outside-file'>, string>> = {
  'not-classic-tiff': 'the file is not a classic TIFF',
  'no-raw-image': 'it lists no CFA or Linear Raw image in a compression the check reads',
  'unreadable-layout': 'its raw image does not list one byte count for each of its strips or tiles, none empty',
  dimensions: 'its raw image is not the size of the decoded picture',
};

function dngRefusal(finding: Exclude<DngRawImageData, 'whole'>, src: string): RawDecodeError {
  if (finding === 'outside-file') return new RawDecodeError(`The .${src} file is truncated: its raw image data runs past the end of the file`);
  return new RawDecodeError(`Native RAW decoder reported corrupted data in the .${src} file, and the file cannot be shown to be whole: ${UNCHECKED_DNG_REASONS[finding]}`);
}

export interface DecoderRun {
  src: string;
  /** The decoder's stderr, trimmed. */
  stderr: string;
  inputPath: string;
  tempDir: string;
  decodedPath: string;
  layout: DecodedTiffLayout;
}

/**
 * The offset of LibRaw's `data corrupted at` line when the decoder's report allows its image to be developed with that warning, or null
 * when the decoder printed nothing. Throws a RawDecodeError for any other report, for the line from a format other than DNG, for a DNG
 * that does not hold every strip or tile of a raw image the size of the decoded picture, and for a decoded image that ends in repeated rows.
 */
export function acceptedDecoderWarning(run: DecoderRun): number | null {
  if (run.stderr === '') return null;
  const offset = run.src === 'dng' ? dataCorruptedOffset(run.stderr, run.inputPath) : null;
  if (offset === null) throw new RawDecodeError(`Native RAW decoder reported a problem with the .${run.src} file: ${decoderStderrDetail(run.stderr, run.tempDir)}`);
  const finding = dngRawImageData(run.inputPath, run.layout);
  if (finding !== 'whole') throw dngRefusal(finding, run.src);
  if (endsInRepeatedRows(run.decodedPath, run.layout)) throw repeatedRowsRefusal(run.src);
  return offset;
}
