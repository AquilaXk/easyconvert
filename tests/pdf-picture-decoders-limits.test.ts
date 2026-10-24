import { readFileSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';
import { runPdfTextJob } from '../src/lib/conversions/pdf-text-geometry';
import { PDF_CONTENT_MAX_PICTURES, PDF_WASM_DECODER_MAX_BYTES, type PdfContentImage } from '../src/lib/conversions/pdf-text-types';
import { withMemoryMaximum } from '../src/lib/conversions/pdf-wasm-memory';
import { PayloadLimitError } from '../src/lib/types';
import { HELVETICA_FONT, buildPdf, textContent, type CraftObject } from './helpers/pdf-craft';

/**
 * The bounds on what pdf.js's WebAssembly decoders may take for a picture: a guard that leaves out, from its headers, a picture
 * whose decode would pass a limit (pdf-picture-guard.ts), and a memory maximum on the decoder modules for what the headers do
 * not show (pdf-wasm-memory.ts). Every job runs in the reader's thread, as the conversions run it, and the resident memory of
 * the process is sampled while it runs: a decoder's memory is outside the thread's heap limit.
 *
 * The JPEG 2000 codestreams are OpenJPEG 2.5 `opj_compress -n 6` of flat ImageMagick `xc:` images of the size named; flat
 * pictures code to a few hundred bytes and decode to as many samples as any other.
 */

const J2K_RGB_8000 = Buffer.from(
  '/0//UQAvAAAAAB9AAAAfQAAAAAAAAAAAAAAIAAAACAAAAAAAAAAAAAADBwEBBwEBBwEB/1IADAAAAAEBBQQEAAH/XAATQEBISFBISFBISFBISFBISFD/ZAAlAAFDcmVhdGVkIGJ5IE9w' +
    'ZW5KUEVHIHZlcnNpb24gMi41LjT/kAAKAAAAAABcAAH/k8B0gBQAXK//f+l/wfIXFABcr/9/6YP+tCAAAAAAAAADCQl//3/B8hcRUFSv/3/pg/60IAAAAAAAAAMJCX//f4CAgICAgICA' +
    'gICAgICAgP+QAAoAAQAAAFwAAf+TwHSAFABcr/9/6X/B8hcUAFyv/3/pg/60IAAAAAAAAAMJCX//f8HyFxFQVK//f+mD/rQgAAAAAAAAAwkJf/9/gICAgICAgICAgICAgICA/5AACgAC' +
    'AAAAXAAB/5PAdIAUAFyv/3/pf8HyFxQAXK//f+mD/rQgAAAAAAAAAwkJf/9/wfIXEVBUr/9/6YP+tCAAAAAAAAADCQl//3+AgICAgICAgICAgICAgID/kAAKAAMAAABcAAH/k8B0gBQA' +
    'XK//f9yPwfIXFABcr/9/3IcmmSAAAAAAAAADCQl//3/B8hcRUFSv/3/chyaZIAAAAAAAAAMJCX//f4CAgICAgICAgICAgICAgP+QAAoABAAAAFwAAf+TwHSAFABcr/9/6X/B8hcUAFyv' +
    '/3/pg/60IAAAAAAAAAMJCX//f8HyFxFQVK//f+mD/rQgAAAAAAAAAwkJf/9/gICAgICAgICAgICAgICA/5AACgAFAAAAXAAB/5PAdIAUAFyv/3/pf8HyFxQAXK//f+mD/rQgAAAAAAAA' +
    'AwkJf/9/wfIXEVBUr/9/6YP+tCAAAAAAAAADCQl//3+AgICAgICAgICAgICAgID/kAAKAAYAAABcAAH/k8B0gBQAXK//f+l/wfIXFABcr/9/6YP+tCAAAAAAAAADCQl//3/B8hcRUFSv' +
    '/3/pg/60IAAAAAAAAAMJCX//f4CAgICAgICAgICAgICAgP+QAAoABwAAAFwAAf+TwHSAFABcr/9/3I/B8hcUAFyv/3/chyaZIAAAAAAAAAMJCX//f8HyFxFQVK//f9yHJpkgAAAAAAAA' +
    'AwkJf/9/gICAgICAgICAgICAgICA/5AACgAIAAAAXAAB/5PAdIAUAFyv/3/pf8HyFxQAXK//f+mD/rQgAAAAAAAAAwkJf/9/wfIXEVBUr/9/6YP+tCAAAAAAAAADCQl//3+AgICAgICA' +
    'gICAgICAgID/kAAKAAkAAABcAAH/k8B0gBQAXK//f+l/wfIXFABcr/9/6YP+tCAAAAAAAAADCQl//3/B8hcRUFSv/3/pg/60IAAAAAAAAAMJCX//f4CAgICAgICAgICAgICAgP+QAAoA' +
    'CgAAAFwAAf+TwHSAFABcr/9/6X/B8hcUAFyv/3/pg/60IAAAAAAAAAMJCX//f8HyFxFQVK//f+mD/rQgAAAAAAAAAwkJf/9/gICAgICAgICAgICAgICA/5AACgALAAAAXAAB/5PAdIAU' +
    'AFyv/3/cj8HyFxQAXK//f9yHJpkgAAAAAAAAAwkJf/9/wfIXEVBUr/9/3IcmmSAAAAAAAAADCQl//3+AgICAgICAgICAgICAgID/kAAKAAwAAABaAAH/k8B0gBQAXK//f6tfwfIWFABc' +
    'r/9/q15OUkAAAAAAAAAGEhL/f8HyFhFQVK//f6teTlJAAAAAAAAABhIS/3+AgICAgICAgICAgICAgID/kAAKAA0AAABaAAH/k8B0gBQAXK//f6tfwfIWFABcr/9/q15OUkAAAAAAAAAG' +
    'EhL/f8HyFhFQVK//f6teTlJAAAAAAAAABhIS/3+AgICAgICAgICAgICAgID/kAAKAA4AAABaAAH/k8B0gBQAXK//f6tfwfIWFABcr/9/q15OUkAAAAAAAAAGEhL/f8HyFhFQVK//f6te' +
    'TlJAAAAAAAAABhIS/3+AgICAgICAgICAgICAgID/kAAKAA8AAABcAAH/k8B0gBQAXK//f/9/wfIXFABcr/9//3VlUKgAAAAAAAADCQl//3/B8hcRUFSv/3//dWVQqAAAAAAAAAMJCX//' +
    'f4CAgICAgICAgICAgICAgP/Z',
  'base64'
);
const J2K_RGB_4096 = Buffer.from(
  '/0//UQAvAAAAABAAAAAQAAAAAAAAAAAAAAAQAAAAEAAAAAAAAAAAAAADBwEBBwEBBwEB/1IADAAAAAEBBQQEAAH/XAATQEBISFBISFBISFBISFBISFD/ZAAlAAFDcmVhdGVkIGJ5IE9w' +
    'ZW5KUEVHIHZlcnNpb24gMi41LjT/kAAKAAAAAAETAAH/k+A9I9I9I9IAFABcr/9/6X8UAFyv/3/pfxQAXK//f+l/FABcr/9/6X/g/IX/EL/kL/kLgBQAXK//f+mD/rQgAAAAAAAAAwkJ' +
    'f/9/FABcr/9/6YP+tCAAAAAAAAADCQl//38UAFyv/3/pg/60IAAAAAAAAAMJCX//fxQAXK//f+mD/rQgAAAAAAAAAwkJf/9/4PyF/xC/5C/5C4ARUFSv/3/pg/60IAAAAAAAAAMJCX//' +
    'fxFQVK//f+mD/rQgAAAAAAAAAwkJf/9/EVBUr/9/6YP+tCAAAAAAAAADCQl//38RUFSv/3/pg/60IAAAAAAAAAMJCX//f4CAgICAgICAgICAgICAgP/Z',
  'base64'
);
const J2K_RGB_3584 = Buffer.from(
  '/0//UQAvAAAAAA4AAAAOAAAAAAAAAAAAAAAOAAAADgAAAAAAAAAAAAADBwEBBwEBBwEB/1IADAAAAAEBBQQEAAH/XAATQEBISFBISFBISFBISFBISFD/ZAAlAAFDcmVhdGVkIGJ5IE9w' +
    'ZW5KUEVHIHZlcnNpb24gMi41LjT/kAAKAAAAAAEJAAH/k+A9I9I9I9IAFABcr/9/6X8UAFyv/3//fxQAXK//f/9/FABcr/9/bX/g/IX/ELfkK/kKgBQAXK//f+mD/rQgAAAAAAAAAwkJ' +
    'f/9/FABcr/9//3/7SzAAAAAAAAMJCX//fxQAXK//f/9/9pOQAAAAAAAGEhL/fxQAXK//f22DuDdAAAAAAAAMJCX/f+D8hf8Qt+Qr+QqAEVBUr/9/6YP+tCAAAAAAAAADCQl//38RUFSv' +
    '/3//f/tLMAAAAAAAAwkJf/9/EVBUr/9//3/2k5AAAAAAAAYSEv9/EVBUr/9/bYO4N0AAAAAAAAwkJf9/gICAgICAgICAgICAgICA/9k=',
  'base64'
);
const J2K_RGBA_2048 = Buffer.from(
  '/0//UQAyAAAAAAgAAAAIAAAAAAAAAAAAAAAIAAAACAAAAAAAAAAAAAAEBwEBBwEBBwEBBwEB/1IADAAAAAEBBQQEAAH/XAATQEBISFBISFBISFBISFBISFD/ZAAlAAFDcmVhdGVkIGJ5' +
    'IE9wZW5KUEVHIHZlcnNpb24gMi41LjT/kAAKAAAAAABiAAH/k8B0gBQAXK//f+l/wfIXFABcr/9/6YP+tCAAAAAAAAADCQl//3/B8hcRUFSv/3/pg/60IAAAAAAAAAMJCX//f4CAgICA' +
    'gICAgICAgICAgICAgICAgP/Z',
  'base64'
);
/** ImageMagick's Group 4 coding of a 64 x 32 page with a black rectangle (see pdf-picture-decoders.test.ts). */
const G4_RECTANGLE = Buffer.from('ff3306bfffffffff8fff001001', 'hex');
const BILEVEL_WIDTH = 64;
const BILEVEL_HEIGHT = 32;

const MIB = 1024 * 1024;
/** A picture the guard leaves out never reaches a decoder; a decode that did would grow the decoder towards its maximum. */
const LEFT_OUT_RSS_GROWTH_BYTES = 96 * MIB;
/** A decode the guard cannot see grows one decoder to its maximum and no further; the rest is pdf.js's copy of the picture. */
const CAPPED_RSS_GROWTH_BYTES = PDF_WASM_DECODER_MAX_BYTES + 160 * MIB;
const POOL_THREADS = 4;
const JOB_TIMEOUT_MS = 120_000;

const JBIG2_PAGE_INFORMATION = 48;
const JBIG2_INTERMEDIATE_GENERIC_REGION = 36;
const JBIG2_IMMEDIATE_GENERIC_REGION = 38;
const JBIG2_MMR = 1;
const JBIG2_END_OF_FILE = 51;

interface Picture {
  dict: string;
  stream: Buffer;
}

function jbig2Segment(number: number, type: number, data: Buffer): Buffer {
  const header = Buffer.alloc(11);
  header.writeUInt32BE(number, 0);
  header.writeUInt8(type, 4);
  header.writeUInt8(1, 6);
  header.writeUInt32BE(data.length, 7);
  return Buffer.concat([header, data]);
}

function jbig2PageInformation(width: number, height: number): Buffer {
  const data = Buffer.alloc(19);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  return jbig2Segment(0, JBIG2_PAGE_INFORMATION, data);
}

/** A generic region of `width` x `height` coded with MMR (T.88 6.2.6), every row white: one vertical-mode bit a row. */
function whiteMmrRegion(number: number, type: number, width: number, height: number): Buffer {
  const info = Buffer.alloc(18);
  info.writeUInt32BE(width, 0);
  info.writeUInt32BE(height, 4);
  info.writeUInt8(JBIG2_MMR, 17);
  return jbig2Segment(number, type, Buffer.concat([info, Buffer.alloc(Math.ceil(height / 8) + 2, 0xff)]));
}

function jbig2Picture(segments: Buffer[], filter = '/JBIG2Decode', encode = (data: Buffer) => data): Picture {
  return {
    dict: `/Width ${BILEVEL_WIDTH} /Height ${BILEVEL_HEIGHT} /BitsPerComponent 1 /ColorSpace /DeviceGray /Filter ${filter}`,
    stream: encode(Buffer.concat(segments)),
  };
}

/** The 64 x 32 rectangle as an immediate MMR generic region. */
function jbig2Rectangle(): Picture {
  const info = Buffer.alloc(18);
  info.writeUInt32BE(BILEVEL_WIDTH, 0);
  info.writeUInt32BE(BILEVEL_HEIGHT, 4);
  info.writeUInt8(JBIG2_MMR, 17);
  return jbig2Picture([jbig2PageInformation(BILEVEL_WIDTH, BILEVEL_HEIGHT), jbig2Segment(1, JBIG2_IMMEDIATE_GENERIC_REGION, Buffer.concat([info, G4_RECTANGLE]))]);
}

function ccittRectangle(): Picture {
  return {
    dict: `/Width ${BILEVEL_WIDTH} /Height ${BILEVEL_HEIGHT} /BitsPerComponent 1 /ColorSpace /DeviceGray /Filter /CCITTFaxDecode /DecodeParms << /K -1 /Columns ${BILEVEL_WIDTH} /Rows ${BILEVEL_HEIGHT} >>`,
    stream: G4_RECTANGLE,
  };
}

function rgbJpx(side: number, codestream: Buffer, filter: string, encode = (data: Buffer) => data): Picture {
  return { dict: `/Width ${side} /Height ${side} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter ${filter}`, stream: encode(codestream) };
}

function box(type: string, ...content: Buffer[]): Buffer {
  const body = Buffer.concat(content);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(body.length + 8, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, body]);
}

/**
 * A JP2 file (ISO 15444-1 annex I) of the 8000 x 8000 codestream whose XML box, ahead of the codestream box, holds the bytes of
 * a size marker of 16 x 16: pdf.js takes the first `FF 51` it finds as the size and so reduces nothing.
 */
function decoyJp2(): Buffer {
  const ihdr = Buffer.alloc(14);
  ihdr.writeUInt32BE(8000, 0);
  ihdr.writeUInt32BE(8000, 4);
  ihdr.writeUInt16BE(3, 8);
  ihdr.writeUInt8(7, 10);
  ihdr.writeUInt8(7, 11);
  const colr = Buffer.from([1, 0, 0, 0, 0, 0, 16]);
  const decoy = Buffer.alloc(43);
  decoy.writeUInt16BE(0xff51, 0);
  decoy.writeUInt16BE(41, 2);
  decoy.writeUInt32BE(16, 6);
  decoy.writeUInt32BE(16, 10);
  decoy.writeUInt32BE(16, 22);
  decoy.writeUInt32BE(16, 26);
  decoy.writeUInt16BE(1, 38);
  return Buffer.concat([
    box('jP  ', Buffer.from('0d0a870a', 'hex')),
    box('ftyp', Buffer.from('jp2 \0\0\0\0jp2 ', 'latin1')),
    box('jp2h', box('ihdr', ihdr), box('colr', colr)),
    box('xml ', decoy),
    box('jp2c', J2K_RGB_8000),
  ]);
}

/** An LZW stream (ISO 32000-1 7.4.4) of 9-bit literal codes, cleared before the table would need wider codes: the guard does not decode LZW. */
function lzwLiteral(bytes: Buffer): Buffer {
  const CLEAR = 256;
  const END = 257;
  const CLEAR_EVERY = 200;
  const out: number[] = [];
  let bits = 0;
  let pending = 0;
  const put = (code: number): void => {
    pending = (pending << 9) | code;
    bits += 9;
    while (bits >= 8) {
      out.push((pending >> (bits - 8)) & 0xff);
      bits -= 8;
    }
    pending &= (1 << bits) - 1;
  };
  put(CLEAR);
  bytes.forEach((byte, index) => {
    if (index > 0 && index % CLEAR_EVERY === 0) put(CLEAR);
    put(byte);
  });
  put(END);
  if (bits > 0) out.push((pending << (8 - bits)) & 0xff);
  return Buffer.from(out);
}

/** One page with a line of text that draws each picture once, as its own image XObject. */
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

interface Measured {
  pictures: PdfContentImage[];
  rssGrowth: number;
}

/** Reads the pictures of `pdf` in the reader's thread, sampling the resident memory of the process while it does. */
async function readInThread(pdf: Buffer): Promise<Measured> {
  const before = process.memoryUsage().rss;
  let peak = before;
  const sampler = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 2);
  try {
    const result = await runPdfTextJob(pdf, { geometry: 'none', content: true, images: true });
    return { pictures: result.content.flatMap((page) => page.images), rssGrowth: Math.max(peak, process.memoryUsage().rss) - before };
  } finally {
    clearInterval(sampler);
  }
}

function sizes(pictures: PdfContentImage[]): string[] {
  return pictures.map((picture) => `${picture.pixelWidth}x${picture.pixelHeight}${picture.data === undefined ? ' none' : ''}`);
}

describe('the memory maximum of the decoder modules', () => {
  const decoder = readFileSync(path.join(process.cwd(), 'node_modules/pdfjs-dist/wasm/jbig2.wasm'));
  const stubImports = (compiled: WebAssembly.Module): WebAssembly.Imports => {
    const imports: Record<string, Record<string, () => number>> = {};
    for (const { module: name, name: field } of WebAssembly.Module.imports(compiled)) (imports[name] ??= {})[field] = () => 0;
    return imports;
  };

  it('lets a decoder grow to the maximum and no further', async () => {
    const pages = PDF_WASM_DECODER_MAX_BYTES / (64 * 1024);
    const compiled = await WebAssembly.compile(withMemoryMaximum(decoder, pages));
    const { exports } = await WebAssembly.instantiate(compiled, stubImports(compiled));
    const memory = Object.values(exports).find((value): value is WebAssembly.Memory => value instanceof WebAssembly.Memory);
    expect(memory).toBeDefined();
    const initialPages = (memory as WebAssembly.Memory).buffer.byteLength / (64 * 1024);
    expect(() => (memory as WebAssembly.Memory).grow(pages - initialPages + 1)).toThrow(RangeError);
    (memory as WebAssembly.Memory).grow(pages - initialPages);
    expect((memory as WebAssembly.Memory).buffer.byteLength).toBe(PDF_WASM_DECODER_MAX_BYTES);
  });

  it('refuses a module whose memory has no maximum to lower, or that a maximum does not fit', () => {
    expect(() => withMemoryMaximum(Buffer.from('0061736d01000000', 'hex'), 4096)).toThrow(/defines no memory/);
    const unbounded = Buffer.from('0061736d01000000' + '050301' + '0001', 'hex');
    expect(() => withMemoryMaximum(unbounded, 4096)).toThrow(/no memory maximum/);
    expect(() => withMemoryMaximum(decoder, 2 ** 21)).toThrow(/does not fit/);
  });
});

describe('pictures whose decode would pass a limit, read in the reader thread', () => {
  beforeAll(async () => {
    // The first job loads pdf.js and both decoders into the thread; the memory of each test below is what its picture adds.
    await readInThread(picturesPdf([jbig2Rectangle(), rgbJpx(2048, J2K_RGBA_2048, '/JPXDecode')]));
  }, JOB_TIMEOUT_MS);

  it(
    'decodes a 4-component 2048 x 2048 JPEG 2000 picture at full size, and a 3-component 3584 x 3584 one behind FlateDecode',
    async () => {
      const { pictures } = await readInThread(picturesPdf([rgbJpx(2048, J2K_RGBA_2048, '/JPXDecode'), rgbJpx(3584, J2K_RGB_3584, '[/FlateDecode /JPXDecode]', zlib.deflateSync)]));
      expect(sizes(pictures)).toEqual(['2048x2048', '3584x3584']);
    },
    JOB_TIMEOUT_MS
  );

  it(
    'decodes an 8000 x 8000 JPEG 2000 picture at the 2000 x 2000 pdf.js reduces it to, which the guard reckons with',
    async () => {
      const [picture] = (await readInThread(picturesPdf([rgbJpx(4000, J2K_RGB_8000, '/JPXDecode')]))).pictures;
      const png = Buffer.from(picture.data ?? []);
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([2000, 2000]);
    },
    JOB_TIMEOUT_MS
  );

  it(
    'leaves out a 3-component 4096 x 4096 JPEG 2000 picture behind FlateDecode, which pdf.js decodes at full size, past the budget',
    async () => {
      const { pictures, rssGrowth } = await readInThread(picturesPdf([rgbJpx(4096, J2K_RGB_4096, '[/FlateDecode /JPXDecode]', zlib.deflateSync), jbig2Rectangle()]));
      expect(sizes(pictures)).toEqual(['64x32']);
      expect(rssGrowth).toBeLessThan(LEFT_OUT_RSS_GROWTH_BYTES);
    },
    JOB_TIMEOUT_MS
  );

  it(
    'leaves out a JP2 picture whose decoy size marker ahead of the codestream would have it decoded at 8000 x 8000',
    async () => {
      const { pictures, rssGrowth } = await readInThread(picturesPdf([{ dict: '/Width 16 /Height 16 /Filter /JPXDecode', stream: decoyJp2() }, jbig2Rectangle()]));
      expect(sizes(pictures)).toEqual(['64x32']);
      expect(rssGrowth).toBeLessThan(LEFT_OUT_RSS_GROWTH_BYTES);
    },
    JOB_TIMEOUT_MS
  );

  it(
    'leaves out a JBIG2 picture with a 65535 x 65535 generic region on a 64 x 32 page',
    async () => {
      const giant = jbig2Picture([jbig2PageInformation(BILEVEL_WIDTH, BILEVEL_HEIGHT), whiteMmrRegion(1, JBIG2_IMMEDIATE_GENERIC_REGION, 65535, 65535)]);
      const { pictures, rssGrowth } = await readInThread(picturesPdf([giant, jbig2Rectangle()]));
      expect(sizes(pictures)).toEqual(['64x32']);
      expect(rssGrowth).toBeLessThan(LEFT_OUT_RSS_GROWTH_BYTES);
    },
    JOB_TIMEOUT_MS
  );

  it(
    'leaves out a JBIG2 picture whose intermediate regions, each kept for later segments, stack to 256 MiB',
    async () => {
      const regions = Array.from({ length: 8 }, (_, index) => whiteMmrRegion(index + 1, JBIG2_INTERMEDIATE_GENERIC_REGION, 16384, 16384));
      const { pictures, rssGrowth } = await readInThread(picturesPdf([jbig2Picture([jbig2PageInformation(BILEVEL_WIDTH, BILEVEL_HEIGHT), ...regions]), jbig2Rectangle()]));
      expect(sizes(pictures)).toEqual(['64x32']);
      expect(rssGrowth).toBeLessThan(LEFT_OUT_RSS_GROWTH_BYTES);
    },
    JOB_TIMEOUT_MS
  );

  it(
    'leaves out a CCITT picture of 8 x 65535 pixels whose rows are decoded at 65535 columns',
    async () => {
      const wide: Picture = {
        dict: '/Width 8 /Height 65535 /BitsPerComponent 1 /ColorSpace /DeviceGray /Filter [/FlateDecode /CCITTFaxDecode] /DecodeParms [null << /K -1 /Columns 65535 /Rows 65535 >>]',
        stream: zlib.deflateSync(Buffer.alloc(65535 / 8 + 2, 0xff)),
      };
      const { pictures, rssGrowth } = await readInThread(picturesPdf([wide, ccittRectangle()]));
      expect(sizes(pictures)).toEqual(['64x32']);
      expect(rssGrowth).toBeLessThan(LEFT_OUT_RSS_GROWTH_BYTES);
    },
    JOB_TIMEOUT_MS
  );

  it(
    'refuses an inline CCITT picture whose rows are decoded at 65535 columns, as an inline picture cannot be left out, and reads a small one',
    async () => {
      const inlinePdf = (dimensions: string, data: Buffer): Buffer => {
        const content = Buffer.concat([Buffer.from(`${textContent('Inline', 740)}\nq 64 0 0 32 72 600 cm BI ${dimensions} /BPC 1 /CS /G /F /CCF ID `, 'latin1'), data, Buffer.from(' EI Q', 'latin1')]);
        return buildPdf(
          [
            { id: 1, dict: '/Type /Catalog /Pages 2 0 R' },
            { id: 2, dict: '/Type /Pages /Kids [3 0 R] /Count 1' },
            { id: 3, dict: '/Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >>' },
            { id: 4, stream: content },
            { id: 5, raw: HELVETICA_FONT },
          ],
          1
        ).buffer;
      };
      const wide = inlinePdf('/W 8 /H 65535 /DP << /K -1 /Columns 65535 /Rows 65535 >>', Buffer.alloc(65535 / 8 + 2, 0xff));
      await expect(readInThread(wide)).rejects.toBeInstanceOf(PayloadLimitError);
      const { pictures } = await readInThread(inlinePdf(`/W ${BILEVEL_WIDTH} /H ${BILEVEL_HEIGHT} /DP << /K -1 /Columns ${BILEVEL_WIDTH} /Rows ${BILEVEL_HEIGHT} >>`, G4_RECTANGLE));
      expect(sizes(pictures)).toEqual(['64x32']);
    },
    JOB_TIMEOUT_MS
  );

  it(
    `refuses a page that would decode more than ${PDF_CONTENT_MAX_PICTURES} CCITT pictures before decoding any`,
    async () => {
      const started = performance.now();
      const pictures = Array.from({ length: PDF_CONTENT_MAX_PICTURES + 1 }, ccittRectangle);
      await expect(readInThread(picturesPdf(pictures))).rejects.toBeInstanceOf(PayloadLimitError);
      expect(performance.now() - started).toBeLessThan(JOB_TIMEOUT_MS / 4);
    },
    JOB_TIMEOUT_MS
  );
});

describe('the cost of the guard itself', () => {
  it(
    'reads a JBIG2Globals stream that 100 pictures share once, within the budget of the filters ahead of the codecs',
    async () => {
      const SHARED = 100;
      const endOfFile = jbig2Segment(0, JBIG2_END_OF_FILE, Buffer.alloc(0));
      const globals = zlib.deflateSync(Buffer.concat([endOfFile, Buffer.alloc(MIB)]));
      const rectangle = jbig2Rectangle();
      const draws = textContent('Shared', 740) + Array.from({ length: SHARED }, (_, index) => `q 64 0 0 32 72 ${700 - (index % 20) * 34} cm /Im${index} Do Q`).join('\n');
      const objects: CraftObject[] = [
        { id: 1, dict: '/Type /Catalog /Pages 2 0 R' },
        { id: 2, dict: '/Type /Pages /Kids [3 0 R] /Count 1' },
        { id: 3, dict: `/Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> /XObject << ${Array.from({ length: SHARED }, (_, index) => `/Im${index} ${10 + index} 0 R`).join(' ')} >> >>` },
        { id: 4, stream: Buffer.from(draws, 'latin1') },
        { id: 5, raw: HELVETICA_FONT },
        { id: 6, dict: '/Filter /FlateDecode', stream: globals },
        ...Array.from({ length: SHARED }, (_, index): CraftObject => ({ id: 10 + index, dict: `/Type /XObject /Subtype /Image ${rectangle.dict} /DecodeParms << /JBIG2Globals 6 0 R >>`, stream: rectangle.stream })),
      ];
      const { pictures } = await readInThread(buildPdf(objects, 1).buffer);
      expect(sizes(pictures)).toEqual(Array(SHARED).fill('64x32'));
    },
    JOB_TIMEOUT_MS
  );
});

describe('pictures whose headers the guard cannot read, decoded under the memory maximum', () => {
  const hiddenJpx = (): Picture => rgbJpx(4000, J2K_RGB_8000, '[/LZWDecode /JPXDecode]', lzwLiteral);
  const hiddenStack = (): Picture => {
    const regions = Array.from({ length: 12 }, (_, index) => whiteMmrRegion(index + 1, JBIG2_INTERMEDIATE_GENERIC_REGION, 16384, 16384));
    return jbig2Picture([jbig2PageInformation(BILEVEL_WIDTH, BILEVEL_HEIGHT), ...regions], '[/LZWDecode /JBIG2Decode]', lzwLiteral);
  };

  it(
    'gives an 8000 x 8000 JPEG 2000 picture behind LZW no picture, and decodes the picture after it',
    async () => {
      const { pictures, rssGrowth } = await readInThread(picturesPdf([hiddenJpx(), rgbJpx(2048, J2K_RGBA_2048, '/JPXDecode')]));
      expect(sizes(pictures)).toEqual(['4000x4000 none', '2048x2048']);
      expect(rssGrowth).toBeLessThan(CAPPED_RSS_GROWTH_BYTES);
    },
    JOB_TIMEOUT_MS
  );

  it(
    'gives JBIG2 pictures whose regions stack past the maximum no picture, and decodes the JBIG2 picture after them',
    async () => {
      const { pictures, rssGrowth } = await readInThread(picturesPdf([hiddenStack(), hiddenStack(), hiddenStack(), jbig2Rectangle()]));
      expect(sizes(pictures)).toEqual(['64x32 none', '64x32 none', '64x32 none', '64x32']);
      expect(rssGrowth).toBeLessThan(CAPPED_RSS_GROWTH_BYTES);
    },
    JOB_TIMEOUT_MS
  );

  it(
    `holds ${POOL_THREADS} threads that each grow a decoder to the maximum at once`,
    async () => {
      const before = process.memoryUsage().rss;
      let peak = before;
      const sampler = setInterval(() => {
        peak = Math.max(peak, process.memoryUsage().rss);
      }, 2);
      try {
        const jobs = Array.from({ length: POOL_THREADS }, () => runPdfTextJob(picturesPdf([hiddenJpx(), jbig2Rectangle()]), { geometry: 'none', content: true, images: true }));
        const results = await Promise.all(jobs);
        expect(results.map((result) => sizes(result.content.flatMap((page) => page.images)))).toEqual(Array(POOL_THREADS).fill(['4000x4000 none', '64x32']));
      } finally {
        clearInterval(sampler);
      }
      expect(peak - before).toBeLessThan(POOL_THREADS * CAPPED_RSS_GROWTH_BYTES);
    },
    JOB_TIMEOUT_MS
  );
});
