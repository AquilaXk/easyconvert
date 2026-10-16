import sharp, { type Sharp } from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { convertImage } from '../src/lib/conversions/image';
import { alphaIsOpaquePlane, decodePlainPngOnce, isPlainPng, type DecodedPng } from '../src/lib/conversions/image-decoded-source';
import { classifyContent, classifyRaster, type ContentClass } from '../src/lib/conversions/image-content';
import { flattenColour } from '../src/lib/conversions/image-background';
import { jpegOptionsFor, webpOptionsFor } from '../src/lib/conversions/image-encoder-defaults';
import { pipelineRuns } from './helpers/pipeline-runs';
import { srgbProfileChunk, textChunk, withChunksAfterHeader } from './helpers/png-chunks';

const WIDTH = 96;
const HEIGHT = 64;
const NOISE_MULTIPLIER = 2654435761;

function noise(index: number): number {
  return (Math.imul(index + 1, NOISE_MULTIPLIER) >>> 24) & 0xff;
}

/** A picture with flat areas, gradients and noise, in 8 or 16 bits, with 1 to 4 bands, as a PNG. */
async function png(channels: 1 | 2 | 3 | 4, deep: boolean, build: (image: Sharp) => Sharp = (image) => image, opaqueAlpha = false): Promise<Buffer> {
  const samples = WIDTH * HEIGHT * channels;
  const data = deep ? new Uint16Array(samples) : new Uint8Array(samples);
  for (let i = 0; i < samples; i += 1) {
    const pixel = Math.floor(i / channels);
    const band = i % channels;
    const isAlpha = (channels === 2 || channels === 4) && band === channels - 1;
    const value = isAlpha ? 255 - (pixel % 97 === 0 && !opaqueAlpha ? 40 : 0) : pixel % 7 < 3 ? 200 : noise(pixel + band);
    data[i] = deep ? value * 257 : value;
  }
  // The library writes a colour PNG from one or two bands unless the picture is declared grey first.
  const picture = sharp(data, { raw: { width: WIDTH, height: HEIGHT, channels } });
  return build(channels < 3 ? picture.toColourspace(deep ? 'grey16' : 'b-w') : picture).png().toBuffer();
}

const PLAIN_PNGS: Array<[string, () => Promise<Buffer>]> = [
  ['8-bit grey', () => png(1, false)],
  ['8-bit colour', () => png(3, false)],
  ['8-bit colour with alpha', () => png(4, false)],
  ['16-bit grey', () => png(1, true, (image) => image.toColourspace('grey16'))],
  ['16-bit grey with alpha', () => png(2, true, (image) => image.toColourspace('grey16'))],
  ['16-bit colour', () => png(3, true, (image) => image.toColourspace('rgb16'))],
  ['16-bit colour with alpha', () => png(4, true, (image) => image.toColourspace('rgb16'))],
  ['palette', async () => sharp(await png(3, false)).png({ palette: true, colours: 16 }).toBuffer()],
];

describe('decodePlainPngOnce', () => {
  it.each(PLAIN_PNGS)('%s: the decoded pipeline has the PNG pipeline\'s colourspace, bands and depth, and writes the same bytes', async (_name, make) => {
    const source = await make();
    const decoded = await decodePlainPngOnce(sharp(source));
    expect(decoded).not.toBeNull();
    const [fromPng, fromRaw] = [await sharp(source).metadata(), await (decoded as DecodedPng).pipeline.metadata()];
    expect([fromRaw.space, fromRaw.channels, fromRaw.depth, fromRaw.width, fromRaw.height, fromRaw.hasAlpha]).toEqual([
      fromPng.space,
      fromPng.channels,
      fromPng.depth,
      fromPng.width,
      fromPng.height,
      fromPng.hasAlpha,
    ]);
    const encoders: Array<[string, (image: Sharp) => Promise<Buffer>]> = [
      ['jpeg', (image) => image.flatten({ background: '#fff' }).jpeg({ quality: 70, mozjpeg: true }).toBuffer()],
      ['webp', (image) => image.webp({ quality: 70, effort: 4 }).toBuffer()],
      ['avif', (image) => image.avif({ quality: 50, effort: 0 }).toBuffer()],
      ['png', (image) => image.png().toBuffer()],
    ];
    for (const [name, encode] of encoders) {
      const expected = await encode(sharp(source));
      const actual = await encode(((await decodePlainPngOnce(sharp(source))) as DecodedPng).pipeline);
      expect(actual.equals(expected), `${name} from decoded pixels equals ${name} from the PNG`).toBe(true);
    }
  });

  it('reports whether the alpha plane is opaque, at 8 and 16 bits, and nothing for a picture without one', async () => {
    const alphaOf = async (source: Buffer): Promise<boolean | undefined> => ((await decodePlainPngOnce(sharp(source))) as DecodedPng).alphaIsOpaque;
    expect(await alphaOf(await png(4, false, (image) => image, true))).toBe(true);
    expect(await alphaOf(await png(4, false))).toBe(false);
    expect(await alphaOf(await png(2, true, (image) => image.toColourspace('grey16'), true))).toBe(true);
    expect(await alphaOf(await png(2, true, (image) => image.toColourspace('grey16')))).toBe(false);
    expect(await alphaOf(await png(3, false))).toBeUndefined();
    expect(await alphaOf(await png(1, false))).toBeUndefined();
    expect(await alphaOf(await png(1, true, (image) => image.toColourspace('grey16')))).toBeUndefined();
  });

  it('leaves an 8-bit grey picture with alpha to the encoder: the library drops its alpha band when it writes it as raw grey', async () => {
    const source = await png(2, false);
    const meta = await sharp(source).metadata();
    expect([meta.space, meta.channels, meta.hasAlpha]).toEqual(['b-w', 2, true]);
    expect(isPlainPng(meta)).toBe(false);
    expect(await decodePlainPngOnce(sharp(source))).toBeNull();
  });

  it('leaves a PNG with a colour profile, EXIF, a custom density or an orientation to the encoder, which would lose them in raw pixels', async () => {
    const base = sharp(await png(3, false));
    const withProfile = await base.clone().withIccProfile('p3').png().toBuffer();
    const withExif = await base.clone().withExif({ IFD0: { Copyright: 'x' } }).png().toBuffer();
    const withDensity = await base.clone().withMetadata({ density: 300 }).png().toBuffer();
    const withOrientation = await base.clone().withMetadata({ orientation: 6 }).png().toBuffer();
    for (const [name, source] of [['profile', withProfile], ['exif', withExif], ['density', withDensity], ['orientation', withOrientation]] as const) {
      const meta = await sharp(source).metadata();
      expect(isPlainPng(meta), name).toBe(false);
      expect(await decodePlainPngOnce(sharp(source)), name).toBeNull();
    }
  });

  it.each([
    ['16-bit colour', 3],
    ['16-bit colour with alpha', 4],
  ] as const)('%s: decoded for an 8-bit encoder, the pipeline and the raster hold the high byte of every sample', async (_name, channels) => {
    const source = await png(channels, true, (image) => image.toColourspace('rgb16'));
    const wide = (await decodePlainPngOnce(sharp(source))) as DecodedPng;
    const narrow = (await decodePlainPngOnce(sharp(source), undefined, true)) as DecodedPng;
    expect(wide.raster.samples).toBeInstanceOf(Uint16Array);
    expect(narrow.raster.samples).toBeInstanceOf(Uint8Array);
    expect(narrow.raster.samples).not.toBeInstanceOf(Uint16Array);
    expect([narrow.raster.width, narrow.raster.height, narrow.raster.channels]).toEqual([wide.raster.width, wide.raster.height, wide.raster.channels]);
    expect(Array.from(narrow.raster.samples)).toEqual(Array.from(wide.raster.samples, (sample) => sample >> 8));
    const meta = await narrow.pipeline.metadata();
    expect([meta.space, meta.depth, meta.channels]).toEqual(['srgb', 'uchar', channels]);
    expect(narrow.alphaIsOpaque).toBe(channels === 4 ? false : undefined);
  });

  it('reads the alpha plane of a picture decoded to 8 bits at 8 bits: a sample whose high byte is full is opaque', async () => {
    const samples = new Uint16Array(WIDTH * HEIGHT * 4).fill(0x8000);
    for (let at = 3; at < samples.length; at += 4) samples[at] = 0xff80;
    const source = await sharp(samples, { raw: { width: WIDTH, height: HEIGHT, channels: 4 } }).toColourspace('rgb16').png().toBuffer();
    expect((await decodePlainPngOnce(sharp(source)))?.alphaIsOpaque).toBe(false);
    expect((await decodePlainPngOnce(sharp(source), undefined, true))?.alphaIsOpaque).toBe(true);
  });

  it.each(PLAIN_PNGS.filter(([name]) => !name.startsWith('16-bit colour')))('%s: is decoded as it is whatever the encoder', async (_name, make) => {
    const source = await make();
    const wide = (await decodePlainPngOnce(sharp(source))) as DecodedPng;
    const narrow = (await decodePlainPngOnce(sharp(source), undefined, true)) as DecodedPng;
    expect(narrow.raster.samples.constructor).toBe(wide.raster.samples.constructor);
    expect(Array.from(narrow.raster.samples)).toEqual(Array.from(wide.raster.samples));
  });

  it('leaves a JPEG, which the decoder can read at a reduced size, and a PNG over the memory cap alone', async () => {
    const jpeg = await sharp(await png(3, false)).jpeg().toBuffer();
    expect(await decodePlainPngOnce(sharp(jpeg))).toBeNull();
    const source = await png(3, false);
    expect(await decodePlainPngOnce(sharp(source), WIDTH * HEIGHT * 3 - 1)).toBeNull();
    expect(await decodePlainPngOnce(sharp(source), WIDTH * HEIGHT * 3)).not.toBeNull();
  });

  it('refuses a picture over the input pixel limit while decoding', async () => {
    const source = await png(3, false);
    await expect(decodePlainPngOnce(sharp(source, { limitInputPixels: WIDTH * HEIGHT - 1 }))).rejects.toThrow(/pixel/i);
  });
});

describe('convertImage on a plain PNG', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(['jpg', 'webp', 'avif'])('inflates the PNG once for %s: the content class, the alpha check and the encoder read the decoded pixels', async (target) => {
    expect((await pipelineRuns(await png(4, false), target)).pngReads).toBe(1);
  });

  it.each(['jpg', 'avif'])('inflates a PNG with text chunks and an sRGB profile once for %s: nothing in them reaches the output', async (target) => {
    const source = withChunksAfterHeader(await png(3, false), [srgbProfileChunk(), textChunk()]);
    const meta = await sharp(source).metadata();
    expect([meta.hasProfile, meta.comments?.length]).toEqual([true, 1]);
    expect((await pipelineRuns(source, target)).pngReads).toBe(1);
  });

  it('leaves a PNG with a wide-gamut profile, which the output carries, to the encoder', async () => {
    const source = await sharp(await png(3, false)).withIccProfile('p3').png().toBuffer();
    expect((await pipelineRuns(source, 'jpg')).pngReads).toBeGreaterThan(1);
  });

  /** Sample depths asked of the raw output by a conversion: the decode of the PNG is the first raw read, and the WebP path makes none. */
  async function rawDepths(source: Buffer, target: string): Promise<unknown[]> {
    const proto = Object.getPrototypeOf(sharp({ create: { width: 1, height: 1, channels: 3, background: '#000' } })) as Sharp;
    const raw = proto.raw;
    const depths: unknown[] = [];
    vi.spyOn(proto, 'raw').mockImplementation(function (this: Sharp, ...args: unknown[]) {
      depths.push((args[0] as { depth?: unknown } | undefined)?.depth);
      return (raw as (...a: unknown[]) => Sharp).apply(this, args);
    } as never);
    try {
      await convertImage(source, target, { quality: 70 }, 'plain.png', 'png');
    } finally {
      vi.restoreAllMocks();
    }
    return depths;
  }

  it('decodes a 16-bit colour PNG once at 16-bit samples for AVIF: the encoder takes them all', async () => {
    const source = await png(4, true, (image) => image.toColourspace('rgb16'));
    expect((await rawDepths(source, 'avif'))[0]).toBe('ushort');
  });

  it.each(['jpg', 'jpeg'])('decodes a 16-bit colour PNG with an opaque alpha plane once at 16-bit samples for %s: the content class reads their tones, and the encoder reduces them', async (target) => {
    const source = await png(4, true, (image) => image.toColourspace('rgb16'), true);
    expect(await rawDepths(source, target)).toEqual(['ushort']);
  });

  it.each(['jpg', 'jpeg'])('decodes a 16-bit colour PNG with a translucent sample again at 8 bits for %s: the flatten works on the 8-bit levels', async (target) => {
    const source = await png(4, true, (image) => image.toColourspace('rgb16'));
    expect(await rawDepths(source, target)).toEqual(['ushort', 'uchar']);
  });

  it('decodes a 16-bit colour PNG that is resized for JPEG once at 8 bits: the resize works on the 8-bit levels', async () => {
    const source = await png(4, true, (image) => image.toColourspace('rgb16'), true);
    const proto = Object.getPrototypeOf(sharp({ create: { width: 1, height: 1, channels: 3, background: '#000' } })) as Sharp;
    const raw = proto.raw;
    const depths: unknown[] = [];
    vi.spyOn(proto, 'raw').mockImplementation(function (this: Sharp, ...args: unknown[]) {
      depths.push((args[0] as { depth?: unknown } | undefined)?.depth);
      return (raw as (...a: unknown[]) => Sharp).apply(this, args);
    } as never);
    try {
      await convertImage(source, 'jpg', { quality: 70, width: 48 }, 'plain.png', 'png');
    } finally {
      vi.restoreAllMocks();
    }
    expect(depths).toEqual(['uchar']);
  });

  it('decodes a 16-bit colour PNG for WebP without a raw read: the encoder reads the PNG itself', async () => {
    const source = await png(4, true, (image) => image.toColourspace('rgb16'));
    expect(await rawDepths(source, 'webp')).toEqual([]);
  });

  it.each([
    ['jpg', (image: Sharp, content: ContentClass) => image.pipelineColourspace('srgb').flatten({ background: flattenColour(undefined) }).jpeg(jpegOptionsFor(70, content))],
    ['webp', (image: Sharp) => image.webp(webpOptionsFor(70))],
  ] as const)('writes the same %s as the encoder reading the PNG itself, for a 16-bit picture with translucent pixels', async (target, encode) => {
    const source = await png(4, true, (image) => image.toColourspace('rgb16'));
    const converted = (await convertImage(source, target, { quality: 70 }, 'plain.png', 'png')).buffer;
    const content = await classifyContent(sharp(source));
    const direct = await encode(sharp(source), content).toBuffer();
    expect(converted.equals(direct)).toBe(true);
  });

  it('takes whether the alpha plane is opaque from the decoded pixels for JPEG, and hands a PNG to the WebP encoder as it is: the encoder drops an opaque alpha plane itself', async () => {
    const opaque = await png(4, false, (image) => image, true);
    expect((await pipelineRuns(opaque, 'webp')).all).toBe(1);
    expect((await pipelineRuns(opaque, 'jpg')).all).toBe(2);
  });

  it.each([
    ['8-bit colour', () => png(4, false, (image) => image, true)],
    ['16-bit colour', () => png(4, true, (image) => image.toColourspace('rgb16'), true)],
    ['8-bit grey', () => png(2, false, (image) => image, true)],
    ['16-bit grey', () => png(2, true, (image) => image.toColourspace('grey16'), true)],
  ] as const)('writes a WebP of a PNG with an opaque alpha plane that is the WebP of the PNG without it (%s)', async (_name, make) => {
    const source = await make();
    const converted = (await convertImage(source, 'webp', { quality: 70 }, 'opaque.png', 'png')).buffer;
    const withoutAlpha = await sharp(source).removeAlpha().webp(webpOptionsFor(70)).toBuffer();
    expect(converted.equals(withoutAlpha)).toBe(true);
  });

  it('drops an alpha plane that is opaque and keeps one that is not, at 8 and 16 bits and with a resize', async () => {
    const sources: Array<[string, Buffer, boolean]> = [
      ['8-bit opaque', await png(4, false, (image) => image, true), false],
      ['8-bit translucent', await png(4, false), true],
      ['16-bit opaque', await png(4, true, (image) => image.toColourspace('rgb16'), true), false],
      ['16-bit one step below full', await png(4, true, (image) => image.toColourspace('rgb16')), true],
      ['grey with opaque alpha', await png(2, false, (image) => image, true), false],
      ['16-bit grey with translucent alpha', await png(2, true), true],
    ];
    for (const [name, source, keepsAlpha] of sources) {
      for (const options of [{}, { width: 48 }]) {
        const converted = (await convertImage(source, 'webp', { quality: 70, ...options }, 'a.png', 'png')).buffer;
        expect((await sharp(converted).metadata()).hasAlpha, `${name} ${JSON.stringify(options)}`).toBe(keepsAlpha);
      }
    }
  });

  it.each(PLAIN_PNGS)('%s: the raster is the decoded samples the pipeline reads', async (_name, make) => {
    const source = await make();
    const decoded = (await decodePlainPngOnce(sharp(source))) as DecodedPng;
    const meta = await sharp(source).metadata();
    const { raster } = decoded;
    expect([raster.width, raster.height, raster.channels]).toEqual([meta.width, meta.height, meta.channels]);
    expect(raster.samples.length).toBe(raster.width * raster.height * raster.channels);
    expect(raster.samples instanceof Uint16Array).toBe(meta.depth === 'ushort');
    const reread = await decoded.pipeline.toColourspace(meta.space as string).raw({ depth: meta.depth === 'ushort' ? 'ushort' : 'uchar' }).toBuffer();
    expect(Buffer.from(reread).equals(Buffer.from(raster.samples.buffer, raster.samples.byteOffset, raster.samples.byteLength))).toBe(true);
  });

  /** Pixels of a JPEG as the library decodes it. */
  const pixelsOf = async (jpeg: Buffer): Promise<Buffer> => sharp(jpeg).raw().toBuffer();

  it.each([
    ['8-bit colour with opaque alpha', () => png(4, false, (image) => image, true), 0],
    ['16-bit colour with opaque alpha', () => png(4, true, (image) => image.toColourspace('rgb16'), true), 0],
    ['8-bit grey with opaque alpha', () => png(2, false, (image) => image, true), 1],
    ['16-bit grey with opaque alpha', () => png(2, true, (image) => image.toColourspace('grey16'), true), 1],
  ] as const)('%s: dropping the alpha band writes the pixels flattening onto white writes (within %i step)', async (_name, make, tolerance) => {
    const source = await make();
    const converted = (await convertImage(source, 'jpg', { quality: 70 }, 'opaque.png', 'png')).buffer;
    const content = await classifyContent(sharp(source));
    const grey = (await sharp(source).metadata()).channels === 2;
    const flattened = sharp(source).pipelineColourspace('srgb').flatten({ background: flattenColour(undefined) });
    const direct = await (grey ? flattened.toColourspace('b-w') : flattened).jpeg(jpegOptionsFor(70, content, grey)).toBuffer();
    const [a, b] = [await pixelsOf(converted), await pixelsOf(direct)];
    expect(a.length).toBe(b.length);
    let largest = 0;
    for (let i = 0; i < a.length; i += 1) largest = Math.max(largest, Math.abs(a[i] - b[i]));
    expect(largest).toBeLessThanOrEqual(tolerance);
  });

  it('drops the alpha band of an unresized picture without a background, and flattens one that is resized or given a background', async () => {
    const source = await png(4, false, (image) => image, true);
    const proto = Object.getPrototypeOf(sharp({ create: { width: 1, height: 1, channels: 3, background: '#000' } })) as Sharp;
    const calls = async (options: Record<string, unknown>): Promise<{ flatten: number; removeAlpha: number }> => {
      const counts = { flatten: 0, removeAlpha: 0 };
      for (const name of ['flatten', 'removeAlpha'] as const) {
        const original = proto[name] as (...args: unknown[]) => Sharp;
        vi.spyOn(proto, name).mockImplementation(function (this: Sharp, ...args: unknown[]) {
          counts[name] += 1;
          return original.apply(this, args);
        } as never);
      }
      await convertImage(source, 'jpg', { quality: 70, ...options }, 'opaque.png', 'png');
      vi.restoreAllMocks();
      return counts;
    };
    expect(await calls({})).toEqual({ flatten: 0, removeAlpha: 1 });
    expect(await calls({ width: 48 })).toEqual({ flatten: 1, removeAlpha: 0 });
    expect(await calls({ background: '#ff0000' })).toEqual({ flatten: 1, removeAlpha: 0 });
  });

  it('reports a truncated PNG as an undecodable image', async () => {
    const source = await png(3, false);
    await expect(convertImage(source.subarray(0, source.length - 40), 'jpg', {}, 'cut.png', 'png')).rejects.toThrow(/Invalid image|could not be decoded|premature|truncated/i);
  });
});

describe('alphaIsOpaquePlane', () => {
  const LAYOUTS = [
    { name: '8-bit colour with alpha', channels: 4, make: (samples: number) => new Uint8Array(samples), maximum: 0xff },
    { name: '16-bit grey with alpha', channels: 2, make: (samples: number) => new Uint16Array(samples), maximum: 0xffff },
    { name: '16-bit colour with alpha', channels: 4, make: (samples: number) => new Uint16Array(samples), maximum: 0xffff },
  ] as const;
  const PIXELS = 37;

  /** Opaque everywhere, colour samples all zero: only the alpha plane decides. */
  function opaque(layout: (typeof LAYOUTS)[number]): Uint8Array | Uint16Array {
    const samples = layout.make(PIXELS * layout.channels);
    for (let at = layout.channels - 1; at < samples.length; at += layout.channels) samples[at] = layout.maximum;
    return samples;
  }

  describe.each(LAYOUTS)('$name', (layout) => {
    it('is opaque when every alpha sample is the maximum, whatever the colour samples hold', () => {
      expect(alphaIsOpaquePlane(opaque(layout), layout.channels)).toBe(true);
    });

    it.each([0, 1, 18, PIXELS - 2, PIXELS - 1])('is not opaque when the alpha sample of pixel %i is one below the maximum', (pixel) => {
      const samples = opaque(layout);
      samples[pixel * layout.channels + layout.channels - 1] = layout.maximum - 1;
      expect(alphaIsOpaquePlane(samples, layout.channels)).toBe(false);
    });

    it('is not opaque when only the high byte of a 16-bit alpha sample is short of the maximum', () => {
      const samples = opaque(layout);
      samples[20 * layout.channels + layout.channels - 1] = layout.maximum === 0xffff ? 0xfeff : 0x7f;
      expect(alphaIsOpaquePlane(samples, layout.channels)).toBe(false);
    });

    it('does not take a colour sample for an alpha sample', () => {
      const samples = opaque(layout);
      for (let at = 0; at < samples.length; at += layout.channels) samples[at] = 0;
      expect(alphaIsOpaquePlane(samples, layout.channels)).toBe(true);
      samples[layout.channels * 5 + layout.channels - 1] = 0;
      expect(alphaIsOpaquePlane(samples, layout.channels)).toBe(false);
    });
  });

  it('reads samples that start on an odd 16-bit offset as they are', () => {
    const bytes = new Uint8Array(2 + PIXELS * 4 * 2);
    const samples = new Uint16Array(bytes.buffer, 2, PIXELS * 4);
    for (let at = 3; at < samples.length; at += 4) samples[at] = 0xffff;
    expect(alphaIsOpaquePlane(samples, 4)).toBe(true);
    samples[PIXELS * 4 - 1] = 0xfffe;
    expect(alphaIsOpaquePlane(samples, 4)).toBe(false);
  });

  it('refuses a pixel that is not a whole number of words instead of guessing', () => {
    expect(() => alphaIsOpaquePlane(new Uint8Array(8), 2)).toThrow(RangeError);
  });
});
