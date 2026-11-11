import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { createZipArchive } from '../src/lib/conversions/archive';
import { DEFLATE_BLOCK_BYTES } from '../src/lib/conversions/deflate-blocks';
import { createZipBuffer, ZIP_PARALLEL_BLOCKS_MIN_BYTES } from '../src/lib/conversions/zip-writer';
import { getOracleToolPath } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';
import { jsonRecords, proseText, runBytes, sha256Hex, zipfText } from './helpers/archive-corpus';

const CLASSIC_ENTRY_LIMIT = 65_535;

function largeFiles(): { filename: string; buffer: Buffer }[] {
  return [
    { filename: 'logs/server.log', buffer: Buffer.concat([zipfText(900_000, 1), jsonRecords(700_000, 2)]) },
    { filename: 'logs/exact-two-blocks.txt', buffer: proseText(ZIP_PARALLEL_BLOCKS_MIN_BYTES, 3) },
    { filename: 'logs/just-under.txt', buffer: proseText(ZIP_PARALLEL_BLOCKS_MIN_BYTES - 1, 4) },
    { filename: 'data/runs.bin', buffer: Buffer.concat([runBytes(400_000, 5), zipfText(300_000, 6)]) },
    { filename: 'small.txt', buffer: Buffer.from('small\n') },
  ];
}

describe('createZipArchive cuts large entries into blocks', () => {
  it('uses blocks from two block sizes up', () => {
    expect(ZIP_PARALLEL_BLOCKS_MIN_BYTES).toBe(2 * DEFLATE_BLOCK_BYTES);
  });

  it('gives back every entry byte for byte, read by a reader that is not the writer', async () => {
    const files = largeFiles();
    const zip = await JSZip.loadAsync((await createZipArchive(files, {}, 'a.zip')).buffer);
    for (const file of files) {
      expect(sha256Hex(await zip.file(file.filename)!.async('nodebuffer')), file.filename).toBe(sha256Hex(file.buffer));
    }
  });

  it('keeps each entry within 0.5 percent of one zlib call at the same level', async () => {
    const files = largeFiles();
    const archive = (await createZipArchive(files, {}, 'a.zip')).buffer;
    const single = await createZipBuffer(files.map((file) => ({ name: file.filename, data: file.buffer, level: 6 })));
    // the same files, same names and folders left out of the comparison: only the data sizes differ by the flushes
    expect(Math.abs(archive.length - single.length) / single.length).toBeLessThan(0.005);
  });

  it('writes the same bytes on every run', async () => {
    const files = largeFiles();
    const first = (await createZipArchive(files, {}, 'a.zip')).buffer;
    const again = (await createZipArchive(files, {}, 'a.zip')).buffer;
    // the modification time is the second the archive was made in; compare the entry data only
    const payload = (archive: Buffer): string[] => {
      const out: string[] = [];
      let at = 0;
      while (archive.readUInt32LE(at) === 0x04034b50) {
        const compressed = archive.readUInt32LE(at + 18);
        const dataAt = at + 30 + archive.readUInt16LE(at + 26) + archive.readUInt16LE(at + 28);
        out.push(sha256Hex(archive.subarray(dataAt, dataAt + compressed)));
        at = dataAt + compressed;
      }
      return out;
    };
    expect(payload(again)).toEqual(payload(first));
    expect(payload(first).length).toBeGreaterThan(5);
  });

  oracleTest('unzip and 7z test the archive and extract the same bytes', ['unzip', '7z'], async () => {
    const files = largeFiles();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-blocks-'));
    const file = path.join(dir, 'a.zip');
    fs.writeFileSync(file, (await createZipArchive(files, {}, 'a.zip')).buffer);
    execFileSync(getOracleToolPath('unzip')!, ['-tq', file]);
    execFileSync(getOracleToolPath('7z')!, ['t', file]);
    for (const entry of files) {
      const out = execFileSync(getOracleToolPath('unzip')!, ['-p', file, entry.filename], { maxBuffer: 1 << 26 });
      expect(sha256Hex(out), entry.filename).toBe(sha256Hex(entry.buffer));
    }
  });
});

describe('ZIP64 record boundaries of the central directory', () => {
  const endRecord = (archive: Buffer): { total: number; hasLocator: boolean } => {
    const at = archive.length - 22;
    expect(archive.readUInt32LE(at)).toBe(0x06054b50);
    return { total: archive.readUInt16LE(at + 10), hasLocator: archive.length >= 42 && archive.readUInt32LE(at - 20) === 0x07064b50 };
  };
  const tiny = (count: number) => Array.from({ length: count }, (_, i) => ({ name: `f${i}`, data: Buffer.alloc(0), method: 'store' as const }));

  it('writes ZIP64 end records at 65,535 entries, where the 16-bit count reads as the marker, and none at 65,534', async () => {
    const below = endRecord(await createZipBuffer(tiny(CLASSIC_ENTRY_LIMIT - 1)));
    expect(below).toEqual({ total: CLASSIC_ENTRY_LIMIT - 1, hasLocator: false });
    const at = endRecord(await createZipBuffer(tiny(CLASSIC_ENTRY_LIMIT)));
    expect(at).toEqual({ total: 0xffff, hasLocator: true });
  }, 120_000);
});
