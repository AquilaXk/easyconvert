import { once } from 'node:events';
import zlib from 'node:zlib';

/**
 * Fixtures for decompression bombs and ordinary compressed files. Every compressed stream is written by Node's zlib
 * streams and every ZIP container by `craftZip`, never by the readers under test.
 */

export const MIB = 1024 * 1024;
/** Decoded size of every bomb: far past what an unbounded decoder could hold without the peak RSS showing it. */
export const BOMB_BYTES = 256 * MIB;

export type StreamKind = 'gzip' | 'rawDeflate';

/** `totalBytes` of zeros compressed by a zlib stream, produced in blocks so the fixture itself stays small. */
export async function compressZeros(totalBytes: number, kind: StreamKind): Promise<Buffer> {
  const stream = kind === 'gzip' ? zlib.createGzip({ level: 9 }) : zlib.createDeflateRaw({ level: 9 });
  const parts: Buffer[] = [];
  stream.on('data', (part: Buffer) => parts.push(part));
  const block = Buffer.alloc(MIB);
  for (let written = 0; written < totalBytes; written += block.length) {
    if (!stream.write(block)) await once(stream, 'drain');
  }
  stream.end();
  await once(stream, 'end');
  return Buffer.concat(parts);
}

/** `head`, `padBytes` spaces and `tail` as one raw deflate stream, produced in blocks so the fixture itself stays small. */
export async function compressPadded(head: string, padBytes: number, tail: string): Promise<Buffer> {
  const stream = zlib.createDeflateRaw({ level: 9 });
  const parts: Buffer[] = [];
  stream.on('data', (part: Buffer) => parts.push(part));
  stream.write(head);
  const block = Buffer.alloc(MIB, 0x20);
  for (let written = 0; written < padBytes; written += block.length) {
    if (!stream.write(written + block.length <= padBytes ? block : block.subarray(0, padBytes - written))) await once(stream, 'drain');
  }
  stream.end(tail);
  await once(stream, 'end');
  return Buffer.concat(parts);
}

/**
 * A raw deflate stream with no final block (it ends at a sync flush) that decodes to `outBytes` bytes, one random byte
 * in every `stride` (about 5.5 bytes of output per input byte at stride 6): the shape on which repairing a ZIP by
 * retrying every prefix of the stream costs quadratic CPU.
 */
export async function unterminatedDeflate(outBytes: number, stride = 6): Promise<Buffer> {
  const payload = Buffer.alloc(outBytes);
  let state = 12345;
  for (let at = 0; at < outBytes; at += stride) {
    state = (state * 1103515245 + 12345) >>> 0;
    payload[at] = state & 0xff;
  }
  const deflater = zlib.createDeflateRaw({ level: 9 });
  const parts: Buffer[] = [];
  deflater.on('data', (part: Buffer) => parts.push(part));
  deflater.write(payload);
  await new Promise<void>((resolve) => deflater.flush(zlib.constants.Z_SYNC_FLUSH, () => resolve()));
  return Buffer.concat(parts);
}

/** Deterministic text of `size` bytes: words drawn from a fixed vocabulary, which deflate shrinks to about a fifth. */
export function compressibleText(size: number, seed = 7): Buffer {
  const vocabulary: string[] = [];
  let state = seed;
  const next = (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state;
  };
  for (let word = 0; word < 4096; word++) {
    let text = '';
    const length = 3 + (next() % 8);
    for (let letter = 0; letter < length; letter++) text += String.fromCharCode(97 + (next() % 26));
    vocabulary.push(text);
  }
  const out = Buffer.alloc(size);
  let at = 0;
  while (at < size) {
    const word = `${vocabulary[next() % vocabulary.length]}${next() % 9 === 0 ? '.\n' : ' '}`;
    at += out.write(word, at, 'latin1');
  }
  return out;
}

const TAR_BLOCK = 512;

/** A POSIX ustar archive of one regular file. */
export function tarOfFile(name: string, content: Buffer): Buffer {
  const header = Buffer.alloc(TAR_BLOCK);
  header.write(name, 0, 'latin1');
  header.write('0000644\0', 100, 'latin1');
  header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124, 'latin1');
  header.write('0', 156, 'latin1');
  header.write('ustar\0', 257, 'latin1');
  header.write('00', 263, 'latin1');
  header.write('        ', 148, 'latin1');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  const padding = Buffer.alloc((TAR_BLOCK - (content.length % TAR_BLOCK)) % TAR_BLOCK);
  return Buffer.concat([header, content, padding, Buffer.alloc(2 * TAR_BLOCK)]);
}

export interface CraftedZipEntry {
  name: string;
  /** The raw deflate stream stored as the entry (method 8). */
  deflated: Buffer;
  /** The uncompressed size the headers declare, which may differ from what the stream decodes to. */
  declaredSize: number;
}

function localHeader(entry: CraftedZipEntry): Buffer {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(8, 8);
  header.writeUInt32LE(entry.deflated.length, 18);
  header.writeUInt32LE(entry.declaredSize, 22);
  header.writeUInt16LE(Buffer.byteLength(entry.name), 26);
  return Buffer.concat([header, Buffer.from(entry.name)]);
}

/** A ZIP of method-8 entries with a central directory, whose declared sizes are the ones given (not checked against the stream). */
export function craftZip(entries: CraftedZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const local = Buffer.concat([localHeader(entry), entry.deflated]);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(entry.deflated.length, 20);
    central.writeUInt32LE(entry.declaredSize, 24);
    central.writeUInt16LE(Buffer.byteLength(entry.name), 28);
    central.writeUInt32LE(offset, 42);
    directory.push(Buffer.concat([central, Buffer.from(entry.name)]));
    parts.push(local);
    offset += local.length;
  }
  const centralBytes = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralBytes, end]);
}

/** A ZIP cut down to the local file header and deflate data of one entry, with no central directory: what repair must salvage. */
export function localEntryOnly(name: string, deflated: Buffer, declaredSize = 0): Buffer {
  return Buffer.concat([localHeader({ name, deflated, declaredSize }), deflated]);
}
