import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { withIncrementalUpdate } from '../src/lib/conversions/pdf-incremental-update';
import { InlinePictureCollector, planPictureDecoding } from '../src/lib/conversions/pdf-picture-guard';
import { jpxCodestream } from '../src/lib/conversions/pdf-picture-headers';
import { pdfjsReadableBytes } from '../src/lib/conversions/pdf-reader-input';
import { assertPdfStreamsWithinLimits } from '../src/lib/conversions/pdf-stream-guard';
import { HELVETICA_FONT, buildPdf, textContent, type CraftObject } from './helpers/pdf-craft';

/**
 * Which pictures the check of pdf-picture-guard.ts leaves out, from the headers of hand-made pictures that pass a limit only when
 * the check reads them as pdf.js does (pdf.worker.mjs of pdfjs-dist 6.3.289): the keys and abbreviations of the dictionary, an
 * indirect /Subtype, the file header of a JBIG2 stream, any stream with a picture codec filter. No picture here is decoded, so
 * the pictures hold headers and filler only. Then the cost of the check itself on files built to make it run on.
 */

const PAGE_OBJECTS: CraftObject[] = [
  { id: 1, dict: '/Type /Catalog /Pages 2 0 R' },
  { id: 2, dict: '/Type /Pages /Kids [3 0 R] /Count 1' },
  { id: 5, raw: HELVETICA_FONT },
];
const FIRST_PICTURE = 10;
const HUGE_SIDE = 65_535;
/** The hostile CCITT picture: /Columns and rows of 65,535, past the 100 million pixels a decoder may walk. */
const HUGE_CCITT = `/Width 8 /Height ${HUGE_SIDE} /BitsPerComponent 1 /ColorSpace /DeviceGray`;
const HOSTILE_TIME_MS = 3_000;
const MIB = 1024 * 1024;

interface Picture {
  /** The image dictionary without `/Type /XObject /Subtype /Image`. */
  dict: string;
  stream: Buffer;
  /** The /Subtype entry, when it is not the name /Image. */
  subtype?: string;
}

function content(pictureCount: number, inline = ''): Buffer {
  const draws = Array.from({ length: pictureCount }, (_, index) => `q 64 0 0 32 72 700 cm /Im${index} Do Q`).join('\n');
  return Buffer.from(textContent('Pictures', 740) + draws + inline, 'latin1');
}

/** One page that draws each picture as its own image XObject (object numbers from 10), with `extra` objects beside them. */
function picturesPdf(pictures: Picture[], extra: CraftObject[] = [], inline = ''): Buffer {
  const names = pictures.map((_, index) => `/Im${index} ${FIRST_PICTURE + index} 0 R`).join(' ');
  return buildPdf(
    [
      ...PAGE_OBJECTS,
      { id: 3, dict: `/Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> /XObject << ${names} >> >>` },
      { id: 4, stream: content(pictures.length, inline) },
      ...pictures.map((picture, index): CraftObject => ({ id: FIRST_PICTURE + index, dict: `/Type /XObject /Subtype ${picture.subtype ?? '/Image'} ${picture.dict}`, stream: picture.stream })),
      ...extra,
    ],
    1
  ).buffer;
}

/** The numbers of the image objects the reader leaves out, by the plan it makes for `pdf`. */
function droppedBy(pdf: Buffer): number[] {
  const inline = new InlinePictureCollector();
  const document = assertPdfStreamsWithinLimits(pdf, inline.visit);
  return planPictureDecoding(document, inline)
    .dropped.map(({ num }) => num)
    .sort((a, b) => a - b);
}

/** A JPEG 2000 main header (ISO 15444-1 A.5.1 SIZ, A.6.1 COD) for a `side` x `side` image in one tile, and no tile data. */
function jpxHeader({ side, components = 1, levels = 5 }: { side: number; components?: number; levels?: number }): Buffer {
  const siz = Buffer.alloc(40 + 3 * components);
  siz.writeUInt16BE(0xff51, 0);
  siz.writeUInt16BE(38 + 3 * components, 2);
  siz.writeUInt32BE(side, 6);
  siz.writeUInt32BE(side, 10);
  siz.writeUInt32BE(side, 22);
  siz.writeUInt32BE(side, 26);
  siz.writeUInt16BE(components, 38);
  for (let component = 0; component < components; component++) siz.set([7, 1, 1], 40 + 3 * component);
  const cod = Buffer.from([0xff, 0x52, 0, 12, 0, 0, 0, 1, 0, levels, 4, 4, 0, 0]);
  return Buffer.concat([Buffer.from([0xff, 0x4f]), siz, cod, Buffer.from([0xff, 0x90])]);
}

/** A segment of an embedded JBIG2 stream (T.88 section 7.2): number, type, no referred-to segments, page 1, data length. */
function jbig2Segment(number: number, type: number, data: Buffer, declaredLength = data.length): Buffer {
  const header = Buffer.alloc(11);
  header.writeUInt32BE(number, 0);
  header.writeUInt8(type, 4);
  header.writeUInt8(1, 6);
  header.writeUInt32BE(declaredLength, 7);
  return Buffer.concat([header, data]);
}

const JBIG2_PAGE_INFORMATION = 48;
const JBIG2_IMMEDIATE_GENERIC_REGION = 38;

function jbig2PageInformation(): Buffer {
  const page = Buffer.alloc(19);
  page.writeUInt32BE(64, 0);
  page.writeUInt32BE(32, 4);
  return jbig2Segment(0, JBIG2_PAGE_INFORMATION, page);
}

/** A generic region (T.88 7.4.6) of `side` x `side` pixels that holds no coded rows: its bitmap is what the decoder allocates. */
function jbig2Region(number: number, side: number): Buffer {
  const region = Buffer.alloc(18);
  region.writeUInt32BE(side, 0);
  region.writeUInt32BE(side, 4);
  return jbig2Segment(number, JBIG2_IMMEDIATE_GENERIC_REGION, region);
}

/** The file header of a standalone JBIG2 file (T.88 annex D.4): the signature, the flags, and a page count unless it is unknown. */
function jbig2FileHeader(unknownPages: boolean): Buffer {
  const signature = Buffer.from('974a42320d0a1a0a', 'hex');
  return unknownPages ? Buffer.concat([signature, Buffer.from([0x03])]) : Buffer.concat([signature, Buffer.from([0x01, 0, 0, 0, 1])]);
}

const SMALL_JBIG2 = Buffer.concat([jbig2PageInformation()]);

describe('pictures the check reads as pdf.js does', () => {
  it('takes /F for the filter before /Filter', () => {
    const picture: Picture = { dict: `${HUGE_CCITT} /Filter /FlateDecode /F /CCITTFaxDecode /DecodeParms << /Columns ${HUGE_SIDE} >>`, stream: Buffer.alloc(8) };
    expect(droppedBy(picturesPdf([picture]))).toEqual([FIRST_PICTURE]);
  });

  it('takes /DP for the parameters before /DecodeParms', () => {
    const picture: Picture = { dict: `${HUGE_CCITT} /Filter /CCITTFaxDecode /DecodeParms << /Columns 8 >> /DP << /Columns ${HUGE_SIDE} >>`, stream: Buffer.alloc(8) };
    expect(droppedBy(picturesPdf([picture]))).toEqual([FIRST_PICTURE]);
  });

  it('takes /H for the number of rows before /Height', () => {
    const picture: Picture = { dict: `/Width 8 /Height 8 /H ${HUGE_SIDE} /BitsPerComponent 1 /Filter /CCITTFaxDecode /DecodeParms << /Columns ${HUGE_SIDE} >>`, stream: Buffer.alloc(8) };
    expect(droppedBy(picturesPdf([picture]))).toEqual([FIRST_PICTURE]);
  });

  it('reads the abbreviation CCF as the CCITT codec', () => {
    const picture: Picture = { dict: `${HUGE_CCITT} /Filter /CCF /DecodeParms << /Columns ${HUGE_SIDE} >>`, stream: Buffer.alloc(8) };
    expect(droppedBy(picturesPdf([picture]))).toEqual([FIRST_PICTURE]);
  });

  it('decodes a JPEG 2000 picture spelled /JPX at full size, where /JPXDecode is reduced by the size pdf.js reads from the stream', () => {
    const eightThousand = jpxHeader({ side: 8000 });
    const reduced: Picture = { dict: '/Width 16 /Height 16 /Filter /JPXDecode', stream: eightThousand };
    const abbreviated: Picture = { dict: '/Width 16 /Height 16 /Filter /JPX', stream: eightThousand };
    expect(droppedBy(picturesPdf([reduced, abbreviated]))).toEqual([FIRST_PICTURE + 1]);
  });

  it('follows an indirect /Subtype to /Image', () => {
    const picture: Picture = { dict: `${HUGE_CCITT} /Filter /CCITTFaxDecode /DecodeParms << /Columns ${HUGE_SIDE} >>`, stream: Buffer.alloc(8), subtype: '30 0 R' };
    expect(droppedBy(picturesPdf([picture], [{ id: 30, raw: '/Image' }]))).toEqual([FIRST_PICTURE]);
  });

  it('checks a stream with a codec filter and no /Subtype, and the image whose /SMask it is', () => {
    const image: Picture = { dict: '/Width 8 /Height 8 /BitsPerComponent 8 /ColorSpace /DeviceGray /SMask 31 0 R', stream: Buffer.alloc(64) };
    const mask: CraftObject = { id: 31, dict: `${HUGE_CCITT} /Filter /CCITTFaxDecode /DecodeParms << /Columns ${HUGE_SIDE} >>`, stream: Buffer.alloc(8) };
    expect(droppedBy(picturesPdf([image], [mask]))).toEqual([FIRST_PICTURE, 31]);
  });

  it('strips the file header of a JBIG2 stream before it reads the segments, with and without a page count', () => {
    const withCount = jbig2FileHeader(false);
    const withoutCount = jbig2FileHeader(true);
    const dict = '/Width 64 /Height 32 /BitsPerComponent 1 /ColorSpace /DeviceGray /Filter /JBIG2Decode';
    const giant = (header: Buffer): Buffer => Buffer.concat([header, jbig2PageInformation(), jbig2Region(1, HUGE_SIDE)]);
    expect(droppedBy(picturesPdf([{ dict, stream: giant(withCount) }, { dict, stream: giant(withoutCount) }, { dict, stream: SMALL_JBIG2 }]))).toEqual([FIRST_PICTURE, FIRST_PICTURE + 1]);
  });

  it('strips the file header of a JBIG2Globals stream as well', () => {
    const dict = '/Width 64 /Height 32 /BitsPerComponent 1 /ColorSpace /DeviceGray /Filter /JBIG2Decode /DecodeParms << /JBIG2Globals 32 0 R >>';
    const globals: CraftObject = { id: 32, stream: Buffer.concat([jbig2FileHeader(false), jbig2Region(1, HUGE_SIDE)]) };
    expect(droppedBy(picturesPdf([{ dict, stream: SMALL_JBIG2 }], [globals]))).toEqual([FIRST_PICTURE]);
  });
});

describe('streams that other readers of the document decode with the same filter chain', () => {
  it('inflates a content stream whose filter is written /F, as pdf.js does', () => {
    const bomb = zlib.deflateSync(Buffer.alloc(200 * MIB, 0x20));
    const pdf = buildPdf(
      [
        ...PAGE_OBJECTS,
        { id: 3, dict: '/Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R' },
        { id: 4, dict: '/F /FlateDecode', stream: bomb },
      ],
      1
    ).buffer;
    expect(() => assertPdfStreamsWithinLimits(pdf)).toThrow(/limit|exceed|more than/i);
  });
});

describe('the headers the check reads, at the limits OpenJPEG holds them to', () => {
  it('reads 16,384 components and 32 resolution levels, and none of 16,385 components or 33 levels', () => {
    expect(jpxCodestream(jpxHeader({ side: 64, components: 16_384 }))).not.toBeNull();
    expect(jpxCodestream(jpxHeader({ side: 64, components: 16_385 }))).toBeNull();
    expect(jpxCodestream(jpxHeader({ side: 64, levels: 32 }))).not.toBeNull();
    expect(jpxCodestream(jpxHeader({ side: 64, levels: 33 }))).toBeNull();
  });

  /** 300 components (so a COC names its component in two bytes), then a COC whose body ends at the last byte of the stream. */
  const truncatedCoc = (): Buffer => Buffer.concat([jpxHeader({ side: 64, components: 300 }).subarray(0, -2), Buffer.from([0xff, 0x53, 0, 3, 0])]);

  it('leaves a COC marker that runs out of bytes to the decoder, and neither throws nor refuses the document, for a picture of an object', () => {
    const picture: Picture = { dict: '/Width 16 /Height 16 /Filter /JPXDecode', stream: truncatedCoc() };
    const pdf = picturesPdf([picture]);
    expect(droppedBy(pdf)).toEqual([]);
    expect(pdfjsReadableBytes(pdf, { content: true, pictures: true }).equals(pdf)).toBe(true);
  });

  it('does the same for an inline picture, which cannot be left out', () => {
    const inline = Buffer.concat([Buffer.from('\nBI /W 16 /H 16 /BPC 8 /CS /G /F /JPXDecode ID ', 'latin1'), truncatedCoc(), Buffer.from('\nEI\n', 'latin1')]).toString('latin1');
    const pdf = picturesPdf([], [], inline);
    expect(pdfjsReadableBytes(pdf, { content: true, pictures: true }).equals(pdf)).toBe(true);
  });
});

describe('the cost of the incremental update of the dropped pictures', () => {
  it('names 200,000 objects without spreading them into a call', () => {
    const OBJECTS = 200_000;
    const objects = Array.from({ length: OBJECTS }, (_, index) => ({ num: index + 10, gen: 0, body: 'null' }));
    const updated = withIncrementalUpdate(Buffer.from('%PDF-1.7\n'), { root: { num: 1, gen: 0 }, nextObjectNumber: 5, previousXref: 0 }, objects);
    expect(updated.toString('latin1')).toContain(`/Size ${OBJECTS + 10} `);
  });
});

describe('the cost of the check itself on files built to make it run on', () => {
  it('reads a JBIG2Globals stream that 1,000 pictures share once, however long its segments run', () => {
    const SHARED = 1_000;
    const globals = zlib.deflateSync(Buffer.alloc(8 * MIB));
    const dict = '/Width 64 /Height 32 /BitsPerComponent 1 /ColorSpace /DeviceGray /Filter /JBIG2Decode /DecodeParms << /JBIG2Globals 900 0 R >>';
    const pictures = Array.from({ length: SHARED }, (): Picture => ({ dict, stream: SMALL_JBIG2 }));
    const pdf = picturesPdf(pictures, [{ id: 900, dict: '/Filter /FlateDecode', stream: globals }]);
    const started = performance.now();
    expect(droppedBy(pdf)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(HOSTILE_TIME_MS);
  });

  it('parses an inline image dictionary over its own BI to ID text, so unclosed arrays do not run on', () => {
    const IMAGES = 4_000;
    const inline = '\n' + 'q BI /W 8 /H 8 /BPC 1 /F [ /CCF ID x EI Q\n'.repeat(IMAGES);
    const started = performance.now();
    expect(droppedBy(picturesPdf([], [], inline))).toEqual([]);
    expect(performance.now() - started).toBeLessThan(HOSTILE_TIME_MS);
  });

  it('stops giving the readers bytes once the spans of pictures that overlap have used the budget', () => {
    const PICTURES = 100;
    const TAIL_BYTES = 16 * MIB;
    const pdf = overlappingJbig2Pdf(PICTURES, TAIL_BYTES);
    const started = performance.now();
    const dropped = droppedBy(pdf);
    expect(performance.now() - started).toBeLessThan(HOSTILE_TIME_MS);
    // Every picture shows a 65535 x 65535 region to a reader; three spans of 16 MiB fit in the 64 MiB budget and a fourth does not.
    expect(dropped).toEqual([FIRST_PICTURE, FIRST_PICTURE + 1, FIRST_PICTURE + 2]);
  });
});

/**
 * A file of `count` JBIG2 pictures that each run, through a /Length given by an object written after them (read once all
 * objects are indexed), to the end of one stream of `tailBytes`. The data of a picture is a segment that jumps to the start of that
 * stream, a region of 65535 x 65535 pixels and then zero bytes, which read as segments of no data.
 */
function overlappingJbig2Pdf(count: number, tailBytes: number): Buffer {
  const JUMP_SEGMENT = 50;
  const TAIL_ID = 9;
  const LENGTH_FIRST_ID = 2_000;
  const pictureObject = (index: number, jump: Buffer): Buffer =>
    Buffer.concat([
      Buffer.from(`${FIRST_PICTURE + index} 0 obj\n<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /BitsPerComponent 1 /ColorSpace /DeviceGray /Filter /JBIG2Decode /Length ${LENGTH_FIRST_ID + index} 0 R >>\nstream\n`, 'latin1'),
      jump,
      Buffer.from('\nendstream\nendobj\n', 'latin1'),
    ]);
  const head = Buffer.from(
    [
      '%PDF-1.4',
      '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj',
      '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj',
      '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj',
      '',
    ].join('\n'),
    'latin1'
  );
  const placeholder = jbig2Segment(0, JUMP_SEGMENT, Buffer.alloc(0), 0);
  const pictureStarts: number[] = [];
  let at = head.length;
  for (let index = 0; index < count; index++) {
    pictureStarts.push(at + pictureObject(index, placeholder).indexOf('stream\n') + 'stream\n'.length);
    at += pictureObject(index, placeholder).length;
  }
  const tailHeader = Buffer.from(`${TAIL_ID} 0 obj\n<< /Length ${tailBytes} >>\nstream\n`, 'latin1');
  const tailStart = at + tailHeader.length;
  const pictures = pictureStarts.map((start, index) => pictureObject(index, jbig2Segment(0, JUMP_SEGMENT, Buffer.alloc(0), tailStart - (start + placeholder.length))));
  const region = jbig2Region(1, HUGE_SIDE);
  const tail = Buffer.concat([region, Buffer.alloc(tailBytes - region.length)]);
  const lengths = pictureStarts.map((start, index) => Buffer.from(`${LENGTH_FIRST_ID + index} 0 obj\n${tailStart + tailBytes - start}\nendobj\n`, 'latin1'));
  return Buffer.concat([head, ...pictures, tailHeader, tail, Buffer.from('\nendstream\nendobj\n', 'latin1'), ...lengths, Buffer.from('trailer\n<< /Root 1 0 R /Size 3000 >>\n%%EOF\n', 'latin1')]);
}
