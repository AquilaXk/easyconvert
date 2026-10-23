import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import JSZip from 'jszip';
import { createDeflatedZipBuffer, writeDeflatedZipFile, ZIP_DEFAULT_LEVEL, type ZipFile } from '../src/lib/conversions/zip-writer';
import { proseText, SeededRandom, sha256Hex } from './helpers/archive-corpus';
import { getOracleToolPath } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';

const KIBIBYTE = 1024;
const MEBIBYTE = 1024 * KIBIBYTE;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const LOCAL_HEADER_FIXED_BYTES = 30;
const LOCAL_HEADER_NAME_LENGTH_OFFSET = 26;
const LOCAL_HEADER_METHOD_OFFSET = 8;
const CENTRAL_SIGNATURE = 0x02014b50;

const PYTHON_CHECK = `
import sys, zipfile, hashlib, json
z = zipfile.ZipFile(sys.argv[1])
print(json.dumps({"bad": z.testzip(), "names": z.namelist(), "sha256": {n: hashlib.sha256(z.read(n)).hexdigest() for n in z.namelist()}}))
`;

function scratchDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zip-deflated-'));
}

function pageLikeFiles(count: number): ZipFile[] {
  const random = new SeededRandom(773);
  return Array.from({ length: count }, (_, index) => ({
    name: `report-p${String(index + 1).padStart(3, '0')}.dxf`,
    data: index % 3 === 2 ? random.bytes(48 * KIBIBYTE + index) : proseText(96 * KIBIBYTE + index * 1000, index + 1),
  }));
}

/** Each entry's name, method and compressed payload, read from the central directory and the local headers (APPNOTE 4.3.7, 4.3.12). */
function centralRecords(archive: Buffer): { name: string; method: number; compressed: Buffer }[] {
  const end = archive.length - 22;
  const count = archive.readUInt16LE(end + 10);
  let at = archive.readUInt32LE(end + 16);
  const records: { name: string; method: number; compressed: Buffer }[] = [];
  for (let i = 0; i < count; i++) {
    expect(archive.readUInt32LE(at)).toBe(CENTRAL_SIGNATURE);
    const compressedSize = archive.readUInt32LE(at + 20);
    const nameLength = archive.readUInt16LE(at + 28);
    const extraLength = archive.readUInt16LE(at + 30);
    const commentLength = archive.readUInt16LE(at + 32);
    const localOffset = archive.readUInt32LE(at + 42);
    const name = archive.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    const localNameLength = archive.readUInt16LE(localOffset + LOCAL_HEADER_NAME_LENGTH_OFFSET);
    const localExtraLength = archive.readUInt16LE(localOffset + LOCAL_HEADER_NAME_LENGTH_OFFSET + 2);
    const dataStart = localOffset + LOCAL_HEADER_FIXED_BYTES + localNameLength + localExtraLength;
    records.push({ name, method: archive.readUInt16LE(localOffset + LOCAL_HEADER_METHOD_OFFSET), compressed: archive.subarray(dataStart, dataStart + compressedSize) });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return records;
}

describe('createDeflatedZipBuffer', () => {
  it('keeps the order and names of the files and gives back every file byte for byte', async () => {
    const files = pageLikeFiles(14);
    const archive = await JSZip.loadAsync(await createDeflatedZipBuffer(files));
    expect(Object.keys(archive.files)).toEqual(files.map((file) => file.name));
    for (const file of files) {
      expect(Buffer.compare(await archive.files[file.name].async('nodebuffer'), Buffer.from(file.data))).toBe(0);
    }
  });

  it('deflates each file with one zlib call at the default level, and stores a file that deflate does not shrink', async () => {
    expect(ZIP_DEFAULT_LEVEL).toBe(6);
    const files = pageLikeFiles(9);
    const records = centralRecords(await createDeflatedZipBuffer(files));
    expect(records).toHaveLength(files.length);
    records.forEach((record, index) => {
      const data = Buffer.from(files[index].data);
      expect(record.name).toBe(files[index].name);
      const compressible = index % 3 !== 2;
      expect(record.method).toBe(compressible ? METHOD_DEFLATE : METHOD_STORE);
      expect(Buffer.compare(record.compressed, compressible ? zlib.deflateRawSync(data, { level: ZIP_DEFAULT_LEVEL }) : data)).toBe(0);
    });
  });

  it('deflates more files than it runs ahead, with an empty file and a repeated buffer among them, in order', async () => {
    const shared = proseText(80 * KIBIBYTE, 5);
    const files: ZipFile[] = Array.from({ length: 40 }, (_, index) => ({ name: `f${index}.txt`, data: index % 7 === 0 ? shared : Buffer.from(`file ${index} `.repeat(2000 + index)) }));
    files.splice(11, 0, { name: 'empty.txt', data: Buffer.alloc(0) });
    const archive = await JSZip.loadAsync(await createDeflatedZipBuffer(files));
    expect(Object.keys(archive.files)).toEqual(files.map((file) => file.name));
    for (const file of files) expect(Buffer.compare(await archive.files[file.name].async('nodebuffer'), Buffer.from(file.data))).toBe(0);
  });

  it('fails with the first deflate error and leaves no unhandled rejection from the files deflated ahead of it', async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown): void => void unhandled.push(reason);
    process.on('unhandledRejection', record);
    const failing = vi.spyOn(zlib, 'deflateRaw').mockImplementation(((_data: unknown, _options: unknown, done: (error: Error | null) => void) => {
      setImmediate(() => done(new Error('deflate failed')));
    }) as unknown as typeof zlib.deflateRaw);
    try {
      const files = Array.from({ length: 12 }, (_, index) => ({ name: `big${index}.txt`, data: proseText(128 * KIBIBYTE, index + 1) }));
      await expect(createDeflatedZipBuffer(files)).rejects.toThrow('deflate failed');
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(failing).toHaveBeenCalledTimes(1 + 4);
      expect(unhandled).toEqual([]);
    } finally {
      failing.mockRestore();
      process.off('unhandledRejection', record);
    }
  });

  it('writes an archive with no file as an empty archive', async () => {
    const archive = await createDeflatedZipBuffer([]);
    expect(archive.length).toBe(22);
    expect(Object.keys((await JSZip.loadAsync(archive)).files)).toEqual([]);
  });
});

describe('writeDeflatedZipFile', () => {
  it('streams the same entries as the buffer holds', async () => {
    const dir = scratchDir();
    try {
      const files = pageLikeFiles(11);
      const target = path.join(dir, 'pages.zip');
      await writeDeflatedZipFile(target, files);
      const fromFile = await JSZip.loadAsync(fs.readFileSync(target));
      const fromBuffer = await JSZip.loadAsync(await createDeflatedZipBuffer(files));
      expect(Object.keys(fromFile.files)).toEqual(Object.keys(fromBuffer.files));
      for (const name of Object.keys(fromFile.files)) {
        expect(Buffer.compare(await fromFile.files[name].async('nodebuffer'), await fromBuffer.files[name].async('nodebuffer'))).toBe(0);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects with the open error of the file instead of emitting an uncaught stream error', async () => {
    const dir = scratchDir();
    try {
      await expect(writeDeflatedZipFile(path.join(dir, 'missing', 'pages.zip'), pageLikeFiles(3))).rejects.toThrow(/ENOENT/);
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  oracleTest('writes an archive that unzip -t and Python zipfile read, with the bytes of the files', ['python3', 'unzip'], async () => {
    const dir = scratchDir();
    try {
      const files = pageLikeFiles(7);
      const target = path.join(dir, 'pages.zip');
      await writeDeflatedZipFile(target, files);
      expect(execFileSync(getOracleToolPath('unzip')!, ['-t', target], { encoding: 'utf8' })).toContain('No errors detected');
      const report = JSON.parse(execFileSync(getOracleToolPath('python3')!, ['-I', '-c', PYTHON_CHECK, target], { encoding: 'utf8' })) as { bad: string | null; names: string[]; sha256: Record<string, string> };
      expect(report.bad).toBeNull();
      expect(report.names).toEqual(files.map((file) => file.name));
      for (const file of files) expect(report.sha256[file.name]).toBe(sha256Hex(file.data));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
