import { UNMAPPABLE_CHARACTER, type PdfPageText } from '../lib/conversions/bitmap-glyph-text';
import { openPdfForReading } from '../lib/conversions/pdf-access';
import { runPdfTextJob } from '../lib/conversions/pdf-text-geometry';
import { encodeSvgPageToDxfWithText } from '../lib/conversions/vector-dxf';
import { encodeEmf, encodeWmf } from '../lib/conversions/vector-metafile';
import { ConversionFailedError, type ConversionOptions } from '../lib/types';
import { pageNumbersOf } from './worker-output';
import type { WorkerConversionResult } from './worker-types';

/**
 * Targets written from the SVG page that Poppler draws for a page of a PDF: the in-process writers read its geometry and
 * write DXF entities or an EMF or WMF metafile. The registry offers them only for the sources whose pages these writers can
 * represent; a page with a picture, or with a clip region that is not one convex polygon and hides part of the drawing, is
 * refused by the writer (a convex one cuts the drawing). The DXF writer also
 * writes the characters of a bitmap font, which Poppler draws as pictures, as text from the PDF's text layer.
 */

/** Reads the text layer of the PDF page an SVG page was drawn from. */
type PageTextReader = () => Promise<PdfPageText>;

const SVG_PAGE_ENCODERS: Readonly<Record<string, (svg: Buffer, readText: PageTextReader) => Buffer | Promise<Buffer>>> = {
  dxf: encodeSvgPageToDxfWithText,
  emf: encodeEmf,
  wmf: encodeWmf,
};

/** The page number in a ZIP entry that `pageEntryName` (page-range.ts) wrote: `<base>-p007.svg`. */
const PAGE_ENTRY_NUMBER = /-p(\d+)\.[^.]+$/;

export function isSvgPageTarget(target: string): boolean {
  return Object.hasOwn(SVG_PAGE_ENCODERS, target);
}

/** What opens the PDF of a request: the text layer is read in the process, and the password never reaches it. */
type PdfAccess = Pick<ConversionOptions, 'password' | 'signal'>;

/**
 * The text layers of the rendered pages of a PDF, read in one job the first time a page needs its own, with every glyph that
 * has no Unicode value kept in its place as the unmappable-character mark. Poppler drew the pages from a decrypted copy that
 * is gone by now, so a request with a password gets the plain bytes as every in-process reader of a PDF does
 * (`openPdfForReading`): the reader is given neither the password nor the encrypted input.
 */
function textLayersOf(readPdf: () => Buffer | undefined, pages: readonly number[], access: PdfAccess): (page: number) => Promise<PdfPageText> {
  let layers: Promise<Map<number, PdfPageText>> | undefined;
  return async (page) => {
    layers ??= (async () => {
      const stored = readPdf();
      if (!stored) throw new ConversionFailedError('The PDF text layer cannot be read: the PDF is not available to the page writer.');
      const pdf = access.password ? await openPdfForReading(stored, access.password, access.signal) : stored;
      const result = await runPdfTextJob(pdf, { geometry: 'none', content: pages, unmappedGlyphText: UNMAPPABLE_CHARACTER });
      return new Map(result.content.map((content) => [content.pageNumber, content]));
    })();
    const layer = (await layers).get(page);
    if (!layer) throw new ConversionFailedError(`The PDF text layer of page ${page} was not read.`);
    return layer;
  };
}

/**
 * The writer of an SVG page target (see `isSvgPageTarget`) for the pages Poppler rendered from a PDF: called with each page
 * and its entry name, it writes the page, reading the PDF (`readPdf`, opened with the password of `access`) only for a page that needs its text layer.
 */
export function svgPageEncoder(target: string, rendered: WorkerConversionResult, readPdf: () => Buffer | undefined, access: PdfAccess = {}): (svg: Buffer, entryName: string) => Promise<Buffer> {
  const encode = SVG_PAGE_ENCODERS[target];
  const pages = pageNumbersOf(rendered);
  const textLayers = textLayersOf(readPdf, pages, access);
  const zipped = rendered.filename.endsWith('.zip');
  return async (svg, entryName) => {
    const page = zipped ? Number(PAGE_ENTRY_NUMBER.exec(entryName)?.[1]) : pages[0];
    return encode(svg, () => textLayers(page));
  };
}
