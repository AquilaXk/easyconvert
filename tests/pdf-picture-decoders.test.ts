import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { convertFile } from '../src/lib/conversions/index';
import { analyzePdfPagesInProcess } from '../src/lib/conversions/pdf-text-geometry';
import { PDF_CONTENT_MAX_IMAGES_PER_PAGE, type PdfContentImage } from '../src/lib/conversions/pdf-text-types';
import { maxInputPixels } from '../src/lib/conversions/image-input-limits';
import { HELVETICA_FONT, buildPdf, textContent, type CraftObject } from './helpers/pdf-craft';
import { requireRealworldSample } from './helpers/realworld-sample';

/**
 * pdf.js 6 decodes CCITT fax, JBIG2 and JPEG 2000 pictures with WebAssembly modules it loads from the `wasmUrl` folder
 * (`src/core/wasm_image.js`, pdf.worker.mjs 15509-15600). Without that folder the decoder is null, the picture arrives as null
 * and the Markdown, HTML and Word outputs leave it out. Poppler's `pdfimages` and the reference readers draw them all.
 *
 * The streams below come from tools other than the code under test. CCITT: ImageMagick 7 (`magick -size 64x32 xc:white -fill
 * black -draw "rectangle 8,8 40,20" -type bilevel -compress Group4 out.pdf`), the 13 bytes of its picture stream. JBIG2: that
 * same Group 4 data as the MMR-coded generic region of an embedded JBIG2 stream (ITU-T T.88 sections 7.4.6 and 7.4.8, no end of
 * page segment as ISO 32000-1 section 7.4.7 asks). JPEG 2000: OpenJPEG 2.5 `opj_compress -n 2` (lossless) of a 16x16
 * ImageMagick `gradient:black-white`, rows 0, 17, 34 ... 255. Poppler's `pdfimages -png` gives the same pixels for all three.
 */

const G4_RECTANGLE = Buffer.from('ff3306bfffffffff8fff001001', 'hex');
const RECTANGLE = { left: 8, top: 8, right: 40, bottom: 20 };
const BILEVEL_WIDTH = 64;
const BILEVEL_HEIGHT = 32;
const JPX_GRADIENT = Buffer.from(
  'AAAADGpQICANCocKAAAAFGZ0eXBqcDIgAAAAAGpwMiAAAAAtanAyaAAAABZpaGRyAAAAEAAAABAAAQcHAAAAAAAPY29scgEAAAAAABEAAADAanAyY/9P/1EAKQAAAAAAEAAA' +
    'ABAAAAAAAAAAAAAAABAAAAAQAAAAAAAAAAAAAQcBAf9SAAwAAAABAAEEBAAB/1wAB0BASEhQ/2QAJQABQ3JlYXRlZCBieSBPcGVuSlBFRyB2ZXJzaW9uIDIuNS40/5AACgAA' +
    'AAAASwAB/5PfgXgSjizPh/kOs2RKeOBm47EbiWE72nRUPhvgypyMklJznOZm0N8fkyAAAAAAAArAH6D5w4A9pjRfNwYD/9k=',
  'base64'
);
const GRADIENT_SIDE = 16;
const GRADIENT_STEP = 17;
/** A 12000 x 12000 mid-gray picture in 1,178 bytes (OpenJPEG `opj_compress -t 2048,2048` of an ImageMagick `xc:gray50`). */
const JPX_HUGE_GRAY = Buffer.from(
  'AAAADGpQICANCocKAAAAFGZ0eXBqcDIgAAAAAGpwMiAAAAAtanAyaAAAABZpaGRyAAAu4AAALuAAAQcHAAAAAAAPY29scgEAAAAAABEAAARNanAyY/9P/1EAKQAAAAAu4AAALuAA' +
    'AAAAAAAAAAAACAAAAAgAAAAAAAAAAAAAAQcBAf9SAAwAAAABAAUEBAAB/1wAE0BASEhQSEhQSEhQSEhQSEhQ/2QAJQABQ3JlYXRlZCBieSBPcGVuSlBFRyB2ZXJzaW9uIDIuNS40' +
    '/5AACgAAAAAAGwAB/5PAJhFQVK//f4CAgICA/5AACgABAAAAGwAB/5PAJhFQVK//f4CAgICA/5AACgACAAAAGwAB/5PAJhFQVK//f4CAgICA/5AACgADAAAAGwAB/5PAJhFQVK//' +
    'f4CAgICA/5AACgAEAAAAGwAB/5PAJhFQVK//f4CAgICA/5AACgAFAAAAGwAB/5PAJhFQVK//f4CAgICA/5AACgAGAAAAGwAB/5PAJhFQVK//f4CAgICA/5AACgAHAAAAGwAB/5PA' +
    'JhFQVK//f4CAgICA/5AACgAIAAAAGwAB/5PAJhFQVK//f4CAgICA/5AACgAJAAAAGwAB/5PAJhFQVK//f4CAgICA/5AACgAKAAAAGwAB/5PAJhFQVK//f4CAgICA/5AACgALAAAA' +
    'GwAB/5PAJhFQVK//f4CAgICA/5AACgAMAAAAGwAB/5PAJhFQVK//f4CAgICA/5AACgANAAAAGwAB/5PAJhFQVK//f4CAgICA/5AACgAOAAAAGwAB/5PAJhFQVK//f4CAgICA/5AA' +
    'CgAPAAAAGwAB/5PAJhFQVK//f4CAgICA/5AACgAQAAAAGwAB/5PAJhFQVK//f4CAgICA/5AACgARAAAAGwAB/5PAJhFQVK//f4CAgICA/5AACgASAAAAGwAB/5PAJhFQVK//f4CA' +
    'gICA/5AACgATAAAAGwAB/5PAJhFQVK//f4CAgICA/5AACgAUAAAAGwAB/5PAJhFQVK//f4CAgICA/5AACgAVAAAAGwAB/5PAJhFQVK//f4CAgICA/5AACgAWAAAAGwAB/5PAJhFQ' +
    'VK//f4CAgICA/5AACgAXAAAAGwAB/5PAJhFQVK//f4CAgICA/5AACgAYAAAAGwAB/5PAJhFQVK//f4CAgICA/5AACgAZAAAAGwAB/5PAJhFQVK//f4CAgICA/5AACgAaAAAAGwAB' +
    '/5PAJhFQVK//f4CAgICA/5AACgAbAAAAGwAB/5PAJhFQVK//f4CAgICA/5AACgAcAAAAGwAB/5PAJhFQVK//f4CAgICA/5AACgAdAAAAGwAB/5PAJhFQVK//f4CAgICA/5AACgAe' +
    'AAAAGwAB/5PAJhFQVK//f4CAgICA/5AACgAfAAAAGwAB/5PAJhFQVK//f4CAgICA/5AACgAgAAAAGwAB/5PAJhFQVK//f4CAgICA/5AACgAhAAAAGwAB/5PAJhFQVK//f4CAgICA' +
    '/5AACgAiAAAAGwAB/5PAJhFQVK//f4CAgICA/5AACgAjAAAAGwAB/5PAJhFQVK//f4CAgICA/9k=',
  'base64'
);
/** The page information segment of the pdf.js test file `bomb_giant.pdf`: a JBIG2 page of 100000 x 100000 pixels, 1.25 GB decoded. */
const JBIG2_GIANT_PAGE = { width: 100_000, height: 100_000 };
const ABSURD_CCITT_COLUMNS = 1_000_000_000;
const ABSURD_JPX_SIDE = 60_000;
const DISTINCT_JPX_PICTURES = 600;
const HOSTILE_TIME_MS = 15_000;
/** A decode of the declared sizes would take gigabytes of WebAssembly memory, which the thread's heap limit does not count. */
const HOSTILE_RSS_GROWTH_BYTES = 512 * 1024 * 1024;
const REAL_SAMPLE_TIMEOUT_MS = 120_000;
const MARKDOWN_PICTURE = /!\[[^\]]*\]\(data:image\/(?:png|jpeg);base64,([^)]*)\)/g;

const JBIG2_PAGE_INFORMATION = 48;
const JBIG2_IMMEDIATE_LOSSLESS_GENERIC_REGION = 38;
const JBIG2_GENERIC_REGION_MMR = 1;

/** A segment of an embedded JBIG2 stream (T.88 section 7.2): number, type, no referred-to segments, page 1, data length. */
function jbig2Segment(number: number, type: number, data: Buffer): Buffer {
  const header = Buffer.alloc(11);
  header.writeUInt32BE(number, 0);
  header.writeUInt8(type, 4);
  header.writeUInt8(0, 5);
  header.writeUInt8(1, 6);
  header.writeUInt32BE(data.length, 7);
  return Buffer.concat([header, data]);
}

/** A page of `page` pixels holding one MMR-coded 64 x 32 generic region at its origin. */
function jbig2Stream(page: { width: number; height: number }): Buffer {
  const pageInformation = Buffer.alloc(19);
  pageInformation.writeUInt32BE(page.width, 0);
  pageInformation.writeUInt32BE(page.height, 4);
  const region = Buffer.alloc(18);
  region.writeUInt32BE(BILEVEL_WIDTH, 0);
  region.writeUInt32BE(BILEVEL_HEIGHT, 4);
  region.writeUInt8(JBIG2_GENERIC_REGION_MMR, 17);
  return Buffer.concat([
    jbig2Segment(0, JBIG2_PAGE_INFORMATION, pageInformation),
    jbig2Segment(1, JBIG2_IMMEDIATE_LOSSLESS_GENERIC_REGION, Buffer.concat([region, G4_RECTANGLE])),
  ]);
}

interface Picture {
  dict: string;
  stream: Buffer;
}

function ccittPicture(columns = BILEVEL_WIDTH): Picture {
  return {
    dict: `/Width ${BILEVEL_WIDTH} /Height ${BILEVEL_HEIGHT} /BitsPerComponent 1 /ColorSpace /DeviceGray /Filter /CCITTFaxDecode /DecodeParms << /K -1 /Columns ${columns} /Rows ${BILEVEL_HEIGHT} >>`,
    stream: G4_RECTANGLE,
  };
}

function jbig2Picture(page = { width: BILEVEL_WIDTH, height: BILEVEL_HEIGHT }): Picture {
  return { dict: `/Width ${BILEVEL_WIDTH} /Height ${BILEVEL_HEIGHT} /BitsPerComponent 1 /ColorSpace /DeviceGray /Filter /JBIG2Decode`, stream: jbig2Stream(page) };
}

function jpxPicture(stream = JPX_GRADIENT): Picture {
  return { dict: `/Width ${GRADIENT_SIDE} /Height ${GRADIENT_SIDE} /Filter /JPXDecode`, stream };
}

/** The JPEG 2000 gradient with a size marker (SIZ, ISO 15444-1 A.5.1) that declares `side` x `side` pixels. */
function jpxDeclaring(side: number): Buffer {
  const stream = Buffer.from(JPX_GRADIENT);
  const siz = stream.indexOf(Buffer.from([0xff, 0x51]));
  stream.writeUInt32BE(side, siz + 6);
  stream.writeUInt32BE(side, siz + 10);
  return stream;
}

/** One page with a line of text (a page without text is recognized by OCR instead) that draws each picture once, as its own image XObject. */
function picturesPdf(pictures: Picture[]): Buffer {
  const draws = textContent('Pictures', 740) + pictures.map((_, index) => `q 64 0 0 32 72 ${700 - (index % 20) * 34} cm /Im${index} Do Q`).join('\n');
  const names = pictures.map((_, index) => `/Im${index} ${10 + index} 0 R`).join(' ');
  const objects: CraftObject[] = [
    { id: 1, dict: '/Type /Catalog /Pages 2 0 R' },
    { id: 2, dict: '/Type /Pages /Kids [3 0 R] /Count 1' },
    { id: 3, dict: `/Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> /XObject << ${names} >> >>` },
    { id: 4, stream: Buffer.from(draws, 'latin1') },
    { id: 5, raw: HELVETICA_FONT },
    ...pictures.map((picture, index): CraftObject => ({ id: 10 + index, dict: `/Type /XObject /Subtype /Image ${picture.dict}`, stream: picture.stream })),
  ];
  return buildPdf(objects, 1).buffer;
}

async function readPictures(pdf: Buffer): Promise<PdfContentImage[]> {
  const result = await analyzePdfPagesInProcess(pdf, { geometry: 'none', content: true, images: true });
  return result.content.flatMap((page) => page.images);
}

async function grayPixels(file: Uint8Array | undefined): Promise<{ width: number; height: number; at: (x: number, y: number) => number }> {
  expect(file).toBeDefined();
  const { data, info } = await sharp(file).greyscale().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, at: (x, y) => data[y * info.width + x] };
}

async function expectRectangle(file: Uint8Array | undefined): Promise<void> {
  const pixels = await grayPixels(file);
  expect([pixels.width, pixels.height]).toEqual([BILEVEL_WIDTH, BILEVEL_HEIGHT]);
  for (let y = 0; y < BILEVEL_HEIGHT; y++) {
    for (let x = 0; x < BILEVEL_WIDTH; x++) {
      const inside = x >= RECTANGLE.left && x <= RECTANGLE.right && y >= RECTANGLE.top && y <= RECTANGLE.bottom;
      expect(pixels.at(x, y), `pixel ${x},${y}`).toBe(inside ? 0 : 255);
    }
  }
}

/** Width and height of each picture of a Markdown output, from the PNG IHDR chunk or the JPEG start-of-frame segment. */
function markdownPictureSizes(markdown: string): string[] {
  return [...markdown.matchAll(MARKDOWN_PICTURE)].map((match) => {
    const file = Buffer.from(match[1], 'base64');
    if (file[0] === 0x89) return `${file.readUInt32BE(16)}x${file.readUInt32BE(20)}`;
    let at = 2;
    while (file[at + 1] < 0xc0 || file[at + 1] > 0xc3) at += 2 + file.readUInt16BE(at + 2);
    return `${file.readUInt16BE(at + 7)}x${file.readUInt16BE(at + 5)}`;
  });
}

describe('pictures that pdf.js decodes with its WebAssembly modules', () => {
  it('reads a CCITT Group 4 and a JBIG2 picture as the pixels they code', async () => {
    const [ccitt, jbig2] = await readPictures(picturesPdf([ccittPicture(), jbig2Picture()]));
    await expectRectangle(ccitt.data);
    await expectRectangle(jbig2.data);
  });

  it('reads a lossless JPEG 2000 picture as its source rows', async () => {
    const [jpx] = await readPictures(picturesPdf([jpxPicture()]));
    const pixels = await grayPixels(jpx.data);
    expect([pixels.width, pixels.height]).toEqual([GRADIENT_SIDE, GRADIENT_SIDE]);
    for (let y = 0; y < GRADIENT_SIDE; y++) {
      expect(Array.from({ length: GRADIENT_SIDE }, (_, x) => pixels.at(x, y)), `row ${y}`).toEqual(Array(GRADIENT_SIDE).fill(y * GRADIENT_STEP));
    }
  });

  it('writes all three into Markdown through the text thread', async () => {
    const markdown = (await convertFile(picturesPdf([ccittPicture(), jbig2Picture(), jpxPicture()]), 'pdf', 'md', {}, 'decoders.pdf')).buffer.toString('utf8');
    expect(markdownPictureSizes(markdown)).toEqual(['64x32', '64x32', '16x16']);
  });
});

describe('hostile pictures for the WebAssembly decoders', () => {
  async function bounded(pdf: Buffer): Promise<PdfContentImage[]> {
    const rssBefore = process.memoryUsage().rss;
    const started = performance.now();
    const pictures = await readPictures(pdf);
    expect(performance.now() - started).toBeLessThan(HOSTILE_TIME_MS);
    expect(process.memoryUsage().rss - rssBefore).toBeLessThan(HOSTILE_RSS_GROWTH_BYTES);
    return pictures;
  }

  it('decodes a JBIG2 picture whose page declares 100000 x 100000 pixels at the size of its picture', async () => {
    const [picture] = await bounded(picturesPdf([jbig2Picture(JBIG2_GIANT_PAGE)]));
    await expectRectangle(picture.data);
  });

  it('leaves out a CCITT picture whose rows declare a billion columns', async () => {
    const [picture] = await bounded(picturesPdf([ccittPicture(ABSURD_CCITT_COLUMNS)]));
    expect(picture.data).toBeUndefined();
  });

  it('leaves out a JPEG 2000 picture whose size marker declares 60000 x 60000 pixels it does not hold', async () => {
    const [picture] = await bounded(picturesPdf([jpxPicture(jpxDeclaring(ABSURD_JPX_SIDE))]));
    expect(picture.data).toBeUndefined();
  });

  it('decodes a 12000 x 12000 JPEG 2000 picture of 1,178 bytes behind a 16 x 16 dictionary at a reduced size within the pixel limit', async () => {
    const [picture] = await bounded(picturesPdf([jpxPicture(JPX_HUGE_GRAY)]));
    const pixels = await grayPixels(picture.data);
    expect(pixels.width * pixels.height).toBeLessThanOrEqual(maxInputPixels());
  });

  it(`decodes ${DISTINCT_JPX_PICTURES} distinct JPEG 2000 pictures on a page and keeps the page's placement limit`, async () => {
    const pictures = await bounded(picturesPdf(Array.from({ length: DISTINCT_JPX_PICTURES }, () => jpxPicture())));
    expect(pictures).toHaveLength(PDF_CONTENT_MAX_IMAGES_PER_PAGE);
    expect(pictures.every((picture) => picture.data !== undefined)).toBe(true);
  });
});

describe('real files with CCITT, JBIG2 and JPEG 2000 pictures', () => {
  it(
    'writes the four JPEG 2000 pictures of govdocs1-000142 into Markdown at the sizes pdfimages lists',
    async (ctx) => {
      const sample = await requireRealworldSample(ctx, 'govdocs1-000142.pdf');
      const markdown = (await convertFile(sample.bytes, 'pdf', 'md', {}, 'govdocs1-000142.pdf')).buffer.toString('utf8');
      expect(markdownPictureSizes(markdown)).toEqual(['1039x527', '513x400', '514x416', '477x308']);
    },
    REAL_SAMPLE_TIMEOUT_MS
  );

  it(
    'writes the 69 JBIG2 page scans of govdocs1-003685 into Markdown beside its one JPEG',
    async (ctx) => {
      const sample = await requireRealworldSample(ctx, 'govdocs1-003685.pdf');
      const markdown = (await convertFile(sample.bytes, 'pdf', 'md', {}, 'govdocs1-003685.pdf')).buffer.toString('utf8');
      expect(markdownPictureSizes(markdown)).toHaveLength(70);
    },
    REAL_SAMPLE_TIMEOUT_MS
  );
});
