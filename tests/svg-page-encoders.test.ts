import { describe, expect, it } from 'vitest';
import { isSvgPageTarget, svgPageEncoder } from '../src/worker/svg-page-encoders';
import type { WorkerConversionResult } from '../src/worker/worker-types';

/**
 * The writers behind the SVG-page targets (DXF, EMF, WMF) are the ones the PDF chain calls for a Visio drawing, so each
 * must write the file signature its format specification names; a table that paired a target with the wrong writer would
 * otherwise hand out a file of another format under the right name.
 */

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><polygon points="10,10 90,20 40,80" fill="#ff0000"/></svg>';
const EMF_SIGNATURE = 0x464d4520;
const WMF_PLACEABLE_KEY = 0x9ac6cdd7;
const WMF_STANDARD_HEADER_WORDS = 9;
/** A one-page render: the page draws no bitmap-font text, so its PDF is never read. */
const RENDERED = { filename: 'drawing.svg' } as WorkerConversionResult;

function write(target: string): Promise<Buffer> {
  return svgPageEncoder(target, RENDERED, () => undefined)(Buffer.from(SVG), RENDERED.filename);
}

describe('the writers of the SVG-page targets', () => {
  it.each(['dxf', 'emf', 'wmf'])('.%s is a target written from the SVG page', (target) => {
    expect(isSvgPageTarget(target)).toBe(true);
  });

  it.each(['png', 'svg', 'cgm', 'pdf', 'eps', 'toString', '__proto__'])('.%s is not', (target) => {
    expect(isSvgPageTarget(target)).toBe(false);
  });

  it('EMF: the header record is type 1 and holds the signature of the format at byte 40', async () => {
    const emf = await write('emf');
    expect(emf.readUInt32LE(0)).toBe(1);
    expect(emf.readUInt32LE(40)).toBe(EMF_SIGNATURE);
    expect(emf.readUInt32LE(48)).toBe(emf.length);
  });

  it('WMF: an Aldus placeable header, or the standard header of nine words', async () => {
    const wmf = await write('wmf');
    const header = wmf.readUInt32LE(0) === WMF_PLACEABLE_KEY ? 22 : 0;
    expect(wmf.readUInt16LE(header + 2)).toBe(WMF_STANDARD_HEADER_WORDS);
    expect([1, 2]).toContain(wmf.readUInt16LE(header));
  });

  it('DXF: a SECTION record opens the file and an EOF record closes it', async () => {
    const dxf = (await write('dxf')).toString('utf-8');
    expect(dxf).toMatch(/^\s*0\nSECTION\n/);
    expect(dxf).toMatch(/\n\s*0\nEOF\s*$/);
  });

  it('each target has a writer of its own', async () => {
    const outputs = await Promise.all(['dxf', 'emf', 'wmf'].map(async (target) => (await write(target)).subarray(0, 48).toString('hex')));
    expect(new Set(outputs).size).toBe(3);
  });
});
