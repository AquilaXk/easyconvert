/**
 * Metafile headers for tests, written from the layouts of [MS-EMF] 2.2.9 (EMR_HEADER) and [MS-WMF] 2.3.2 (META_PLACEABLE and
 * META_HEADER), so that a test states the frame it expects from the specification and not from a reader.
 */

export const EMF_HEADER_BYTES = 88;
export const EMF_SIGNATURE = 0x464d4520;
export const EMR_SETMAPMODE = 17;
export const MM_ANISOTROPIC = 8;
export const WMF_PLACEABLE_KEY = 0x9ac6cdd7;
export const WMF_PLACEABLE_BYTES = 22;
export const WMF_HEADER_WORDS = 9;
export const META_EOF = 0x0000;
export const META_SETWINDOWEXT = 0x020c;

export interface EmfOptions {
  /** rclFrame in 0.01 mm: left, top, right, bottom (both ends inclusive). */
  frame: [number, number, number, number];
  description?: string;
  nextRecord?: { type: number; mode: number };
  size?: number;
}

export function emf({ frame, description = '', nextRecord, size }: EmfOptions): Buffer {
  const encoded = Buffer.from(description, 'utf16le');
  const text = Buffer.concat([encoded, Buffer.alloc((4 - (encoded.length % 4)) % 4)]);
  const headerSize = size ?? EMF_HEADER_BYTES + text.length;
  const header = Buffer.alloc(headerSize);
  header.writeUInt32LE(1, 0);
  header.writeUInt32LE(headerSize, 4);
  header.writeInt32LE(frame[0], 24);
  header.writeInt32LE(frame[1], 28);
  header.writeInt32LE(frame[2], 32);
  header.writeInt32LE(frame[3], 36);
  header.writeUInt32LE(EMF_SIGNATURE, 40);
  header.writeUInt32LE(0x10000, 44);
  header.writeUInt32LE(2, 52);
  header.writeUInt32LE(description.length, 60);
  header.writeUInt32LE(EMF_HEADER_BYTES, 64);
  header.writeInt32LE(1024, 72);
  header.writeInt32LE(768, 76);
  header.writeInt32LE(320, 80);
  header.writeInt32LE(240, 84);
  text.copy(header, EMF_HEADER_BYTES);
  const records: Buffer[] = [];
  if (nextRecord) {
    const record = Buffer.alloc(12);
    record.writeUInt32LE(nextRecord.type, 0);
    record.writeUInt32LE(12, 4);
    record.writeUInt32LE(nextRecord.mode, 8);
    records.push(record);
  }
  const eof = Buffer.alloc(20);
  eof.writeUInt32LE(14, 0);
  eof.writeUInt32LE(20, 4);
  eof.writeUInt32LE(20, 16);
  const file = Buffer.concat([header, ...records, eof]);
  file.writeUInt32LE(file.length, 48);
  return file;
}

export function wmfRecord(type: number, params: number[]): Buffer {
  const record = Buffer.alloc(6 + params.length * 2);
  record.writeUInt32LE(record.length / 2, 0);
  record.writeUInt16LE(type, 4);
  params.forEach((value, index) => record.writeInt16LE(value, 6 + index * 2));
  return record;
}

export interface WmfOptions {
  /** META_PLACEABLE bounding box (left, top, right, bottom) and logical units per inch; absent for a file without the placeable header. */
  placeable?: { box: [number, number, number, number]; inch: number };
  records?: Buffer[];
}

export function wmf({ placeable, records }: WmfOptions): Buffer {
  const parts: Buffer[] = [];
  if (placeable) {
    const header = Buffer.alloc(WMF_PLACEABLE_BYTES);
    header.writeUInt32LE(WMF_PLACEABLE_KEY, 0);
    placeable.box.forEach((value, index) => header.writeInt16LE(value, 6 + index * 2));
    header.writeUInt16LE(placeable.inch, 14);
    parts.push(header);
  }
  const standard = Buffer.alloc(WMF_HEADER_WORDS * 2);
  standard.writeUInt16LE(1, 0);
  standard.writeUInt16LE(WMF_HEADER_WORDS, 2);
  standard.writeUInt16LE(0x0300, 4);
  return Buffer.concat([...parts, standard, ...(records ?? [wmfRecord(META_EOF, [])])]);
}

export function setWindowExtent(x: number, y: number): Buffer {
  return wmfRecord(META_SETWINDOWEXT, [y, x]);
}

