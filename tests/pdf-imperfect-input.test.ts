import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { convertFile } from '../src/lib/conversions/index';
import { assertPdfStreamsWithinLimits } from '../src/lib/conversions/pdf-stream-guard';
import { extractPdfDocument } from '../src/lib/conversions/pdf-text-document';
import { FileExtensionSpoofError } from '../src/lib/registry';
import { assertNotSpoofedFile } from '../src/lib/security/file-guard';
import { ConversionFailedError, CorruptStreamError, DecompressionLimitError } from '../src/lib/types';
import { captureError } from './helpers/capture-error';
import { requireOracleTool } from './helpers/differential-oracle';
import { type CraftObject, buildPdf, flate, HELVETICA_FONT, singlePagePdf, textContent } from './helpers/pdf-craft';
import { wordF1 } from './helpers/pdf-text-metrics';
import { requireRealworldSample } from './helpers/realworld-sample';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * PDFs with flaws that the established readers open, and the defences that stay. The readers are the oracles: Poppler
 * (`pdftotext`, `pdfinfo`) and qpdf (`--check`, `--filtered-stream-data`) read the same bytes.
 *
 * - Bytes in front of the `%PDF-` header: a MacBinary header or a line break. pdf.js, Poppler and qpdf look for the header
 *   in the first 1,024 bytes; a file of another kind under a .pdf name is still refused.
 * - A stream whose /Length is an object written after it. pdf.js and PDFBox resolve the reference before they look for
 *   `endstream`, so a stream whose data ends in a CR or LF byte keeps that byte.
 * - A Flate stream whose Adler-32 checksum is wrong (no reader checks it) and an empty Flate stream (pdf.js reads none).
 * - A Flate bomb is still refused at the cap, a stream that breaks at its first byte is still a 400, and lengths that all
 *   end in one long run of white space are refused at the structure budget instead of costing the run once per stream.
 */

const toolsMissing = skipWithoutTools('pdftotext', 'pdfinfo', 'qpdf');
const CONVERSION_TIMEOUT_MS = 120_000;
vi.setConfig({ testTimeout: CONVERSION_TIMEOUT_MS });
/** Words of the converted text that Poppler's text may lack, and the reverse (headers, hyphenation, math, reading order). */
const MIN_WORD_F1 = 0.97;
const HTTP_BAD_REQUEST = 400;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const MAX_TOOL_OUTPUT_BYTES = 64 * 1024 * 1024;
const MIB = 1024 * 1024;
/** Above the 64 MiB per-stream cap. */
const BOMB_MIB = 128;
/** pdf.js, Poppler and qpdf read the header only when all of `%PDF-` lies in the first 1,024 bytes. */
const LAST_HEADER_OFFSET = 1024 - '%PDF-'.length;
const PDF_BODY = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1');
const ZIP_LOCAL_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);
const MZ_HEADER = Buffer.from('MZ\x90\x00\x03\x00\x00\x00', 'latin1');
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const HTML_PAGE = Buffer.from('<!DOCTYPE html><html><body><script>alert(1)</script>', 'latin1');
/** The first bytes of a MacBinary II header (a zero byte, then the length of the file name). */
const MAC_BINARY_LEAD = Buffer.from([0x00, 0x0b]);

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function writeTemp(bytes: Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-imperfect-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'in.pdf');
  fs.writeFileSync(file, bytes);
  return file;
}

function pdftotext(bytes: Buffer): string {
  return execFileSync(requireOracleTool('pdftotext'), ['-q', '-enc', 'UTF-8', writeTemp(bytes), '-'], { encoding: 'utf8', maxBuffer: MAX_TOOL_OUTPUT_BYTES });
}

function popplerPageCount(bytes: Buffer): number {
  const info = execFileSync(requireOracleTool('pdfinfo'), [writeTemp(bytes)], { encoding: 'utf8' });
  return Number(/^Pages:\s+(\d+)/m.exec(info)?.[1]);
}

/** qpdf's verdict on the file's structure and streams (exit 0: no errors; 3: warnings only). */
function qpdfCheckStatus(bytes: Buffer): number {
  try {
    execFileSync(requireOracleTool('qpdf'), ['--check', writeTemp(bytes)], { stdio: 'pipe' });
    return 0;
  } catch (error) {
    return (error as { status: number }).status;
  }
}

/** The data of object `num` as qpdf decodes it. */
function qpdfDecodedStream(bytes: Buffer, num: number): Buffer {
  return execFileSync(requireOracleTool('qpdf'), ['--warning-exit-0', `--show-object=${num}`, '--filtered-stream-data', writeTemp(bytes)], { maxBuffer: MAX_TOOL_OUTPUT_BYTES });
}

function qpdfDecrypted(bytes: Buffer): Buffer {
  const input = writeTemp(bytes);
  const output = path.join(path.dirname(input), 'out.pdf');
  execFileSync(requireOracleTool('qpdf'), ['--warning-exit-0', '--decrypt', input, output]);
  return fs.readFileSync(output);
}

/** Every content and ToUnicode stream the text reader decodes, after the bounded check it runs first. */
function decodedStreams(bytes: Buffer): string[] {
  const document = assertPdfStreamsWithinLimits(bytes);
  const streams: string[] = [];
  document.contentStreams((content) => streams.push(content));
  document.toUnicodeStreams((content) => streams.push(content));
  return streams;
}

/** The words of Markdown: without the images it embeds as data URIs and without its markup characters. */
function markdownText(markdown: string): string {
  return markdown.replace(/!\[[^\]]*\]\(data:[^)]*\)/g, ' ').replace(/[#*_|>`\\-]/g, ' ');
}

function withHeaderAt(lead: Buffer, offset: number): Buffer {
  const front = Buffer.alloc(offset, 0x20);
  lead.copy(front, 0, 0, Math.min(lead.length, offset));
  return Buffer.concat([front, PDF_BODY, Buffer.alloc(2048, 0x20)]);
}

const LEADING_BYTES_SAMPLES = ['govdocs1-001294.pdf', 'govdocs1-001284.pdf', 'govdocs1-001273.pdf', 'govdocs1-002729.pdf', 'govdocs1-002731.pdf'];

describe.skipIf(toolsMissing)('bytes in front of the %PDF- header (real files)', () => {
  for (const id of LEADING_BYTES_SAMPLES) {
    it(`${id}: passes the upload gate and converts to the text Poppler reads`, async (ctx) => {
      const { bytes } = await requireRealworldSample(ctx, id);
      const header = bytes.indexOf('%PDF-', 0, 'latin1');
      expect(header).toBeGreaterThan(0);
      expect(header).toBeLessThanOrEqual(LAST_HEADER_OFFSET);
      expect(qpdfCheckStatus(bytes)).toBe(0);
      expect(popplerPageCount(bytes)).toBeGreaterThan(0);

      expect(() => assertNotSpoofedFile(bytes, 'pdf', id)).not.toThrow();
      const text = (await convertFile(bytes, 'pdf', 'txt', {}, id)).buffer.toString('utf8');
      expect(wordF1(pdftotext(bytes), text)).toBeGreaterThanOrEqual(MIN_WORD_F1);
    });
  }
});

describe('the %PDF- header search window of the upload gate', () => {
  it('accepts a header that ends on the last byte of the first 1,024 and refuses one that runs past it', () => {
    expect(() => assertNotSpoofedFile(withHeaderAt(MAC_BINARY_LEAD, LAST_HEADER_OFFSET), 'pdf', 'edge.pdf')).not.toThrow();
    for (const offset of [LAST_HEADER_OFFSET + 1, 1023, 1025]) {
      expect(() => assertNotSpoofedFile(withHeaderAt(MAC_BINARY_LEAD, offset), 'pdf', 'late.pdf')).toThrow(FileExtensionSpoofError);
    }
  });

  const otherKinds: Array<[string, Buffer]> = [
    ['a ZIP archive', ZIP_LOCAL_HEADER],
    ['a Windows executable', MZ_HEADER],
    ['a PNG image', PNG_SIGNATURE],
  ];
  for (const [kind, lead] of otherKinds) {
    it(`refuses ${kind} named .pdf whatever offset its %PDF- bytes sit at`, () => {
      for (const offset of [16, LAST_HEADER_OFFSET, 1023, 1025]) {
        expect(() => assertNotSpoofedFile(withHeaderAt(lead, offset), 'pdf', 'renamed.pdf')).toThrow(FileExtensionSpoofError);
      }
      expect(() => assertNotSpoofedFile(Buffer.concat([lead, Buffer.alloc(2048)]), 'pdf', 'renamed.pdf')).toThrow(FileExtensionSpoofError);
    });
  }

  it('refuses an HTML page named .pdf with %PDF- past the window', () => {
    for (const offset of [1023, 1025]) {
      expect(() => assertNotSpoofedFile(withHeaderAt(HTML_PAGE, offset), 'pdf', 'page.pdf')).toThrow(FileExtensionSpoofError);
    }
    expect(() => assertNotSpoofedFile(Buffer.concat([HTML_PAGE, Buffer.alloc(2048, 0x20)]), 'pdf', 'page.pdf')).toThrow(FileExtensionSpoofError);
  });

  it('hands an HTML page with %PDF- inside the window to the PDF reader, which refuses it when no PDF follows', async () => {
    const page = Buffer.concat([HTML_PAGE, Buffer.from('<p>%PDF- is how a PDF starts</p></body></html>', 'latin1'), Buffer.alloc(2048, 0x20)]);
    const error = await captureError(() => convertFile(page, 'pdf', 'txt', {}, 'page.pdf'));
    expect(error).toBeInstanceOf(ConversionFailedError);
    expect(error).not.toBeInstanceOf(FileExtensionSpoofError);
    expect(error).toHaveProperty('status', HTTP_BAD_REQUEST);
  });
});

/** Each real file and the object the reader refused: its /Length is written after it and the reader cut its last data byte, except in -002400, whose Adler-32 checksum is wrong. */
const STREAM_SAMPLES: Array<[string, number]> = [
  ['govdocs1-001376.pdf', 355],
  ['govdocs1-002174.pdf', 292],
  ['govdocs1-003843.pdf', 28],
  ['govdocs1-004679.pdf', 114],
  ['govdocs1-004701.pdf', 229],
  ['govdocs1-000153.pdf', 88],
  ['govdocs1-001377.pdf', 47],
  ['govdocs1-002463.pdf', 37],
  ['govdocs1-000887.pdf', 227],
  ['govdocs1-002145.pdf', 34],
  ['govdocs1-002166.pdf', 2],
  ['govdocs1-002400.pdf', 6],
  ['govdocs1-002705.pdf', 35],
  ['govdocs1-003824.pdf', 23],
  ['govdocs1-000332.pdf', 31],
  ['govdocs1-004442.pdf', 38],
  ['govdocs1-000324.pdf', 20],
  ['govdocs1-000141.pdf', 68],
  ['govdocs1-003667.pdf', 87],
  ['govdocs1-003688.pdf', 786],
  ['govdocs1-004507.pdf', 5],
  ['govdocs1-004657.pdf', 105],
];

describe.skipIf(toolsMissing)('streams the references decode (real files)', () => {
  for (const [id, num] of STREAM_SAMPLES) {
    it(`${id}: decodes object ${num} to the bytes qpdf decodes`, async (ctx) => {
      const { bytes } = await requireRealworldSample(ctx, id);
      const expected = qpdfDecodedStream(bytes, num).toString('latin1');
      expect(expected.length).toBeGreaterThan(0);
      expect(decodedStreams(bytes)).toContain(expected);
    });
  }

  for (const id of ['govdocs1-004679.pdf', 'govdocs1-001376.pdf']) {
    it(`${id}: converts to Markdown with the words Poppler reads`, async (ctx) => {
      const { bytes } = await requireRealworldSample(ctx, id);
      const markdown = (await convertFile(bytes, 'pdf', 'md', {}, id)).buffer.toString('utf8');
      expect(wordF1(pdftotext(bytes), markdownText(markdown))).toBeGreaterThanOrEqual(MIN_WORD_F1);
    });
  }

  it('pdfjs-sechandler.pdf: reads the empty Flate stream that the decrypted file holds as empty, and converts', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, 'pdfjs-sechandler.pdf');
    const decrypted = qpdfDecrypted(bytes);
    expect(qpdfDecodedStream(decrypted, 25).length).toBe(0);
    expect(() => decodedStreams(decrypted)).not.toThrow();
    const rtf = (await dispatchConversion(bytes, 'pdf', 'rtf', {}, 'pdfjs-sechandler.pdf')).buffer.toString('latin1');
    expect(rtf.startsWith('{\\rtf1')).toBe(true);
  });
});

const PAGE_TEXT = 'Indirect length text';

/** A one-page PDF whose content stream (4) takes its /Length from object 6, written after it; `lineEnd` comes before `endstream`. */
function laterLengthPdf(data: Buffer, declaredLength: number = data.length, lineEnd = ''): Buffer {
  const objects: CraftObject[] = [
    { id: 1, dict: '/Type /Catalog /Pages 2 0 R' },
    { id: 2, dict: '/Type /Pages /Kids [3 0 R] /Count 1' },
    { id: 3, dict: '/Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >>' },
    { id: 4, raw: `<< /Filter /FlateDecode /Length 6 0 R >>\nstream\n${data.toString('latin1')}${lineEnd}endstream` },
    { id: 5, raw: HELVETICA_FONT },
    { id: 6, raw: String(declaredLength) },
  ];
  return buildPdf(objects, 1).buffer;
}

const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;

/** Flate data of a content stream drawing PAGE_TEXT whose last byte (the last of the Adler-32 checksum) is `last`. */
function flateEndingIn(last: number): Buffer {
  for (let pad = 0; ; pad++) {
    const data = flate(`${textContent(PAGE_TEXT)}${' '.repeat(pad)}`);
    if (data.at(-1) === last) return data;
  }
}

function withBadChecksum(data: Buffer): Buffer {
  const broken = Buffer.from(data);
  broken[broken.length - 1] ^= 0xff;
  return broken;
}

function expectStatus(error: unknown, type: typeof CorruptStreamError | typeof DecompressionLimitError, status: number): void {
  expect(error).toBeInstanceOf(type);
  expect(error).toHaveProperty('status', status);
}

describe.skipIf(toolsMissing)('stream extents and Flate data the references read', () => {
  const lineEndBytes: Array<[string, number, string]> = [
    ['a line feed, right before endstream', LINE_FEED, ''],
    ['a carriage return, right before endstream', CARRIAGE_RETURN, ''],
    ['a carriage return, then a line feed before endstream', CARRIAGE_RETURN, '\n'],
  ];
  for (const [what, last, lineEnd] of lineEndBytes) {
    it(`keeps the last data byte of a stream whose /Length is written after it and whose data ends in ${what}`, async () => {
      const data = flateEndingIn(last);
      const pdf = laterLengthPdf(data, data.length, lineEnd);
      expect(qpdfDecodedStream(pdf, 4).toString('latin1')).toContain(PAGE_TEXT);
      expect(pdftotext(pdf)).toContain(PAGE_TEXT);
      expect((await extractPdfDocument(pdf)).text).toContain(PAGE_TEXT);
    });
  }

  it('falls back to the endstream keyword when the /Length written after the stream is wrong or past the end of the file', async () => {
    const data = flate(textContent(PAGE_TEXT));
    for (const declared of [3, data.length + 1, 10 * MIB]) {
      expect((await extractPdfDocument(laterLengthPdf(data, declared))).text).toContain(PAGE_TEXT);
    }
  });

  it('reads a Flate stream whose Adler-32 checksum is wrong, as qpdf and Poppler do', async () => {
    const pdf = singlePagePdf(withBadChecksum(flate(textContent(PAGE_TEXT)))).buffer;
    expect(qpdfDecodedStream(pdf, 4).toString('latin1')).toBe(textContent(PAGE_TEXT));
    expect(pdftotext(pdf)).toContain(PAGE_TEXT);
    expect((await extractPdfDocument(pdf)).text).toContain(PAGE_TEXT);
  });

  it('reads an empty Flate stream as no content, as qpdf does', async () => {
    const pdf = singlePagePdf(Buffer.alloc(0), [], { pageExtra: '' }).buffer;
    expect(qpdfDecodedStream(pdf, 4).length).toBe(0);
    expect(() => decodedStreams(pdf)).not.toThrow();
    expect(decodedStreams(pdf)).toEqual(['']);
  });
});

/** Streams, and the bytes of white space their lengths all end in (halfway in): checked without a bound, the lookahead would skip 3,000 x 1 MiB. */
const RUN_STREAMS = 3000;
const RUN_BYTES = 2 * MIB;
/** Hang guard only: with the lookahead bounded, indexing the file takes milliseconds. */
const RUN_HANG_GUARD_MS = 20_000;
/** Streams of the NUL-run file, the bytes of data each holds, and the streams of the small file whose content is read back (the guard and the reader each decode every stream). */
const NUL_STREAMS = 40;
const NUL_STREAM_BYTES = 4 * MIB;
const NUL_STREAMS_READ_BACK = 4;

/** A file of RUN_STREAMS tiny streams whose /Length (direct, or an object written after them) ends inside one long run of spaces. */
function lengthsIntoOneWhiteRun(later: boolean): Buffer {
  const bodies = Array.from({ length: RUN_STREAMS }, (_, i) => `${i + 1} 0 obj\n<< /Length ${'#'.repeat(20)} >>\nstream\nxxendstream\nendobj\n`);
  const dataStarts: number[] = [];
  let offset = '%PDF-1.4\n'.length;
  for (const body of bodies) {
    dataStarts.push(offset + body.indexOf('stream\n') + 'stream\n'.length);
    offset += body.length;
  }
  const insideRun = offset + RUN_BYTES / 2;
  const lengthObjects = later ? dataStarts.map((start, i) => `${RUN_STREAMS + 1 + i} 0 obj\n${insideRun - start}\nendobj\n`).join('') : '';
  const streams = bodies.map((body, i) => body.replace('#'.repeat(20), (later ? `${RUN_STREAMS + 1 + i} 0 R` : String(insideRun - dataStarts[i])).padEnd(20)));
  return Buffer.from(`%PDF-1.4\n${streams.join('')}${' '.repeat(RUN_BYTES)}${lengthObjects}trailer\n<< /Root 1 0 R >>\n%%EOF\n`, 'latin1');
}

/** `count` content streams with a direct /Length of 1 that each hold `q `, a run of NULs (PDF white space) and ` Q`. */
function wrongLengthsBeforeNulRuns(count: number): Buffer {
  const data = Buffer.concat([Buffer.from('q '), Buffer.alloc(NUL_STREAM_BYTES, 0), Buffer.from(' Q')]);
  const objects = Array.from({ length: count }, (_, i) =>
    Buffer.concat([Buffer.from(`${10 + i} 0 obj\n<< /Length 1 >>\nstream\n`), data, Buffer.from('\nendstream\nendobj\n')])
  );
  const refs = Array.from({ length: count }, (_, i) => `${10 + i} 0 R`).join(' ');
  const head = `%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] /Contents [${refs}] >>\nendobj\n`;
  return Buffer.concat([Buffer.from(head), ...objects, Buffer.from('trailer\n<< /Root 1 0 R >>\n%%EOF\n')]);
}

describe('stream length checks on hostile input', () => {
  for (const later of [false, true]) {
    it(`reads, in milliseconds, a file whose ${later ? 'later' : 'direct'} /Length values all end in one long run of white space`, async () => {
      const bytes = lengthsIntoOneWhiteRun(later);
      const started = Date.now();
      expect(() => decodedStreams(bytes)).not.toThrow();
      expect(Date.now() - started).toBeLessThan(RUN_HANG_GUARD_MS);
    });
  }

  it('passes the guard, in milliseconds, for a file whose wrong /Length is followed by megabytes of NUL bytes in every one of its streams', () => {
    const bytes = wrongLengthsBeforeNulRuns(NUL_STREAMS);
    const started = Date.now();
    expect(() => assertPdfStreamsWithinLimits(bytes)).not.toThrow();
    expect(Date.now() - started).toBeLessThan(RUN_HANG_GUARD_MS);
  });

  it('reads the whole data of a stream whose wrong /Length is followed by megabytes of NUL bytes, as it was read before the lookahead was bounded', () => {
    const contents = decodedStreams(wrongLengthsBeforeNulRuns(NUL_STREAMS_READ_BACK));
    expect(contents.map((content) => content.length)).toEqual(Array(NUL_STREAMS_READ_BACK).fill(NUL_STREAM_BYTES + 4));
    for (const content of contents) {
      expect(content.startsWith('q ')).toBe(true);
      expect(content.endsWith(' Q')).toBe(true);
    }
  });
});

describe('the white space between a stream length and endstream', () => {
  const DATA = 'BT /F1 12 Tf (x) Tj ET';
  const streamFile = (gap: string): Buffer =>
    Buffer.from(
      `%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] /Contents 4 0 R >>\nendobj\n4 0 obj\n<< /Length ${DATA.length} >>\nstream\n${DATA}${gap}endstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`,
      'latin1'
    );

  it('ends the data at the length when a CR LF, the longest line end, or sixteen spaces separate them', () => {
    expect(decodedStreams(streamFile('\r\n'))).toEqual([DATA]);
    expect(decodedStreams(streamFile(' '.repeat(16)))).toEqual([DATA]);
  });

  it('searches for endstream, and drops one line end, when more than sixteen bytes of white space separate them', () => {
    expect(decodedStreams(streamFile(`${' '.repeat(17)}\n`))).toEqual([`${DATA}${' '.repeat(17)}`]);
  });
});

describe('Flate defences that stay', () => {
  const zeroBomb = zlib.deflateSync(Buffer.alloc(BOMB_MIB * MIB), { level: 9 });

  it('refuses a bomb with a wrong checksum at the cap (413), before the checksum is reached', async () => {
    const error = await captureError(async () => decodedStreams(singlePagePdf(withBadChecksum(zeroBomb)).buffer));
    expectStatus(error, DecompressionLimitError, HTTP_PAYLOAD_TOO_LARGE);
  });

  it('refuses a bomb that is cut short at the cap (413)', async () => {
    const error = await captureError(async () => decodedStreams(singlePagePdf(zeroBomb.subarray(0, zeroBomb.length - 64)).buffer));
    expectStatus(error, DecompressionLimitError, HTTP_PAYLOAD_TOO_LARGE);
  });

  const brokenAtStart: Array<[string, Buffer]> = [
    ['no zlib header', Buffer.from('this is not a zlib stream at all', 'latin1')],
    ['a compression method other than deflate', Buffer.from([0x79, 0x9c, 0x03, 0x00])],
    ['a header whose check bits are wrong', Buffer.from([0x78, 0x9d, 0x03, 0x00])],
    ['a preset dictionary', Buffer.from([0x78, 0xbb, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01])],
    ['the reserved block type in its first block', Buffer.from([0x78, 0x9c, 0xff, 0xff, 0xff])],
    ['a header and nothing after it', Buffer.from([0x78, 0x9c])],
  ];
  for (const [what, data] of brokenAtStart) {
    it(`refuses a Flate stream with ${what} (400)`, async () => {
      const error = await captureError(async () => decodedStreams(singlePagePdf(data).buffer));
      expectStatus(error, CorruptStreamError, HTTP_BAD_REQUEST);
    });
  }
});
