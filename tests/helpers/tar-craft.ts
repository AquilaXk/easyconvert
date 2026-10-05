/**
 * Hand-assembled POSIX ustar/pax header blocks for adversarial TAR tests.
 *
 * Deliberately independent of the module under test: every byte, length and checksum here is
 * computed from the ustar specification (IEEE 1003.1), not from src/lib/conversions/archive.ts.
 */

export const TAR_TEST_BLOCK = 512;

const CHECKSUM_OFFSET = 148;
const CHECKSUM_END = 156;
const SPACE = 0x20;

/** Unsigned header checksum with the chksum field counted as eight spaces. */
export function headerChecksum(header: Buffer): number {
  let sum = 0;
  for (let i = 0; i < TAR_TEST_BLOCK; i++) {
    sum += i >= CHECKSUM_OFFSET && i < CHECKSUM_END ? SPACE : header[i];
  }
  return sum;
}

export interface CraftedHeader {
  name: string;
  typeflag: string;
  size?: number;
  sizeField?: Buffer;
  modeField?: Buffer;
  uidField?: Buffer;
  linkname?: string;
}

export function craftHeader(spec: CraftedHeader): Buffer {
  const header = Buffer.alloc(TAR_TEST_BLOCK);
  header.write(spec.name, 0, 100, 'utf8');
  if (spec.modeField) spec.modeField.copy(header, 100);
  else header.write('0000644\0', 100, 8, 'ascii');
  if (spec.uidField) spec.uidField.copy(header, 108);
  else header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  if (spec.sizeField) spec.sizeField.copy(header, 124);
  else header.write(`${(spec.size ?? 0).toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header.write(spec.typeflag, 156, 1, 'ascii');
  if (spec.linkname) header.write(spec.linkname, 157, 100, 'utf8');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  header.write(`${headerChecksum(header).toString(8).padStart(6, '0')}\0 `, CHECKSUM_OFFSET, 8, 'ascii');
  return header;
}

export function padToBlock(data: Buffer): Buffer {
  const pad = (TAR_TEST_BLOCK - (data.length % TAR_TEST_BLOCK)) % TAR_TEST_BLOCK;
  return Buffer.concat([data, Buffer.alloc(pad)]);
}

export const END_OF_ARCHIVE = Buffer.alloc(TAR_TEST_BLOCK * 2);

/** One pax record `<len> <key>=<value>\n`, where len includes its own digits. */
export function paxRecordBytes(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  const bodyLength = Buffer.byteLength(body);
  let length = bodyLength + 1;
  while (String(length).length + bodyLength !== length) length = String(length).length + bodyLength;
  return Buffer.from(`${length}${body}`);
}

/** A pax extension header (`x` local, `g` global) with its padded record data. */
export function craftPaxHeader(typeflag: 'x' | 'g', ...records: Buffer[]): Buffer {
  const data = Buffer.concat(records);
  return Buffer.concat([
    craftHeader({ name: 'PaxHeaders/entry', typeflag, size: data.length }),
    padToBlock(data),
  ]);
}

/** A complete entry: header plus padded body. */
export function craftEntry(name: string, data: Buffer | string = '', typeflag = '0'): Buffer {
  const body = Buffer.from(data);
  return Buffer.concat([craftHeader({ name, typeflag, size: body.length }), padToBlock(body)]);
}

/** Base-256 numeric field: `first` byte then zeros, with `last` as the final byte. */
export function base256Field(first: number, last: number, length = 12): Buffer {
  const field = Buffer.alloc(length);
  field[0] = first;
  field[length - 1] = last;
  return field;
}
