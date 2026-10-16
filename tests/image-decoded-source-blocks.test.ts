import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import { convertImage } from '../src/lib/conversions/image';
import { isPlainPng } from '../src/lib/conversions/image-decoded-source';
import { type Chunk, serializeChunks } from './helpers/apng-builder';
import { requireOracleTool } from './helpers/differential-oracle';
import { pipelineRuns } from './helpers/pipeline-runs';
import { withChunksAfterHeader, xmpChunk } from './helpers/png-chunks';

/**
 * A plain PNG is decoded once for the encoders that read it more than once. Blocks that the output of the AVIF and JPEG encoders does not
 * change, or that the decoded pipeline writes again exactly as the PNG route does, do not take a picture out of that route: an XMP packet
 * (written again from its text), a background colour (no encoder uses it) and, for AVIF, a print density (an AVIF carries none).
 * Oracles: the encoders' own output compared with the output of the same picture without the block, `exiftool` for the density and the
 * packet a JPEG holds, and the bytes of the packet as the test wrote them.
 */

const WIDTH = 96;
const HEIGHT = 64;
const PACKET = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" dc:creator="Zoë"/></rdf:RDF></x:xmpmeta>';
const TRANSPARENT_BACKGROUND = { type: 'bKGD', data: Buffer.from([0, 7, 0, 255, 0, 13]) };

/** `png` with the density chunk (pixels per metre, unit 1) set to `dpi` dots per inch; the image library writes an EXIF block along with a density, which this does not. */
function withDensityChunk(png: Buffer, dpi: number): Buffer {
  const chunks: Chunk[] = [];
  const perMetre = Buffer.alloc(9);
  perMetre.writeUInt32BE(Math.round(dpi / 0.0254), 0);
  perMetre.writeUInt32BE(Math.round(dpi / 0.0254), 4);
  perMetre[8] = 1;
  for (let at = 8; at < png.length; at += 12 + png.readUInt32BE(at)) {
    const type = png.toString('latin1', at + 4, at + 8);
    chunks.push({ type, data: type === 'pHYs' ? perMetre : png.subarray(at + 8, at + 8 + png.readUInt32BE(at)) });
  }
  return serializeChunks(chunks);
}

/** A coloured picture with flat areas and a gradient, 16-bit or 8-bit, without a block. */
async function picture(deep: boolean, density?: number): Promise<Buffer> {
  const samples = WIDTH * HEIGHT * 3;
  const data = deep ? new Uint16Array(samples) : new Uint8Array(samples);
  for (let i = 0; i < samples; i += 1) {
    const pixel = Math.floor(i / 3);
    const x = pixel % WIDTH;
    const value = x < WIDTH / 2 ? (pixel % 5) * 40 : (x * 2 + (i % 3) * 30) % 256;
    data[i] = deep ? value * 257 : value;
  }
  const image = sharp(data, { raw: { width: WIDTH, height: HEIGHT, channels: 3 } }).toColourspace(deep ? 'rgb16' : 'srgb');
  const written = await image.png().toBuffer();
  return density === undefined ? written : withDensityChunk(written, density);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('which blocks keep a PNG on the decoded route', () => {
  it('lets an XMP packet through: it is written again from its text', async () => {
    const withPacket = withChunksAfterHeader(await picture(false), [xmpChunk(PACKET)]);
    const meta = await sharp(withPacket).metadata();
    expect(meta.xmp?.toString('utf8')).toContain('Zoë');
    expect(isPlainPng(meta)).toBe(true);
  });

  it('keeps a PNG whose XMP packet is not text that survives a round trip through UTF-8 on the route of the PNG', async () => {
    const broken = { type: 'iTXt', data: Buffer.concat([Buffer.from('XML:com.adobe.xmp\0\0\0\0\0', 'latin1'), Buffer.from([0x3c, 0x78, 0xff, 0xfe, 0x3e])]) };
    const meta = await sharp(withChunksAfterHeader(await picture(false), [broken])).metadata();
    expect(meta.xmp).toBeDefined();
    expect(isPlainPng(meta)).toBe(false);
  });

  it('lets a background colour through: no encoder of the route uses it', async () => {
    const meta = await sharp(withChunksAfterHeader(await picture(false), [TRANSPARENT_BACKGROUND])).metadata();
    expect(meta.background).toBeDefined();
    expect(isPlainPng(meta)).toBe(true);
  });

  it('lets a print density through only for an encoder that writes none', async () => {
    const meta = await sharp(await picture(false, 300)).metadata();
    expect(meta.density).toBe(300);
    expect(isPlainPng(meta)).toBe(false);
    expect(isPlainPng(meta, undefined, true)).toBe(true);
  });

  it('still keeps an EXIF block on the route of the PNG', async () => {
    const exif = { type: 'eXIf', data: Buffer.from('MM\0*\0\0\0\b\0\0\0\0\0\0') };
    const meta = await sharp(withChunksAfterHeader(await picture(false), [exif])).metadata();
    expect(meta.exif).toBeDefined();
    expect(isPlainPng(meta)).toBe(false);
  });
});

describe.each([
  ['8-bit', false],
  ['16-bit', true],
] as const)('a %s PNG with a block', (_depth, deep) => {
  it.each(['jpg', 'avif'])('with an XMP packet is read once for %s and the output holds the packet byte for byte', async (target) => {
    const source = withChunksAfterHeader(await picture(deep), [xmpChunk(PACKET)]);
    expect((await pipelineRuns(source, target)).pngReads).toBe(1);
    const out = (await convertImage(source, target, { quality: 70 }, 'x.png', 'png')).buffer;
    expect(out.includes(Buffer.from(PACKET, 'utf8'))).toBe(true);
  });

  it.each(['jpg', 'avif'])('with a background colour is read once for %s and gives the bytes of the picture without it', async (target) => {
    const plain = await picture(deep);
    const source = withChunksAfterHeader(plain, [TRANSPARENT_BACKGROUND]);
    expect((await pipelineRuns(source, target)).pngReads).toBe(1);
    const [withBlock, without] = [await convertImage(source, target, { quality: 70 }, 'x.png', 'png'), await convertImage(plain, target, { quality: 70 }, 'x.png', 'png')];
    expect(withBlock.buffer.equals(without.buffer)).toBe(true);
  });

  it('with a print density is read once for AVIF and gives the bytes of the picture at the default density', async () => {
    const source = await picture(deep, 300);
    expect((await pipelineRuns(source, 'avif')).pngReads).toBe(1);
    const [dense, normal] = [await convertImage(source, 'avif', { quality: 70 }, 'x.png', 'png'), await convertImage(await picture(deep), 'avif', { quality: 70 }, 'x.png', 'png')];
    expect(dense.buffer.equals(normal.buffer)).toBe(true);
  });

  it('with a print density stays on the route of the PNG for JPEG, which writes the density', async () => {
    const source = await picture(deep, 300);
    expect((await pipelineRuns(source, 'jpg')).pngReads).toBeGreaterThan(1);
    const out = (await convertImage(source, 'jpg', { quality: 70 }, 'x.png', 'png')).buffer;
    const dir = mkdtempSync(path.join(os.tmpdir(), 'blocks-'));
    try {
      const file = path.join(dir, 'out.jpg');
      writeFileSync(file, out);
      expect(Math.round(Number(execFileSync(requireOracleTool('exiftool'), ['-s3', '-XResolution', file], { encoding: 'utf-8' })))).toBe(300);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
