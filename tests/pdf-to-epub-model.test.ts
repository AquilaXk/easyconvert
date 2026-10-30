import JSZip from 'jszip';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { convertFile } from '../src/lib/conversions';
import { requireRealworldSample } from './helpers/realworld-sample';

/**
 * A PDF became an EPUB by writing its text as Markdown and parsing that Markdown again with the limits of a user's Markdown
 * (1 MiB of source, 100,000 blocks, 20 levels of nesting). Text that starts like Markdown markup was read as markup: a table
 * of numbers ("50. 50. 108. 45. ...") opened one nested list per number, so a 71-page report of station assignments was
 * refused with "Markdown nesting exceeds the 20 level limit", and two books (345 and 357 pages) hit the size and block limits.
 * The EPUB is now written from the block model the PDF reader produced, as the DOCX already was; the same three files are what
 * the nightly run of 2026-10-30 refused for MOBI, AZW3, PDB, LRF and OEB, which calibre writes from this EPUB.
 */

const NUMBER_ROW = Array.from({ length: 30 }, (_, index) => `${index + 1}.`).join(' ');
const MARKDOWN_LOOKALIKES = [NUMBER_ROW, '- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -', '> > > > > > > > > > > > > > > > > > > > > > > > text'];

async function pdfWithLines(lines: readonly string[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  lines.forEach((line, index) => page.drawText(line, { x: 36, y: 560 - index * 24, size: 9, font }));
  return Buffer.from(await doc.save());
}

async function bookDocuments(epub: Buffer): Promise<string[]> {
  const zip = await JSZip.loadAsync(epub);
  const names = Object.keys(zip.files).filter((name) => /\.xhtml$/.test(name) && !/nav\.xhtml$/.test(name));
  return Promise.all(names.map((name) => (zip.file(name) as JSZip.JSZipObject).async('string')));
}

const textOf = (documents: readonly string[]): string => documents.join(' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('a PDF written as an EPUB keeps text that looks like Markdown as text', () => {
  it('writes a row of numbers, dashes and quote marks as paragraphs, not as nested lists or quotes', async () => {
    const pdf = await pdfWithLines(MARKDOWN_LOOKALIKES);
    const documents = await bookDocuments((await convertFile(pdf, 'pdf', 'epub', {}, 'rows.pdf')).buffer);
    const markup = documents.join('\n');
    expect(markup).not.toMatch(/<(ol|ul|li|blockquote)[\s>]/);
    const text = textOf(documents);
    expect(text).toContain(NUMBER_ROW);
    expect(text).toContain('text');
  });

});

const REFUSED_BY_THE_MARKDOWN_LIMITS = [
  ['govdocs1-003115.pdf', 'Table of Station Assignment and Service Information'],
  ['govdocs1-001071.pdf', ''],
  ['govdocs1-001677.pdf', ''],
] as const;

describe('the real PDFs that the Markdown limits refused are written as EPUB', () => {
  for (const [id, firstLine] of REFUSED_BY_THE_MARKDOWN_LIMITS) {
    it(`writes ${id}`, async (ctx) => {
      const { bytes } = await requireRealworldSample(ctx, id);
      const documents = await bookDocuments((await convertFile(bytes, 'pdf', 'epub', {}, id)).buffer);
      expect(documents.length).toBeGreaterThan(0);
      expect(textOf(documents)).toContain(firstLine);
    }, 120_000);
  }
});
