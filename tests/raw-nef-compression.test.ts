import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { isHighEfficiencyNef, readNefCompression } from '../src/worker/raw-nef-compression';
import { buildNef, type NefShape } from './helpers/nef-builder';
import { rawSamplePath, skipWithoutRawSamples } from './helpers/strict-skip';

/**
 * Which Nikon NEF files need the decoder of the pinned LibRaw snapshot. The camera records the compression in its maker note:
 * tag 0x0093 (NEFCompression, a SHORT) in older bodies and tag 0x0051 (a 24 byte block, the SHORT at offset 10) in the Z 6III, Z 8,
 * Z 9 and Z f; 13 is "High Efficiency" and 14 is "High Efficiency*" (ExifTool's Nikon tables). The files below are built byte by
 * byte from that layout, and the real samples are read as well.
 */

const dir = mkdtempSync(path.join(tmpdir(), 'nef-compression-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const write = (name: string, bytes: Buffer): string => {
  const file = path.join(dir, name);
  writeFileSync(file, bytes);
  return file;
};

describe('the compression of a Nikon NEF read from its maker note', () => {
  it.each<[string, NefShape, number]>([
    ['0x51 block of a Z body, little endian', { tag: 0x51, value: 13 }, 13],
    ['0x51 block, high efficiency star', { tag: 0x51, value: 14 }, 14],
    ['0x93 SHORT of an older body', { tag: 0x93, value: 3 }, 3],
    ['0x93 SHORT, 12 bit packed', { tag: 0x93, value: 9 }, 9],
    ['big endian file and maker note', { tag: 0x51, value: 13, little: false }, 13],
    ['a maker note whose byte order differs from the file', { tag: 0x93, value: 14, little: true, makerLittle: false }, 14],
  ])('%s', (_name, shape, expected) => {
    expect(readNefCompression(write('a.nef', buildNef(shape)))).toBe(expected);
  });

  it('calls only 13 and 14 high efficiency', () => {
    for (let value = 0; value < 20; value += 1) {
      expect(isHighEfficiencyNef(write('b.nef', buildNef({ tag: 0x51, value })))).toBe(value === 13 || value === 14);
    }
  });

  it('answers null, and not high efficiency, for files that are not a Nikon NEF with a readable maker note', () => {
    const good = buildNef({ value: 13 });
    const cases: Record<string, Buffer> = {
      empty: Buffer.alloc(0),
      text: Buffer.from('not a tiff file at all'),
      'bad magic': Buffer.concat([Buffer.from('II'), Buffer.from([0x2b, 0]), good.subarray(4)]),
      'no exif pointer': buildNef({ value: 13, exifTag: 0x8825 }),
      'no maker note': buildNef({ value: 13, makerNoteTag: 0x9000 }),
      'another maker': buildNef({ value: 13, header: Buffer.from('OLYMP\0\x02\x11\0\0', 'latin1') }),
      'maker note without a TIFF header of its own': buildNef({ value: 13, header: Buffer.from('Nikon\0\x01\x00\0\0', 'latin1') }),
      'cut inside the maker note': good.subarray(0, good.length - 30),
      'cut inside the exif directory': good.subarray(0, 30),
      'cut after the header': good.subarray(0, 8),
    };
    for (const [name, bytes] of Object.entries(cases)) {
      const file = write('c.nef', bytes);
      expect(readNefCompression(file), name).toBeNull();
      expect(isHighEfficiencyNef(file), name).toBe(false);
    }
  });

  it('is not led astray by offsets that point past the file or back into the header', () => {
    const loop = buildNef({ value: 13 });
    loop.writeUInt32LE(0xffff_fff0, 4);
    expect(isHighEfficiencyNef(write('d.nef', loop))).toBe(false);
    const wild = buildNef({ value: 13 });
    wild.writeUInt32LE(0xffff_fff0, 18);
    expect(isHighEfficiencyNef(write('e.nef', wild))).toBe(false);
    expect(readNefCompression(path.join(dir, 'missing.nef'))).toBeNull();
  });
});

describe('the real Nikon samples', () => {
  const noSamples = skipWithoutRawSamples('nef-zf', 'nef-z9he', 'nef');
  it.skipIf(noSamples)('the Z f and Z 9 files say High Efficiency and the uncompressed scanner file does not', () => {
    expect(readNefCompression(rawSamplePath('nef-zf'))).toBe(13);
    expect(readNefCompression(rawSamplePath('nef-z9he'))).toBe(13);
    expect(isHighEfficiencyNef(rawSamplePath('nef-zf'))).toBe(true);
    expect(isHighEfficiencyNef(rawSamplePath('nef-z9he'))).toBe(true);
    expect(isHighEfficiencyNef(rawSamplePath('nef'))).toBe(false);
  });
});
