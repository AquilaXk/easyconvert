import { describe, expect, it, vi } from 'vitest';
import { PdfStructureError } from '../src/lib/conversions/pdf-document';
import { extractStructuredTextFromPdf } from '../src/lib/conversions/pdf-utils';
import { type CraftObject, buildPdf, flate, singlePagePdf, textContent } from './helpers/pdf-craft';
import { expectLinearOnInputs, expectSizeIndependentOnInputs, SCALING_FACTOR, settle } from './helpers/timing';

/**
 * Linear-time structure reading: object streams, indirect stream lengths and page-tree fallbacks
 * must cost time proportional to the file, whatever offsets, lengths or sizes the file declares.
 * Fixtures are written with tests/helpers/pdf-craft.ts from the ISO 32000-1 object stream
 * (section 7.5.7) and stream dictionary (section 7.3.8) layouts.
 */

const MIB = 1024 * 1024;
// Each bound is checked by comparing two inputs in the same process (tests/helpers/timing.ts): work that must
// not depend on a declared or repeated quantity costs the same for both, and work that must be linear in the
// file grows about 4x for 4x the file. Neither depends on how fast the runner is.
const BOUND_TEST_TIMEOUT_MS = 60_000;
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

vi.setConfig({ testTimeout: BOUND_TEST_TIMEOUT_MS });

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
    it(`entries that all open an unterminated "${opener}" cost one pass, not one pass each`, async () => {
      // One pass over the body whatever the number of entries: 4x the entries must cost about the same, where a
      // pass per entry would cost 4x.
      const objectStreamPdf = (entries: number): Buffer => {
        let header = '';
        for (let i = 0; i < entries; i++) header += `${FIRST_OBJECT_NUMBER + i} 0 `;
        const body = opener + 'a'.repeat(OBJSTM_BODY_MIB * MIB);
        const objectStream: CraftObject = {
          id: 9,
          dict: `/Type /ObjStm /N ${entries} /First ${header.length} /Filter /FlateDecode`,
          stream: flate(header + body),
        };
        return buildPdf([...catalog, objectStream], 1).buffer;
      };
      const { largeResult } = await expectSizeIndependentOnInputs(
        `unterminated ${opener}`,
        (pdf: Buffer) => settle(() => extractStructuredTextFromPdf(pdf)),
        { modest: objectStreamPdf(OBJSTM_ENTRIES / SCALING_FACTOR), huge: objectStreamPdf(OBJSTM_ENTRIES) }
      );
      expect(largeResult.ok, 'the object stream is read without error').toBe(true);
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
    const { err } = timed(() => extractStructuredTextFromPdf(pdf));
    expect(err).toBeInstanceOf(PdfStructureError);
    expect((err as Error).message).toMatch(/\/First/);
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

describe('a document defines a bounded number of objects', () => {
  const OBJECT_CAP = 500 * 1000;

  function tinyObjects(count: number): Buffer {
    const parts: string[] = ['%PDF-1.7\n'];
    for (let i = 1; i <= count; i++) parts.push(`${i} 0 obj\n<< /A ${i} >>\nendobj\n`);
    parts.push('trailer\n<< >>\n%%EOF\n');
    return Buffer.from(parts.join(''), 'latin1');
  }

  it('refuses more objects than the cap in time linear in the file', async () => {
    const { largeResult } = await expectLinearOnInputs('objects past the cap', (pdf: Buffer) => settle(() => extractStructuredTextFromPdf(pdf)), {
      small: tinyObjects(Math.floor(OBJECT_CAP / SCALING_FACTOR)),
      large: tinyObjects(OBJECT_CAP + 1),
    });
    if (largeResult.ok) throw new Error('a file with more objects than the cap was accepted');
    expect(largeResult.error).toBeInstanceOf(PdfStructureError);
    expect((largeResult.error as Error).message).toMatch(/more than 500000 objects/);
  });

  it('reads a file with no root and many objects that name no type in linear time', async () => {
    const { largeResult } = await expectLinearOnInputs('objects without a type', (pdf: Buffer) => extractStructuredTextFromPdf(pdf), {
      small: tinyObjects(OBJECT_CAP / SCALING_FACTOR),
      large: tinyObjects(OBJECT_CAP),
    });
    expect(largeResult.text).toBe('');
  });
});

describe('an indirect /Length costs a constant per stream', () => {
  it('reads only the leading integer of the length object', async () => {
    // The /Length target is an array of LENGTH_TARGET_ELEMENTS integers read by 400 streams. A reader that
    // parses the whole target per stream costs 4x as much for a 4x longer array; reading only the leading
    // integer costs the same for both.
    const pdfWithLengthTarget = (elements: number): Buffer => {
      const lengthTarget: CraftObject = { id: 20, raw: `[${'1 '.repeat(elements)}]` };
      const streams: CraftObject[] = [];
      for (let i = 0; i < LENGTH_REFERENCING_STREAMS; i++) {
        streams.push({ id: 100 + i, raw: '<< /Length 20 0 R >>\nstream\nab\nendstream' });
      }
      const content = singlePagePdf(flate(textContent('LENGTH-LIES'))).buffer;
      return Buffer.concat([
        content.subarray(0, content.indexOf('xref')),
        Buffer.from(`${lengthTarget.id} 0 obj\n${lengthTarget.raw}\nendobj\n`, 'latin1'),
        ...streams.map((s) => Buffer.from(`${s.id} 0 obj\n${s.raw}\nendobj\n`, 'latin1')),
        content.subarray(content.indexOf('xref')),
      ]);
    };
    const { largeResult } = await expectSizeIndependentOnInputs('indirect length target', (pdf: Buffer) => extractStructuredTextFromPdf(pdf), {
      modest: pdfWithLengthTarget(LENGTH_TARGET_ELEMENTS / SCALING_FACTOR),
      huge: pdfWithLengthTarget(LENGTH_TARGET_ELEMENTS),
    });
    expect(largeResult.text).toBe('LENGTH-LIES');
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
