/**
 * The block checksum of bzip2: CRC-32 with the polynomial 0x04C11DB7 fed most significant bit first, started at all ones
 * and inverted at the end (the polynomial of ZIP and gzip, but not the reflected form that `zlib.crc32` computes).
 * Eight bytes are folded per step through eight 256-entry tables (Kounavis and Berry, "A Systematic Approach to Building
 * High Performance, Software-based, CRC Generators", Intel, 2005, here in the most-significant-first form).
 */

const BZ_CRC_POLY = 0x04c11db7;
const BZ_CRC_INIT = 0xffffffff;
const BZ_CRC_TOP_BIT = 0x80000000;
const BYTE_VALUES = 256;
const BYTE_BITS = 8;
const BYTE_MASK = 0xff;
const TOP_BYTE_SHIFT = 24;
/** Bytes folded per step; the algorithm needs one table per byte of the stride. */
const SLICE_STRIDE = 8;

/** TABLES[k * 256 + b] is the checksum contribution of the byte b followed by k zero bytes. */
const TABLES = new Uint32Array(SLICE_STRIDE * BYTE_VALUES);
for (let value = 0; value < BYTE_VALUES; value++) {
  let c = value << TOP_BYTE_SHIFT;
  for (let bit = 0; bit < BYTE_BITS; bit++) c = c & BZ_CRC_TOP_BIT ? (c << 1) ^ BZ_CRC_POLY : c << 1;
  TABLES[value] = c >>> 0;
}
for (let k = 1; k < SLICE_STRIDE; k++) {
  for (let value = 0; value < BYTE_VALUES; value++) {
    const shorter = TABLES[(k - 1) * BYTE_VALUES + value];
    TABLES[k * BYTE_VALUES + value] = ((shorter << BYTE_BITS) ^ TABLES[shorter >>> TOP_BYTE_SHIFT]) >>> 0;
  }
}

/** The bzip2 block checksum of `buf`. */
export function computeBzBlockCrc(buf: Uint8Array): number {
  const t = TABLES;
  let crc = BZ_CRC_INIT;
  let i = 0;
  const stridedEnd = buf.length - (buf.length % SLICE_STRIDE);
  while (i < stridedEnd) {
    const high = crc ^ ((buf[i] << 24) | (buf[i + 1] << 16) | (buf[i + 2] << 8) | buf[i + 3]);
    crc =
      t[7 * BYTE_VALUES + (high >>> TOP_BYTE_SHIFT)] ^
      t[6 * BYTE_VALUES + ((high >>> 16) & BYTE_MASK)] ^
      t[5 * BYTE_VALUES + ((high >>> 8) & BYTE_MASK)] ^
      t[4 * BYTE_VALUES + (high & BYTE_MASK)] ^
      t[3 * BYTE_VALUES + buf[i + 4]] ^
      t[2 * BYTE_VALUES + buf[i + 5]] ^
      t[BYTE_VALUES + buf[i + 6]] ^
      t[buf[i + 7]];
    i += SLICE_STRIDE;
  }
  for (; i < buf.length; i++) crc = (crc << BYTE_BITS) ^ t[((crc >>> TOP_BYTE_SHIFT) ^ buf[i]) & BYTE_MASK];
  return (crc ^ BZ_CRC_INIT) >>> 0;
}
