import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import AdmZip from 'adm-zip';
import {
  crc32,
  MAX_STREAMING_ZIP_ENTRIES,
  MAX_ZIP_ENTRY_NAME_BYTES,
  streamZip,
  streamZipReadable,
  type StreamingZipEntry,
} from '../src/lib/archive/streaming-zip';
import { inspectArchive } from '../src/lib/conversions/archive';
import { POST as bundlePost } from '../src/app/api/storage/bundle/route';
import { NextRequest } from 'next/server';
import { getOracleToolPath } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';

const SPARSE_ZIP64_TIMEOUT_MS = 120_000;

async function collectZipBuffer(
  entries: Iterable<StreamingZipEntry> | AsyncIterable<StreamingZipEntry>
): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of streamZip(entries)) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

describe('streaming-zip generator (client-zip MIT port)', () => {
  it('creates a valid STORE zip archive from memory buffers with valid CRC32', async () => {
    const file1 = Buffer.from('Hello world from file 1');
    const file2 = Buffer.from('Another test file with content 2');

    const entries = [
      { name: 'hello.txt', data: file1, size: file1.length },
      { name: 'sub\\nested.txt', data: file2, size: file2.length },
    ];

    const zipBuffer = await collectZipBuffer(entries);
    expect(zipBuffer.length).toBeGreaterThan(0);

    const adm = new AdmZip(zipBuffer);
    const admEntries = adm.getEntries();
    expect(admEntries.map((e) => e.entryName).sort()).toEqual(['hello.txt', 'sub/nested.txt']);
    expect(adm.readAsText('hello.txt')).toBe('Hello world from file 1');
    expect(adm.readAsText('sub/nested.txt')).toBe('Another test file with content 2');

    const inspected = await inspectArchive(zipBuffer);
    expect(inspected.extractable).toBe(true);
    expect(inspected.entries.map((e) => e.name).sort()).toEqual(['hello.txt', 'sub/nested.txt']);
  });

  it('streams zip chunks via ReadableStream in streamZipReadable', async () => {
    const content = Buffer.from('Streaming test data');
    const entries = [{ name: 'stream.txt', data: content, size: content.length }];

    const stream = streamZipReadable(entries);
    const res = new Response(stream);
    const arrayBuffer = await res.arrayBuffer();
    const zipBuffer = Buffer.from(arrayBuffer);

    const adm = new AdmZip(zipBuffer);
    expect(adm.getEntries().map((e) => e.entryName)).toEqual(['stream.txt']);
    expect(adm.readAsText('stream.txt')).toBe('Streaming test data');
  });

  it('matches node:zlib.crc32 bit-for-bit across lengths, byteOffsets, and chunk boundaries', () => {
    for (let size = 0; size <= 257; size++) {
      const backing = crypto.randomBytes(size + 13);
      const offset = (size % 7) + 1;
      const view = new Uint8Array(backing.buffer, backing.byteOffset + offset, size);
      expect(crc32(view)).toBe(zlib.crc32(view) >>> 0);
    }

    const combined = crypto.randomBytes(512 * 1024 + 5);
    let chained = 0;
    for (let cursor = 0; cursor < combined.length; ) {
      const step = Math.min(combined.length - cursor, (cursor % 41) + 1);
      chained = crc32(combined.subarray(cursor, cursor + step), chained);
      cursor += step;
    }
    expect(chained).toBe(zlib.crc32(combined) >>> 0);
  });

  oracleTest(
    'writes 20-byte ZIP64 local header extras and 24-byte descriptors for unsize-declared streams',
    ['python3', 'zipinfo', 'unzip', '7z'],
    async () => {
      const knownPayload = Buffer.from('known small payload');
      const streamPayload = crypto.randomBytes(128 * 1024 + 7);
      const asyncPayload = crypto.randomBytes(64 * 1024 + 3);

      const webStream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(streamPayload.subarray(0, 50_000));
          controller.enqueue(streamPayload.subarray(50_000));
          controller.close();
        },
      });
      async function* asyncGen(): AsyncGenerator<Uint8Array> {
        yield asyncPayload.subarray(0, 12_345);
        yield asyncPayload.subarray(12_345);
      }

      const zipBuffer = await collectZipBuffer([
        { name: 'known.txt', data: knownPayload, size: knownPayload.length },
        { name: 'streamed.bin', data: webStream },
        { name: 'async.bin', data: asyncGen() },
      ]);

      // Entry 0 (known < 4 GiB): classic 30-byte LFH with extraLength=0 and 16-byte DD.
      expect(zipBuffer.readUInt32LE(0)).toBe(0x04034b50);
      expect(zipBuffer.readUInt16LE(4)).toBe(20);
      expect(zipBuffer.readUInt16LE(26)).toBe('known.txt'.length);
      expect(zipBuffer.readUInt16LE(28)).toBe(0);
      const dd0At = 30 + 'known.txt'.length + knownPayload.length;
      expect(zipBuffer.readUInt32LE(dd0At)).toBe(0x08074b50);

      // Entry 1 (unsize-declared ReadableStream): ZIP64 LFH with 20-byte 0x0001 extra and 24-byte DD.
      const lfh1At = dd0At + 16;
      expect(zipBuffer.readUInt32LE(lfh1At)).toBe(0x04034b50);
      expect(zipBuffer.readUInt16LE(lfh1At + 4)).toBe(45);
      expect(zipBuffer.readUInt32LE(lfh1At + 18)).toBe(0xffffffff);
      expect(zipBuffer.readUInt32LE(lfh1At + 22)).toBe(0xffffffff);
      const name1Len = zipBuffer.readUInt16LE(lfh1At + 26);
      expect(name1Len).toBe('streamed.bin'.length);
      expect(zipBuffer.readUInt16LE(lfh1At + 28)).toBe(20);
      const extra1At = lfh1At + 30 + name1Len;
      expect(zipBuffer.readUInt16LE(extra1At)).toBe(0x0001);
      expect(zipBuffer.readUInt16LE(extra1At + 2)).toBe(16);
      expect(zipBuffer.readBigUInt64LE(extra1At + 4)).toBe(0n);
      expect(zipBuffer.readBigUInt64LE(extra1At + 12)).toBe(0n);
      const dd1At = extra1At + 20 + streamPayload.length;
      expect(zipBuffer.readUInt32LE(dd1At)).toBe(0x08074b50);
      expect(zipBuffer.readBigUInt64LE(dd1At + 8)).toBe(BigInt(streamPayload.length));
      expect(zipBuffer.readBigUInt64LE(dd1At + 16)).toBe(BigInt(streamPayload.length));

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'streaming-zip-mixed-'));
      const tmpZip = path.join(tmpDir, 'mixed.zip');
      try {
        fs.writeFileSync(tmpZip, zipBuffer);
        execFileSync(getOracleToolPath('zipinfo')!, ['-v', tmpZip], { stdio: 'ignore' });
        execFileSync(getOracleToolPath('unzip')!, ['-tq', tmpZip]);
        execFileSync(getOracleToolPath('7z')!, ['t', '-bd', tmpZip], { stdio: 'ignore' });
        const pyCheck = execFileSync(
          getOracleToolPath('python3')!,
          [
            '-I',
            '-c',
            [
              'import sys,zipfile,hashlib,json',
              'z=zipfile.ZipFile(sys.argv[1])',
              'assert z.testzip() is None',
              'out={n:hashlib.sha256(z.read(n)).hexdigest() for n in z.namelist()}',
              'print(json.dumps(out))',
            ].join(';'),
            tmpZip,
          ],
          { encoding: 'utf8' }
        );
        const hashes = JSON.parse(pyCheck) as Record<string, string>;
        expect(hashes['known.txt']).toBe(crypto.createHash('sha256').update(knownPayload).digest('hex'));
        expect(hashes['streamed.bin']).toBe(crypto.createHash('sha256').update(streamPayload).digest('hex'));
        expect(hashes['async.bin']).toBe(crypto.createHash('sha256').update(asyncPayload).digest('hex'));
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    }
  );

  oracleTest(
    'streams >= 4 GiB entry with ZIP64 local extra and post-4 GiB second entry into sparse archive accepted by zipinfo, unzip, 7z, and Python',
    ['python3', 'zipinfo', 'unzip', '7z'],
    async () => {
      const zeroChunk = Buffer.alloc(16 * 1024 * 1024);
      const tailBytes = Buffer.from('0123456789abcdef');
      const hugeSize = (1n << 32n) + BigInt(tailBytes.length);
      const after4gPayload = Buffer.from('hello after 4 GiB!');

      async function* hugeChunks(): AsyncGenerator<Uint8Array> {
        for (let i = 0; i < 256; i++) {
          yield zeroChunk;
        }
        yield tailBytes;
      }

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'streaming-zip-4g-'));
      const tmpZip = path.join(tmpDir, 'over4g.zip');
      let fd: number | undefined;
      let writeCursor = 0n;
      try {
        fd = fs.openSync(tmpZip, 'w+');
        try {
          for await (const chunk of streamZip([
            { name: 'huge.bin', data: hugeChunks(), size: hugeSize },
            { name: 'after4g.txt', data: after4gPayload, size: after4gPayload.length },
          ])) {
            if (chunk === zeroChunk) {
              writeCursor += BigInt(chunk.byteLength);
              continue;
            }
            fs.writeSync(fd, chunk, 0, chunk.byteLength, Number(writeCursor));
            writeCursor += BigInt(chunk.byteLength);
          }

          // Verify huge.bin Local File Header (offset 0) carries 20-byte 0x0001 extra.
          const headBuf = Buffer.alloc(58);
          fs.readSync(fd, headBuf, 0, headBuf.length, 0);
          expect(headBuf.readUInt16LE(4)).toBe(45);
          expect(headBuf.readUInt32LE(18)).toBe(0xffffffff);
          expect(headBuf.readUInt32LE(22)).toBe(0xffffffff);
          expect(headBuf.readUInt16LE(26)).toBe('huge.bin'.length);
          expect(headBuf.readUInt16LE(28)).toBe(20);
          expect(headBuf.readUInt16LE(38)).toBe(0x0001);
          expect(headBuf.readUInt16LE(40)).toBe(16);

          // Verify huge.bin 24-byte Data Descriptor immediately precedes after4g.txt at > 4 GiB.
          const ddOffset = 58n + hugeSize;
          const ddAndLfh2 = Buffer.alloc(24 + 30 + 'after4g.txt'.length);
          fs.readSync(fd, ddAndLfh2, 0, ddAndLfh2.length, Number(ddOffset));
          expect(ddAndLfh2.readUInt32LE(0)).toBe(0x08074b50);
          expect(ddAndLfh2.readBigUInt64LE(8)).toBe(hugeSize);
          expect(ddAndLfh2.readBigUInt64LE(16)).toBe(hugeSize);
          expect(ddAndLfh2.readUInt32LE(24)).toBe(0x04034b50);
          expect(ddAndLfh2.readUInt16LE(28)).toBe(20);
          expect(ddAndLfh2.readUInt16LE(52)).toBe(0);
        } finally {
          fs.closeSync(fd);
        }

        const zipinfoOut = execFileSync(getOracleToolPath('zipinfo')!, ['-v', tmpZip], { encoding: 'utf8' });
        expect(zipinfoOut).toContain('4294967312 bytes');
        execFileSync(getOracleToolPath('unzip')!, ['-tq', tmpZip]);
        execFileSync(getOracleToolPath('7z')!, ['t', '-bd', tmpZip], { stdio: 'ignore' });
        const pyRes = execFileSync(
          getOracleToolPath('python3')!,
          [
            '-I',
            '-c',
            [
              'import sys,zipfile,json',
              'z=zipfile.ZipFile(sys.argv[1])',
              'infos=z.infolist()',
              'print(json.dumps({"entries":[[i.filename,i.file_size,i.header_offset] for i in infos],"after":z.read("after4g.txt").decode()}))',
            ].join(';'),
            tmpZip,
          ],
          { encoding: 'utf8' }
        );
        const parsed = JSON.parse(pyRes) as { entries: Array<[string, number, number]>; after: string };
        expect(parsed.entries).toEqual([
          ['huge.bin', Number(hugeSize), 0],
          ['after4g.txt', after4gPayload.length, 58 + Number(hugeSize) + 24],
        ]);
        expect(parsed.after).toBe('hello after 4 GiB!');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
    SPARSE_ZIP64_TIMEOUT_MS
  );

  oracleTest('accepts an exact 65,535-byte entry name across Python zipfile', ['python3'], async () => {
    const maxName = 'a'.repeat(MAX_ZIP_ENTRY_NAME_BYTES);
    const payload = Buffer.from('boundary name payload');
    const zipBuffer = await collectZipBuffer([{ name: maxName, data: payload, size: payload.length }]);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'streaming-zip-maxname-'));
    const tmpZip = path.join(tmpDir, 'maxname.zip');
    try {
      fs.writeFileSync(tmpZip, zipBuffer);
      const out = execFileSync(
        getOracleToolPath('python3')!,
        [
          '-I',
          '-c',
          'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); n=z.namelist()[0]; print(len(n.encode()), z.read(n).decode())',
          tmpZip,
        ],
        { encoding: 'utf8' }
      ).trim();
      expect(out).toBe(`${MAX_ZIP_ENTRY_NAME_BYTES} boundary name payload`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects > 65,535-byte UTF-8 entry names and unsafe traversal paths', async () => {
    await expect(
      collectZipBuffer([{ name: 'a'.repeat(MAX_ZIP_ENTRY_NAME_BYTES + 1), data: Buffer.from('x') }])
    ).rejects.toThrow(RangeError);
    await expect(
      collectZipBuffer([{ name: '가'.repeat(21_846), data: Buffer.from('x') }])
    ).rejects.toThrow(RangeError);

    const badNames = [
      '',
      '/',
      'a\0b.txt',
      '/etc/passwd',
      '\\Windows\\win.ini',
      'C:\\evil.txt',
      'C:/evil.txt',
      'd:',
      '../secret.txt',
      'sub\\..\\evil.txt',
      './a.txt',
      'a/./b.txt',
      'a//b.txt',
    ];
    for (const badName of badNames) {
      await expect(collectZipBuffer([{ name: badName, data: Buffer.from('x') }])).rejects.toThrow(RangeError);
    }
  });

  it('rejects invalid or mismatched entry sizes and enforces the entry count limit', async () => {
    const empty = new Uint8Array(0);
    await expect(collectZipBuffer([{ name: 'neg.txt', data: empty, size: -1 }])).rejects.toThrow(RangeError);
    await expect(collectZipBuffer([{ name: 'negb.txt', data: empty, size: -1n }])).rejects.toThrow(RangeError);
    await expect(collectZipBuffer([{ name: 'nan.txt', data: empty, size: Number.NaN }])).rejects.toThrow(RangeError);
    await expect(
      collectZipBuffer([{ name: 'short.txt', data: [Buffer.alloc(9)], size: 10 }])
    ).rejects.toThrow(RangeError);
    await expect(
      collectZipBuffer([{ name: 'long.txt', data: [Buffer.alloc(11)], size: 10 }])
    ).rejects.toThrow(RangeError);

    function* tooManyEntries(): Generator<StreamingZipEntry> {
      for (let i = 0; i <= MAX_STREAMING_ZIP_ENTRIES; i++) {
        yield { name: `f/${i}.txt`, data: empty, size: 0 };
      }
    }
    const consumeAll = async (): Promise<void> => {
      for await (const chunk of streamZip(tooManyEntries())) {
        void chunk.byteLength;
      }
    };
    await expect(consumeAll()).rejects.toThrow(RangeError);
  });
});

describe('POST /api/storage/bundle', () => {
  it('refuses invalid or empty JSON body', async () => {
    const req = new NextRequest('http://localhost/api/storage/bundle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const res = await bundlePost(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.success).toBe(false);
  });

  it('refuses unknown or unauthorized storage key with 404', async () => {
    const req = new NextRequest('http://localhost/api/storage/bundle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        files: [{ key: 'conversions/unknown-user-id/12345_test.pdf', name: 'test.pdf' }],
      }),
    });
    const res = await bundlePost(req);
    expect(res.status).toBe(404);
  });
});
