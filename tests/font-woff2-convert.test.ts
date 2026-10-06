import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { convertFont } from '../src/lib/conversions/font';
import { countWoff2Fonts } from '../src/lib/conversions/font-woff2';
import { UnsupportedOptionError } from '../src/lib/types';

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
    await expect(convertFont(fixture('pair.google.woff2'), 'ttf', 'ttf', {}, 'pair.ttf')).rejects.toBeInstanceOf(UnsupportedOptionError);
  });

  it('still converts a WOFF2 file with a single font', async () => {
    const result = await convertFont(fixture('dejavu-sans-latin.google.woff2'), 'woff2', 'ttf', {}, 'dejavu.woff2');
    expect(result.buffer.readUInt32BE(0)).toBe(0x00010000);
  });
});
