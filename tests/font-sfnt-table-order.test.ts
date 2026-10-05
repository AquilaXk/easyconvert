import { describe, expect, it } from 'vitest';
import { encodeSfnt, type ParsedFont, type SfntTable } from '../src/lib/conversions/font';
import { readSfntFile } from './helpers/sfnt-outline-reader';

/**
 * OpenType requires the table directory to be sorted by the tags' byte values (uppercase letters
 * and "OS/2" before lowercase tags), so binary search over the directory works. Locale collation
 * puts "cmap" before "OS/2" and breaks that rule.
 */

function table(tag: string, byte: number): SfntTable {
  const data = Buffer.alloc(8, byte);
  return { tag, checkSum: 0, offset: 0, length: data.length, data };
}

describe('SFNT table directory order', () => {
  it('sorts tags by byte value with uppercase and "OS/2" before lowercase tags', () => {
    const tags = ['name', 'cmap', 'OS/2', 'head', 'CFF ', 'post', 'GSUB', 'glyf'];
    const font: ParsedFont = {
      sfntVersion: 0x4f54544f,
      flavor: 'OTTO',
      numTables: tags.length,
      tables: Object.fromEntries(tags.map((tag, i) => [tag, table(tag, i + 1)])),
      fontFamily: 'Order',
    };

    const file = readSfntFile(encodeSfnt(font));

    expect(file.entries.map((e) => e.tag)).toEqual(['CFF ', 'GSUB', 'OS/2', 'cmap', 'glyf', 'head', 'name', 'post']);
    for (const entry of file.entries) {
      expect(file.table(entry.tag).every((b) => b === tags.indexOf(entry.tag) + 1), entry.tag).toBe(true);
    }
  });
});
