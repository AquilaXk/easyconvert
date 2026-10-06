import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PdfStructureError } from '../src/lib/conversions/pdf-document';
import { extractTextFromPdf } from '../src/lib/conversions/pdf-utils';
import { CorruptStreamError, DecompressionLimitError } from '../src/lib/types';
import { getOracleToolPath } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';
import { type CraftObject, buildPdf, flate, textContent } from './helpers/pdf-craft';

/**
 * Stream filter chains of ISO 32000-1 section 7.4: ASCIIHexDecode (7.4.2), ASCII85Decode (7.4.3) and
 * FlateDecode with the PNG and TIFF predictors (7.4.4.4). Encoders below are written from those
 * sections for the test, and pdftotext reads the same files as the reference.
 */

const MIB = 1024 * 1024;
const HTTP_BAD_REQUEST = 400;
const ROW_BYTES = 16;
const ASCII85_ZERO_RUN = 20 * MIB;
const ASCII85_BASE = 85;
const ASCII85_FIRST_CHAR = 33;
const BYTES_PER_GROUP = 4;

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function pdftotext(pdf: Buffer): string {
  const tool = getOracleToolPath('pdftotext');
  if (!tool) throw new Error('pdftotext is required for this oracle test');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-filters-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'in.pdf');
  fs.writeFileSync(file, pdf);
  return execFileSync(tool, [file, '-'], { encoding: 'utf8' });
}

const words = (text: string): string[] => text.split(/\s+/).filter((w) => w.length > 0);

function caught(run: () => unknown): unknown {
  try {
    run();
  } catch (err) {
    return err;
  }
  return undefined;
}

/** Content of whole rows: text operators padded with spaces to a multiple of the row width. */
function paddedContent(text: string): Buffer {
  const raw = Buffer.from(textContent(text), 'latin1');
  const padded = Buffer.alloc(Math.ceil(raw.length / ROW_BYTES) * ROW_BYTES, 0x20);
  raw.copy(padded);
  return padded;
}

// ---- encoders written from the specification ------------------------------------------------------

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** PNG filtering (section 9 of the PNG specification): row i uses filter type i mod 5. */
function pngEncode(data: Buffer, rowBytes: number, bytesPerPixel: number): Buffer {
  const rows = data.length / rowBytes;
  const out = Buffer.alloc(rows * (rowBytes + 1));
  for (let r = 0; r < rows; r++) {
    const type = r % 5;
    out[r * (rowBytes + 1)] = type;
    for (let i = 0; i < rowBytes; i++) {
      const x = data[r * rowBytes + i];
      const left = i >= bytesPerPixel ? data[r * rowBytes + i - bytesPerPixel] : 0;
      const up = r > 0 ? data[(r - 1) * rowBytes + i] : 0;
      const upLeft = r > 0 && i >= bytesPerPixel ? data[(r - 1) * rowBytes + i - bytesPerPixel] : 0;
      let predicted = 0;
      if (type === 1) predicted = left;
      else if (type === 2) predicted = up;
      else if (type === 3) predicted = Math.floor((left + up) / 2);
      else if (type === 4) predicted = paeth(left, up, upLeft);
      out[r * (rowBytes + 1) + 1 + i] = (x - predicted) & 0xff;
    }
  }
  return out;
}

/** TIFF predictor 2 for 8-bit samples: each byte becomes its difference from the sample one pixel left. */
function tiffEncode(data: Buffer, rowBytes: number, bytesPerPixel: number): Buffer {
  const out = Buffer.from(data);
  for (let r = 0; r < data.length / rowBytes; r++) {
    for (let i = bytesPerPixel; i < rowBytes; i++) {
      out[r * rowBytes + i] = (data[r * rowBytes + i] - data[r * rowBytes + i - bytesPerPixel]) & 0xff;
    }
  }
  return out;
}

function asciiHexEncode(data: Buffer): Buffer {
  return Buffer.from(`${data.toString('hex').replace(/(.{64})/g, '$1\n')}>`, 'latin1');
}

function ascii85Encode(data: Buffer): Buffer {
  let out = '';
  for (let i = 0; i < data.length; i += BYTES_PER_GROUP) {
    const group = data.subarray(i, i + BYTES_PER_GROUP);
    const padded = Buffer.alloc(BYTES_PER_GROUP);
    group.copy(padded);
    let value = padded.readUInt32BE(0);
    const digits: string[] = [];
    for (let d = 0; d <= BYTES_PER_GROUP; d++) {
      digits.unshift(String.fromCharCode((value % ASCII85_BASE) + ASCII85_FIRST_CHAR));
      value = Math.floor(value / ASCII85_BASE);
    }
    out += group.length === BYTES_PER_GROUP ? digits.join('') : digits.slice(0, group.length + 1).join('');
  }
  return Buffer.from(`${out}~>`, 'latin1');
}

function pdfWithContent(stream: Buffer, dict: string): Buffer {
  return buildPdf(
    [
      { id: 1, dict: '/Type /Catalog /Pages 2 0 R' },
      { id: 2, dict: '/Type /Pages /Kids [3 0 R] /Count 1' },
      {
        id: 3,
        dict: '/Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >>',
      },
      { id: 4, dict, stream },
      { id: 5, raw: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' },
    ],
    1
  ).buffer;
}

describe('FlateDecode predictors', () => {
  const content = paddedContent('PREDICTOR-ROUNDTRIP-TEXT');
  const parms = `/Columns ${ROW_BYTES}`;

  for (const predictor of [10, 11, 12, 13, 14, 15]) {
    it(`reads PNG predictor ${predictor} (rows filtered with types 0 to 4)`, () => {
      const stream = flate(pngEncode(content, ROW_BYTES, 1));
      const pdf = pdfWithContent(stream, `/Filter /FlateDecode /DecodeParms << /Predictor ${predictor} ${parms} >>`);
      expect(extractTextFromPdf(pdf)).toBe('PREDICTOR-ROUNDTRIP-TEXT');
    });
  }

  it('reads TIFF predictor 2 on 8-bit samples', () => {
    const stream = flate(tiffEncode(content, ROW_BYTES, 1));
    const pdf = pdfWithContent(stream, `/Filter /FlateDecode /DecodeParms << /Predictor 2 ${parms} >>`);
    expect(extractTextFromPdf(pdf)).toBe('PREDICTOR-ROUNDTRIP-TEXT');
  });

  it('reads a predictor over four colour components', () => {
    const colors = 4; // ROW_BYTES / 4 pixels of 4 bytes
    const stream = flate(pngEncode(content, ROW_BYTES, colors));
    const pdf = pdfWithContent(
      stream,
      `/Filter /FlateDecode /DecodeParms << /Predictor 15 /Colors ${colors} ${parms} /Columns ${ROW_BYTES / colors} >>`
    );
    expect(extractTextFromPdf(pdf)).toBe('PREDICTOR-ROUNDTRIP-TEXT');
  });

  oracleTest('matches pdftotext for a PNG-predicted content stream', ['pdftotext'], () => {
    const pdf = pdfWithContent(
      flate(pngEncode(content, ROW_BYTES, 1)),
      `/Filter /FlateDecode /DecodeParms << /Predictor 15 ${parms} >>`
    );
    expect(words(extractTextFromPdf(pdf))).toEqual(words(pdftotext(pdf)));
  });

  it('refuses predictor parameters that describe no row layout', () => {
    const pdf = pdfWithContent(flate(content), '/Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 0 >>');
    const err = caught(() => extractTextFromPdf(pdf));
    expect(err).toBeInstanceOf(PdfStructureError);
    expect((err as Error).message).toMatch(/Columns/);
  });
});

describe('filter chains', () => {
  const text = 'CHAINED-FILTER-TEXT';
  const content = Buffer.from(textContent(text), 'latin1');

  it('reads ASCIIHexDecode then FlateDecode', () => {
    const pdf = pdfWithContent(asciiHexEncode(flate(content)), '/Filter [/ASCIIHexDecode /FlateDecode]');
    expect(extractTextFromPdf(pdf)).toBe(text);
  });

  it('reads ASCII85Decode then FlateDecode', () => {
    const pdf = pdfWithContent(ascii85Encode(flate(content)), '/Filter [/ASCII85Decode /FlateDecode]');
    expect(extractTextFromPdf(pdf)).toBe(text);
  });

  it('reads a lone ASCIIHexDecode and a lone ASCII85Decode content stream', () => {
    expect(extractTextFromPdf(pdfWithContent(asciiHexEncode(content), '/Filter /ASCIIHexDecode'))).toBe(text);
    expect(extractTextFromPdf(pdfWithContent(ascii85Encode(content), '/Filter /ASCII85Decode'))).toBe(text);
  });

  it('applies a predictor to the Flate stage of a chain', () => {
    const padded = paddedContent(text);
    const pdf = pdfWithContent(
      asciiHexEncode(flate(pngEncode(padded, ROW_BYTES, 1))),
      `/Filter [/ASCIIHexDecode /FlateDecode] /DecodeParms [null << /Predictor 15 /Columns ${ROW_BYTES} >>]`
    );
    expect(extractTextFromPdf(pdf)).toBe(text);
  });

  oracleTest('matches pdftotext for ASCII85 then Flate', ['pdftotext'], () => {
    const pdf = pdfWithContent(ascii85Encode(flate(content)), '/Filter [/ASCII85Decode /FlateDecode]');
    expect(words(extractTextFromPdf(pdf))).toEqual(words(pdftotext(pdf)));
  });

  it('maps malformed ASCII85 and ASCIIHex data to a typed 400', () => {
    for (const [data, filter] of [
      [Buffer.from('!!!\x01!~>', 'latin1'), '/ASCII85Decode'],
      [Buffer.from('4G5Zz>', 'latin1'), '/ASCIIHexDecode'],
    ] as const) {
      const err = caught(() => extractTextFromPdf(pdfWithContent(data, `/Filter ${filter}`)));
      expect(err).toBeInstanceOf(CorruptStreamError);
      expect((err as CorruptStreamError).status).toBe(HTTP_BAD_REQUEST);
    }
  });

  it('bounds the expansion of ASCII85 zero groups', () => {
    const zeros = Buffer.alloc(ASCII85_ZERO_RUN, 'z');
    const err = caught(() => extractTextFromPdf(pdfWithContent(Buffer.concat([zeros, Buffer.from('~>')]), '/Filter /ASCII85Decode')));
    expect(err).toBeInstanceOf(DecompressionLimitError);
  });
});

describe('streams that must be decoded for text never vanish silently', () => {
  it('refuses a page content stream with a filter this reader cannot decode', () => {
    const err = caught(() => extractTextFromPdf(pdfWithContent(Buffer.from('....', 'latin1'), '/Filter /LZWDecode')));
    expect(err).toBeInstanceOf(PdfStructureError);
    expect((err as Error).message).toMatch(/LZWDecode/);
  });

  it('refuses a chain whose last filter cannot be decoded', () => {
    const pdf = pdfWithContent(asciiHexEncode(Buffer.from('....')), '/Filter [/ASCIIHexDecode /RunLengthDecode]');
    const err = caught(() => extractTextFromPdf(pdf));
    expect(err).toBeInstanceOf(PdfStructureError);
    expect((err as Error).message).toMatch(/RunLengthDecode/);
  });

  it('leaves undecodable streams alone in a file with no page structure', () => {
    const objects: CraftObject[] = [
      { id: 1, dict: '/Filter /DCTDecode', stream: Buffer.from('\xff\xd8not an image', 'latin1') },
      { id: 2, dict: '', stream: Buffer.from(textContent('LOOSE-STREAM-TEXT'), 'latin1') },
    ];
    const pdf = buildPdf(objects, 1).buffer.toString('latin1').replace(/trailer[\s\S]*?startxref/, 'startxref');
    expect(extractTextFromPdf(Buffer.from(pdf, 'latin1'))).toBe('LOOSE-STREAM-TEXT');
  });
});

describe('a root with no usable page tree still yields its page objects', () => {
  const page: CraftObject = {
    id: 3,
    dict: '/Type /Page /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >>',
  };
  const rest: CraftObject[] = [
    { id: 4, dict: '/Filter /FlateDecode', stream: flate(textContent('LOOSE-PAGE-TEXT')) },
    { id: 5, raw: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' },
  ];

  it('reads page objects when the catalog has no /Pages', () => {
    const pdf = buildPdf([{ id: 1, dict: '/Type /Catalog' }, page, ...rest], 1).buffer;
    expect(extractTextFromPdf(pdf)).toBe('LOOSE-PAGE-TEXT');
  });

  it('reads page objects when the page tree lists no kids', () => {
    const pdf = buildPdf(
      [{ id: 1, dict: '/Type /Catalog /Pages 2 0 R' }, { id: 2, dict: '/Type /Pages /Kids [] /Count 0' }, page, ...rest],
      1
    ).buffer;
    expect(extractTextFromPdf(pdf)).toBe('LOOSE-PAGE-TEXT');
  });

  it('prefers the page tree when it lists pages', () => {
    const pdf = buildPdf(
      [
        { id: 1, dict: '/Type /Catalog /Pages 2 0 R' },
        { id: 2, dict: '/Type /Pages /Kids [3 0 R] /Count 1' },
        { ...page, dict: `${page.dict} /Parent 2 0 R` },
        ...rest,
        { id: 6, dict: '/Type /Page /Contents 7 0 R /Resources << /Font << /F1 5 0 R >> >>' },
        { id: 7, dict: '/Filter /FlateDecode', stream: flate(textContent('UNLISTED-PAGE-TEXT')) },
      ],
      1
    ).buffer;
    expect(extractTextFromPdf(pdf)).toBe('LOOSE-PAGE-TEXT');
  });

  it('returns no text for a catalog with no pages at all', () => {
    const pdf = buildPdf(
      [
        { id: 1, dict: '/Type /Catalog /Pages 2 0 R' },
        { id: 2, dict: '/Type /Pages /Kids [] /Count 0' },
        { id: 7, dict: '', stream: Buffer.from(textContent('ORPHAN-STREAM-TEXT'), 'latin1') },
      ],
      1
    ).buffer;
    expect(extractTextFromPdf(pdf)).toBe('');
  });
});
