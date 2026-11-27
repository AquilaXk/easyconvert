import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { RasterFallbackTooLargeError } from '../src/worker/metafile-raster-fallback';
import { differingShare, inkscapePicture, MAX_DIFFERING_SHARE, MAX_FRAMED_DIFFERING_SHARE, officeSuitePicture, pdfPagePicture } from './helpers/metafile-fidelity';
import { requireRealworldSample } from './helpers/realworld-sample';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * Real pages that the office suite drew wrong as EMF and WMF (a gradient lost under a clip, a background fill, a cropped picture, a soft
 * mask) and that the in-process writer now writes with a picture for the part it cannot draw (entry 459). Each id is in
 * bench/realworld/manifest.json; the page of its PDF is written as EMF or WMF, redrawn by two readers other than the writer, and compared
 * with Poppler's picture of the same PDF page. Before the change both readers measured the pages below 0.2 to 0.9 apart from it.
 */

const toolsMissing = skipWithoutTools('soffice', 'pdftoppm', 'pdftocairo', 'qpdf', 'inkscape');
const CONVERSION_TIMEOUT_MS = 600_000;
const EMR_STRETCHDIBITS = 81;
const META_STRETCHDIB = 0x0f43;
const WMF_PLACEABLE_KEY = 0x9ac6cdd7;
const WMF_PLACEABLE_HEADER_BYTES = 22;
const WMF_HEADER_BYTES = 18;

interface PageCase {
  /** Id in bench/realworld/manifest.json. */
  id: string;
  extension: string;
  page: number;
  target: 'emf' | 'wmf';
  /** What the page loses when the office suite writes it. */
  lost: string;
}

const CASES: readonly PageCase[] = [
  // Illustrator and EPS drawings (entry 458 measured them wrong through the office suite): a gradient under a curved clip.
  { id: 'jupyter-python.ai', extension: 'ai', page: 1, target: 'wmf', lost: 'the blue and yellow gradients' },
  { id: 'pydotorg-python-logo-mods.ai', extension: 'ai', page: 1, target: 'emf', lost: 'the gradients and the clipped shapes' },
  { id: 'pdfbox-archivergb.ai', extension: 'ai', page: 1, target: 'emf', lost: 'most of the drawing' },
  { id: 'cncf-open-workflow-specification.ai', extension: 'ai', page: 1, target: 'emf', lost: 'the gradients' },
  { id: 'cncf-tektonhub_color.eps', extension: 'eps', page: 1, target: 'wmf', lost: 'the gradient of the lettering' },
  { id: 'im-logo.eps', extension: 'eps', page: 1, target: 'emf', lost: 'the shading of the sphere' },
  { id: 'gs-ridt91.eps', extension: 'eps', page: 1, target: 'wmf', lost: 'the shaded areas' },
  // A page of a PDF with soft-masked spheres, a transparent page, and slides that lost a background fill or a cropped picture.
  { id: 'pdf-pypdf-geotopo.pdf', extension: 'pdf', page: 3, target: 'emf', lost: 'the shading of the spheres' },
  { id: 'pdfjs-issue17069.pdf', extension: 'pdf', page: 1, target: 'emf', lost: 'the transparent shapes' },
  { id: 'office-slideshow-themes.pptx', extension: 'pptx', page: 4, target: 'emf', lost: 'the gradient background' },
  { id: 'govdocs1-005475.ppt', extension: 'ppt', page: 1, target: 'emf', lost: 'the crop of the picture' },
  { id: 'govdocs1-001888.ppt', extension: 'ppt', page: 1, target: 'emf', lost: 'the crop of the picture' },
];

/** The number of bitmap records of an EMF or WMF file, found by walking its records. */
function bitmapRecords(metafile: Buffer, target: string): number {
  let count = 0;
  if (target === 'emf') {
    for (let at = 0; at + 8 <= metafile.length; at += metafile.readUInt32LE(at + 4)) if (metafile.readUInt32LE(at) === EMR_STRETCHDIBITS) count++;
    return count;
  }
  let at = (metafile.readUInt32LE(0) === WMF_PLACEABLE_KEY ? WMF_PLACEABLE_HEADER_BYTES : 0) + WMF_HEADER_BYTES;
  for (; at + 6 <= metafile.length; at += metafile.readUInt32LE(at) * 2) if (metafile.readUInt16LE(at + 4) === META_STRETCHDIB) count++;
  return count;
}

async function onlyPage(output: Buffer): Promise<Buffer> {
  if (output.subarray(0, 2).toString('latin1') !== 'PK') return output;
  const archive = await JSZip.loadAsync(output);
  return Buffer.from(await archive.files[Object.keys(archive.files).sort()[0]].async('uint8array'));
}

/** The metafile of the page is redrawn by the office suite and by Inkscape and compared with Poppler's page of the PDF. */
async function expectPageDrawn(sample: PageCase, pdf: Buffer, metafile: Buffer): Promise<void> {
  const reference = pdfPagePicture(pdf, sample.page);
  const office = officeSuitePicture(metafile, sample.target);
  expect(office, 'the office suite reads the file').toBeDefined();
  expect(await differingShare(reference, office as Buffer, { cutToDrawing: true }), 'office suite').toBeLessThanOrEqual(MAX_DIFFERING_SHARE);
  const inkscape = inkscapePicture(metafile, sample.target);
  expect(inkscape, 'Inkscape reads the file').toBeDefined();
  expect(await differingShare(reference, inkscape as Buffer, { blurSigma: 9, inkLevel: 240, colourDifference: 50 }), 'Inkscape').toBeLessThanOrEqual(MAX_FRAMED_DIFFERING_SHARE);
  expect(bitmapRecords(metafile, sample.target), 'bitmap records').toBeGreaterThan(0);
}

describe.skipIf(toolsMissing)('real pages written with a picture for what the in-process writer cannot draw', () => {
  for (const sample of CASES) {
    it(
      `${sample.id} page ${sample.page} as ${sample.target}: ${sample.lost} is drawn, by two other readers`,
      async (ctx) => {
        const { bytes } = await requireRealworldSample(ctx, sample.id);
        const pdf = sample.extension === 'pdf' ? bytes : (await dispatchConversion(bytes, sample.extension, 'pdf', {}, sample.id)).buffer;
        const metafile = await onlyPage((await dispatchConversion(pdf, 'pdf', sample.target, { pages: String(sample.page) }, sample.id)).buffer);
        await expectPageDrawn(sample, pdf, metafile);
      },
      CONVERSION_TIMEOUT_MS
    );
  }

  // Entry 460 offers Illustrator and EPS files as EMF and WMF: the same pages, converted from the file itself.
  for (const sample of CASES.filter((page) => page.extension === 'ai' || page.extension === 'eps')) {
    it(
      `${sample.id} converts as ${sample.target} from the ${sample.extension} file itself: ${sample.lost} is drawn`,
      async (ctx) => {
        const { bytes } = await requireRealworldSample(ctx, sample.id);
        const pdf = (await dispatchConversion(bytes, sample.extension, 'pdf', {}, sample.id)).buffer;
        const metafile = await onlyPage((await dispatchConversion(bytes, sample.extension, sample.target, { pages: String(sample.page) }, sample.id)).buffer);
        await expectPageDrawn(sample, pdf, metafile);
      },
      CONVERSION_TIMEOUT_MS
    );
  }

  it('refuses a page whose picture would need more than the bounds, with a typed error and no file', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, 'asf-apache-20th-badge-1-cmyk.ai');
    const pdf = (await dispatchConversion(bytes, 'ai', 'pdf', {}, 'asf-apache-20th-badge-1-cmyk.ai')).buffer;
    const refusal = dispatchConversion(pdf, 'pdf', 'emf', { pages: '1' }, 'asf-apache-20th-badge-1-cmyk.pdf');
    await expect(refusal).rejects.toBeInstanceOf(RasterFallbackTooLargeError);
    await expect(refusal).rejects.toThrow(/more than 72 dpi allows within 12000000 pixels/);
  }, CONVERSION_TIMEOUT_MS);

  it('refuses a 69-inch Illustrator art board as EMF and WMF with the same typed error', async (ctx) => {
    const { bytes } = await requireRealworldSample(ctx, 'asf-apache-20th-badge-1-cmyk.ai');
    for (const target of ['emf', 'wmf']) {
      const refusal = dispatchConversion(bytes, 'ai', target, { pages: '1' }, 'asf-apache-20th-badge-1-cmyk.ai');
      await expect(refusal, `ai -> ${target}`).rejects.toBeInstanceOf(RasterFallbackTooLargeError);
      await expect(refusal, `ai -> ${target}`).rejects.toThrow(/more than 72 dpi allows within 12000000 pixels/);
    }
  }, CONVERSION_TIMEOUT_MS);
});
