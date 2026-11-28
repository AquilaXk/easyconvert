import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { cgmBinaryAsClearText, cgmBinaryElements, cgmBinaryName, cgmBinaryPoints, cgmBinaryString } from './helpers/cgm-binary-oracle';
import { getOracleToolPath } from './helpers/differential-oracle';
import { requireDwgSample } from './helpers/dwg-samples';
import { differingShare, MAX_DIFFERING_SHARE, officeSuitePicture, pdfPagePicture } from './helpers/metafile-fidelity';
import { skipUnless, skipWithoutTools } from './helpers/strict-skip';

/**
 * Entry 468: a DXF or DWG drawing is written as a binary CGM from the page of the PDF the in-process engine draws of it, the route of its
 * WMF (entry 466). Each drawing is pinned in bench/corpus/remote-manifest.json. The file is walked by an independent reader of the binary
 * encoding (`helpers/cgm-binary-oracle.ts`), redrawn by the office suite's CGM import, and compared with Poppler's picture of the drawing's PDF.
 *
 * The suite places a CGM picture on a slide of 28 by 15.75 cm after fitting it to a box of 28 by 21 cm (`icgm/cgm.cxx` `ImplSetMapMode`,
 * `gnOutdx` and `gnOutdy`), so the lower part of a picture taller than 16:9 is off the slide in the suite's own picture of it; the reference
 * is cut to the part of the page that the slide shows, and the suite's picture to the area of the picture.
 */

const toolsMissing = skipWithoutTools('soffice', 'pdftoppm', 'pdftocairo');
const dwg2dxf = getOracleToolPath('dwg2dxf');
const readerMissing = skipUnless('dwg2dxf', dwg2dxf !== null);
const CONVERSION_TIMEOUT_MS = 300_000;
const SLIDE_CM = { width: 28, height: 15.75 };
const FIT_BOX_CM = { width: 28, height: 21 };
const BEGIN_METAFILE = { elementClass: 0, id: 1 };
const END_METAFILE = { elementClass: 0, id: 2 };
/**
 * The comparison of entry 466 with a finer blur and a lighter ink level: the thin lines of a drawing (0.75 pixel at the 50 dpi of the comparison)
 * are inked in both pictures, where the blur of entry 454 dissolves them and the share of a drawing of lines alone is 0 for any picture. Measured on the
 * public drawings: 0 to 4.5% for the suite's redraw, 4% to 30% for the same redraw mirrored where it is not symmetric.
 */
const COMPARISON = { blurSigma: 1, inkLevel: 250 };

/** The size on the slide, in centimetres, of a CGM whose picture is `vdc` units wide and high: the picture fitted to its box, cut at the edges of the slide. */
function pictureOnSlide(vdc: { width: number; height: number }): { fitted: { width: number; height: number }; shown: { width: number; height: number } } {
  const aspect = vdc.width / vdc.height;
  const fitted = aspect >= FIT_BOX_CM.width / FIT_BOX_CM.height ? { width: FIT_BOX_CM.width, height: FIT_BOX_CM.width / aspect } : { width: FIT_BOX_CM.height * aspect, height: FIT_BOX_CM.height };
  return { fitted, shown: { width: Math.min(fitted.width, SLIDE_CM.width), height: Math.min(fitted.height, SLIDE_CM.height) } };
}

/** The top left corner of a picture, `fraction` of its width and height, on whole pixels. */
async function topLeft(picture: Buffer, fraction: { x: number; y: number }): Promise<Buffer> {
  const { width = 1, height = 1 } = await sharp(picture).metadata();
  return sharp(picture)
    .extract({ left: 0, top: 0, width: Math.max(1, Math.round(fraction.x * width)), height: Math.max(1, Math.round(fraction.y * height)) })
    .png()
    .toBuffer();
}

/**
 * The picture is the whole of the page placed at the top left corner of the slide, so the suite's picture of the CGM is cut to the area the picture takes
 * on the slide and Poppler's picture of the page to the share of the page that the slide shows: both then show the same frame, which a cut to the ink of
 * each would not do for a drawing of thin lines (Poppler draws them fainter than the suite at 50 dpi).
 */
async function frameOfDrawing(slide: Buffer, page: Buffer, vdc: { width: number; height: number }): Promise<{ redraw: Buffer; reference: Buffer }> {
  const { fitted, shown } = pictureOnSlide(vdc);
  return {
    redraw: await topLeft(slide, { x: shown.width / SLIDE_CM.width, y: shown.height / SLIDE_CM.height }),
    reference: await topLeft(page, { x: shown.width / fitted.width, y: shown.height / fitted.height }),
  };
}

/** The CGM is one picture of vector elements, and the office suite draws it as Poppler draws the drawing's PDF. `mirrored` is the comparison of the redraw turned over, which a drawing that is not symmetric must fail. */
async function expectDrawing(source: Buffer, extension: 'dxf' | 'dwg', id: string, { cellArrays = 0, mirrored = false } = {}): Promise<void> {
  const pdf = (await dispatchConversion(source, extension, 'pdf', {}, id)).buffer;
  const result = await dispatchConversion(source, extension, 'cgm', {}, id);
  expect(result.filename).toBe(`${id.replace(/\.[^.]+$/, '')}.cgm`);
  const elements = cgmBinaryElements(result.buffer);
  const names = elements.map(cgmBinaryName);
  expect(elements[0]).toMatchObject(BEGIN_METAFILE);
  expect(elements.at(-1)).toMatchObject(END_METAFILE);
  expect(cgmBinaryString(elements[0].parameters)).toBe('drawing');
  expect(names.filter((name) => name === 'BEGPIC')).toHaveLength(1);
  expect(names.filter((name) => name === 'ENDPIC')).toHaveLength(1);
  expect(names.filter((name) => name === 'POLYLINE' || name === 'POLYGON' || name === 'POLYGONSET').length).toBeGreaterThan(0);
  expect(names.filter((name) => name === 'CELLARRAY'), 'the parts of the drawing that the writer cannot draw').toHaveLength(cellArrays);
  expect(cgmBinaryAsClearText(result.buffer)).toContain('ENDMF;');
  const [from, to] = cgmBinaryPoints((elements.find((element) => cgmBinaryName(element) === 'VDCEXT') as (typeof elements)[number]).parameters);
  const office = officeSuitePicture(result.buffer, 'cgm');
  expect(office, 'the office suite reads the file').toBeDefined();
  const { redraw, reference } = await frameOfDrawing(office as Buffer, pdfPagePicture(pdf, 1), { width: Math.abs(to.x - from.x), height: Math.abs(to.y - from.y) });
  expect(await differingShare(reference, redraw, COMPARISON)).toBeLessThanOrEqual(MAX_DIFFERING_SHARE);
  if (mirrored) expect(await differingShare(reference, await sharp(redraw).flip().toBuffer(), COMPARISON), 'the comparison tells a turned picture apart').toBeGreaterThan(MAX_DIFFERING_SHARE);
}

describe.skipIf(toolsMissing)('DXF drawings written as CGM from the page of their PDF (entry 468)', () => {
  // Text in eight fonts, a floor plan with blocks, nested inserts of another program, and 452 line segments of a model export.
  it('cad-text-alignments.dxf is not drawn upside down', async (ctx) => {
    await expectDrawing(await requireDwgSample(ctx, 'cad-text-alignments.dxf'), 'dxf', 'cad-text-alignments.dxf', { mirrored: true });
  }, CONVERSION_TIMEOUT_MS);

  for (const id of ['cad-text-fonts.dxf', 'cad-floorplan.dxf', 'cad-insert-bricscad.dxf', 'cad-openscad-export.dxf', 'cad-text-alignments.dxf']) {
    it(`${id} is drawn as the PDF of the drawing is`, async (ctx) => {
      await expectDrawing(await requireDwgSample(ctx, id), 'dxf', id);
    }, CONVERSION_TIMEOUT_MS);
  }
});

describe.skipIf(toolsMissing || readerMissing)('DWG drawings written as CGM through their DXF and PDF (entry 468)', () => {
  // The example drawing holds a filled shape of overlapping contours that the CGM has no fill rule for (the WMF is written with WINDING): one cell array of 6 by 6 cells.
  for (const [id, cellArrays] of [['dwg-example-2018.dwg', 1], ['dwg-gdal-attribs-2013.dwg', 0]] as const) {
    it(`${id} is drawn as the PDF of the drawing is`, async (ctx) => {
      process.env.DWG2DXF_PATH ??= dwg2dxf as string;
      await expectDrawing(await requireDwgSample(ctx, id), 'dwg', id, { cellArrays });
    }, CONVERSION_TIMEOUT_MS);
  }
});
