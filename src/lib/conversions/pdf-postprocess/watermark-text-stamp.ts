import PDFDocument from 'pdfkit';
import { PdfUnicodeTextWriter, loadFontCoverageIndex, type PdfFontFace } from '../pdf-fonts';

/**
 * A one-line text watermark rendered as a tiny PDF page with the same embedded-font writer the in-process PDF
 * writers use: every face is a subset (tagged name, ToUnicode map) and every run has a covering font. The page is
 * then placed on the target pages as a form XObject, so the watermark font travels with the stamp and never
 * touches the fonts of the document it marks.
 */

const COLOR_MAX = 255;
/** The stamp page is the second page of its document; the first is the blank page used to measure. */
export const STAMP_PAGE_INDEX = 1;
const MEASURE_PAGE_SIZE = 10;

export interface StampColor {
  red: number;
  green: number;
  blue: number;
}

export interface TextStampRequest {
  text: string;
  fontSize: number;
  /** Components in 0..1. */
  color: StampColor;
  /** 0..1. */
  opacity: number;
  /** A face the caller already checked covers the text; otherwise the installed faces are searched. */
  face?: PdfFontFace;
}

export interface TextStamp {
  /** A PDF whose page STAMP_PAGE_INDEX is the stamp. */
  pdf: Buffer;
  width: number;
  height: number;
}

function collect(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

/**
 * @throws EngineUnavailableError('unicode-font') when no installed font covers the text.
 * @throws ConversionFailedError when a code point can be drawn by no font at all.
 */
export async function renderTextStamp(request: TextStampRequest): Promise<TextStamp> {
  await loadFontCoverageIndex();
  const doc = new PDFDocument({ size: [MEASURE_PAGE_SIZE, MEASURE_PAGE_SIZE], margin: 0, compress: true });
  const writer = new PdfUnicodeTextWriter(doc, request.face);
  doc.fontSize(request.fontSize);
  // The measure call selects the font of each run, so an uncovered code point fails here, before anything is drawn.
  const { width, lineHeight } = writer.measure(request.text);
  doc.addPage({ size: [width, lineHeight], margin: 0 });
  doc.fontSize(request.fontSize);
  const { red, green, blue } = request.color;
  doc.fillColor([red * COLOR_MAX, green * COLOR_MAX, blue * COLOR_MAX]).fillOpacity(request.opacity);
  writer.write(request.text, { lineBreak: false }, 0, 0);
  return { pdf: await collect(doc), width, height: lineHeight };
}
