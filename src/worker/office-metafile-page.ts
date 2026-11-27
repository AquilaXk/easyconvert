import JSZip from 'jszip';
import { loadPdfLibDocument } from '../lib/conversions/pdf-lib-load';
import { extractPdfPages } from '../lib/conversions/pdf-postprocess/page-ops';
import { ownSignatureVerdict } from '../lib/format-signatures';
import { SandboxedProcessError } from '../lib/security/process-sandbox';
import { ConversionFailedError, EngineUnavailableError, type ConversionOptions } from '../lib/types';

/**
 * The metafile page writer of the office suite: the PDF page that the in-process metafile writers refuse (a picture, a dash, a clip that
 * is not one convex polygon; entries 42 and 99) is imported by the Draw application of the office suite and exported by its own EMF or WMF
 * filter, which writes bitmaps, dashes and clip regions as records. The page keeps its size: the margins the import gives it are removed first.
 */

/** Runs the office suite on a one-page PDF and returns the metafile it wrote. */
export type OfficeMetafileRun = (pdfPage: Buffer, target: string) => Promise<Buffer>;

/** The message of a run that ended without a file (engines.ts). */
const NO_OUTPUT_PATTERN = /^LibreOffice execution completed without producing expected output file/;

/** `/Type /Font` dictionaries of this subtype draw each glyph with a content stream, which the PDF import of the office suite does not draw. */
const TYPE3_FONT_SUBTYPE = 'Type3';

/**
 * Whether a PDF holds a Type 3 font. dvips and many older TeX and Ghostscript files draw their bitmap fonts so; the office suite's PDF
 * import drops the glyphs of such a font and keeps the page's other marks, so the metafile would show a page with its text gone.
 */
export async function holdsType3Font(pdf: Buffer): Promise<boolean> {
  const { PDFDict, PDFName } = await import('pdf-lib');
  const document = await loadPdfLibDocument(pdf, { updateMetadata: false, throwOnInvalidObject: false });
  for (const [, object] of document.context.enumerateIndirectObjects()) {
    if (object instanceof PDFDict && object.get(PDFName.of('Subtype')) === PDFName.of(TYPE3_FONT_SUBTYPE) && object.get(PDFName.of('Type')) === PDFName.of('Font')) return true;
  }
  return false;
}

/**
 * Page `page` of `pdf` written as `target` by the office suite. `refusal` is the error the page already earned from the in-process
 * writer: it is thrown again for a page with a Type 3 font, whose text the office suite would drop without saying so.
 * @throws ConversionFailedError when the suite writes no valid metafile.
 */
export async function officeSuiteMetafilePage(
  pdf: Buffer,
  page: number,
  target: string,
  access: Pick<ConversionOptions, 'password' | 'signal'>,
  run: OfficeMetafileRun,
  refusal: unknown
): Promise<Buffer> {
  const single = await extractPdfPages(pdf, String(page), access);
  if (await holdsType3Font(single)) throw refusal;
  const metafile = await run(single, target).catch((error: unknown) => {
    // The suite stops on a page it cannot export (its stderr is not shown: it names the job directory).
    if (error instanceof SandboxedProcessError || (error instanceof Error && NO_OUTPUT_PATTERN.test(error.message))) {
      throw new ConversionFailedError(`The office suite could not write page ${page} as .${target}: it fails on the content of this page.`);
    }
    throw error;
  });
  if (ownSignatureVerdict(target, metafile) !== true) throw new ConversionFailedError(`The office suite wrote no .${target} file for page ${page}.`);
  return metafile;
}

/** The page margins of an OpenDocument page layout (`styles.xml`), which the office suite's metafile export cuts off the page. */
const PAGE_MARGIN_PATTERN = /fo:margin-(top|bottom|left|right)="[^"]*"/g;
const STYLES_ENTRY = 'styles.xml';
const MIMETYPE_ENTRY = 'mimetype';

/**
 * The drawing the office suite made of a PDF page, with the margins of its pages set to nothing. The PDF import gives each page margins of
 * its own (measured: 1 cm at the top of a page-sized picture, 0.4 to 1.5 cm on the sides of a text page) and the metafile export keeps the
 * page without them, so a picture that fills the page loses its edge in the frame of the file, and a viewer that clips to the frame cuts it.
 * @throws ConversionFailedError for a drawing that is not an OpenDocument package.
 */
export async function withoutPageMargins(drawing: Buffer): Promise<Buffer> {
  const package_ = await JSZip.loadAsync(drawing).catch(() => undefined);
  const styles = package_?.file(STYLES_ENTRY);
  if (!package_ || !styles) throw new ConversionFailedError('The office suite wrote no drawing of the page.');
  package_.file(STYLES_ENTRY, (await styles.async('string')).replace(PAGE_MARGIN_PATTERN, 'fo:margin-$1="0cm"'));
  package_.file(MIMETYPE_ENTRY, await (package_.file(MIMETYPE_ENTRY)?.async('nodebuffer') ?? Buffer.alloc(0)), { compression: 'STORE' });
  return package_.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** The office suite's run of one conversion, as the worker's runner answers it: the written file's bytes and where it was persisted. */
type OfficeSuiteConvert = (input: Buffer, sourceFormat: string, targetFormat: string) => Promise<{ buffer: Buffer; filePath?: string } | null>;

/**
 * The run of the office suite that writes a one-page PDF as a metafile: the suite imports the page as an OpenDocument drawing, the
 * margins its import gave the page are removed (`withoutPageMargins`), and the drawing is exported. `discard` removes a file the runner persisted.
 */
export function officeMetafileRun(convert: OfficeSuiteConvert, discard: (filePath: string | undefined) => void): OfficeMetafileRun {
  const write = async (input: Buffer, sourceFormat: string, targetFormat: string): Promise<Buffer> => {
    const written = await convert(input, sourceFormat, targetFormat);
    if (!written) throw new EngineUnavailableError('soffice', 'The office suite wrote no metafile page.');
    try {
      return written.buffer;
    } finally {
      discard(written.filePath);
    }
  };
  return async (pdfPage, target) => write(await withoutPageMargins(await write(pdfPage, 'pdf', 'odg')), 'odg', target);
}
