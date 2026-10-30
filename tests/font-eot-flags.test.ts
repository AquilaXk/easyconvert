import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { convertFont } from '../src/lib/conversions/font';
import { ConversionFailedError } from '../src/lib/types';
import { requireRealworldSample } from './helpers/realworld-sample';

/**
 * An Embedded OpenType file declares in its header (Flags, offset 12) whether the font data is compressed with MicroType Express
 * (0x4) or XOR-encrypted with 0x50 (0x10000000). The reader took the last FontDataSize bytes for an sfnt whatever the flags said and,
 * when they were not one, made a font of the raw EOT bytes: two IBM Plex Sans Arabic files (compressed) were refused as fonts
 * "with no glyph outlines", which no one could act on. A compressed file is now refused by name, and an XOR-encrypted one is read.
 */

const EOT_LP_SIGNATURE_OFFSET = 34;
const FLAGS_OFFSET = 12;
const XOR_FLAG = 0x10000000;
const XOR_KEY = 0x50;
const sourceFont = fs.readFileSync(path.join(__dirname, 'fixtures', 'woff2', 'dejavu-sans-latin.reference.woff2'));

async function eotOf(): Promise<Buffer> {
  return (await convertFont(sourceFont, 'woff2', 'eot', {}, 'dejavu.woff2')).buffer;
}

describe('the flags of an EOT header', () => {
  it('reads XOR-encrypted font data as the font it hides', async () => {
    const plain = await eotOf();
    const fontDataSize = plain.readUInt32LE(4);
    const hidden = Buffer.from(plain);
    for (let at = hidden.length - fontDataSize; at < hidden.length; at += 1) hidden[at] ^= XOR_KEY;
    hidden.writeUInt32LE(plain.readUInt32LE(FLAGS_OFFSET) | XOR_FLAG, FLAGS_OFFSET);
    const fromPlain = (await convertFont(plain, 'eot', 'ttf', {}, 'plain.eot')).buffer;
    const fromHidden = (await convertFont(hidden, 'eot', 'ttf', {}, 'hidden.eot')).buffer;
    expect(fromHidden.equals(fromPlain)).toBe(true);
  });

  it('refuses MicroType Express compression by name', async () => {
    const compressed = Buffer.from(await eotOf());
    compressed.writeUInt32LE(compressed.readUInt32LE(FLAGS_OFFSET) | 0x4, FLAGS_OFFSET);
    const attempt = convertFont(compressed, 'eot', 'ttf', {}, 'compressed.eot');
    await expect(attempt).rejects.toBeInstanceOf(ConversionFailedError);
    await expect(attempt).rejects.toThrow(/MicroType Express/);
  });

  it('refuses font data that is no sfnt instead of making a font of the file', async () => {
    const damaged = Buffer.from(await eotOf());
    damaged.fill(0x41, damaged.length - damaged.readUInt32LE(4), damaged.length - damaged.readUInt32LE(4) + 64);
    await expect(convertFont(damaged, 'eot', 'ttf', {}, 'damaged.eot')).rejects.toBeInstanceOf(Error);
  });

  it('refuses a file whose declared font data does not fit', async () => {
    const lying = Buffer.from(await eotOf());
    lying.writeUInt32LE(lying.length + 1, 4);
    await expect(convertFont(lying, 'eot', 'ttf', {}, 'lying.eot')).rejects.toThrow(/does not fit/);
  });

  for (const id of ['plex-ibmplexsansarabic-bold.eot', 'plex-ibmplexsansarabic-light.eot']) {
    it(`names the compression of the real file ${id}`, async (ctx) => {
      const { bytes } = await requireRealworldSample(ctx, id);
      expect(bytes.readUInt32LE(FLAGS_OFFSET) & 0x4).toBe(0x4);
      expect(bytes.readUInt16LE(EOT_LP_SIGNATURE_OFFSET)).toBe(0x504c);
      await expect(convertFont(bytes, 'eot', 'otf', {}, id)).rejects.toThrow(/MicroType Express/);
    });
  }
});
