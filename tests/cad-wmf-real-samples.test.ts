import { describe, expect, it } from 'vitest';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { getOracleToolPath } from './helpers/differential-oracle';
import { requireDwgSample } from './helpers/dwg-samples';
import { differingShare, MAX_DIFFERING_SHARE, officeSuitePicture, pdfPagePicture } from './helpers/metafile-fidelity';
import { skipUnless, skipWithoutTools } from './helpers/strict-skip';

/**
 * Entry 466: a DXF or DWG drawing is written as WMF from the page of the PDF the in-process engine draws of it, so its text is
 * outlines and its round line caps are pens or pictures, where the SVG of the drawing held both and the WMF writer refused them
 * (entry 187: 7 of 14 public drawings). Each drawing is pinned in bench/corpus/remote-manifest.json; the WMF is redrawn by the office
 * suite and compared with Poppler's picture of the drawing's PDF.
 */

const toolsMissing = skipWithoutTools('soffice', 'pdftoppm', 'pdftocairo');
const dwg2dxf = getOracleToolPath('dwg2dxf');
const readerMissing = skipUnless('dwg2dxf', dwg2dxf !== null);
const CONVERSION_TIMEOUT_MS = 300_000;
const WMF_PLACEABLE_KEY = 0x9ac6cdd7;
const WMF_PLACEABLE_HEADER_BYTES = 22;
const WMF_HEADER_BYTES = 18;
const META_STRETCHDIB = 0x0f43;
const META_POLYLINE = 0x0325;
const META_POLYGON = 0x0324;
const META_POLYPOLYGON = 0x0538;

/** The record functions of a placeable WMF, by walking its records. */
function recordFunctions(wmf: Buffer): number[] {
  expect(wmf.readUInt32LE(0)).toBe(WMF_PLACEABLE_KEY);
  const functions: number[] = [];
  for (let at = WMF_PLACEABLE_HEADER_BYTES + WMF_HEADER_BYTES; at + 6 <= wmf.length; at += wmf.readUInt32LE(at) * 2) {
    functions.push(wmf.readUInt16LE(at + 4));
    if (wmf.readUInt32LE(at) === 0) break;
  }
  return functions;
}

/** The WMF is vector records only, and the office suite draws it as Poppler draws the drawing's PDF. */
async function expectDrawing(source: Buffer, extension: 'dxf' | 'dwg', id: string): Promise<void> {
  const pdf = (await dispatchConversion(source, extension, 'pdf', {}, id)).buffer;
  const result = await dispatchConversion(source, extension, 'wmf', {}, id);
  expect(result.filename).toBe(`${id.replace(/\.[^.]+$/, '')}.wmf`);
  const functions = recordFunctions(result.buffer);
  expect(functions.filter((fn) => fn === META_POLYLINE || fn === META_POLYGON || fn === META_POLYPOLYGON).length).toBeGreaterThan(0);
  expect(functions.filter((fn) => fn === META_STRETCHDIB)).toHaveLength(0);
  const office = officeSuitePicture(result.buffer, 'wmf');
  expect(office, 'the office suite reads the file').toBeDefined();
  expect(await differingShare(pdfPagePicture(pdf, 1), office as Buffer, { cutToDrawing: true })).toBeLessThanOrEqual(MAX_DIFFERING_SHARE);
}

describe.skipIf(toolsMissing)('DXF drawings written as WMF from the page of their PDF (entry 466)', () => {
  // Text in eight fonts, a floor plan with blocks, nested inserts of another program, and 452 line segments of a model export.
  for (const id of ['cad-text-fonts.dxf', 'cad-floorplan.dxf', 'cad-insert-bricscad.dxf', 'cad-openscad-export.dxf', 'cad-text-alignments.dxf']) {
    it(`${id} is drawn as the PDF of the drawing is`, async (ctx) => {
      await expectDrawing(await requireDwgSample(ctx, id), 'dxf', id);
    }, CONVERSION_TIMEOUT_MS);
  }
});

describe.skipIf(toolsMissing || readerMissing)('DWG drawings written as WMF through their DXF and PDF (entry 466)', () => {
  for (const id of ['dwg-example-2018.dwg', 'dwg-gdal-attribs-2013.dwg']) {
    it(`${id} is drawn as the PDF of the drawing is`, async (ctx) => {
      process.env.DWG2DXF_PATH ??= dwg2dxf as string;
      await expectDrawing(await requireDwgSample(ctx, id), 'dwg', id);
    }, CONVERSION_TIMEOUT_MS);
  }
});
