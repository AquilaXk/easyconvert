import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { convertFile } from '../src/lib/conversions';
import { buildOpenXpsPackage } from '../src/lib/conversions/openxps';
import { readXpsPages } from '../src/lib/conversions/office/xps-reader';
import { ConversionFailedError, CorruptStreamError, DecompressionLimitError, PayloadLimitError } from '../src/lib/types';
import { requireRealworldSample } from './helpers/realworld-sample';
import { pythonModuleAvailable, runPythonHelper } from './helpers/python-oracle';
import { skipUnless } from './helpers/strict-skip';

/**
 * XPS and OpenXPS sources. Until #783 the bytes of the package were read as text and the answer was refused as "not a
 * .txt file". The text is read from the glyph runs of the fixed pages; the oracle is MuPDF (PyMuPDF), an independent XPS
 * reader, on three real files of the Apache Tika test documents (a Word print, a PowerPoint print and a file with
 * right-to-left text, hyperlinks and an embedded PDF name).
 */

const mupdfMissing = skipUnless('PyMuPDF', pythonModuleAvailable('pymupdf') || pythonModuleAvailable('fitz'));
const MIN_WORD_LENGTH = 3;
const CONVERSION_TIMEOUT_MS = 120_000;
const SAMPLES = ['tika-test_text.xps', 'tika-testppt.xps', 'tika-testxps_various.xps'] as const;

function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= MIN_WORD_LENGTH);
}

function mupdfWords(xps: Buffer): Set<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xps-oracle-'));
  try {
    const file = path.join(dir, 'in.xps');
    fs.writeFileSync(file, xps);
    return new Set(wordsOf(runPythonHelper<string[]>('xps_text.py', [file]).join(' ')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(mupdfMissing)('XPS text of real files against MuPDF', () => {
  for (const id of SAMPLES) {
    it(
      `${id} converts to text and HTML with the words MuPDF reads`,
      async (ctx) => {
        const { bytes: xps } = await requireRealworldSample(ctx, id);
        const reference = mupdfWords(xps);
        expect(reference.size).toBeGreaterThan(0);
        for (const target of ['txt', 'html'] as const) {
          const result = await dispatchConversion(xps, 'xps', target, {}, id);
          const markup = result.buffer.toString('utf-8');
          const text = target === 'html' ? markup.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>') : markup;
          const have = new Set(wordsOf(text));
          expect({ target, missing: [...reference].filter((word) => !have.has(word)) }).toEqual({ target, missing: [] });
        }
      },
      CONVERSION_TIMEOUT_MS
    );
  }
});

interface Run {
  x: number;
  y: number;
  em?: number;
  text: string;
  bidi?: number;
  /** Advance of every glyph in hundredths of the font size, as `Indices` states it. */
  advances?: readonly number[];
}

/** An XPS package written from the ECMA-388 part layout: one document of one page per entry, the runs drawn in the order given. */
async function xpsOf(pages: readonly (readonly Run[])[]): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file(
    '_rels/.rels',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.microsoft.com/xps/2005/06/fixedrepresentation" Target="/FixedDocSeq.fdseq"/></Relationships>'
  );
  zip.file('FixedDocSeq.fdseq', '<FixedDocumentSequence xmlns="http://schemas.microsoft.com/xps/2005/06"><DocumentReference Source="/Documents/1/FixedDoc.fdoc"/></FixedDocumentSequence>');
  const pageRefs = pages.map((_, index) => `<PageContent Source="Pages/${index + 1}.fpage"/>`).join('');
  zip.file('Documents/1/FixedDoc.fdoc', `<FixedDocument xmlns="http://schemas.microsoft.com/xps/2005/06">${pageRefs}</FixedDocument>`);
  pages.forEach((runs, index) => {
    const glyphs = runs
      .map((run) => {
        const indices = run.advances === undefined ? '' : ` Indices="${run.advances.map((advance) => `,${advance}`).join(';')}"`;
        return `<Glyphs OriginX="${run.x}" OriginY="${run.y}" FontRenderingEmSize="${run.em ?? 10}" BidiLevel="${run.bidi ?? 0}" UnicodeString="${run.text}"${indices}/>`;
      })
      .join('');
    zip.file(`Documents/1/Pages/${index + 1}.fpage`, `<FixedPage xmlns="http://schemas.microsoft.com/xps/2005/06" Width="800" Height="1000"><Canvas>${glyphs}</Canvas></FixedPage>`);
  });
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('XPS reading order', () => {
  it('reads the lines from the top down and the runs of a line from left to right, whatever order they are drawn in', async () => {
    const xps = await xpsOf([
      [
        { x: 100, y: 200, text: 'second line' },
        { x: 150, y: 100, text: 'right' },
        { x: 100, y: 100, text: 'left ' },
      ],
    ]);
    expect(await readXpsPages(xps)).toEqual(['left right\nsecond line']);
  });

  it('keeps runs that sit a little off the baseline on one line, and a line one font size lower apart', async () => {
    const xps = await xpsOf([
      [
        { x: 100, y: 100, em: 10, text: 'E=mc' },
        { x: 121, y: 96, em: 6, text: '2' },
        { x: 100, y: 112, em: 10, text: 'next line' },
      ],
    ]);
    expect(await readXpsPages(xps)).toEqual(['E=mc2\nnext line']);
  });

  it('puts the pages in order and a blank line between them', async () => {
    const xps = await xpsOf([[{ x: 10, y: 10, text: 'page one' }], [{ x: 10, y: 10, text: 'page two' }]]);
    expect(await readXpsPages(xps)).toEqual(['page one', 'page two']);
    expect(await convertFile(xps, 'xps', 'txt', {}, 'two.xps').then((result) => result.buffer.toString('utf-8'))).toBe('page one\n\npage two');
  });

  it('removes the literal-brace prefix of a UnicodeString and drops runs with no characters', async () => {
    const xps = await xpsOf([[{ x: 10, y: 10, text: '{}{braces}' }, { x: 80, y: 10, text: '' }]]);
    expect(await readXpsPages(xps)).toEqual(['{braces}']);
  });
});

describe('XPS word gaps', () => {
  it('adds the space a style change left out when the measured width of the run leaves room for one', async () => {
    // "tika" is 4 glyphs of 25 hundredths of an em at 10 pt: 10 pt wide, from 100 to 110; the next run starts at 113.
    const xps = await xpsOf([[{ x: 100, y: 10, text: 'tika', advances: [25, 25, 25, 25] }, { x: 113, y: 10, text: 'content' }]]);
    expect(await readXpsPages(xps)).toEqual(['tika content']);
  });

  it('adds no space when the measured run ends where the next one starts', async () => {
    const xps = await xpsOf([[{ x: 100, y: 10, text: 'tika', advances: [25, 25, 25, 25] }, { x: 110.5, y: 10, text: 'content' }]]);
    expect(await readXpsPages(xps)).toEqual(['tikacontent']);
  });

  it('adds no space between letters drawn one run each (glyph advances come from the font)', async () => {
    const runs = [...'Rain'].map((letter, index) => ({ x: 100 + index * 6, y: 10, text: letter }));
    expect(await readXpsPages(await xpsOf([runs]))).toEqual(['Rain']);
  });

  it('adds a space when the estimated width leaves a wide gap, and none when a run already has the space', async () => {
    const spaced = await xpsOf([[{ x: 100, y: 10, text: 'ab' }, { x: 140, y: 10, text: 'cd' }]]);
    expect(await readXpsPages(spaced)).toEqual(['ab cd']);
    const alreadySpaced = await xpsOf([[{ x: 100, y: 10, text: 'ab ' }, { x: 140, y: 10, text: 'cd' }]]);
    expect(await readXpsPages(alreadySpaced)).toEqual(['ab cd']);
    const leading = await xpsOf([[{ x: 100, y: 10, text: 'ab' }, { x: 140, y: 10, text: ' cd' }]]);
    expect(await readXpsPages(leading)).toEqual(['ab cd']);
  });
});

describe('XPS glyph advances', () => {
  it('measures no width when a glyph leaves its advance to the font, and adds no space from a partial sum', async () => {
    // Three glyphs state 25 hundredths of an em and the fourth none: summing the three would end the run at 107.5 and
    // leave room for a space before 113; without the fourth advance the width is unknown, estimated from the characters.
    const unstated = await xpsOf([[{ x: 100, y: 10, text: 'tika', advances: [25, 25, 25, '' as unknown as number] }, { x: 113, y: 10, text: 'content' }]]);
    expect(await readXpsPages(unstated)).toEqual(['tikacontent']);
    const notANumber = await xpsOf([[{ x: 100, y: 10, text: 'tika', advances: [25, 25, 25, 'x' as unknown as number] }, { x: 113, y: 10, text: 'content' }]]);
    expect(await readXpsPages(notANumber)).toEqual(['tikacontent']);
  });
});

describe('XPS right-to-left runs', () => {
  it('orders a right to left run among its neighbours by its left edge, estimated from its characters', async () => {
    // The origin of the run is 130; four characters of 10 pt reach back to about 110, before the left to right run at 120.
    const xps = await xpsOf([
      [
        { x: 120, y: 10, em: 10, text: ' ab' },
        { x: 130, y: 10, em: 10, text: 'wxyz', bidi: 1 },
      ],
    ]);
    expect(await readXpsPages(xps)).toEqual(['wxyz ab']);
  });

  it('puts no space between runs of different directions, whatever the gap between them', async () => {
    const xps = await xpsOf([[{ x: 100, y: 10, em: 10, text: 'ab' }, { x: 140, y: 10, em: 10, text: 'cd', bidi: 1 }]]);
    expect(await readXpsPages(xps)).toEqual(['abcd']);
  });

  it('puts a space between right to left runs only when the gap between the left edge of one and the origin of the next is wide', async () => {
    const adjacent = await xpsOf([[{ x: 200, y: 10, em: 10, text: 'ab', bidi: 1 }, { x: 191, y: 10, em: 10, text: 'cd', bidi: 1 }]]);
    expect(await readXpsPages(adjacent)).toEqual(['abcd']);
    const apart = await xpsOf([[{ x: 200, y: 10, em: 10, text: 'ab', bidi: 1 }, { x: 170, y: 10, em: 10, text: 'cd', bidi: 1 }]]);
    expect(await readXpsPages(apart)).toEqual(['ab cd']);
  });

  it('reads a stretch of right-to-left runs from the right, where each origin is the run\'s right edge', async () => {
    // Three Arabic words drawn leftwards from x = 210, 174 and 108: reading order is the rightmost first.
    const xps = await xpsOf([
      [
        { x: 108, y: 10, em: 10, text: 'cc', bidi: 1 },
        { x: 210, y: 10, em: 10, text: 'aa', bidi: 1 },
        { x: 174, y: 10, em: 10, text: 'bb', bidi: 1 },
      ],
    ]);
    expect(await readXpsPages(xps)).toEqual(['aa bb cc']);
  });

  it('reads a line of a few hundred thousand right-to-left runs, which a spread of the stretch into one call could not take', async () => {
    const runs = Array.from({ length: 200_000 }, (_, index) => ({ x: 1_000_000 - index * 2, y: 10, em: 1, text: 'a', bidi: 1 }));
    const [page] = await readXpsPages(await xpsOf([runs]));
    expect(page.length).toBeGreaterThan(200_000);
    expect(page.replaceAll(' ', '')).toBe('a'.repeat(200_000));
  }, 60_000);

  it('keeps left-to-right text in place around a right-to-left word', async () => {
    const xps = await xpsOf([
      [
        { x: 72, y: 10, em: 10, text: 'The ' },
        { x: 107.55, y: 10, em: 10, text: 'xyzuv', bidi: 1 },
        { x: 107.54, y: 10, em: 10, text: ' ' },
        { x: 110, y: 10, em: 10, text: 'fox' },
      ],
    ]);
    expect(await readXpsPages(xps)).toEqual(['The xyzuv fox']);
  });
});

describe('XPS reader', () => {
  it('reads back the lines that the OpenXPS writer drew', async () => {
    const lines = ['Quarterly report', 'Revenue grew by 4 percent.', 'See the appendix for the method.'];
    const xps = await buildOpenXpsPackage([{ title: 'Report', lines }], 'Report');
    const pages = await readXpsPages(xps);
    expect(pages.join('\n').split('\n')).toEqual(lines);
  });

  it('converts through the shared entry point to the same text', async () => {
    const lines = ['First line of text', 'Second line of text'];
    const xps = await buildOpenXpsPackage([{ title: 'Doc', lines }], 'Doc');
    const result = await convertFile(xps, 'xps', 'txt', {}, 'doc.xps');
    expect(result.buffer.toString('utf-8')).toBe(lines.join('\n'));
  });

  it('answers a ZIP package with no fixed document sequence with a typed error naming the format', async () => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
    zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>');
    const notXps = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(readXpsPages(notXps)).rejects.toBeInstanceOf(ConversionFailedError);
    await expect(readXpsPages(notXps)).rejects.toThrow(/not an XPS document/);
  });

  it('answers bytes that are not a ZIP package with a typed error', async () => {
    await expect(readXpsPages(Buffer.from('not a package at all'))).rejects.toThrow('The XPS file is not a valid ZIP package.');
  });
});

const FIXED_NS = 'http://schemas.microsoft.com/xps/2005/06';
const MEBIBYTE = 1024 * 1024;

function fixedPage(glyphText: string): string {
  return `<FixedPage xmlns="${FIXED_NS}" Width="800" Height="1000"><Canvas><Glyphs OriginX="10" OriginY="10" FontRenderingEmSize="10" UnicodeString="${glyphText}"/></Canvas></FixedPage>`;
}

/** An XPS package written from the ECMA-388 part layout whose fixed document sequence and documents name the parts given, whatever the parts hold. */
async function xpsOfParts(sequenceSources: readonly string[], parts: Readonly<Record<string, string>>): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file(
    '_rels/.rels',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.microsoft.com/xps/2005/06/fixedrepresentation" Target="/FixedDocSeq.fdseq"/></Relationships>'
  );
  const references = sequenceSources.map((source) => `<DocumentReference Source="${source}"/>`).join('');
  zip.file('FixedDocSeq.fdseq', `<FixedDocumentSequence xmlns="${FIXED_NS}">${references}</FixedDocumentSequence>`);
  for (const [name, content] of Object.entries(parts)) zip.file(name, content);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function fixedDocument(pageSources: readonly string[]): string {
  return `<FixedDocument xmlns="${FIXED_NS}">${pageSources.map((source) => `<PageContent Source="${source}"/>`).join('')}</FixedDocument>`;
}

describe('XPS package limits', () => {
  it('refuses a package whose document names the same page part twice, instead of reading it again', async () => {
    const xps = await xpsOfParts(['/Documents/1/FixedDoc.fdoc'], {
      'Documents/1/FixedDoc.fdoc': fixedDocument(['Pages/1.fpage', 'Pages/2.fpage', 'Pages/1.fpage']),
      'Documents/1/Pages/1.fpage': fixedPage('first'),
      'Documents/1/Pages/2.fpage': fixedPage('second'),
    });
    const refusal = await readXpsPages(xps).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(CorruptStreamError);
    expect((refusal as Error).message).toBe('The XPS package references the fixed page "Documents/1/Pages/1.fpage" more than once.');
  });

  it('refuses a package whose sequence names the same document part twice', async () => {
    const xps = await xpsOfParts(['/Documents/1/FixedDoc.fdoc', '/Documents/1/FixedDoc.fdoc'], {
      'Documents/1/FixedDoc.fdoc': fixedDocument(['Pages/1.fpage']),
      'Documents/1/Pages/1.fpage': fixedPage('only'),
    });
    const refusal = await readXpsPages(xps).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(CorruptStreamError);
    expect((refusal as Error).message).toBe('The XPS package references the fixed document "Documents/1/FixedDoc.fdoc" more than once.');
  });

  describe('the number of documents', () => {
    const MAX_DOCUMENT_REFERENCES = 1_000;

    function documentsOf(count: number): { sources: string[]; parts: Record<string, string> } {
      const sources: string[] = [];
      const parts: Record<string, string> = {};
      for (let index = 0; index < count; index += 1) {
        sources.push(`/Documents/${index}/FixedDoc.fdoc`);
        parts[`Documents/${index}/FixedDoc.fdoc`] = fixedDocument(['page.fpage']);
        parts[`Documents/${index}/page.fpage`] = fixedPage(`document ${index}`);
      }
      return { sources, parts };
    }

    it('is read in full at the limit', async () => {
      const { sources, parts } = documentsOf(MAX_DOCUMENT_REFERENCES);
      const pages = await readXpsPages(await xpsOfParts(sources, parts));
      expect(pages).toHaveLength(MAX_DOCUMENT_REFERENCES);
      expect(pages.at(-1)).toBe(`document ${MAX_DOCUMENT_REFERENCES - 1}`);
    });

    it('is refused past the limit before any document is read', async () => {
      // The documents named are not in the package: a reader that opened them would answer "not in the package" instead.
      const sources = Array.from({ length: MAX_DOCUMENT_REFERENCES + 1 }, (_, index) => `/Documents/${index}/FixedDoc.fdoc`);
      const refusal = await readXpsPages(await xpsOfParts(sources, {})).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(PayloadLimitError);
      expect((refusal as Error).message).toBe(`The XPS package names more than ${MAX_DOCUMENT_REFERENCES} documents.`);
    });
  });

  it('charges every part read to one budget for the whole package', async () => {
    // Five distinct pages of 60 MiB each (an XML comment, which deflates to a few dozen KiB) are 300 MiB: more than the 256 MiB budget.
    const comment = `<!--${'x'.repeat(60 * MEBIBYTE)}-->`;
    const bigPage = `<FixedPage xmlns="${FIXED_NS}" Width="800" Height="1000">${comment}</FixedPage>`;
    const pageNames = ['1', '2', '3', '4', '5'].map((name) => `Pages/${name}.fpage`);
    const parts: Record<string, string> = { 'Documents/1/FixedDoc.fdoc': fixedDocument(pageNames) };
    for (const name of pageNames) parts[`Documents/1/${name}`] = bigPage;
    const xps = await xpsOfParts(['/Documents/1/FixedDoc.fdoc'], parts);
    expect(xps.length).toBeLessThan(MEBIBYTE);
    const refusal = await readXpsPages(xps).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(DecompressionLimitError);
    expect((refusal as Error).message).toMatch(/Documents\/1\/Pages\/5\.fpage" would exceed the decoded-byte budget of 268435456 bytes for the whole package/);
  }, 60_000);

  it('stops at the first part read after the job signal fires', async () => {
    const pageNames = Array.from({ length: 10 }, (_, index) => `Pages/${index}.fpage`);
    const parts: Record<string, string> = { 'Documents/1/FixedDoc.fdoc': fixedDocument(pageNames) };
    for (const name of pageNames) parts[`Documents/1/${name}`] = fixedPage(name);
    const xps = await xpsOfParts(['/Documents/1/FixedDoc.fdoc'], parts);
    const reason = new Error('the job deadline passed');
    let checks = 0;
    // The relationships, the sequence, the document and the first page are read; the check before the fifth part fires.
    const signal = {
      throwIfAborted(): void {
        checks += 1;
        if (checks === 5) throw reason;
      },
    } as AbortSignal;
    await expect(readXpsPages(xps, signal)).rejects.toBe(reason);
    expect(checks).toBe(5);
  });

  it('is given the signal of the conversion that reads the package', async () => {
    const xps = await xpsOf([[{ x: 10, y: 10, text: 'page one' }]]);
    const reason = new Error('the client closed the connection');
    await expect(convertFile(xps, 'xps', 'txt', { signal: AbortSignal.abort(reason) }, 'one.xps')).rejects.toBe(reason);
  });
});
