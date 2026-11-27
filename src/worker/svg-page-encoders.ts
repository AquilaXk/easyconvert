import { UNMAPPABLE_CHARACTER, type PdfPageText } from '../lib/conversions/bitmap-glyph-text';
import { openPdfForReading } from '../lib/conversions/pdf-access';
import { runPdfTextJob } from '../lib/conversions/pdf-text-geometry';
import { encodeSvgPageToDxfWithText, PicturePages } from '../lib/conversions/vector-dxf';
import { encodeEmf, encodeWmf } from '../lib/conversions/vector-metafile';
import { CadGeometryUnavailableError, ConversionFailedError, UnsupportedOptionError, type ConversionOptions } from '../lib/types';
import { writeMetafilePageWithPictures, type PageRasterRun } from './metafile-raster-fallback';
import { officeSuiteMetafilePage, type OfficeMetafileRun } from './office-metafile-page';
import { pageNumbersOf } from './worker-output';
import type { WorkerConversionResult } from './worker-types';

export { officeMetafileRun } from './office-metafile-page';
export { pageRasterRun } from './metafile-raster-fallback';

/**
 * Targets written from the SVG page that Poppler draws for a page of a PDF: the in-process writers read its geometry and
 * write DXF entities or an EMF or WMF metafile. The registry offers them only for the sources whose pages these writers can
 * represent. A picture is left out of a DXF page with a warning (entry 129); a clip region that is not one convex polygon and hides
 * part of the drawing is refused by the writer (a convex one cuts the drawing). The DXF writer also writes the characters of a bitmap
 * font, which Poppler draws as pictures, as text from the PDF's text layer. An EMF or WMF page is written with a bitmap record for each
 * part the writer cannot draw (a picture, a dash, a clip, a mask, a gradient, a pen the format lacks), cut from Poppler's picture of
 * the page (`metafile-raster-fallback.ts`, entry 459); a page the writer refuses as a whole is written by the office suite instead
 * (`office-metafile-page.ts`).
 */

/** The targets whose parts are drawn as pictures and whose pages refused as a whole the office suite writes. */
const OFFICE_SUITE_METAFILE_TARGETS: ReadonlySet<string> = new Set(['emf', 'wmf']);

/** What a page of a metafile target falls back on for the parts the in-process writer cannot draw. */
export interface MetafileFallbacks {
  /** The office suite, for a page the in-process writer refuses as a whole. */
  officeSuite?: OfficeMetafileRun;
  /** Poppler's picture of a page: a bitmap record cut from it stands for each part the writer cannot draw. */
  pageRaster?: PageRasterRun;
}

/** Reads the text layer of the PDF page an SVG page was drawn from. */
type PageTextReader = () => Promise<PdfPageText>;

const SVG_PAGE_ENCODERS: Readonly<Record<string, (svg: Buffer, readText: PageTextReader, leftOut: PicturePages, page: number) => Buffer | Promise<Buffer>>> = {
  dxf: encodeSvgPageToDxfWithText,
  emf: encodeEmf,
  wmf: encodeWmf,
};

/** The page number in a ZIP entry that `pageEntryName` (page-range.ts) wrote: `<base>-p007.svg`. */
const PAGE_ENTRY_NUMBER = /-p(\d+)\.[^.]+$/;

export function isSvgPageTarget(target: string): boolean {
  return Object.hasOwn(SVG_PAGE_ENCODERS, target);
}

/** The root of a page that cairo wrote without a unit: `width="612" height="792" viewBox="0 0 612 792"` (cairo's order and spelling). */
const SVG_NUMBER = String.raw`[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?`;
const UNITLESS_ROOT = new RegExp(String.raw`(<svg\b[^>]*?)\swidth="${SVG_NUMBER}"\sheight="${SVG_NUMBER}"(\sviewBox="0 0 (${SVG_NUMBER}) (${SVG_NUMBER})")`);
/** The root element is in the first bytes of the file (Poppler writes it on the second line). */
const SVG_ROOT_SEARCH_BYTES = 4096;

/**
 * The page of a Poppler SVG with the size of its viewBox in points, which is the page cairo drew (the crop box, turned by /Rotate). cairo
 * counts its user units in points and writes the viewBox in them, but the root's width and height carry a unit only in some versions:
 * Poppler 25.02 and later write `612pt`, Poppler 24 on cairo 1.17.6 and later (Ubuntu noble) writes `612`, which the SVG reader counts
 * as pixels and draws at 0.75 of the page. A root that names a unit, or has no viewBox, is left to the reader.
 */
export function pageInPoints(svg: Buffer): Buffer {
  const root = UNITLESS_ROOT.exec(svg.toString('latin1', 0, SVG_ROOT_SEARCH_BYTES));
  if (!root) return svg;
  const [matched, before, viewBox, width, height] = root;
  const sized = Buffer.from(`${before} width="${width}pt" height="${height}pt"${viewBox}`, 'latin1');
  return Buffer.concat([svg.subarray(0, root.index), sized, svg.subarray(root.index + matched.length)]);
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
 * The pages whose pictures a DXF leaves out are noted in `leftOut`, which the caller reports once the last page is written.
 */
export function svgPageEncoder(
  target: string,
  rendered: WorkerConversionResult,
  readPdf: () => Buffer | undefined,
  access: PdfAccess,
  leftOut: PicturePages,
  fallbacks: MetafileFallbacks = {}
): (svg: Buffer, entryName: string) => Promise<Buffer> {
  const encode = SVG_PAGE_ENCODERS[target];
  const pages = pageNumbersOf(rendered);
  const textLayers = textLayersOf(readPdf, pages, access);
  const zipped = rendered.filename.endsWith('.zip');
  return async (svg, entryName) => {
    const page = zipped ? Number(PAGE_ENTRY_NUMBER.exec(entryName)?.[1]) : pages[0];
    try {
      const sized = pageInPoints(svg);
      if (fallbacks.pageRaster && OFFICE_SUITE_METAFILE_TARGETS.has(target)) return await writeMetafilePageWithPictures(sized, target as 'emf' | 'wmf', page, fallbacks.pageRaster);
      return await encode(sized, () => textLayers(page), leftOut, page);
    } catch (refusal) {
      const stored = readPdf();
      if (!(refusal instanceof CadGeometryUnavailableError || refusal instanceof UnsupportedOptionError) || !fallbacks.officeSuite || !stored || !OFFICE_SUITE_METAFILE_TARGETS.has(target)) throw refusal;
      return officeSuiteMetafilePage(stored, page, target, access, fallbacks.officeSuite, refusal);
    }
  };
}

/** Runs `write` with the writer of `target` for the pages of one render, then reports once the pages whose pictures a DXF left out. */
export async function withSvgPageEncoder<T>(
  target: string,
  rendered: WorkerConversionResult,
  readPdf: () => Buffer | undefined,
  access: PdfAccess,
  write: (encode: (svg: Buffer, entryName: string) => Promise<Buffer>) => Promise<T>,
  fallbacks?: MetafileFallbacks
): Promise<T> {
  const leftOut = new PicturePages();
  const written = await write(svgPageEncoder(target, rendered, readPdf, access, leftOut, fallbacks));
  leftOut.report();
  return written;
}
