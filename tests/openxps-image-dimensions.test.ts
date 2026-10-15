import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { buildOpenXpsPackage, type XpsPageInput } from '../src/lib/conversions/openxps';

/**
 * An XPS page that embeds an image must be told the image size: the ImageBrush viewbox is the pixel
 * rectangle of the picture, and an invented size would crop or distort it.
 *
 * Oracle: the generated FixedPage XML is read back with JSZip and matched against the sizes passed in.
 */

const PNG_STUB = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const PAGE_PART = 'Documents/1/Pages/1.fpage';

function pageWith(image: Partial<NonNullable<XpsPageInput['image']>>): XpsPageInput {
  return { title: 'p', image: { buffer: PNG_STUB, format: 'png', ...image } as NonNullable<XpsPageInput['image']> };
}

async function captureError(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`rejected with a non-Error value: ${String(error)}`);
  }
  throw new Error('expected the package build to reject');
}

describe('buildOpenXpsPackage image dimensions', () => {
  it('writes the given pixel size into the image brush viewbox', async () => {
    const buffer = await buildOpenXpsPackage([pageWith({ width: 41, height: 23 })], 'doc');
    const zip = await JSZip.loadAsync(buffer);
    const fpage = await zip.file(PAGE_PART)!.async('string');
    const viewboxes = [...fpage.matchAll(/Viewbox="([^"]+)"/g)].map((match) => match[1]);
    expect(viewboxes).toEqual(['0,0,41,23']);
  });

  it.each([
    ['width missing', { height: 23 }],
    ['height missing', { width: 41 }],
    ['both missing', {}],
    ['zero width', { width: 0, height: 23 }],
    ['negative height', { width: 41, height: -1 }],
    ['fractional width', { width: 41.5, height: 23 }],
    ['NaN height', { width: 41, height: Number.NaN }],
  ])('rejects an image with %s', async (_label, size) => {
    const error = await captureError(() => buildOpenXpsPackage([pageWith(size)], 'doc'));
    expect(error.name).toBe('ConversionFailedError');
    expect(error.message).toMatch(/XPS image on page 1 needs a positive integer width and height/);
  });

  it('still builds text-only pages without an image', async () => {
    const buffer = await buildOpenXpsPackage([{ title: 't', lines: ['hello'] }], 'doc');
    const zip = await JSZip.loadAsync(buffer);
    const fpage = await zip.file(PAGE_PART)!.async('string');
    expect([...fpage.matchAll(/<ImageBrush/g)]).toHaveLength(0);
    expect([...fpage.matchAll(/UnicodeString="([^"]*)"/g)].map((match) => match[1])).toEqual(['hello']);
  });
});
