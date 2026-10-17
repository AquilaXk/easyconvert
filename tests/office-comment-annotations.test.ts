import { describe, expect, it } from 'vitest';
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib';
import JSZip from 'jszip';
import sharp from 'sharp';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { resolveLibreOfficeFilter } from '../src/worker/libreoffice-pool';
import { oracleTest } from './helpers/oracle-test';
import { craftDocx } from './helpers/docx-craft';
import { requireRealworldSample } from './helpers/realworld-sample';

/**
 * The PDF the office suite writes carries the comments of a document as PDF annotations only when the export is asked for
 * them. The worker passes FilterData to the export (JPEG pass-through, outline), and the suite then takes every property it was
 * not given from the export's own defaults, which write the comments as annotations, where its plain export writes none. A
 * Word document with a comment in an Uzbek Cyrillic text (`office-document-wordwithattachments.docx`, nightly run 39012667333)
 * then ended the Ubuntu 24.04 LibreOffice (24.2) with a segmentation fault in its exit handlers, after the PDF was written,
 * and the sandbox reported the exit status: docx to jpg and png failed with `exit 139`. The export now states that comments
 * are not annotations, which is what the suite's plain export writes, and the readers other than the converter judge it: pdf-lib
 * counts the annotations of the PDF, and the page chain's images are decoded by the image library.
 */

const TEST_TIMEOUT_MS = 300_000;
const COMMENT_CROSS_REFERENCE = '<w:r><w:commentReference w:id="0"/></w:r>';
const UZBEK_CYRILLIC = 'uz-Cyrl-UZ';
const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/></Types>';
const COMMENT_RELATIONSHIP =
  '<Relationship Id="rIdC" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>';
const COMMENTS_PART =
  '<?xml version="1.0" encoding="UTF-8"?><w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  '<w:comment w:id="0" w:author="Reviewer" w:date="2008-01-22T13:21:00Z" w:initials="R"><w:p><w:r>' +
  `<w:rPr><w:lang w:val="${UZBEK_CYRILLIC}"/></w:rPr><w:t>иккинчи тўғри</w:t></w:r></w:p></w:comment></w:comments>`;

/** A one-paragraph Word document with a comment on its text, the comment written in Uzbek Cyrillic. */
function documentWithComment(): Promise<Buffer> {
  return craftDocx({
    body: `<w:p><w:commentRangeStart w:id="0"/><w:r><w:t>Reviewed text</w:t></w:r><w:commentRangeEnd w:id="0"/>${COMMENT_CROSS_REFERENCE}</w:p>`,
    relationships: COMMENT_RELATIONSHIP,
    parts: { '[Content_Types].xml': CONTENT_TYPES, 'word/comments.xml': COMMENTS_PART },
  });
}

const COMMENT_ANNOTATION_SUBTYPE = PDFName.of('Text');

/** Text annotations (the sticky notes a comment becomes) on the pages of a PDF, read by pdf-lib from the page dictionaries. */
async function commentAnnotationCount(pdf: Buffer): Promise<number> {
  const document = await PDFDocument.load(pdf);
  let count = 0;
  for (const page of document.getPages()) {
    const annotations = page.node.Annots();
    for (let index = 0; index < (annotations?.size() ?? 0); index += 1) {
      const annotation = annotations?.lookup(index, PDFDict);
      if (annotation?.get(PDFName.of('Subtype')) === COMMENT_ANNOTATION_SUBTYPE) count += 1;
    }
  }
  return count;
}

const PICTURE_FORMAT: Readonly<Record<string, string>> = { png: 'png', jpg: 'jpeg' };

const ZIP_SIGNATURE = Buffer.from('PK');

/** The pages of a PNG or JPEG conversion: the picture itself for one page, the entries of the ZIP for several. */
async function pageImages(output: Buffer): Promise<Buffer[]> {
  if (!output.subarray(0, ZIP_SIGNATURE.length).equals(ZIP_SIGNATURE)) return [output];
  const zip = await JSZip.loadAsync(output);
  const names = Object.keys(zip.files).sort((a, b) => a.localeCompare(b));
  return Promise.all(names.map((name) => zip.files[name].async('nodebuffer')));
}

/** Checks that each page is a picture of `target` the image library decodes to the last pixel, and returns how many pages there are. */
async function expectDecodedPages(output: Buffer, target: string, expectedPages: number): Promise<void> {
  const pages = await pageImages(output);
  expect(pages).toHaveLength(expectedPages);
  for (const page of pages) {
    const { format, width } = await sharp(page).metadata();
    expect(format).toBe(PICTURE_FORMAT[target]);
    expect(width).toBeGreaterThan(0);
    await sharp(page).raw().toBuffer();
  }
}

describe('the PDF export of an office document', () => {
  it('states that comments are not written as PDF annotations, for every application of the suite', () => {
    for (const source of ['docx', 'xlsx', 'pptx']) {
      const filter = resolveLibreOfficeFilter('pdf', source);
      expect(JSON.parse(filter.slice(filter.indexOf('{'))), source).toMatchObject({ ExportNotes: { type: 'boolean', value: 'false' } });
    }
  });

  oracleTest(
    'a Word document with a comment converts to PDF without a note annotation, and to PNG and JPEG pages the image library decodes',
    ['soffice', 'pdftoppm'],
    async () => {
      const source = await documentWithComment();
      const pdf = await dispatchConversion(source, 'docx', 'pdf', {}, 'commented.docx');
      expect(await commentAnnotationCount(pdf.buffer)).toBe(0);
      const pageCount = (await PDFDocument.load(pdf.buffer)).getPageCount();
      for (const target of ['png', 'jpg']) {
        const pages = await dispatchConversion(source, 'docx', target, {}, 'commented.docx');
        await expectDecodedPages(pages.buffer, target, pageCount);
      }
    },
    TEST_TIMEOUT_MS
  );

  oracleTest(
    'the Word document with attachments of the nightly corpus converts to PDF, PNG and JPEG',
    ['soffice', 'pdftoppm'],
    async (ctx) => {
      const sample = await requireRealworldSample(ctx, 'office-document-wordwithattachments.docx');
      const pdf = await dispatchConversion(sample.bytes, 'docx', 'pdf', {}, 'wordwithattachments.docx');
      expect(await commentAnnotationCount(pdf.buffer)).toBe(0);
      const pageCount = (await PDFDocument.load(pdf.buffer)).getPageCount();
      for (const target of ['png', 'jpg']) {
        const pages = await dispatchConversion(sample.bytes, 'docx', target, {}, 'wordwithattachments.docx');
        await expectDecodedPages(pages.buffer, target, pageCount);
      }
    },
    TEST_TIMEOUT_MS
  );
});
