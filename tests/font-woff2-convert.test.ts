import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { convertFont } from '../src/lib/conversions/font';
import { countWoff2Fonts } from '../src/lib/conversions/font-woff2';
import { UnsupportedOptionError } from '../src/lib/types';
import { readSfntTables, unwrapWoff } from './helpers/font-oracles';

const FIXTURES = path.join(__dirname, 'fixtures', 'woff2');
const fixture = (name: string): Buffer => fs.readFileSync(path.join(FIXTURES, name));

describe('convertFont with a WOFF2 collection', () => {
  const SINGLE_FONT_TARGETS = ['ttf', 'otf', 'woff', 'woff2', 'eot', 'svg'];

  it('counts the fonts of a WOFF2 file from its headers', () => {
    expect(countWoff2Fonts(fixture('pair.google.woff2'))).toBe(2);
    expect(countWoff2Fonts(fixture('dejavu-sans-latin.google.woff2'))).toBe(1);
  });

  it.each(SINGLE_FONT_TARGETS)('refuses to turn a two-font collection into one %s font', async (target) => {
    const attempt = convertFont(fixture('pair.google.woff2'), 'woff2', target, {}, 'pair.woff2');
    await expect(attempt).rejects.toBeInstanceOf(UnsupportedOptionError);
    await expect(attempt).rejects.toThrow(/2 fonts/);
  });

  it('refuses the collection when the format is only recognised by its signature', async () => {
    const attempt = convertFont(fixture('pair.google.woff2'), 'ttf', 'ttf', {}, 'pair.ttf');
    await expect(attempt).rejects.toBeInstanceOf(UnsupportedOptionError);
    await expect(attempt).rejects.toThrow(/collection of 2 fonts/);
  });

  it('still converts a WOFF2 file with a single font', async () => {
    const result = await convertFont(fixture('dejavu-sans-latin.google.woff2'), 'woff2', 'ttf', {}, 'dejavu.woff2');
    expect(result.buffer.readUInt32BE(0)).toBe(0x00010000);
  });
});

describe('convertFont writes fonts that satisfy the sfnt checksum rules', () => {
  const SFNT_MAGIC_SUM = 0xb1b0afba;
  const SFNT_HEADER_BYTES = 12;
  const SFNT_RECORD_BYTES = 16;
  const HEAD_ADJUSTMENT_AT = 8;

  /** The sum of all big-endian 32-bit words of a file, zero padded: 0xB1B0AFBA for a font with a right adjustment. */
  function wholeFileSum(file: Buffer): number {
    const padded = Buffer.concat([file, Buffer.alloc((4 - (file.length % 4)) % 4)]);
    let sum = 0;
    for (let i = 0; i < padded.length; i += 4) sum = (sum + padded.readUInt32BE(i)) >>> 0;
    return sum;
  }

  function tableSum(data: Buffer, zeroAdjustment: boolean): number {
    const copy = Buffer.concat([data, Buffer.alloc((4 - (data.length % 4)) % 4)]);
    if (zeroAdjustment) copy.writeUInt32BE(0, HEAD_ADJUSTMENT_AT);
    let sum = 0;
    for (let i = 0; i < copy.length; i += 4) sum = (sum + copy.readUInt32BE(i)) >>> 0;
    return sum;
  }

  /** The sfnt a WOFF file stands for: tables in directory order, each directory record with its true checksum. */
  function assembleSfnt(tables: Map<string, Buffer>): Buffer {
    const tags = [...tables.keys()];
    const entrySelector = Math.floor(Math.log2(tags.length));
    const directory = Buffer.alloc(SFNT_HEADER_BYTES + SFNT_RECORD_BYTES * tags.length);
    directory.writeUInt32BE(0x00010000, 0);
    directory.writeUInt16BE(tags.length, 4);
    directory.writeUInt16BE(2 ** entrySelector * 16, 6);
    directory.writeUInt16BE(entrySelector, 8);
    directory.writeUInt16BE(tags.length * 16 - 2 ** entrySelector * 16, 10);
    const parts: Buffer[] = [directory];
    let offset = directory.length;
    tags.forEach((tag, i) => {
      const data = tables.get(tag)!;
      const at = SFNT_HEADER_BYTES + i * SFNT_RECORD_BYTES;
      directory.write(tag, at, 'latin1');
      directory.writeUInt32BE(tableSum(data, tag === 'head'), at + 4);
      directory.writeUInt32BE(offset, at + 8);
      directory.writeUInt32BE(data.length, at + 12);
      const padded = Buffer.concat([data, Buffer.alloc((4 - (data.length % 4)) % 4)]);
      parts.push(padded);
      offset += padded.length;
    });
    return Buffer.concat(parts);
  }

  const CASES = [
    ['dejavu-sans-latin.google.woff2', 'ttf'],
    ['dejavu-serif-hinted-ascii.google.woff2', 'ttf'],
    ['synthetic-triplets.google.woff2', 'ttf'],
    ['synthetic-cff.google.woff2', 'otf'],
  ] as const;

  it.each(CASES)('%s to %s: the whole file sums to 0xB1B0AFBA', async (source, target) => {
    const result = await convertFont(fixture(source), 'woff2', target, {}, 'font.woff2');
    expect(wholeFileSum(result.buffer)).toBe(SFNT_MAGIC_SUM);
  });

  it.each(CASES)('%s to %s: the directory is in ascending byte order with true table checksums', async (source, target) => {
    const { buffer } = await convertFont(fixture(source), 'woff2', target, {}, 'font.woff2');
    const count = buffer.readUInt16BE(4);
    const tags: string[] = [];
    for (let i = 0; i < count; i++) {
      const at = SFNT_HEADER_BYTES + i * SFNT_RECORD_BYTES;
      const tag = buffer.toString('latin1', at, at + 4);
      const offset = buffer.readUInt32BE(at + 8);
      const length = buffer.readUInt32BE(at + 12);
      tags.push(tag);
      expect(offset % 4, `offset of '${tag}'`).toBe(0);
      expect(buffer.readUInt32BE(at + 4), `checksum of '${tag}'`).toBe(tableSum(buffer.subarray(offset, offset + length), tag === 'head'));
    }
    expect(tags).toEqual([...tags].sort());
    expect(tags.indexOf('OS/2')).toBeLessThan(tags.indexOf('cmap'));
  });

  it('woff2 to woff: the WOFF tables come in ascending byte order and rebuild a font that sums to 0xB1B0AFBA', async () => {
    const { buffer } = await convertFont(fixture('dejavu-sans-latin.google.woff2'), 'woff2', 'woff', {}, 'font.woff2');
    const tables = unwrapWoff(buffer);
    const tags = [...tables.keys()];
    expect(tags).toEqual([...tags].sort());
    expect(wholeFileSum(assembleSfnt(tables))).toBe(SFNT_MAGIC_SUM);
  });

  it('ttf to ttf keeps the tables and repairs a stale adjustment', async () => {
    const source = fixture('dejavu-sans-latin.ttf');
    const { buffer } = await convertFont(source, 'ttf', 'ttf', {}, 'font.ttf');
    expect(wholeFileSum(buffer)).toBe(SFNT_MAGIC_SUM);
    const before = readSfntTables(source);
    const after = readSfntTables(buffer);
    for (const [tag, data] of before) {
      if (tag === 'head') continue;
      expect(after.get(tag)!.equals(data), `table '${tag}'`).toBe(true);
    }
  });
});
