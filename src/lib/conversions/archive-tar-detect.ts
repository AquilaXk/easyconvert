import fs from 'node:fs';

/** Recognising a tar by its first block: the `ustar` magic, or the checksum of a header (the test 7-Zip applies). */

const TAR_MAGIC_OFFSET = 257;
const TAR_MAGIC = 'ustar';
const TAR_HEADER_BYTES = 512;

/** POSIX and GNU tars carry `ustar` in their first header; compression wrappers do not rename the inner file reliably. */
export function hasTarMagic(filePath: string): boolean {
  const fd = fs.openSync(filePath, 'r');
  try {
    const header = Buffer.alloc(TAR_HEADER_BYTES);
    const read = fs.readSync(fd, header, 0, TAR_HEADER_BYTES, 0);
    return read === TAR_HEADER_BYTES && header.toString('latin1', TAR_MAGIC_OFFSET, TAR_MAGIC_OFFSET + TAR_MAGIC.length) === TAR_MAGIC;
  } finally {
    fs.closeSync(fd);
  }
}

const TAR_CHECKSUM_OFFSET = 148;
const TAR_CHECKSUM_BYTES = 8;
const TAR_OCTAL_RADIX = 8;
const SPACE = 0x20;
const NUL = 0;
const ASCII_ZERO = 0x30;
const ASCII_SEVEN = 0x37;
const SIGN_BIT = 0x80;
const BYTE_RANGE = 0x100;

/**
 * Whether a 512-byte block is a tar header: the checksum field holds an octal number equal to the sum of the block's
 * bytes with that field read as spaces (the POSIX rule, summed as unsigned or as signed bytes). This is the test 7-Zip
 * applies before it opens a file as a tar, so data that fails it cannot be listed as one, and a v7 tar without the
 * `ustar` magic passes it. A short block, an all-zero block and anything else is not a tar header.
 */
export function isTarHeaderBlock(header: Uint8Array): boolean {
  if (header.length < TAR_HEADER_BYTES) return false;
  let stored = 0;
  let digits = 0;
  let at = TAR_CHECKSUM_OFFSET;
  const fieldEnd = TAR_CHECKSUM_OFFSET + TAR_CHECKSUM_BYTES;
  while (at < fieldEnd && (header[at] === SPACE || header[at] === NUL)) at++;
  while (at < fieldEnd && header[at] >= ASCII_ZERO && header[at] <= ASCII_SEVEN) {
    stored = stored * TAR_OCTAL_RADIX + (header[at] - ASCII_ZERO);
    digits++;
    at++;
  }
  if (digits === 0) return false;
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < TAR_HEADER_BYTES; i++) {
    const inField = i >= TAR_CHECKSUM_OFFSET && i < fieldEnd;
    const byte = inField ? SPACE : header[i];
    unsigned += byte;
    signed += byte >= SIGN_BIT ? byte - BYTE_RANGE : byte;
  }
  return stored === unsigned || stored === signed;
}

/** Whether a 512-byte block carries the POSIX or GNU `ustar` magic. */
export function hasTarMagicBlock(header: Uint8Array): boolean {
  if (header.length < TAR_HEADER_BYTES) return false;
  for (let i = 0; i < TAR_MAGIC.length; i++) {
    if (header[TAR_MAGIC_OFFSET + i] !== TAR_MAGIC.charCodeAt(i)) return false;
  }
  return true;
}

/** Whether the first 512-byte block of `filePath` is a tar header (see {@link isTarHeaderBlock}); a missing or short file is not. */
export function hasTarHeaderChecksum(filePath: string): boolean {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(TAR_HEADER_BYTES);
    return fs.readSync(fd, header, 0, TAR_HEADER_BYTES, 0) === TAR_HEADER_BYTES && isTarHeaderBlock(header);
  } catch {
    return false;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}
