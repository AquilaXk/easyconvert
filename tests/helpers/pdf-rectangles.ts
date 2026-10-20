import { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream } from 'pdf-lib';

/**
 * The rectangles a PDF page draws with the `re` operator, read from the page's content stream by pdf-lib (which shares no
 * code with the writers under test). Coordinates are in points as the content stream states them: the in-process writer
 * flips the page so that y grows downward from the top edge.
 */

export interface DrawnRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

const RECTANGLE_OPERATOR = /(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+re\b/g;

/** The rectangles of every page of `pdf`, in drawing order. */
export async function pageRectangles(pdf: Buffer): Promise<DrawnRectangle[][]> {
  const doc = await PDFDocument.load(pdf);
  return doc.getPages().map((page) => {
    const contents = page.node.Contents();
    const streams = contents instanceof PDFArray ? contents.asArray() : [contents];
    const content = streams.map((ref) => Buffer.from(decodePDFRawStream(doc.context.lookup(ref) as PDFRawStream).decode()).toString('latin1')).join('\n');
    return [...content.matchAll(RECTANGLE_OPERATOR)].map((match) => ({
      x: Number(match[1]),
      y: Number(match[2]),
      width: Number(match[3]),
      height: Number(match[4]),
    }));
  });
}
