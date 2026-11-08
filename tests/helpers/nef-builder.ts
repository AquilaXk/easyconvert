/**
 * A Nikon NEF reduced to what the reader of the compression looks at: a classic TIFF whose IFD0 holds the Exif pointer, whose Exif IFD holds
 * the maker note, and a Nikon maker note of the layout with a TIFF header of its own that holds one entry, tag 0x0051 (the 24 byte
 * block of the Z bodies, the compression at offset 10) or tag 0x0093 (a SHORT). It has no image data.
 */
export interface NefShape {
  little?: boolean;
  makerLittle?: boolean;
  tag?: 0x51 | 0x93;
  value: number;
  /** The maker note header: "Nikon\0" and the version of the layout with a TIFF header of its own (2). */
  header?: Buffer;
  exifTag?: number;
  makerNoteTag?: number;
}

/** A classic TIFF: IFD0 with the Exif pointer, the Exif IFD with the maker note, the Nikon type 3 maker note with one entry. */
export function buildNef(shape: NefShape): Buffer {
  const little = shape.little ?? true;
  const makerLittle = shape.makerLittle ?? little;
  const w16 = (b: Buffer, at: number, v: number, le: boolean) => (le ? b.writeUInt16LE(v, at) : b.writeUInt16BE(v, at));
  const w32 = (b: Buffer, at: number, v: number, le: boolean) => (le ? b.writeUInt32LE(v, at) : b.writeUInt32BE(v, at));
  const header = shape.header ?? Buffer.from([0x4e, 0x69, 0x6b, 0x6f, 0x6e, 0x00, 0x02, 0x11, 0x00, 0x00]);
  const exifAt = 8 + 2 + 12 + 4;
  const noteAt = exifAt + 2 + 12 + 4;
  const noteIfd = 8; // relative to the maker note TIFF header
  const entryTag = shape.tag ?? 0x51;
  const block = Buffer.alloc(24);
  block.write('0100', 0, 'latin1');
  w16(block, 10, shape.value, makerLittle);
  const noteTiff = Buffer.alloc(8 + 2 + 12 + 4 + (entryTag === 0x51 ? block.length : 0));
  noteTiff.write(makerLittle ? 'II' : 'MM', 0, 'latin1');
  w16(noteTiff, 2, 42, makerLittle);
  w32(noteTiff, 4, noteIfd, makerLittle);
  w16(noteTiff, 8, 1, makerLittle);
  w16(noteTiff, 10, entryTag, makerLittle);
  if (entryTag === 0x51) {
    w16(noteTiff, 12, 7, makerLittle);
    w32(noteTiff, 14, block.length, makerLittle);
    w32(noteTiff, 18, 8 + 2 + 12 + 4, makerLittle);
    block.copy(noteTiff, 8 + 2 + 12 + 4);
  } else {
    w16(noteTiff, 12, 3, makerLittle);
    w32(noteTiff, 14, 1, makerLittle);
    w16(noteTiff, 18, shape.value, makerLittle);
  }
  const note = Buffer.concat([header, noteTiff]);
  const file = Buffer.alloc(noteAt + note.length);
  file.write(little ? 'II' : 'MM', 0, 'latin1');
  w16(file, 2, 42, little);
  w32(file, 4, 8, little);
  w16(file, 8, 1, little);
  w16(file, 10, shape.exifTag ?? 0x8769, little);
  w16(file, 12, 4, little);
  w32(file, 14, 1, little);
  w32(file, 18, exifAt, little);
  w16(file, exifAt, 1, little);
  w16(file, exifAt + 2, shape.makerNoteTag ?? 0x927c, little);
  w16(file, exifAt + 4, 7, little);
  w32(file, exifAt + 6, note.length, little);
  w32(file, exifAt + 10, noteAt, little);
  note.copy(file, noteAt);
  return file;
}
