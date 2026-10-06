import { describe, expect, it } from 'vitest';
import { PdfStructureError } from '../src/lib/conversions/pdf-document';
import { extractStructuredTextFromPdf } from '../src/lib/conversions/pdf-utils';
import { type CraftObject, buildPdf, flate, singlePagePdf, textContent } from './helpers/pdf-craft';

/**
 * Linear-time structure reading: object streams, indirect stream lengths and page-tree fallbacks
 * must cost time proportional to the file, whatever offsets, lengths or sizes the file declares.
 * Fixtures are written with tests/helpers/pdf-craft.ts from the ISO 32000-1 object stream
 * (section 7.5.7) and stream dictionary (section 7.3.8) layouts.
 */

const MIB = 1024 * 1024;
const FAST_MS = 1000;
const OBJSTM_ENTRIES = 100;
const OBJSTM_BODY_MIB = 8;
const HEADER_FLOOD_PAIRS = 32 * MIB;
const LENGTH_TARGET_ELEMENTS = 500 * 1000;
const LENGTH_REFERENCING_STREAMS = 400;
const FIRST_OBJECT_NUMBER = 100;

const catalog: CraftObject[] = [
  { id: 1, dict: '/Type /Catalog /Pages 2 0 R' },
  { id: 2, dict: '/Type /Pages /Kids [] /Count 0' },
];

function timed<T>(run: () => T): { value?: T; err?: unknown; ms: number } {
  const started = Date.now();
  try {
    return { value: run(), ms: Date.now() - started };
  } catch (err) {
    return { err, ms: Date.now() - started };
  }
}

describe('object stream entries are read in time linear in the stream', () => {
  for (const opener of ['(', '<', '[']) {
    it(`entries that all open an unterminated "${opener}" cost one pass, not one pass each`, () => {
      let header = '';
      for (let i = 0; i < OBJSTM_ENTRIES; i++) header += `${FIRST_OBJECT_NUMBER + i} 0 `;
      const body = opener + 'a'.repeat(OBJSTM_BODY_MIB * MIB);
      const objectStream: CraftObject = {
        id: 9,
        dict: `/Type /ObjStm /N ${OBJSTM_ENTRIES} /First ${header.length} /Filter /FlateDecode`,
        stream: flate(header + body),
      };
      const pdf = buildPdf([...catalog, objectStream], 1).buffer;
      const { err, ms } = timed(() => extractStructuredTextFromPdf(pdf));
      expect(err).toBeUndefined();
      expect(ms).toBeLessThan(FAST_MS);
    });
  }

  it('still reads the objects of a well-formed object stream', () => {
    const page = '<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>';
    const pages = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>';
    const header = `2 0 3 ${pages.length + 1} `;
    const objectStream: CraftObject = {
      id: 9,
      dict: `/Type /ObjStm /N 2 /First ${header.length} /Filter /FlateDecode`,
      stream: flate(`${header}${pages} ${page}`),
    };
    const objects: CraftObject[] = [
      { id: 1, dict: '/Type /Catalog /Pages 2 0 R' },
      objectStream,
      { id: 4, dict: '/Filter /FlateDecode', stream: flate(textContent('PACKED-PAGE-TREE')) },
    ];
    expect(extractStructuredTextFromPdf(buildPdf(objects, 1).buffer).text).toBe('PACKED-PAGE-TREE');
  });
});

describe('an object stream cannot make the reader tokenise or allocate its whole body', () => {
  it('refuses a /First that points far past the header an object count can need', () => {
    const body = '1 '.repeat(HEADER_FLOOD_PAIRS);
    const objectStream: CraftObject = {
      id: 9,
      dict: `/Type /ObjStm /N 1 /First ${body.length} /Filter /FlateDecode`,
      stream: flate(body),
    };
    const pdf = buildPdf([...catalog, objectStream], 1).buffer;
    const rssBefore = process.resourceUsage().maxRSS;
    const { err, ms } = timed(() => extractStructuredTextFromPdf(pdf));
    expect(err).toBeInstanceOf(PdfStructureError);
    expect((err as Error).message).toMatch(/\/First/);
    expect(ms).toBeLessThan(FAST_MS);
    expect((process.resourceUsage().maxRSS - rssBefore) / 1024).toBeLessThan(300);
  });

  it('refuses a /First beyond the decoded stream', () => {
    const objectStream: CraftObject = {
      id: 9,
      dict: '/Type /ObjStm /N 1 /First 4000 /Filter /FlateDecode',
      stream: flate('2 0 << >>'),
    };
    const err = timed(() => extractStructuredTextFromPdf(buildPdf([...catalog, objectStream], 1).buffer)).err;
    expect(err).toBeInstanceOf(PdfStructureError);
    expect((err as Error).message).toMatch(/\/First/);
  });
});

describe('an indirect /Length costs a constant per stream', () => {
  it('reads only the leading integer of the length object', () => {
    const lengthTarget: CraftObject = { id: 20, raw: `[${'1 '.repeat(LENGTH_TARGET_ELEMENTS)}]` };
    const streams: CraftObject[] = [];
    for (let i = 0; i < LENGTH_REFERENCING_STREAMS; i++) {
      streams.push({ id: 100 + i, raw: '<< /Length 20 0 R >>\nstream\nab\nendstream' });
    }
    const content = singlePagePdf(flate(textContent('LENGTH-LIES'))).buffer;
    const withLengths = Buffer.concat([
      content.subarray(0, content.indexOf('xref')),
      Buffer.from(`${lengthTarget.id} 0 obj\n${lengthTarget.raw}\nendobj\n`, 'latin1'),
      ...streams.map((s) => Buffer.from(`${s.id} 0 obj\n${s.raw}\nendobj\n`, 'latin1')),
      content.subarray(content.indexOf('xref')),
    ]);
    const { value, ms } = timed(() => extractStructuredTextFromPdf(withLengths));
    expect(value?.text).toBe('LENGTH-LIES');
    expect(ms).toBeLessThan(FAST_MS);
  });

  it('honours an indirect /Length that is an integer', () => {
    const payload = '% endstream appears inside the data\n';
    const objects: CraftObject[] = [
      { id: 1, dict: '/Type /Catalog /Pages 2 0 R' },
      { id: 2, dict: '/Type /Pages /Kids [3 0 R] /Count 1' },
      { id: 3, dict: '/Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >>' },
      { id: 5, raw: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' },
      { id: 6, raw: String(payload.length + textContent('LENGTH-HONOURED').length) },
      {
        id: 4,
        raw: `<< /Length 6 0 R >>\nstream\n${payload}${textContent('LENGTH-HONOURED')}endstream`,
      },
    ];
    expect(extractStructuredTextFromPdf(buildPdf(objects, 1).buffer).text).toBe('LENGTH-HONOURED');
  });
});
