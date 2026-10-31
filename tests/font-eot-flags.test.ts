import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { convertFont, decodeEot } from '../src/lib/conversions/font';
import { ConversionFailedError } from '../src/lib/types';

/**
 * An Embedded OpenType file declares in its header (Flags, offset 12) whether the font data is compressed with MicroType Express
 * (0x4) or XOR-encrypted with 0x50 (0x10000000). The reader took the last FontDataSize bytes for an sfnt whatever the flags said and,
 * when they were not one, made a font of the raw EOT bytes: two IBM Plex Sans Arabic files (compressed) were refused as fonts
 * "with no glyph outlines", which no one could act on. The in-process reader now refuses a compressed file by name and reads an XOR-encrypted
 * one; convertFont sends a compressed file to eot2ttf first, and tests/font-eot-mtx.test.ts converts the two real files.
 */

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

  it('refuses MicroType Express compression by name in the in-process reader, which does not decompress it', async () => {
    const compressed = Buffer.from(await eotOf());
    compressed.writeUInt32LE(compressed.readUInt32LE(FLAGS_OFFSET) | 0x4, FLAGS_OFFSET);
    expect(() => decodeEot(compressed, 'compressed')).toThrow(ConversionFailedError);
    expect(() => decodeEot(compressed, 'compressed')).toThrow(/MicroType Express/);
  });

  it('refuses font data that is no sfnt instead of making a font of the file', async () => {
    const damaged = Buffer.from(await eotOf());
    damaged.fill(0x41, damaged.length - damaged.readUInt32LE(4), damaged.length - damaged.readUInt32LE(4) + 64);
    await expect(convertFont(damaged, 'eot', 'ttf', {}, 'damaged.eot')).rejects.toThrow(/Invalid SFNT font: the directory of \d+ tables is cut short/);
  });

  it('refuses a file whose declared font data does not fit', async () => {
    const lying = Buffer.from(await eotOf());
    lying.writeUInt32LE(lying.length + 1, 4);
    await expect(convertFont(lying, 'eot', 'ttf', {}, 'lying.eot')).rejects.toThrow(/does not fit/);
  });
});
