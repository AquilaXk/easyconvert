import { afterAll, describe, expect, it } from 'vitest';
import {
  mapToPalette,
  quantizeImage,
  quantizeImageAsync,
  runMapStripe,
  runRepairStripes,
  STRIPED_MIN_PIXELS,
  stripeStarts,
  type IndexedImage,
} from '../src/lib/conversions/color-quantizer';
import { shutdownCpuPool } from '../src/lib/workers/cpu-pool';

/**
 * The plain palette mapper keeps the previous pixel's colour where the nearest colour is nearly as far (the run tolerance), so a
 * pixel's index depends on the pixel before it. A raster mapped in stripes (each stripe from a guess of the colour before it, the
 * first pixels of each repaired afterwards) must give the indices of the one-pass mapper, whatever the number of stripes.
 */
const RGBA = 4;

/** A small deterministic generator (mulberry32), so every run sees the same picture. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Shape {
  /** 0 keeps every pixel opaque; otherwise the chance per pixel that a transparent run starts. */
  holes: number;
  /** Noise added to the smooth gradient, in levels: 0 makes long runs of one colour. */
  noise: number;
}

/** A gradient with noise, the way a photograph moves through neighbouring palette colours, and optional runs of transparent pixels. */
function picture(width: number, height: number, shape: Shape, seed: number): Uint8Array {
  const random = generator(seed);
  const pixels = new Uint8Array(width * height * RGBA);
  let hole = 0;
  for (let p = 0; p < width * height; p += 1) {
    const x = p % width;
    const y = Math.floor(p / width);
    const base = [(x * 255) / width, (y * 255) / height, ((x + y) * 255) / (width + height)];
    for (let c = 0; c < 3; c += 1) pixels[p * RGBA + c] = Math.max(0, Math.min(255, Math.round(base[c] + (random() - 0.5) * shape.noise)));
    if (hole === 0 && shape.holes > 0 && random() < shape.holes) hole = 1 + Math.floor(random() * 3 * width);
    pixels[p * RGBA + 3] = hole > 0 ? 0 : 255;
    if (hole > 0) hole -= 1;
  }
  return pixels;
}

function palettedBy(pixels: Uint8Array, width: number, height: number, colours: number): IndexedImage {
  return quantizeImage(pixels, width, height, colours, { dither: 'none', transparency: 'threshold' });
}

/** The stripes and the repair run one after the other, as the pool runs them, on memory shared by plain typed arrays. */
function mapInStripes(pixels: Uint8Array, width: number, height: number, image: IndexedImage, runTolerance: number, stripes: number): Uint8Array {
  const opaqueSize = image.transparentIndex >= 0 ? image.transparentIndex : image.paletteSize;
  const indices = new Uint8Array(width * height);
  const task = { pixels, indices, palette: image.palette, paletteSize: opaqueSize, transparentIndex: image.transparentIndex, runTolerance };
  const starts = stripeStarts(width, height, stripes);
  starts.forEach((from, k) => runMapStripe(task, { from, to: k + 1 < starts.length ? starts[k + 1] : indices.length }));
  runRepairStripes(task, starts.slice(1));
  return indices;
}

function serialMap(pixels: Uint8Array, width: number, height: number, image: IndexedImage, runTolerance: number): Uint8Array {
  const opaqueSize = image.transparentIndex >= 0 ? image.transparentIndex : image.paletteSize;
  return mapToPalette(pixels, width, height, image.palette, opaqueSize, 'none', image.transparentIndex, runTolerance);
}

afterAll(async () => {
  await shutdownCpuPool();
});

describe('stripe boundaries', () => {
  it('start at whole rows, cover every row once and never make an empty stripe', () => {
    for (const [width, height, stripes] of [[10, 100, 4], [7, 5, 16], [1, 1, 3], [64, 3, 3], [5, 1000, 7]]) {
      const starts = stripeStarts(width, height, stripes);
      expect(starts[0]).toBe(0);
      expect(starts.length).toBe(Math.min(stripes, height));
      for (let k = 0; k < starts.length; k += 1) {
        expect(starts[k] % width).toBe(0);
        if (k > 0) expect(starts[k]).toBeGreaterThan(starts[k - 1]);
      }
      expect(starts[starts.length - 1]).toBeLessThan(width * height);
    }
  });
});

describe('the palette mapper in stripes', () => {
  const cases: Array<{ name: string; width: number; height: number; shape: Shape; colours: number }> = [
    { name: 'a noisy photograph', width: 160, height: 120, shape: { holes: 0, noise: 24 }, colours: 256 },
    { name: 'a noisy photograph with transparent runs', width: 160, height: 120, shape: { holes: 0.004, noise: 24 }, colours: 200 },
    { name: 'a smooth picture of long runs', width: 160, height: 120, shape: { holes: 0, noise: 2 }, colours: 64 },
    { name: 'a smooth picture with transparent runs longer than a row', width: 97, height: 83, shape: { holes: 0.01, noise: 3 }, colours: 32 },
    { name: 'a picture that is mostly transparent', width: 50, height: 90, shape: { holes: 0.2, noise: 10 }, colours: 16 },
    // A stripe starts where the row before it ended only in a picture so narrow that the end of a row is next to the start of the next.
    { name: 'a column of pixels', width: 1, height: 3000, shape: { holes: 0, noise: 30 }, colours: 8 },
    { name: 'a column of pixels with transparent runs', width: 2, height: 1500, shape: { holes: 0.01, noise: 30 }, colours: 8 },
    { name: 'a picture three pixels wide', width: 3, height: 1000, shape: { holes: 0.003, noise: 16 }, colours: 6 },
  ];
  for (const { name, width, height, shape, colours } of cases) {
    const pixels = picture(width, height, shape, width * 31 + height);
    const image = palettedBy(pixels, width, height, colours);
    for (const runTolerance of [0, 0.25, 1, 4]) {
      it(`gives the indices of the one-pass mapper for ${name} at tolerance ${runTolerance}, for 1 to 64 stripes`, () => {
        const expected = serialMap(pixels, width, height, image, runTolerance);
        for (const stripes of [1, 2, 3, 4, 7, 16, 64]) {
          const actual = mapInStripes(pixels, width, height, image, runTolerance, stripes);
          expect(Buffer.from(actual).equals(Buffer.from(expected)), `${stripes} stripes`).toBe(true);
        }
      });
    }
  }

  it('repairs a stripe that starts in a long run of one colour (the colour before it is the only thing that differs)', () => {
    // Rows of one colour that is nearly as far from one palette colour as from another: a stripe that starts inside a run keeps the colour
    // the stripe before it ended on, and must follow it through the whole run.
    const width = 40;
    const height = 8;
    const pixels = new Uint8Array(width * height * RGBA).fill(255);
    for (let p = 0; p < width * height; p += 1) {
      const row = Math.floor(p / width);
      const colour = row < 4 ? [200, 60, 60] : row < 6 ? [201, 61, 60] : [60, 60, 200];
      pixels.set(colour, p * RGBA);
    }
    const image = palettedBy(pixels, width, height, 3);
    for (const runTolerance of [0.05, 0.25, 1]) {
      const expected = serialMap(pixels, width, height, image, runTolerance);
      for (const stripes of [2, 4, 8]) expect(Buffer.from(mapInStripes(pixels, width, height, image, runTolerance, stripes)).equals(Buffer.from(expected))).toBe(true);
    }
  });

  it('does not depend on how the picture is cut: every cut of one raster gives one answer', () => {
    const width = 120;
    const height = 70;
    const pixels = picture(width, height, { holes: 0.003, noise: 30 }, 7);
    const image = palettedBy(pixels, width, height, 128);
    const answers = new Set<string>();
    for (let stripes = 1; stripes <= 70; stripes += 1) answers.add(Buffer.from(mapInStripes(pixels, width, height, image, 0.25, stripes)).toString('base64'));
    expect(answers.size).toBe(1);
  });
});

describe('quantizeImageAsync of a large picture, mapped in stripes on the pool', () => {
  it('gives the palette and indices of the one-pass quantizer', async () => {
    const width = 1700;
    const height = Math.ceil(STRIPED_MIN_PIXELS / width) + 5;
    const pixels = picture(width, height, { holes: 0.00002, noise: 40 }, 99);
    const expected = quantizeImage(pixels.slice(), width, height, 256, { dither: 'none', transparency: 'threshold', runTolerance: 0.25 });
    const actual = await quantizeImageAsync(pixels, width, height, 256, { dither: 'none', transparency: 'threshold', runTolerance: 0.25 });
    expect(actual.paletteSize).toBe(expected.paletteSize);
    expect(actual.transparentIndex).toBe(expected.transparentIndex);
    expect(Buffer.from(actual.palette).equals(Buffer.from(expected.palette))).toBe(true);
    expect(Buffer.from(actual.indices).equals(Buffer.from(expected.indices))).toBe(true);
  }, 120_000);
});
