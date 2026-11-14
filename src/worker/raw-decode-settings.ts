import { isHighEfficiencyNef } from './raw-nef-compression';
import { SandboxedProcessError } from './sandbox';

/** Settings of the native RAW decode (`dcraw_emu`, run in the process sandbox by `convertWithNativeRaw`). */
export const RAW_DECODE_DEFAULT_TIMEOUT_MS = 120_000;
export const RAW_DECODE_MAX_TIMEOUT_MS = 600_000;
/** Address-space ceiling for the decoder: room for the largest sensor plus LibRaw's working buffers. */
export const RAW_DECODE_MEMORY_LIMIT_MB = 4096;
export const RAW_DECODE_UNRECOGNIZED_PATTERN = /unsupported file format|not raw file/i;
/** dcraw_emu: write a TIFF (-T) with 16-bit samples (-6), camera white balance (-w) in sRGB (-o 1). */
export const RAW_DECODE_FLAGS: readonly string[] = ['-T', '-6', '-w', '-o', '1'];

/**
 * The `dcraw_emu` that decodes `inputPath`: the distribution's, except for a Nikon NEF whose maker note says High Efficiency or High
 * Efficiency*, which only the pinned LibRaw snapshot of `scripts/install-libraw-he.sh` reads. Where `highEfficiencyDecoder` finds no
 * such program the distribution's runs as before and refuses the file with its own words.
 */
export function rawDecoderFor(src: string, inputPath: string, distributionDecoder: string, highEfficiencyDecoder: () => string | null): string {
  if (src !== 'nef' || !isHighEfficiencyNef(inputPath)) return distributionDecoder;
  return highEfficiencyDecoder() ?? distributionDecoder;
}

/**
 * Runs `decode` with the distribution's `dcraw_emu` and, when LibRaw answers "Unsupported file format or not RAW file" (a camera its
 * release does not list: the Sony ILCE-7M5 is in the pinned snapshot, since 2026-05-21, and not in 0.22.3), once more with the pinned
 * snapshot, which lists more of them. The refusal of the snapshot stands when it refuses too; any other failure, and a snapshot that is not
 * installed, leave the first answer alone. A file the distribution's LibRaw reads never reaches the snapshot.
 */
export async function decodeWithSnapshotFallback<T>(decode: (program: string) => Promise<T>, program: string, snapshotDecoder: () => string | null): Promise<T> {
  try {
    return await decode(program);
  } catch (err) {
    const snapshot = err instanceof SandboxedProcessError && RAW_DECODE_UNRECOGNIZED_PATTERN.test(err.stderr) ? snapshotDecoder() : null;
    if (snapshot === null || snapshot === program) throw err;
    return decode(snapshot);
  }
}
