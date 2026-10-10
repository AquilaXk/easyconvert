/**
 * A writer for the Unix `compress` (.Z) format: LZW in block mode with 9-bit codes, the layout `compress` and
 * `gzip -d` read. It is a test fixture builder for sources no tool of the CI image can write (ncompress is not
 * installed); `gzip -dc` is the reader that proves its output, in the test that uses it.
 *
 * Only inputs whose code table stays within 9-bit codes are written: wider codes bring the group-of-eight
 * alignment of the real format, which this builder does not reproduce, so it refuses them instead.
 */

const MAGIC = Buffer.from([0x1f, 0x9d]);
/** Flags byte: block mode (0x80) and a maximum code width of 16 bits. */
const FLAGS_BLOCK_MODE_16_BITS = 0x90;
const CODE_BITS = 9;
const BYTE_ALPHABET = 256;
/** In block mode code 256 clears the table, so the first code a string can get is 257. */
const FIRST_FREE_CODE = 257;
/** The decoder widens its codes when its table passes 511 entries; stay clear of that. */
const LAST_CODE_AT_NINE_BITS = 510;
const BITS_PER_BYTE = 8;

export function compressLzw(data: Buffer): Buffer {
  const table = new Map<number, number>();
  const codes: number[] = [];
  let next = FIRST_FREE_CODE;
  let prefix = -1;
  for (const byte of data) {
    if (prefix === -1) {
      prefix = byte;
      continue;
    }
    const key = prefix * BYTE_ALPHABET + byte;
    const known = table.get(key);
    if (known !== undefined) {
      prefix = known;
      continue;
    }
    codes.push(prefix);
    if (next > LAST_CODE_AT_NINE_BITS) throw new RangeError('compressLzw: the input needs codes wider than 9 bits');
    table.set(key, next++);
    prefix = byte;
  }
  if (prefix !== -1) codes.push(prefix);

  const packed = Buffer.alloc(Math.ceil((codes.length * CODE_BITS) / BITS_PER_BYTE));
  let bitPosition = 0;
  for (const code of codes) {
    for (let bit = 0; bit < CODE_BITS; bit++) {
      if ((code >> bit) & 1) packed[bitPosition >> 3] |= 1 << (bitPosition & 7);
      bitPosition += 1;
    }
  }
  return Buffer.concat([MAGIC, Buffer.from([FLAGS_BLOCK_MODE_16_BITS]), packed]);
}
