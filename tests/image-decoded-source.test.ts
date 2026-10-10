import sharp, { type Sharp } from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { convertImage } from '../src/lib/conversions/image';
import { decodePlainPngOnce, isPlainPng, type DecodedPng } from '../src/lib/conversions/image-decoded-source';
import { classifyContent, classifyRaster, type ContentClass } from '../src/lib/conversions/image-content';
import { flattenColour } from '../src/lib/conversions/image-background';
import { jpegOptionsFor, webpOptionsFor } from '../src/lib/conversions/image-encoder-defaults';

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

  /** Native pipeline runs (`toBuffer`) a conversion makes, and how many of them read the PNG itself rather than pixels in memory. */
  async function pipelineRuns(source: Buffer, target: string, options: Record<string, unknown> = {}): Promise<{ all: number; pngReads: number }> {
    const proto = Object.getPrototypeOf(sharp({ create: { width: 1, height: 1, channels: 3, background: '#000' } })) as Sharp;
    const toBuffer = proto.toBuffer;
    const runs = { all: 0, pngReads: 0 };
    vi.spyOn(proto, 'toBuffer').mockImplementation(function (this: Sharp, ...args: unknown[]) {
      const input = (this as unknown as { options: { input: { buffer?: Buffer } } }).options.input;
      runs.all += 1;
      // A cloned pipeline holds a copy of the input, so the PNG is recognised by its bytes.
      if (input.buffer !== undefined && Buffer.from(input.buffer).equals(source)) runs.pngReads += 1;
      return (toBuffer as (...a: unknown[]) => Promise<unknown>).apply(this, args);
    } as never);
    await convertImage(source, target, { quality: 70, ...options }, 'plain.png', 'png');
    vi.restoreAllMocks();
    return runs;
  }

  it.each(['jpg', 'webp', 'avif'])('inflates the PNG once for %s: the content class, the alpha check and the encoder read the decoded pixels', async (target) => {
    expect((await pipelineRuns(await png(4, false), target)).pngReads).toBe(1);
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

  it('takes whether the alpha plane is opaque from the decoded pixels, and WebP needs no content class: a WebP is the decode and the encode, nothing more', async () => {
    const opaque = await png(4, false, (image) => image, true);
    expect((await pipelineRuns(opaque, 'webp')).all).toBe(2);
    expect((await pipelineRuns(opaque, 'jpg')).all).toBe(2);
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
