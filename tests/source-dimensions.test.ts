import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { convertVectorCad, parseCgmToSvg } from '../src/lib/conversions/vector-cad';
import { ConversionFailedError } from '../src/lib/types';

/**
 * Output sizes come from the source drawing. A CGM without a VDC extent has no size to read, so it is refused
 * (HTTP 400) instead of being drawn on an invented 800 x 600 canvas.
 */

describe('CGM sizes', () => {
  it('reads the canvas from VDCEXT', () => {
    const svg = parseCgmToSvg('BEGMF "x";\nBEGPIC "p";\nVDCEXT (0,0) (320,200);\nBEGPICBODY;\nLINE (0,0) (10,10);\nENDPIC;\nENDMF;\n');
    expect(/viewBox="([^"]*)"/.exec(svg ?? '')?.[1]).toBe('0 0 320 200');
    expect(/<svg[^>]* width="(\d+)" height="(\d+)"/.exec(svg ?? '')?.slice(1)).toEqual(['320', '200']);
  });

  it.each([
    ['no VDCEXT', 'BEGMF "x";\nBEGPIC "p";\nBEGPICBODY;\nLINE (0,0) (10,10);\nENDPIC;\nENDMF;\n'],
    ['a zero-width VDCEXT', 'BEGMF "x";\nVDCEXT (5,0) (5,200);\nLINE (0,0) (10,10);\nENDMF;\n'],
  ])('refuses a CGM with %s with a typed 400 error', (_label, cgm) => {
    let thrown: unknown;
    try {
      parseCgmToSvg(cgm);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ConversionFailedError);
    expect((thrown as Error).message).toMatch(/no VDC extent|empty VDC extent/);
  });

  it('answers a CGM conversion without a VDC extent with the same error', async () => {
    const run = convertVectorCad(Buffer.from('BEGMF "x";\nLINE (0,0) (10,10);\nENDMF;\n', 'utf-8'), 'cgm', 'png', {}, 'drawing.cgm');
    await expect(run).rejects.toBeInstanceOf(ConversionFailedError);
    await expect(run).rejects.toThrow(/no VDC extent/);
  });
});

describe('invented canvas sizes are gone from the sources', () => {
  const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', 'src', 'lib', 'conversions', rel), 'utf-8');

  it('vector-cad.ts has no 800 x 600 CGM default and no 600 x 400 raster fallback', () => {
    const source = read('vector-cad.ts');
    expect([...source.matchAll(/let width = 800|meta\.width \|\| 600|meta\.height \|\| 400/g)].map((m) => m[0])).toEqual([]);
  });

  it('vector-cad.ts has no PostScript stand-in rectangle or fixed 600 x 600 canvas', () => {
    const source = read('vector-cad.ts');
    expect([...source.matchAll(/width="500" height="500"|viewBox="0 0 600 600"/g)].map((m) => m[0])).toEqual([]);
  });
});
