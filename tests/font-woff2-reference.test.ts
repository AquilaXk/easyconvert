import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { readSfntTables } from './helpers/font-oracles';
import { readWoff2Reference } from './helpers/woff2-reference';

/**
 * Pins the test-side WOFF2 reader (tests/helpers/woff2-reference.ts) to the Google reference decoder,
 * so the other WOFF2 suites can use it as an oracle without the Google binaries being installed.
 */

const FIXTURES = path.join(__dirname, 'fixtures', 'woff2');
const fixture = (name: string): Buffer => fs.readFileSync(path.join(FIXTURES, name));

const HEAD_ADJUSTMENT_OFFSET = 8;

const CASES = [
  ['dejavu-sans-latin.google.woff2', 'dejavu-sans-latin.google-decoded.ttf'],
  ['dejavu-serif-hinted-ascii.google.woff2', 'dejavu-serif-hinted-ascii.google-decoded.ttf'],
  ['synthetic-triplets.google.woff2', 'synthetic-triplets.google-decoded.ttf'],
  ['synthetic-cff.google.woff2', 'synthetic-cff.google-decoded.otf'],
  ['dejavu-sans-latin.fonttools-hmtx.woff2', 'dejavu-sans-latin.fonttools-hmtx.google-decoded.ttf'],
] as const;

describe('test-side WOFF2 reader against the Google reference decoder', () => {
  it.each(CASES)('%s: every rebuilt table equals the reference decoder output', (woff2, decoded) => {
    const rebuilt = readWoff2Reference(fixture(woff2)).tables;
    const reference = readSfntTables(fixture(decoded));
    expect([...rebuilt.keys()].sort()).toEqual([...reference.keys()].sort());
    for (const [tag, data] of reference) {
      const mine = Buffer.from(rebuilt.get(tag)!);
      const theirs = Buffer.from(data);
      if (tag === 'head') {
        mine.writeUInt32BE(0, HEAD_ADJUSTMENT_OFFSET);
        theirs.writeUInt32BE(0, HEAD_ADJUSTMENT_OFFSET);
      }
      expect(mine.equals(theirs), `table '${tag}'`).toBe(true);
    }
  });

  it('exposes the header, the directory and the stored bytes of the file', () => {
    const reading = readWoff2Reference(fixture('dejavu-sans-latin.fonttools-hmtx.woff2'));
    expect(reading.header.numTables).toBe(reading.directory.length);
    expect(reading.directory.find((row) => row.tag === 'hmtx')?.version).toBe(1);
    expect(reading.directory.find((row) => row.tag === 'loca')?.transformLength).toBe(0);
    expect(reading.stored.get('glyf')!.length).toBe(reading.directory.find((row) => row.tag === 'glyf')?.transformLength);
  });
});
