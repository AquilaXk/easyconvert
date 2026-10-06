import { describe, expect, it } from 'vitest';
import { convertFile } from '../src/lib/conversions';
import { InputPixelLimitError } from '../src/lib/conversions/image-input-limits';

const HTTP_PAYLOAD_TOO_LARGE = 413;
const EXPECTED_DEFAULT_LIMIT = 100_000_000;
/** 2000 x 2000 user units: 8333 pixels a side at 300 dpi (69 MP), 16667 at 600 dpi (278 MP). */
const SVG_SIDE_UNITS = 2_000;
const DPI_WITHIN_LIMIT = 150;
const DPI_OVER_LIMIT = 600;
const DPI_BETWEEN_LIMITS = 480;
const PNG_IHDR_WIDTH_OFFSET = 16;
const PIXELS_PER_INCH_OF_SVG_UNITS = 72;

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="${SVG_SIDE_UNITS}" height="${SVG_SIDE_UNITS}" viewBox="0 0 ${SVG_SIDE_UNITS} ${SVG_SIDE_UNITS}"><rect width="${SVG_SIDE_UNITS}" height="${SVG_SIDE_UNITS}" fill="#336699"/></svg>`;

describe('SVG rendering is held to the input pixel limit at the requested dpi', () => {
  it.each([DPI_OVER_LIMIT, DPI_BETWEEN_LIMITS])('refuses a %i dpi render of a 2000 unit square for PNG with a typed 413', async (dpi) => {
    const run = convertFile(Buffer.from(SVG), 'svg', 'png', { dpi }, 'art.svg');
    await expect(run).rejects.toBeInstanceOf(InputPixelLimitError);
    await expect(run).rejects.toMatchObject({ status: HTTP_PAYLOAD_TOO_LARGE, limit: EXPECTED_DEFAULT_LIMIT });
  });

  it('refuses the same render for PDF output', async () => {
    const run = convertFile(Buffer.from(SVG), 'svg', 'pdf', { dpi: DPI_OVER_LIMIT }, 'art.svg');
    await expect(run).rejects.toBeInstanceOf(InputPixelLimitError);
    await expect(run).rejects.toMatchObject({ status: HTTP_PAYLOAD_TOO_LARGE });
  });

  it('still renders at a dpi within the limit, at exactly the size the dpi implies', async () => {
    const result = await convertFile(Buffer.from(SVG), 'svg', 'png', { dpi: DPI_WITHIN_LIMIT }, 'art.svg');
    const expectedSide = Math.round((SVG_SIDE_UNITS * DPI_WITHIN_LIMIT) / PIXELS_PER_INCH_OF_SVG_UNITS);
    expect(result.buffer.readUInt32BE(PNG_IHDR_WIDTH_OFFSET)).toBe(expectedSide);
  });
});
