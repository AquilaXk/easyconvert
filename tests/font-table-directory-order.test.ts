import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { convertFile } from '../src/lib/conversions';

/**
 * The OpenType and WOFF 1.0 specifications require table directory entries sorted by tag in
 * ascending binary order ('OS/2' before 'cmap', both before 'name'); readers binary-search it.
 * The directory is read here byte by byte, independently of the font engine.
 */
const SOURCE = readFileSync(path.join(__dirname, 'fixtures', 'sample.woff2'));
const SFNT_HEADER_BYTES = 12;
const SFNT_ENTRY_BYTES = 16;
const WOFF_HEADER_BYTES = 44;
const WOFF_ENTRY_BYTES = 20;
const TAG_BYTES = 4;

function directoryTags(font: Buffer, headerBytes: number, entryBytes: number, countOffset: number): string[] {
  const count = font.readUInt16BE(countOffset);
  return Array.from({ length: count }, (_, i) => font.toString('latin1', headerBytes + i * entryBytes, headerBytes + i * entryBytes + TAG_BYTES));
}

function binarySorted(tags: string[]): string[] {
  return [...tags].sort((a, b) => Buffer.compare(Buffer.from(a, 'latin1'), Buffer.from(b, 'latin1')));
}

/** OpenType: the uint32 sum of the whole font, checkSumAdjustment included, is this constant. */
const SFNT_CHECKSUM_MAGIC = 0xb1b0afba;
const HEAD_ADJUSTMENT_OFFSET = 8;

function uint32Sum(data: Buffer): number {
  const padded = Buffer.concat([data, Buffer.alloc((4 - (data.length % 4)) % 4)]);
  let sum = 0;
  for (let i = 0; i < padded.length; i += 4) sum = (sum + padded.readUInt32BE(i)) >>> 0;
  return sum;
}

describe('font checksums', () => {
  it.each(['ttf', 'otf'])('woff2 -> %s carries a whole-font checksum and per-table checksums that verify', async (target) => {
    const font = (await convertFile(SOURCE, 'woff2', target, {}, 'sample.woff2')).buffer;
    expect(uint32Sum(font)).toBe(SFNT_CHECKSUM_MAGIC);
    const count = font.readUInt16BE(4);
    for (let i = 0; i < count; i += 1) {
      const entry = SFNT_HEADER_BYTES + i * SFNT_ENTRY_BYTES;
      const tag = font.toString('latin1', entry, entry + TAG_BYTES);
      const offset = font.readUInt32BE(entry + 8);
      const table = Buffer.from(font.subarray(offset, offset + font.readUInt32BE(entry + 12)));
      // The 'head' checksum is defined with checkSumAdjustment set to zero.
      if (tag === 'head') table.writeUInt32BE(0, HEAD_ADJUSTMENT_OFFSET);
      expect([tag, font.readUInt32BE(entry + 4)]).toEqual([tag, uint32Sum(table)]);
    }
  });
});

describe('font table directory order', () => {
  it.each(['ttf', 'otf'])('woff2 -> %s lists tables in ascending binary tag order', async (target) => {
    const result = await convertFile(SOURCE, 'woff2', target, {}, 'sample.woff2');
    const tags = directoryTags(result.buffer, SFNT_HEADER_BYTES, SFNT_ENTRY_BYTES, 4);
    expect(tags.some((tag) => tag !== tag.toLowerCase())).toBe(true);
    expect(tags).toEqual(binarySorted(tags));
  });

  it('woff2 -> woff lists tables in ascending binary tag order', async () => {
    const result = await convertFile(SOURCE, 'woff2', 'woff', {}, 'sample.woff2');
    expect(result.buffer.toString('latin1', 0, TAG_BYTES)).toBe('wOFF');
    const tags = directoryTags(result.buffer, WOFF_HEADER_BYTES, WOFF_ENTRY_BYTES, 12);
    expect(tags).toEqual(binarySorted(tags));
  });
});
