import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { withLegacyDdsPixelFormat } from '../src/lib/conversions/image-dds-header';
import { findMagick } from '../src/lib/conversions/image-magick-cli';
import { decodeRgba } from './helpers/image-pixels';
import { requireRealworldSample } from './helpers/realworld-sample';
import { skipUnless } from './helpers/strict-skip';

/**
 * DDS files whose pixel format sits in the DX10 extension header (#783). ImageMagick 7.1.1 reads the DX10 R8G8B8A8_UNORM
 * and BC7 files but refuses R8G8B8A8_UNORM_SRGB ("image type not supported"), and ImageMagick 6 refuses every DX10 file. The
 * uncompressed 8-bit formats are handed over under the legacy header the DDS guide defines for the same bytes.
 *
 * The expected pixels are the ones Pillow 11.1.0 decodes (`Image.open(file).convert('RGBA').tobytes()`, run on Debian 13 with
 * `python3 -I`), as SHA-256 digests of the RGBA bytes; the output is a lossless PNG, so the tolerance is zero. The two
 * small files are a two-colour pattern (128 transparent white and 128 opaque black pixels) and cannot tell red from blue, so
 * the channel order is judged on the 256 x 256 picture, whose files below are derived from it by changing the header or swapping its channels.
 */

const needsMagick = skipUnless('ImageMagick (magick or convert)', findMagick() !== null);

const PICTURE = 'pil-argb-32bpp_mipmaps-1.dds';
const PICTURE_DIGEST = 'c7f63f8b9976a6734517397bf54f2b167fcfbac984a8ae4dccf2a7d49b602dd1';
const TWO_COLOUR_SRGB = 'pil-dxgi_format_r8g8b8a8_unorm_srgb.dds';
const BC7 = 'pil-dxgi_format_bc7_unorm_srgb.dds';
const TWO_COLOUR_DIGEST = '12ac59c4cbaec2c1d85cd2474d72a09b549cbc31cf6eb3ea3bbb1c06049ab37c';

/** DDS file layout: "DDS " and the 124-byte header (pixel format at 76), then the 20-byte DX10 header (DXGI format, resource dimension). */
const FILE_HEADER_BYTES = 128;
const DX10_HEADER_BYTES = 20;
const PIXEL_FORMAT_FLAGS_AT = 80;
const DXGI_FORMAT_AT = FILE_HEADER_BYTES;
const RESOURCE_DIMENSION_AT = FILE_HEADER_BYTES + 4;
const DDPF_RGB_WITH_ALPHA = 0x41;

/** DXGI_FORMAT numbers (Microsoft DXGI_FORMAT enumeration). */
const DXGI = {
  r8g8b8a8Typeless: 27,
  r8g8b8a8Unorm: 28,
  r8g8b8a8UnormSrgb: 29,
  r16g16b16a16Unorm: 11,
  b8g8r8a8Unorm: 87,
  b8g8r8a8Typeless: 90,
  b8g8r8a8UnormSrgb: 91,
} as const;
const RESOURCE_TEXTURE_3D = 4;

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

async function pngDigest(dds: Buffer): Promise<{ width: number; height: number; digest: string }> {
  const decoded = await decodeRgba((await dispatchConversion(dds, 'dds', 'png', {}, 'texture.dds')).buffer);
  return { width: decoded.width, height: decoded.height, digest: sha256(decoded.data) };
}

function withDxgiFormat(dds: Buffer, format: number): Buffer {
  const derived = Buffer.from(dds);
  derived.writeUInt32LE(format, DXGI_FORMAT_AT);
  return derived;
}

/** The same picture with red and blue exchanged in every pixel of the surface, stored as B8G8R8A8. */
function withSwappedRedAndBlue(dds: Buffer, format: number): Buffer {
  const derived = withDxgiFormat(dds, format);
  for (let at = FILE_HEADER_BYTES + DX10_HEADER_BYTES; at + 2 < derived.length; at += 4) {
    [derived[at], derived[at + 2]] = [derived[at + 2], derived[at]];
  }
  return derived;
}

describe.skipIf(needsMagick)('DDS files with a DX10 header', () => {
  it('converts the R8G8B8A8_UNORM_SRGB file to the pixels Pillow decodes', { timeout: 60_000 }, async (ctx) => {
    const sample = await requireRealworldSample(ctx, TWO_COLOUR_SRGB);
    expect(await pngDigest(sample.bytes)).toEqual({ width: 16, height: 16, digest: TWO_COLOUR_DIGEST });
    expect((await decodeRgba((await dispatchConversion(sample.bytes, 'dds', 'jpg', {}, 'texture.dds')).buffer)).width).toBe(16);
  });

  it('converts the R8G8B8A8_UNORM picture with mipmap data to the pixels Pillow decodes', { timeout: 60_000 }, async (ctx) => {
    const sample = await requireRealworldSample(ctx, PICTURE);
    expect(await pngDigest(sample.bytes)).toEqual({ width: 256, height: 256, digest: PICTURE_DIGEST });
  });

  it.for([
    ['R8G8B8A8_TYPELESS', DXGI.r8g8b8a8Typeless],
    ['R8G8B8A8_UNORM_SRGB', DXGI.r8g8b8a8UnormSrgb],
  ] as const)('reads the bytes of a %s file as red, green, blue, alpha', { timeout: 60_000 }, async ([, format], ctx) => {
    const sample = await requireRealworldSample(ctx, PICTURE);
    expect((await pngDigest(withDxgiFormat(sample.bytes, format))).digest).toBe(PICTURE_DIGEST);
  });

  it.for([
    ['B8G8R8A8_UNORM', DXGI.b8g8r8a8Unorm],
    ['B8G8R8A8_TYPELESS', DXGI.b8g8r8a8Typeless],
    ['B8G8R8A8_UNORM_SRGB', DXGI.b8g8r8a8UnormSrgb],
  ] as const)('reads the bytes of a %s file as blue, green, red, alpha', { timeout: 60_000 }, async ([, format], ctx) => {
    const sample = await requireRealworldSample(ctx, PICTURE);
    expect((await pngDigest(withSwappedRedAndBlue(sample.bytes, format))).digest).toBe(PICTURE_DIGEST);
  });

  it('still refuses a DXGI format that is not an 8-bit four-channel one, and a volume texture, with the typed answer', async (ctx) => {
    const sample = await requireRealworldSample(ctx, PICTURE);
    const refusal = { name: 'ConversionFailedError', message: 'Invalid image: the DDS picture could not be decoded' };
    await expect(pngDigest(withDxgiFormat(sample.bytes, DXGI.r16g16b16a16Unorm))).rejects.toMatchObject(refusal);
    const volume = Buffer.from(sample.bytes);
    volume.writeUInt32LE(RESOURCE_TEXTURE_3D, RESOURCE_DIMENSION_AT);
    await expect(pngDigest(volume)).rejects.toMatchObject(refusal);
  });
});

/** Whether the ImageMagick the conversion runs reads the file: version 7.1 reads BC7 (the block format of Direct3D 11), version 6 does not. */
function magickReads(file: string): boolean {
  try {
    execFileSync(findMagick() as string, ['-ping', `dds:${file}`, 'info:'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(needsMagick)('a DDS file with BC7 blocks', () => {
  it('converts to the pixels Pillow decodes where ImageMagick reads BC7', { timeout: 60_000 }, async (ctx) => {
    const sample = await requireRealworldSample(ctx, BC7);
    // skip-ok: the refusal test below runs where this ImageMagick cannot read BC7, so exactly one of the two runs on any machine
    if (!magickReads(sample.path)) ctx.skip();
    expect(await pngDigest(sample.bytes)).toEqual({ width: 16, height: 16, digest: TWO_COLOUR_DIGEST });
  });

  it('is refused with the typed answer where ImageMagick cannot read BC7', async (ctx) => {
    const sample = await requireRealworldSample(ctx, BC7);
    // skip-ok: the conversion test above runs where this ImageMagick reads BC7, so exactly one of the two runs on any machine
    if (magickReads(sample.path)) ctx.skip();
    await expect(pngDigest(sample.bytes)).rejects.toMatchObject({ name: 'ConversionFailedError', message: 'Invalid image: the DDS picture could not be decoded' });
  });
});

describe('the legacy header of a DX10 DDS file', () => {
  it('replaces the DX10 header of an R8G8B8A8 file by the A8R8G8B8 pixel format and exchanges red and blue in the surface', async (ctx) => {
    const sample = await requireRealworldSample(ctx, TWO_COLOUR_SRGB);
    const legacy = withLegacyDdsPixelFormat(sample.bytes);
    expect(legacy.length).toBe(sample.bytes.length - DX10_HEADER_BYTES);
    expect(legacy.subarray(0, 4).toString('ascii')).toBe('DDS ');
    // DDS_PIXELFORMAT of D3DFMT_A8R8G8B8: size 32, flags RGB | ALPHAPIXELS, no FourCC, 32 bits, masks R, G, B, A of the little-endian word.
    expect(Array.from({ length: 8 }, (_, index) => legacy.readUInt32LE(76 + index * 4))).toEqual([32, DDPF_RGB_WITH_ALPHA, 0, 32, 0x00ff0000, 0x0000ff00, 0x000000ff, 0xff000000]);
    expect(legacy.subarray(0, PIXEL_FORMAT_FLAGS_AT - 4)).toEqual(sample.bytes.subarray(0, PIXEL_FORMAT_FLAGS_AT - 4));
    expect(legacy.subarray(FILE_HEADER_BYTES)).toEqual(withSwappedRedAndBlue(sample.bytes, DXGI.r8g8b8a8UnormSrgb).subarray(FILE_HEADER_BYTES + DX10_HEADER_BYTES));
  });

  it('keeps the surface bytes of a B8G8R8A8 file, which already are the A8R8G8B8 layout', async (ctx) => {
    const sample = await requireRealworldSample(ctx, PICTURE);
    const blueFirst = withSwappedRedAndBlue(sample.bytes, DXGI.b8g8r8a8Unorm);
    expect(withLegacyDdsPixelFormat(blueFirst).subarray(FILE_HEADER_BYTES)).toEqual(blueFirst.subarray(FILE_HEADER_BYTES + DX10_HEADER_BYTES));
  });

  it('leaves a BC7 file, a legacy file and bytes that are no DDS file as they are', async (ctx) => {
    const bc7 = (await requireRealworldSample(ctx, 'pil-dxgi_format_bc7_unorm_srgb.dds')).bytes;
    expect(withLegacyDdsPixelFormat(bc7)).toBe(bc7);
    const legacy = Buffer.from(bc7);
    legacy.writeUInt32LE(0, 84);
    expect(withLegacyDdsPixelFormat(legacy)).toBe(legacy);
    const other = Buffer.from('this is not a DDS file at all, but it is longer than a DX10 header');
    expect(withLegacyDdsPixelFormat(other)).toBe(other);
    const cut = (await requireRealworldSample(ctx, TWO_COLOUR_SRGB)).bytes.subarray(0, FILE_HEADER_BYTES + DX10_HEADER_BYTES - 1);
    expect(withLegacyDdsPixelFormat(cut)).toBe(cut);
  });
});
