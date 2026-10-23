import { analyzePdfPagesInProcess } from '../src/lib/conversions/pdf-text-geometry';
import { picturePdf } from './helpers/picture-pdf';

/**
 * Child process of tests/pdf-picture-memory.test.ts. It reads a PDF with a large picture of its own on every page, as the
 * text thread does for a conversion that keeps the pictures, and reports the resident set it peaked at. pdf.js keeps the
 * decoded pixels of a page in `page.objs`, outside the V8 heap, until `page.cleanup()` is called, so a reader that never
 * cleans up holds every page's picture at once.
 */

const [pagesArgument, dimensionArgument] = process.argv.slice(2);
const pages = Number(pagesArgument);
const dimension = Number(dimensionArgument);

async function main(): Promise<void> {
  const result = await analyzePdfPagesInProcess(picturePdf({ pages, drawsPerPage: 1, dimension, sharedPicture: false }), { geometry: 'none', content: true, images: true });
  const pictures = result.content.reduce((total, page) => total + page.images.filter((image) => image.data !== undefined).length, 0);
  process.stdout.write(`ok ${pictures} pictures, peak rss ${Math.round(process.resourceUsage().maxRSS / 1024)} MiB\n`);
  process.exit(0);
}

void main();
