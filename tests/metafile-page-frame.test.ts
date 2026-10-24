import { describe, expect, it } from 'vitest';
import { EMF_HEADER_BYTES, EMR_SETMAPMODE, META_EOF, META_SETWINDOWEXT, MM_ANISOTROPIC, emf, setWindowExtent, wmf, wmfRecord } from './helpers/metafile-headers';
import {
  MAX_METAFILE_PAGE_POINTS,
  MIN_METAFILE_PAGE_POINTS,
  readMetafilePage,
} from '../src/lib/conversions/office/metafile-page-frame';

/**
 * The page of an EMF or WMF file: the frame its header declares, read the way the reference import filter reads it
 * (EMR_HEADER rclFrame of [MS-EMF] 2.2.9, META_PLACEABLE of [MS-WMF] 2.3.2.3 and the window extent of a file without one).
 * The expected sizes are worked out from the layouts in those specifications, not taken from a run of the reader.
 */

const POINTS_PER_MM = 72 / 25.4;

describe('the page of an EMF file', () => {
  it('is the frame of its header, whose edges are both inside the frame, in points', () => {
    const page = readMetafilePage(emf({ frame: [0, 0, 2999, 1999] }), 'emf');
    expect(page?.widthPt).toBeCloseTo(30 * POINTS_PER_MM, 6);
    expect(page?.heightPt).toBeCloseTo(20 * POINTS_PER_MM, 6);
  });

  it('is the size of a frame that is not at the origin', () => {
    const page = readMetafilePage(emf({ frame: [-9313, -36031, -6469, -33063] }), 'emf');
    expect(page?.widthPt).toBeCloseTo(28.45 * POINTS_PER_MM, 6);
    expect(page?.heightPt).toBeCloseTo(29.69 * POINTS_PER_MM, 6);
  });

  it('is scaled by 25.4 over 30 for the file an Adobe application wrote in the anisotropic map mode', () => {
    const adobe = emf({ frame: [0, 0, 2999, 1999], description: 'Adobe Systems\0Adobe Illustrator\0\0', nextRecord: { type: EMR_SETMAPMODE, mode: MM_ANISOTROPIC } });
    const page = readMetafilePage(adobe, 'emf');
    expect(page?.widthPt).toBeCloseTo(30 * (25.4 / 30) * POINTS_PER_MM, 6);
    expect(page?.heightPt).toBeCloseTo(20 * (25.4 / 30) * POINTS_PER_MM, 6);
  });

  it('is not scaled when the producer is another one, or the record after the header is not the anisotropic map mode', () => {
    const plain = { frame: [0, 0, 2999, 1999] as [number, number, number, number] };
    const other = emf({ ...plain, description: 'Microsoft Word\0\0', nextRecord: { type: EMR_SETMAPMODE, mode: MM_ANISOTROPIC } });
    const otherMode = emf({ ...plain, description: 'Adobe Systems\0\0', nextRecord: { type: EMR_SETMAPMODE, mode: 1 } });
    const otherRecord = emf({ ...plain, description: 'Adobe Systems\0\0', nextRecord: { type: 18, mode: MM_ANISOTROPIC } });
    const longer = emf({ ...plain, description: 'Adobe Systems Inc\0\0', nextRecord: { type: EMR_SETMAPMODE, mode: MM_ANISOTROPIC } });
    for (const bytes of [other, otherMode, otherRecord, longer]) expect(readMetafilePage(bytes, 'emf')?.widthPt).toBeCloseTo(30 * POINTS_PER_MM, 6);
  });
});

describe('the page of a WMF file', () => {
  it('is the placeable bounding box over the logical units per inch, in points', () => {
    const page = readMetafilePage(wmf({ placeable: { box: [0, 0, 1439, 719], inch: 1440 } }), 'wmf');
    expect(page?.widthPt).toBeCloseTo(72, 6);
    expect(page?.heightPt).toBeCloseTo(36, 6);
  });

  it('counts 1440 units per inch when the header says 0', () => {
    const page = readMetafilePage(wmf({ placeable: { box: [0, 0, 1439, 719], inch: 0 } }), 'wmf');
    expect(page?.widthPt).toBeCloseTo(72, 6);
  });

  it('follows the unit of a box that does not start at the origin', () => {
    const page = readMetafilePage(wmf({ placeable: { box: [100, 50, 199, 149], inch: 100 } }), 'wmf');
    expect(page?.widthPt).toBeCloseTo(72, 6);
    expect(page?.heightPt).toBeCloseTo(72, 6);
  });

  it('is the first window extent when the file has no placeable header', () => {
    const page = readMetafilePage(wmf({ records: [wmfRecord(0x0103, [8]), setWindowExtent(5103, 2159), wmfRecord(META_EOF, [])] }), 'wmf');
    expect(page?.widthPt).toBeCloseTo((5104 / 1440) * 72, 6);
    expect(page?.heightPt).toBeCloseTo((2160 / 1440) * 72, 6);
  });

  it('is the first window extent when the placeable box is empty', () => {
    const page = readMetafilePage(wmf({ placeable: { box: [0, 0, 0, 0], inch: 720 }, records: [setWindowExtent(719, 359), setWindowExtent(10, 10), wmfRecord(META_EOF, [])] }), 'wmf');
    expect(page?.widthPt).toBeCloseTo(72, 6);
    expect(page?.heightPt).toBeCloseTo(36, 6);
  });

  it('is A4 landscape when a file with no box and no window extent ends', () => {
    const page = readMetafilePage(wmf({}), 'wmf');
    expect(page?.widthPt).toBeCloseTo(((Math.round((1440 * 297) / 25.4) + 1) / 1440) * 72, 6);
    expect(page?.heightPt).toBeCloseTo(((Math.round((1440 * 210) / 25.4) + 1) / 1440) * 72, 6);
  });
});

describe('a header that does not give a page', () => {
  const frame: [number, number, number, number] = [0, 0, 2999, 1999];

  it('is not read from bytes that are no metafile of the format asked for', () => {
    expect(readMetafilePage(Buffer.from('not a metafile at all, only text'), 'emf')).toBeUndefined();
    expect(readMetafilePage(Buffer.from('not a metafile at all, only text'), 'wmf')).toBeUndefined();
    expect(readMetafilePage(emf({ frame }), 'wmf')).toBeUndefined();
    expect(readMetafilePage(wmf({ placeable: { box: [0, 0, 100, 100], inch: 100 } }), 'emf')).toBeUndefined();
    expect(readMetafilePage(Buffer.alloc(0), 'emf')).toBeUndefined();
  });

  it('is not read from an EMF whose signature or header size is wrong, or which stops inside the header', () => {
    const noSignature = emf({ frame });
    noSignature.writeUInt32LE(0, 40);
    const small = emf({ frame });
    small.writeUInt32LE(40, 4);
    const past = emf({ frame });
    past.writeUInt32LE(past.length + 4, 4);
    const unaligned = emf({ frame });
    unaligned.writeUInt32LE(EMF_HEADER_BYTES + 1, 4);
    for (const bytes of [noSignature, small, past, unaligned, emf({ frame }).subarray(0, 60)]) expect(readMetafilePage(bytes, 'emf')).toBeUndefined();
  });

  it('is not read from an EMF frame that is empty, reversed or outside the sizes a PDF page may have', () => {
    const frames: Array<[number, number, number, number]> = [
      [0, 0, 0, 0],
      [100, 0, 50, 100],
      [0, 100, 100, 20],
      [0, 0, 2147483647, 2147483647],
      [-2147483648, -2147483648, 2147483647, 2147483647],
      [0, 0, 10, 10],
      [0, 0, 100000000, 100],
    ];
    for (const rect of frames) expect(readMetafilePage(emf({ frame: rect }), 'emf'), JSON.stringify(rect)).toBeUndefined();
  });

  it('is not read from a WMF box that is reversed, or whose unit makes a page outside the sizes a PDF page may have', () => {
    const boxes: Array<{ box: [number, number, number, number]; inch: number }> = [
      { box: [100, 0, 50, 100], inch: 100 },
      { box: [0, 0, 100, 100], inch: 65535 },
      { box: [-32768, -32768, 32767, 32767], inch: 1 },
      { box: [0, 0, 32767, 32767], inch: 1 },
    ];
    for (const placeable of boxes) expect(readMetafilePage(wmf({ placeable }), 'wmf'), JSON.stringify(placeable)).toBeUndefined();
  });

  it('is not read from a WMF whose records run past the end, are shorter than a record may be, or end before a window extent', () => {
    const header = wmf({ placeable: { box: [0, 0, 0, 0], inch: 1440 }, records: [] });
    const past = Buffer.concat([header, wmfRecord(0x0103, [8])]);
    past.writeUInt32LE(1000, header.length);
    const zeroSize = Buffer.concat([header, wmfRecord(0x0103, [8])]);
    zeroSize.writeUInt32LE(0, header.length);
    const noRecord = Buffer.concat([header, Buffer.from([1, 0])]);
    const shortExtent = Buffer.concat([header, wmfRecord(META_SETWINDOWEXT, [5]), wmfRecord(META_EOF, [])]);
    for (const bytes of [past, zeroSize, noRecord, header, shortExtent]) expect(readMetafilePage(bytes, 'wmf')).toBeUndefined();
  });

  it('is not read from a WMF window extent that is zero or negative', () => {
    for (const [x, y] of [
      [0, 100],
      [100, 0],
      [-100, 100],
    ]) {
      expect(readMetafilePage(wmf({ records: [setWindowExtent(x, y), wmfRecord(META_EOF, [])] }), 'wmf'), `${x} x ${y}`).toBeUndefined();
    }
  });

  it('is found in a time that does not grow with the records of a file that never gives a window extent', () => {
    const filler = wmfRecord(0x0103, [8]);
    const many = wmf({ records: [...Array.from({ length: 200_000 }, () => filler), wmfRecord(META_EOF, [])] });
    const started = performance.now();
    const page = readMetafilePage(many, 'wmf');
    expect(page).toBeDefined();
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('keeps the bounds a PDF page may have: at least 3 points and at most 14400', () => {
    expect({ min: MIN_METAFILE_PAGE_POINTS, max: MAX_METAFILE_PAGE_POINTS }).toEqual({ min: 3, max: 14400 });
    const smallest = emf({ frame: [0, 0, 105, 105] });
    expect(readMetafilePage(smallest, 'emf')?.widthPt).toBeCloseTo((1.06 * 72) / 25.4, 6);
  });
});
