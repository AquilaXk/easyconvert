import zlib from 'node:zlib';

/** CRC-32 (ISO 3309 / ITU-T V.42, reflected polynomial 0xEDB88320), the checksum of ZIP, gzip, xz, 7z, PNG and RAR. */

/** CRC-32 of `buf`, continuing from the CRC `previous` of the bytes before it (0 for a fresh checksum); the zlib routine of the runtime. */
export function crc32(buf: Uint8Array, previous = 0): number {
  return zlib.crc32(buf, previous);
}
