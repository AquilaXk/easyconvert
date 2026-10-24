import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';

/** A word to draw: its right end (`right`, in points from the left of the unrotated page) and baseline (`baseline`, from the bottom). */
export interface DrawnWord {
  text: string;
  right: number;
  baseline: number;
}

export interface DrawnPage {
  /** MediaBox width and height in points. */
  size: readonly [number, number];
  words: readonly DrawnWord[];
  /** CropBox as x, y, width, height. */
  cropBox?: readonly [number, number, number, number];
  rotate?: 90 | 180 | 270;
}

const FONT_SIZE = 12;

/** A PDF whose pages hold the given words in Helvetica 12 pt, each ending exactly at its `right`, wherever that is in relation to the page. */
export async function pdfWithWords(pages: readonly DrawnPage[]): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const drawn of pages) {
    const page = pdf.addPage([drawn.size[0], drawn.size[1]]);
    if (drawn.cropBox) page.setCropBox(...drawn.cropBox);
    if (drawn.rotate) page.setRotation(degrees(drawn.rotate));
    for (const word of drawn.words) {
      page.drawText(word.text, { x: word.right - font.widthOfTextAtSize(word.text, FONT_SIZE), y: word.baseline, size: FONT_SIZE, font });
    }
  }
  return Buffer.from(await pdf.save());
}
