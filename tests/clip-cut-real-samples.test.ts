import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { readDxf } from './helpers/dxf-reader';
import { differingShare, MAX_DIFFERING_SHARE, officeSuitePicture, pdfPagePicture } from './helpers/metafile-fidelity';
import { requireRealworldSample } from './helpers/realworld-sample';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * Real pages whose drawing sits under a clip that is not one convex polygon (policy 473). The in-process writers refused them
 * for it (a curved clip, a nested clip of a concave outline), and the EMF and WMF writers drew the refused parts as a picture of the
 * page. Each id is in bench/realworld/manifest.json or its regression manifest; the page of its PDF is written as DXF, EMF and
 * WMF, and the EMF and WMF are drawn again by the office suite and compared with Poppler's picture of the PDF page.
 */

const toolsMissing = skipWithoutTools('soffice', 'pdftoppm', 'pdftocairo', 'qpdf');
const CONVERSION_TIMEOUT_MS = 600_000;
const EMR_STRETCHDIBITS = 81;
const META_STRETCHDIB = 0x0f43;
const WMF_PLACEABLE_KEY = 0x9ac6cdd7;
const WMF_PLACEABLE_HEADER_BYTES = 22;
const WMF_HEADER_BYTES = 18;

interface PageCase {
  /** Id in a corpus manifest. */
  id: string;
  extension: 'ai' | 'pdf';
  page: number;
  /** The clip that the page was refused for. */
  clip: string;
  /** The page in points, which a DXF of a PDF is written in (entry 99), and the fewest entities its drawing holds (read 27, 2,478 and 2,175). */
  pagePoints: { width: number; height: number };
  minEntities: number;
  /** The bitmap records the page still needs: strokes under a non-uniform scale, which a metafile pen cannot draw, are a picture of the page. */
  pictures: number;
}

const CASES: readonly PageCase[] = [
  { id: 'asf-apachecon2020.ai', extension: 'ai', page: 1, clip: 'a circle, over a square of paint', pagePoints: { width: 1200, height: 1200 }, minEntities: 20, pictures: 0 },
  { id: 'govdocs1-002145.pdf', extension: 'pdf', page: 4, clip: 'the plot areas of three charts, each under two clips', pagePoints: { width: 612, height: 792 }, minEntities: 2000, pictures: 2 },
  { id: 'pdf-pypdf-geotopo.pdf', extension: 'pdf', page: 33, clip: 'the hatching of two circles, cut at the circle', pagePoints: { width: 595.28, height: 841.89 }, minEntities: 2000, pictures: 0 },
];

/** The number of bitmap records of an EMF or WMF file, found by walking its records. */
function bitmapRecords(metafile: Buffer, target: 'emf' | 'wmf'): number {
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

describe.skipIf(toolsMissing)('real pages under a clip that is not one convex polygon', () => {
  for (const sample of CASES) {
    it(
      `${sample.id} page ${sample.page} (${sample.clip}) is written as EMF and WMF with ${sample.pictures} pictures, and the office suite draws what Poppler draws`,
      async (ctx) => {
        const { bytes } = await requireRealworldSample(ctx, sample.id);
        const pdf = sample.extension === 'pdf' ? bytes : (await dispatchConversion(bytes, sample.extension, 'pdf', {}, sample.id)).buffer;
        const reference = pdfPagePicture(pdf, sample.page);
        for (const target of ['emf', 'wmf'] as const) {
          const metafile = await onlyPage((await dispatchConversion(pdf, 'pdf', target, { pages: String(sample.page) }, sample.id)).buffer);
          expect(bitmapRecords(metafile, target), `${target} bitmap records`).toBe(sample.pictures);
          const redrawn = officeSuitePicture(metafile, target);
          expect(redrawn, `the office suite reads the ${target}`).toBeDefined();
          expect(await differingShare(reference, redrawn as Buffer, { cutToDrawing: true }), target).toBeLessThanOrEqual(MAX_DIFFERING_SHARE);
        }
      },
      CONVERSION_TIMEOUT_MS
    );

    it(
      `${sample.id} page ${sample.page} is written as DXF with lines inside the page`,
      async (ctx) => {
        const { bytes } = await requireRealworldSample(ctx, sample.id);
        const pdf = sample.extension === 'pdf' ? bytes : (await dispatchConversion(bytes, sample.extension, 'pdf', {}, sample.id)).buffer;
        const dxf = readDxf((await onlyPage((await dispatchConversion(pdf, 'pdf', 'dxf', { pages: String(sample.page) }, sample.id)).buffer)).toString('utf-8'));
        expect(dxf.entities.length).toBeGreaterThanOrEqual(sample.minEntities);
        const points = dxf.entities.flatMap((entity) => entity.points);
        expect(points.every((p) => p.x >= 0 && p.x <= sample.pagePoints.width && p.y >= 0 && p.y <= sample.pagePoints.height), 'every point is on the page').toBe(true);
      },
      CONVERSION_TIMEOUT_MS
    );
  }
});
