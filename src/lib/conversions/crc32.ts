import zlib from 'node:zlib';

/**
 * CRC-32 (ISO 3309 / ITU-T V.42, reflected polynomial 0xEDB88320), the checksum of ZIP, gzip, xz, 7z, PNG and RAR.
 * Every caller in the project uses `crc32`: it is the native zlib routine where Node provides one and a
 * slicing-by-8 table implementation otherwise.
 */

const CRC32_POLYNOMIAL = 0xedb88320;
const CRC32_INITIAL = 0xffffffff;
const TABLE_SIZE = 256;
const BITS_PER_BYTE = 8;
const BYTE_MASK = 0xff;
/** Bytes folded per step of the slicing loop; the algorithm needs one table per byte of the stride. */
const SLICE_STRIDE = 8;

/** TABLES[k][b] is the CRC contribution of byte b followed by k zero bytes. */
const TABLES = new Uint32Array(SLICE_STRIDE * TABLE_SIZE);
for (let n = 0; n < TABLE_SIZE; n++) {
  let c = n;
  for (let bit = 0; bit < BITS_PER_BYTE; bit++) c = c & 1 ? CRC32_POLYNOMIAL ^ (c >>> 1) : c >>> 1;
  TABLES[n] = c >>> 0;
}
for (let n = 0; n < TABLE_SIZE; n++) {
  let c = TABLES[n];
  for (let k = 1; k < SLICE_STRIDE; k++) {
    c = TABLES[c & BYTE_MASK] ^ (c >>> BITS_PER_BYTE);
    TABLES[k * TABLE_SIZE + n] = c >>> 0;
  }
}

/**
 * Slicing-by-8 CRC-32: eight bytes per iteration through eight 256-entry tables (Kounavis and Berry, "A Systematic
 * Approach to Building High Performance, Software-based, CRC Generators", Intel, 2005). `previous` is the CRC of the
 * data that precedes `buf`, so a checksum can be continued across chunks.
 */
export function crc32Slicing8(buf: Uint8Array, previous = 0): number {
  const t = TABLES;
  let c = (previous ^ CRC32_INITIAL) >>> 0;
  let i = 0;
  const end = buf.length;
  const stridedEnd = end - (end % SLICE_STRIDE);
  while (i < stridedEnd) {
    const lo = (c ^ (buf[i] | (buf[i + 1] << 8) | (buf[i + 2] << 16) | (buf[i + 3] << 24))) >>> 0;
    c =
      t[7 * TABLE_SIZE + (lo & BYTE_MASK)] ^
      t[6 * TABLE_SIZE + ((lo >>> 8) & BYTE_MASK)] ^
      t[5 * TABLE_SIZE + ((lo >>> 16) & BYTE_MASK)] ^
      t[4 * TABLE_SIZE + (lo >>> 24)] ^
      t[3 * TABLE_SIZE + buf[i + 4]] ^
      t[2 * TABLE_SIZE + buf[i + 5]] ^
      t[TABLE_SIZE + buf[i + 6]] ^
      t[buf[i + 7]];
    i += SLICE_STRIDE;
  }
  while (i < end) {
    c = t[(c ^ buf[i]) & BYTE_MASK] ^ (c >>> BITS_PER_BYTE);
    i++;
  }
  return (c ^ CRC32_INITIAL) >>> 0;
}

const nativeCrc32: ((data: Uint8Array, value?: number) => number) | undefined =
  typeof zlib.crc32 === 'function' ? (zlib.crc32 as (data: Uint8Array, value?: number) => number) : undefined;

/** CRC-32 of `buf`, continuing from the CRC `previous` of the bytes before it (0 for a fresh checksum). */
export function crc32(buf: Uint8Array, previous = 0): number {
  return nativeCrc32 ? nativeCrc32(buf, previous) : crc32Slicing8(buf, previous);
}
