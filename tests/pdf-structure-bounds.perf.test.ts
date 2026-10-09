import { describe, expect, it, vi } from 'vitest';
import { PdfDocument, PdfStructureError } from '../src/lib/conversions/pdf-document';
import { type CraftObject, buildPdf, flate, singlePagePdf, textContent } from './helpers/pdf-craft';
import { expectLinearOnInputs, expectSizeIndependentOnInputs, SCALING_FACTOR, settle } from './helpers/timing';

/**
 * Timing-ratio checks moved out of pdf-structure-bounds.test.ts.
 * They compare runs of the same work and need a quiet machine, so they run in the nightly performance workflow
 * (`npx vitest run --no-file-parallelism .perf.test.ts`) and not in the PR gate.
 * The PR gate keeps a hang guard on the same hostile input in pdf-structure-bounds.test.ts.
 */

const MIB = 1024 * 1024;
// Each bound is checked by comparing two inputs in the same process (tests/helpers/timing.ts): work that must
// not depend on a declared or repeated quantity costs the same for both, and work that must be linear in the
// file grows about 4x for 4x the file. Neither depends on how fast the runner is.
const BOUND_TEST_TIMEOUT_MS = 60_000;
const OBJSTM_ENTRIES = 100;
const OBJSTM_BODY_MIB = 8;
const LENGTH_TARGET_ELEMENTS = 500 * 1000;
const LENGTH_REFERENCING_STREAMS = 400;
const LENGTH_TARGET_OBJECT = 20;
const UNREFERENCED_ARRAY_OBJECT = 21;
const FIRST_OBJECT_NUMBER = 100;

const catalog: CraftObject[] = [
  { id: 1, dict: '/Type /Catalog /Pages 2 0 R' },
  { id: 2, dict: '/Type /Pages /Kids [] /Count 0' },
];

vi.setConfig({ testTimeout: BOUND_TEST_TIMEOUT_MS });

/** What the structure reader hands to the text extraction: the decoded content of every stream the pages draw. */
function drawnContent(pdf: Buffer): string {
  const parts: string[] = [];
  new PdfDocument(pdf).contentStreams((content) => parts.push(content));
  return parts.join('\n');
}

/** The literal strings the content shows with Tj, in order. */
function shownStrings(content: string): string[] {
  return [...content.matchAll(/\(([^)]*)\) Tj/g)].map((match) => match[1]);
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
        (pdf: Buffer) => settle(() => drawnContent(pdf)),
        { modest: objectStreamPdf(OBJSTM_ENTRIES / SCALING_FACTOR), huge: objectStreamPdf(OBJSTM_ENTRIES) }
      );
      expect(largeResult.ok, 'the object stream is read without error').toBe(true);
    });
  }
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
    const { largeResult } = await expectLinearOnInputs('objects past the cap', (pdf: Buffer) => settle(() => drawnContent(pdf)), {
      small: tinyObjects(Math.floor(OBJECT_CAP / SCALING_FACTOR)),
      large: tinyObjects(OBJECT_CAP + 1),
    });
    if (largeResult.ok) throw new Error('a file with more objects than the cap was accepted');
    expect(largeResult.error).toBeInstanceOf(PdfStructureError);
    expect((largeResult.error as Error).message).toMatch(/more than 500000 objects/);
  });

  it('reads a file with no root and many objects that name no type in linear time', async () => {
    const { largeResult } = await expectLinearOnInputs('objects without a type', (pdf: Buffer) => drawnContent(pdf), {
      small: tinyObjects(OBJECT_CAP / SCALING_FACTOR),
      large: tinyObjects(OBJECT_CAP),
    });
    expect(largeResult).toBe('');
  });
});

describe('an indirect /Length costs a constant per stream', () => {
  it('reads only the leading integer of the length object', async () => {
    // The /Length target is an array read by 400 streams. A reader that parses the whole target per stream costs 4x
    // as much for a 4x longer array; reading only the leading integer costs the same for both. The file is indexed
    // in one pass whatever the target holds, so both files have the same size: the elements the shorter target
    // lacks sit in an array that no stream refers to, and only the cost of reading the target can differ.
    const pdfWithLengthTarget = (elements: number): Buffer => {
      const lengthTarget: CraftObject = { id: LENGTH_TARGET_OBJECT, raw: `[${'1 '.repeat(elements)}]` };
      const unreferenced: CraftObject = { id: UNREFERENCED_ARRAY_OBJECT, raw: `[${'1 '.repeat(LENGTH_TARGET_ELEMENTS - elements)}]` };
      const streams: CraftObject[] = [];
      for (let i = 0; i < LENGTH_REFERENCING_STREAMS; i++) {
        streams.push({ id: 100 + i, raw: `<< /Length ${LENGTH_TARGET_OBJECT} 0 R >>\nstream\nab\nendstream` });
      }
      const content = singlePagePdf(flate(textContent('LENGTH-LIES'))).buffer;
      return Buffer.concat([
        content.subarray(0, content.indexOf('xref')),
        ...[lengthTarget, unreferenced, ...streams].map((o) => Buffer.from(`${o.id} 0 obj\n${o.raw}\nendobj\n`, 'latin1')),
        content.subarray(content.indexOf('xref')),
      ]);
    };
    const modest = pdfWithLengthTarget(LENGTH_TARGET_ELEMENTS / SCALING_FACTOR);
    const huge = pdfWithLengthTarget(LENGTH_TARGET_ELEMENTS);
    expect(modest.length).toBe(huge.length);
    const { largeResult } = await expectSizeIndependentOnInputs('indirect length target', (pdf: Buffer) => drawnContent(pdf), {
      modest,
      huge,
    });
    expect(shownStrings(largeResult)).toEqual(['LENGTH-LIES']);
  });
});
