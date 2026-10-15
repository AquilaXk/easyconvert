/**
 * A POSIX ustar reader written from IEEE 1003.1 (pax interchange format, "ustar" header layout) for tests.
 * It checks the header checksum of every block and the end-of-archive marker, and lists the entries. It imports
 * nothing from src, so it is an independent oracle for the archive streams.
 */

const BLOCK = 512;
const NAME_END = 100;
const SIZE_START = 124;
const SIZE_END = 136;
const CHECKSUM_START = 148;
const CHECKSUM_END = 156;
const TYPEFLAG_AT = 156;
const MAGIC_START = 257;
const SPACE = 0x20;

export interface WalkedTarEntry {
  name: string;
  size: number;
  typeflag: string;
}

function field(block: Uint8Array, start: number, end: number): string {
  let stop = start;
  while (stop < end && block[stop] !== 0) stop++;
  return Buffer.from(block.subarray(start, stop)).toString('latin1');
}

function isZeroBlock(block: Uint8Array): boolean {
  return block.every((byte) => byte === 0);
}

/** Lists the entries of a ustar archive; throws on a bad magic, checksum, truncation or missing end marker. */
export function walkTar(bytes: Uint8Array): WalkedTarEntry[] {
  const entries: WalkedTarEntry[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const block = bytes.subarray(offset, offset + BLOCK);
    if (block.length < BLOCK) throw new Error(`tar: truncated header block at ${offset}`);
    if (isZeroBlock(block)) {
      const second = bytes.subarray(offset + BLOCK, offset + 2 * BLOCK);
      if (second.length < BLOCK || !isZeroBlock(second)) throw new Error('tar: lone zero block');
      if (!bytes.subarray(offset).every((byte) => byte === 0)) throw new Error('tar: data after end of archive');
      return entries;
    }
    if (field(block, MAGIC_START, MAGIC_START + 5) !== 'ustar') throw new Error(`tar: no ustar magic at ${offset}`);
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= CHECKSUM_START && i < CHECKSUM_END ? SPACE : block[i];
    const stored = parseInt(field(block, CHECKSUM_START, CHECKSUM_END).trim(), 8);
    if (stored !== sum) throw new Error(`tar: checksum ${stored} != ${sum} at ${offset}`);
    const size = parseInt(field(block, SIZE_START, SIZE_END).trim() || '0', 8);
    const typeflag = String.fromCharCode(block[TYPEFLAG_AT]);
    entries.push({ name: field(block, 0, NAME_END), size, typeflag });
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
  }
  throw new Error('tar: no end-of-archive marker');
}
