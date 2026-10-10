import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync, spawnSync } from 'node:child_process';
import { create7zArchive, extract7zArchive } from '../src/lib/conversions';
import { ConversionOptions, CorruptStreamError } from '../src/lib/types';
import { oracleTest } from './helpers/oracle-test';
import { requireOracleTool } from './helpers/differential-oracle';

/**
 * The 7z writer and reader are proven against the reference 7-Zip: what the writer produces must list, test and
 * extract under 7-Zip with the sizes, CRCs and bytes that were put in, and what 7-Zip writes must come back out of
 * the reader unchanged. Damaged archives (found damaged by 7-Zip itself) are refused with a typed error.
 */

const SEVEN_ZIP_SIGNATURE = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
const START_HEADER_CRC_OFFSET = 8;
const START_HEADER_BYTES = 32;
const NEXT_HEADER_CRC_OFFSET = 28;
const SEVEN_ZIP_COMMAND_TIMEOUT_MS = 30_000;

const REPETITIVE = Buffer.from('EasyConvert archive fidelity. '.repeat(300), 'utf-8');
const SAMPLE_FILES = [
  { filename: 'readme.md', buffer: Buffer.from('# Archive\nwith a second line\n') },
  { filename: 'nested/config.json', buffer: Buffer.from(JSON.stringify({ port: 8080, level: 9 })) },
  { filename: 'repetitive.txt', buffer: REPETITIVE },
  { filename: 'random.bin', buffer: crypto.createHash('sha512').update('seed').digest() },
];

function withTempDir<T>(run: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seven-zip-oracle-'));
  try {
    return run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function sevenZip(args: string[]): string {
  return execFileSync(requireOracleTool('7z'), args, { encoding: 'utf-8', timeout: SEVEN_ZIP_COMMAND_TIMEOUT_MS });
}

/** The `Path`, `Size` and `CRC` of every file entry in the technical listing (`7z l -slt`). */
function listEntries(archivePath: string): { path: string; size: number; crc: string }[] {
  const listing = sevenZip(['l', '-slt', archivePath]);
  const entries: { path: string; size: number; crc: string }[] = [];
  for (const block of listing.split(/\r?\n\r?\n/)) {
    const fields = new Map<string, string>();
    for (const line of block.split(/\r?\n/)) {
      const separator = line.indexOf(' = ');
      if (separator > 0) fields.set(line.slice(0, separator), line.slice(separator + 3));
    }
    // The archive's own block and directories carry no CRC; every file with data does.
    if (fields.has('Path') && fields.get('CRC')) {
      entries.push({ path: fields.get('Path')!, size: Number(fields.get('Size')), crc: fields.get('CRC')!.toLowerCase() });
    }
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

function crcHex(bytes: Buffer): string {
  return zlib.crc32(bytes).toString(16).padStart(8, '0');
}

describe('7z writer against the reference 7-Zip', () => {
  const writerConfigurations: { label: string; options: ConversionOptions }[] = [
    { label: 'level 0 (copy)', options: { compressionLevel: 0 } },
    { label: 'level 6', options: { compressionLevel: 6 } },
    { label: 'level 9', options: { compressionLevel: 9 } },
    ...(['lzma2', 'lzma', 'deflate', 'copy'] as const).flatMap((archiveCoder) => [
      { label: `${archiveCoder} coder`, options: { archiveCoder } },
      { label: `${archiveCoder} coder, solid`, options: { archiveCoder, solid: true } },
    ]),
  ];

  for (const { label, options } of writerConfigurations) {
    oracleTest(`${label}: 7-Zip tests the archive and finds each file with its size and CRC`, ['7z'], () => {
      const archive = create7zArchive(SAMPLE_FILES, options, 'sample.7z');
      expect(archive.buffer.subarray(0, SEVEN_ZIP_SIGNATURE.length)).toEqual(SEVEN_ZIP_SIGNATURE);
      withTempDir((dir) => {
        const archivePath = path.join(dir, 'sample.7z');
        fs.writeFileSync(archivePath, archive.buffer);
        expect(sevenZip(['t', archivePath])).toContain('Everything is Ok');
        expect(listEntries(archivePath)).toEqual(
          SAMPLE_FILES.map((file) => ({ path: file.filename, size: file.buffer.length, crc: crcHex(file.buffer) })).sort((a, b) => a.path.localeCompare(b.path))
        );
        const outDir = path.join(dir, 'out');
        sevenZip(['x', `-o${outDir}`, '-y', archivePath]);
        for (const file of SAMPLE_FILES) {
          expect(fs.readFileSync(path.join(outDir, file.filename)).toString('base64')).toBe(file.buffer.toString('base64'));
        }
      });
    });
  }

  oracleTest('a compressed archive is smaller than the payload, as 7-Zip reports its packed size', ['7z'], () => {
    const archive = create7zArchive([{ filename: 'repetitive.txt', buffer: REPETITIVE }], { compressionLevel: 6 }, 'compressed.7z');
    expect(archive.buffer.length).toBeLessThan(REPETITIVE.length / 4);
    withTempDir((dir) => {
      const archivePath = path.join(dir, 'compressed.7z');
      fs.writeFileSync(archivePath, archive.buffer);
      const listing = sevenZip(['l', '-slt', archivePath]);
      expect(listing).toMatch(new RegExp(`^Size = ${REPETITIVE.length}$`, 'm'));
      expect(listing).toMatch(/^Method = (LZMA2?|Deflate|Copy)/m);
    });
  });
});

describe('7z reader against archives written by the reference 7-Zip', () => {
  oracleTest('files written by 7-Zip come back byte for byte', ['7z'], () => {
    withTempDir((dir) => {
      const sourceDir = path.join(dir, 'src');
      for (const file of SAMPLE_FILES) {
        fs.mkdirSync(path.dirname(path.join(sourceDir, file.filename)), { recursive: true });
        fs.writeFileSync(path.join(sourceDir, file.filename), file.buffer);
      }
      // An empty file and a directory are entries without a data stream: they must not shift the names of the files after them.
      fs.writeFileSync(path.join(sourceDir, 'empty.txt'), '');
      fs.mkdirSync(path.join(sourceDir, 'emptydir'));
      for (const mode of [['-ms=off'], ['-ms=on']]) {
        const archivePath = path.join(dir, `reference${mode[0]}.7z`);
        sevenZip(['a', '-t7z', '-m0=lzma2', ...mode, archivePath, `${sourceDir}${path.sep}*`]);
        const extracted = extract7zArchive(fs.readFileSync(archivePath));
        const byName = new Map(extracted.map((entry) => [entry.filename, entry.buffer]));
        const expected = [...SAMPLE_FILES, { filename: 'empty.txt', buffer: Buffer.alloc(0) }];
        expect([...byName.keys()].sort()).toEqual(expected.map((file) => file.filename).sort());
        for (const file of expected) {
          expect(byName.get(file.filename)?.toString('base64'), `${file.filename} (${mode[0]})`).toBe(file.buffer.toString('base64'));
        }
      }
    });
  });
});

describe('damaged 7z archives are refused', () => {
  function referenceArchive(): Buffer {
    return withTempDir((dir) => {
      const inputPath = path.join(dir, 'payload.txt');
      fs.writeFileSync(inputPath, REPETITIVE);
      const archivePath = path.join(dir, 'reference.7z');
      sevenZip(['a', '-t7z', archivePath, inputPath]);
      return fs.readFileSync(archivePath);
    });
  }

  function flipByte(buffer: Buffer, offset: number): Buffer {
    const copy = Buffer.from(buffer);
    copy[offset] ^= 0xff;
    return copy;
  }

  const damages: [string, (archive: Buffer) => Buffer, RegExp][] = [
    ['a signature that is not 7z', () => Buffer.from('NOT_A_VALID_7Z_FILE_HEADER_GARBAGE_PADDING'), /Invalid 7z archive: bad signature/],
    ['a file shorter than the start header', (archive) => archive.subarray(0, START_HEADER_BYTES - 1), /Invalid 7z archive: shorter than the 32-byte start header/],
    ['a damaged start header checksum', (archive) => flipByte(archive, START_HEADER_CRC_OFFSET), /Corrupted 7z archive: start header CRC mismatch/],
    ['a damaged next header checksum', (archive) => flipByte(archive, NEXT_HEADER_CRC_OFFSET), /Corrupted 7z archive: (start header|next header) CRC mismatch/],
    ['a next header cut off by truncation', (archive) => archive.subarray(0, archive.length - 3), /Corrupted 7z archive: (truncated|next header)/],
  ];

  it.each(damages)('%s throws a CorruptStreamError', (_name, damage, message) => {
    const damaged = damage(referenceArchive());
    const failure = (() => {
      try {
        return extract7zArchive(damaged);
      } catch (err) {
        return err;
      }
    })();
    expect(failure).toBeInstanceOf(CorruptStreamError);
    expect((failure as Error).message).toMatch(message);
  });

  oracleTest('7-Zip itself rejects the damaged archives the reader refuses', ['7z'], () => {
    const archive = referenceArchive();
    for (const damaged of [flipByte(archive, START_HEADER_CRC_OFFSET), archive.subarray(0, archive.length - 3)]) {
      withTempDir((dir) => {
        const archivePath = path.join(dir, 'damaged.7z');
        fs.writeFileSync(archivePath, damaged);
        const result = spawnSync(requireOracleTool('7z'), ['t', archivePath], { encoding: 'utf-8', timeout: SEVEN_ZIP_COMMAND_TIMEOUT_MS });
        expect(result.status).not.toBe(0);
      });
    }
  });
});
