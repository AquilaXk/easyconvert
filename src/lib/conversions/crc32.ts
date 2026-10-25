import zlib from 'node:zlib';

/**
 * CRC-32 (ISO 3309 / ITU-T V.42, reflected polynomial 0xEDB88320), the checksum of ZIP, gzip, xz, 7z, PNG and RAR.
 * Every caller in the project uses `crc32`: it is the zlib routine of the Node.js runtime (`zlib.crc32`, in Node.js 22.2
 * and later; `engines` requires 24), which is the CRC-32 of zlib itself with its vectorised paths.
 */

/** CRC-32 of `buf`, continuing from the CRC `previous` of the bytes before it (0 for a fresh checksum). */
export function crc32(buf: Uint8Array, previous = 0): number {
  return zlib.crc32(buf, previous);
}
