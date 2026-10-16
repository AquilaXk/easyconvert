import { ConversionFailedError } from '../../types';
import { startsWithBytes } from '../package-access';

/**
 * The bytes of a source format with no reader are never taken for text. A ZIP, OLE2 compound file or 7z container, or
 * a file with a null byte in its first 4 KiB, is binary: reading it as UTF8 would pack mojibake into the output, so it is
 * refused with a typed error that names the format.
 */

const BINARY_CONTAINER_SIGNATURES: ReadonlyArray<readonly number[]> = [
  [0x50, 0x4b, 0x03, 0x04],
  [0xd0, 0xcf, 0x11, 0xe0],
  [0x37, 0x7a, 0xbc, 0xaf],
];
const NULL_SCAN_BYTES = 4096;
const NULL_BYTE = 0x00;

export function assertReadableAsText(input: Buffer, format: string): void {
  if (BINARY_CONTAINER_SIGNATURES.some((signature) => startsWithBytes(input, signature))) {
    throw new ConversionFailedError(
      `Cannot extract plain text from binary/compressed container for format '.${format}': fail-closed against mojibake corruption.`
    );
  }
  if (input.subarray(0, NULL_SCAN_BYTES).includes(NULL_BYTE)) {
    throw new ConversionFailedError(`Binary null bytes detected in source format '.${format}': fail-closed against mojibake corruption.`);
  }
}
