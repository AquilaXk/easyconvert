import { isHighEfficiencyNef } from './raw-nef-compression';

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
