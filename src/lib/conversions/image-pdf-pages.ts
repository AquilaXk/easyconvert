import PDFDocument from 'pdfkit';
import type { ConversionOptions } from '../types';
import { pageSizePoints, withinPdfPageLimit, type PageSize, type PrintDensity } from './image-print-density';

/**
 * A PDF with one picture to the page. A page is the picture at its stored print size (pixels x 72 / dpi on each axis, see
 * image-print-density.ts), scaled evenly to 14400 points on its longer side when it would be longer; the pixels are the picture's own,
 * placed over the whole picture rectangle. A requested landscape orientation turns a portrait page, and the picture is then fitted
 * inside it and centred.
 */

/** One PDF page: the oriented picture as PNG, its pixel size and the density it is shown at. */
export interface PdfPageImage {
  png: Buffer;
  width: number;
  height: number;
  density: PrintDensity;
}

interface PagePlacement {
  page: PageSize;
  /** Where the picture goes: its size on the page and the offset of its top-left corner. */
  picture: PageSize & { x: number; y: number };
}

function placementOf(image: PdfPageImage, orientation: ConversionOptions['orientation']): PagePlacement {
  const size = withinPdfPageLimit(pageSizePoints(image.width, image.height, image.density));
  const isLandscape = orientation === 'landscape' || (size.width > size.height && !orientation);
  // The size is already [width, height] in the final orientation, so no layout swap is applied.
  const page = isLandscape ? { width: Math.max(size.width, size.height), height: Math.min(size.width, size.height) } : size;
  const scale = Math.min(page.width / size.width, page.height / size.height);
  const width = size.width * scale;
  const height = size.height * scale;
  return { page, picture: { width, height, x: (page.width - width) / 2, y: (page.height - height) / 2 } };
}

/** The PDF of `images`, one page each in order. */
export function assemblePicturePdf(images: readonly PdfPageImage[], orientation: ConversionOptions['orientation']): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const placements = images.map((image) => placementOf(image, orientation));
    const doc = new PDFDocument({ size: [placements[0].page.width, placements[0].page.height], margin: 0 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', (err) => reject(err));

    images.forEach((image, index) => {
      const { page, picture } = placements[index];
      if (index > 0) doc.addPage({ size: [page.width, page.height], margin: 0 });
      doc.image(image.png, picture.x, picture.y, { width: picture.width, height: picture.height });
    });
    doc.end();
  });
}
