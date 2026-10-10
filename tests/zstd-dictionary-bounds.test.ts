import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { POST as convertRoute } from '../src/app/api/convert/route';
import { convertArchive, extractTarArchive } from '../src/lib/conversions/archive';
import {
  compressWithZstdDict,
  DATA_DICTIONARY_JSON_CSV,
  getRawDictionaryContent,
  ZstdDictionaryStreamCompressor,
  decodeZstdCompressedBlockWithDict,
  decompressWithZstdDict,
  OFFICE_XML_DICTIONARY,
  ZSTD_DICT_MAGIC,
  ZSTD_OFFICE_DICT_MAGIC,
} from '../src/lib/conversions/zstd-dict';
import { decompressZstd, getZstdBinaryPath, ZSTD_SECURITY_LIMITS } from '../src/lib/conversions/zstd';
import { ConversionFailedError } from '../src/lib/types';
import { oracleTest } from './helpers/oracle-test';
import {
  assertFrameChecksum,
  buildFrame,
  buildRleBombFrame,
  compressedBlock,
  denseExpansionBlock,
  makeRng,
  maxExpansionPredefinedBlock,
  rawBlock,
  rleBlock,
  rleTableSequencesBlock,
  type TestBlock,
} from './helpers/zstd-frames';
import { SCALING_FACTOR, SCALING_TEST_TIMEOUT_MS, expectNoHangOnInput } from './helpers/timing';

/** Real engine, CLI or large-input work: the 5 s default fails on a loaded CI shard without any regression; 60 s only stops a hang. */
const ENGINE_TEST_TIMEOUT_MS = 60_000;
vi.setConfig({ testTimeout: ENGINE_TEST_TIMEOUT_MS });

const MIB = 1024 * 1024;
const BLOCK_MAX = 128 * 1024;
const LOW_ENTROPY_BASE_BYTES = 64 * 1024;
/** Hang guard only: a hostile block is refused in about a millisecond; decoding it in full would take far longer. */
const REJECTION_HANG_GUARD_MS = 10_000;
const RLE_BLOCK_SIZE_MAX = 2 ** 21 - 1;
const FLOOR_BLOCKS = (32 * MIB) / BLOCK_MAX;

function dictFrame(blocks: TestBlock[], dictionaryId = ZSTD_DICT_MAGIC, contentSize?: number): Buffer {
  if (contentSize !== undefined) {
    return buildFrame(blocks, { singleSegment: true, contentSize, dictionaryId });
  }
  return buildFrame(blocks, { windowLog: 17, dictionaryId });
}

function elapsedMs(action: () => void): number {
  const start = process.hrtime.bigint();
  action();
  return Number(process.hrtime.bigint() - start) / 1e6;
}

function captureError(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  return null;
}

/** Frame of `blockCount` blocks that each expand ~87:1 (1500 literal bytes become `BLOCK_MAX` bytes). */
function denseFrame(blockCount: number): Buffer {
  const block = denseExpansionBlock(1500, BLOCK_MAX, 5);
  const blocks: TestBlock[] = [];
  for (let i = 0; i < blockCount; i++) blocks.push(compressedBlock(block));
  return buildFrame(blocks, { windowLog: 17 });
}

function withDictionaryFile<T>(content: Buffer, action: (file: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zstd-dict-file-'));
  try {
    const file = path.join(dir, 'content.dict');
    fs.writeFileSync(file, content);
    return action(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('dictionary frames decode through the bounded block decoder', () => {
  for (const sequenceCount of [200, 1000, 2000, 4000, 8000]) {
    it(`rejects a ${sequenceCount}-sequence block that expands past the 128 KiB block maximum, fast`, () => {
      const { payload, decodedSize } = maxExpansionPredefinedBlock(sequenceCount, 100000);
      expect(decodedSize).toBeGreaterThan(BLOCK_MAX);
      const frame = dictFrame([compressedBlock(payload)]);
      let error: unknown = null;
      const ms = elapsedMs(() => {
        error = captureError(() => decompressWithZstdDict(frame, DATA_DICTIONARY_JSON_CSV));
      });
      expect(error).toBeInstanceOf(ConversionFailedError);
      expect((error as Error).message).toMatch(/block maximum|declared content size/);
      expect(ms).toBeLessThan(REJECTION_HANG_GUARD_MS);
    });
  }

  it('rejects the same block when the frame declares a small content size', () => {
    const { payload } = maxExpansionPredefinedBlock(2000, 100000);
    const frame = dictFrame([compressedBlock(payload)], ZSTD_DICT_MAGIC, 1000);
    let error: unknown = null;
    const ms = elapsedMs(() => {
      error = captureError(() => decompressWithZstdDict(frame, DATA_DICTIONARY_JSON_CSV));
    });
    expect(error).toBeInstanceOf(ConversionFailedError);
    expect(ms).toBeLessThan(REJECTION_HANG_GUARD_MS);
  });

  it('rejects RLE and raw blocks above the block maximum without allocating them', () => {
    const rle = dictFrame([rleBlock(0x61, RLE_BLOCK_SIZE_MAX)]);
    expect(captureError(() => decompressWithZstdDict(rle, DATA_DICTIONARY_JSON_CSV))).toBeInstanceOf(ConversionFailedError);
    const raw = dictFrame([rawBlock(Buffer.alloc(BLOCK_MAX + 1, 0x62))]);
    const error = captureError(() => decompressWithZstdDict(raw, DATA_DICTIONARY_JSON_CSV));
    expect(error).toBeInstanceOf(ConversionFailedError);
    expect((error as Error).message).toMatch(/block maximum/);
    const before = process.memoryUsage().arrayBuffers;
    const manyRle: TestBlock[] = [];
    for (let i = 0; i < 300; i++) manyRle.push(rleBlock(0x61, RLE_BLOCK_SIZE_MAX));
    expect(captureError(() => decompressWithZstdDict(dictFrame(manyRle), DATA_DICTIONARY_JSON_CSV))).toBeInstanceOf(
      ConversionFailedError
    );
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(64 * MIB);
  });

  it('applies the 32 MiB-floor ratio guard to dictionary frames', () => {
    const atFloor = buildFrame(Array.from({ length: FLOOR_BLOCKS }, () => rleBlock(0, BLOCK_MAX)), {
      windowLog: 17,
      dictionaryId: ZSTD_DICT_MAGIC,
    });
    expect(decompressWithZstdDict(atFloor, DATA_DICTIONARY_JSON_CSV).length).toBe(32 * MIB);
    const beyond = buildFrame(Array.from({ length: FLOOR_BLOCKS + 1 }, () => rleBlock(0, BLOCK_MAX)), {
      windowLog: 17,
      dictionaryId: ZSTD_DICT_MAGIC,
    });
    const error = captureError(() => decompressWithZstdDict(beyond, DATA_DICTIONARY_JSON_CSV));
    expect(error).toBeInstanceOf(ConversionFailedError);
    expect((error as Error).message).toMatch(/Archive bomb detected: compression ratio \(\d+\.\d:1\) exceeds 100:1 limit/);
  });

  it('decodes tens of thousands of sequences in linear time (hang guard; growth ratio in the perf suite)', async () => {
    const count = 30000;
    const frameOf = (sequences: number) => dictFrame([compressedBlock(rleTableSequencesBlock(sequences, 0x61))]);
    // 4x the sequences may cost at most 8x the time (tests/helpers/timing.ts); a quadratic decoder costs 16x.
    const { largeResult: decoded } = await expectNoHangOnInput(
      'dictionary sequences',
      (frame: Buffer) => decompressWithZstdDict(frame, DATA_DICTIONARY_JSON_CSV),
      frameOf(count)
    );
    expect(decoded.length).toBe(count * 4);
    expect(decoded.every((b) => b === 0x61)).toBe(true);
  }, SCALING_TEST_TIMEOUT_MS);

  it('fails dictionary id mismatches, bad magic and tampered checksums with typed errors', () => {
    const payload = Buffer.from('{"id":1,"name":"typed","status":"active"}\n'.repeat(20));
    const frame = compressWithZstdDict(payload, DATA_DICTIONARY_JSON_CSV);
    assertFrameChecksum(frame, payload);
    expect(Buffer.compare(decompressWithZstdDict(frame, DATA_DICTIONARY_JSON_CSV), payload)).toBe(0);
    expect(captureError(() => decompressWithZstdDict(frame, OFFICE_XML_DICTIONARY))).toBeInstanceOf(ConversionFailedError);
    const badMagic = Buffer.from(frame);
    badMagic[0] = 0;
    expect(captureError(() => decompressWithZstdDict(badMagic, DATA_DICTIONARY_JSON_CSV))).toBeInstanceOf(ConversionFailedError);
    const tampered = Buffer.from(frame);
    tampered[tampered.length - 1] ^= 0xff;
    expect(captureError(() => decompressWithZstdDict(tampered, DATA_DICTIONARY_JSON_CSV))).toBeInstanceOf(ConversionFailedError);
    expect(captureError(() => decompressWithZstdDict(frame.subarray(0, 10), DATA_DICTIONARY_JSON_CSV))).toBeInstanceOf(
      ConversionFailedError
    );
  });

  it('the block-level helper throws ConversionFailedError and is bounded too', () => {
    const { payload } = maxExpansionPredefinedBlock(2000, 100000);
    const ms = elapsedMs(() => {
      expect(captureError(() => decodeZstdCompressedBlockWithDict(payload, DATA_DICTIONARY_JSON_CSV))).toBeInstanceOf(
        ConversionFailedError
      );
    });
    expect(ms).toBeLessThan(REJECTION_HANG_GUARD_MS);
  });
});

describe('dictionary compression stays inside the 128 KiB block maximum', () => {
  function jsonRows(size: number, seed: number): Buffer {
    const rng = makeRng(seed);
    const parts: string[] = [];
    let total = 0;
    while (total < size) {
      const row = `{"id":${Math.floor(rng() * 100000)},"name":"user${Math.floor(rng() * 977)}","status":"${rng() < 0.7 ? 'active' : 'pending'}","score":${Math.floor(rng() * 1000)}}\n`;
      parts.push(row);
      total += row.length;
    }
    return Buffer.from(parts.join('').slice(0, size));
  }

  /** Block sizes of a single-segment frame with a 4-byte dictionary id and content size. */
  function declaredBlockSizes(frame: Buffer): number[] {
    const fcsBytes = [1, 2, 4, 8][frame[4] >> 6];
    let pos = 5 + 4 + fcsBytes;
    const sizes: number[] = [];
    let last = false;
    while (!last) {
      const header = frame[pos] | (frame[pos + 1] << 8) | (frame[pos + 2] << 16);
      pos += 3;
      last = (header & 1) === 1;
      const type = (header >> 1) & 3;
      const size = header >>> 3;
      sizes.push(size);
      pos += type === 1 ? 1 : size;
    }
    return sizes;
  }

  for (const size of [BLOCK_MAX - 1, BLOCK_MAX + 1, 300 * 1024]) {
    it(`round-trips ${size} bytes in blocks no larger than the maximum`, () => {
      const input = jsonRows(size, size);
      const frame = compressWithZstdDict(input, DATA_DICTIONARY_JSON_CSV);
      assertFrameChecksum(frame, input);
      for (const blockSize of declaredBlockSizes(frame)) expect(blockSize).toBeLessThanOrEqual(BLOCK_MAX);
      expect(Buffer.compare(decompressWithZstdDict(frame, DATA_DICTIONARY_JSON_CSV), input)).toBe(0);
    });
  }

  describe('large inputs (offsets and bit fields wider than 21 bits)', () => {
    const ROW = '{"id":10,"name":"alpha","ok":true}'.padEnd(39, ' ') + '\n';
    const RAW_DICTIONARY = Buffer.from(ROW.repeat(4));

    function repeatedRows(size: number): Buffer {
      return Buffer.from(ROW.repeat(Math.ceil(size / ROW.length)).slice(0, size));
    }

    it('the fixture dictionary is 160 bytes of 40-byte rows', () => {
      expect(ROW.length).toBe(40);
      expect(RAW_DICTIONARY.length).toBe(160);
    });

    oracleTest('round-trips 2 MiB - 1, 2 MiB, 3,000,000 and 4 MiB with the CLI as the decoder oracle', ['zstd'], () => {
      const bin = getZstdBinaryPath();
      if (!bin) throw new Error('zstd CLI path unavailable although the oracle precondition passed.');
      withDictionaryFile(RAW_DICTIONARY, (dictFile) => {
        for (const size of [2 * MIB - 1, 2 * MIB, 3_000_000, 4 * MIB]) {
          const input = repeatedRows(size);
          const frame = compressWithZstdDict(input, RAW_DICTIONARY, { dictId: 0 });
          assertFrameChecksum(frame, input);
          const viaCli = execFileSync(bin, ['-d', '-D', dictFile, '-c', '-q'], { input: frame, maxBuffer: 64 * MIB });
          expect(Buffer.compare(viaCli, input), `${size} bytes: CLI`).toBe(0);
          expect(Buffer.compare(decompressWithZstdDict(frame, RAW_DICTIONARY), input), `${size} bytes: repo`).toBe(0);
        }
      });
    });

    oracleTest('dictionary matches at offsets of 2^22 and more decode under the CLI', ['zstd'], () => {
      const bin = getZstdBinaryPath();
      if (!bin) throw new Error('zstd CLI path unavailable although the oracle precondition passed.');
      withDictionaryFile(RAW_DICTIONARY, (dictFile) => {
        // 4.5 MiB of zeros (RLE blocks) put the rows that follow more than 2^22 bytes after the dictionary.
        const input = Buffer.concat([Buffer.alloc(4 * MIB + 512 * 1024), repeatedRows(200 * 1024)]);
        const frame = compressWithZstdDict(input, RAW_DICTIONARY, { dictId: 0 });
        assertFrameChecksum(frame, input);
        const viaCli = execFileSync(bin, ['-d', '-D', dictFile, '-c', '-q'], { input: frame, maxBuffer: 64 * MIB });
        expect(Buffer.compare(viaCli, input)).toBe(0);
        expect(Buffer.compare(decompressWithZstdDict(frame, RAW_DICTIONARY), input)).toBe(0);
        // The rows after the zeros were coded as dictionary matches, not stored as literals.
        expect(frame.length).toBeLessThan(MIB / 16);
      });
    });
  });

  it('bounds the match search so low-entropy input does not make compression quadratic (hang guard; growth ratio in the perf suite)', async () => {
    const lowEntropy = (bytes: number) => {
      const rng = makeRng(2024);
      const input = Buffer.alloc(bytes);
      for (let i = 0; i < input.length; i++) input[i] = rng() < 0.5 ? 0x30 : 0x31;
      return input;
    };
    // 4x the input may cost at most 8x the time; an unbounded match search costs 16x (tests/helpers/timing.ts).
    const input = lowEntropy(LOW_ENTROPY_BASE_BYTES * SCALING_FACTOR);
    const { largeResult: frame } = await expectNoHangOnInput(
      'low-entropy compression',
      (data: Buffer) => compressWithZstdDict(data, DATA_DICTIONARY_JSON_CSV),
      input
    );
    assertFrameChecksum(frame, input);
    expect(Buffer.compare(decompressWithZstdDict(frame, DATA_DICTIONARY_JSON_CSV), input)).toBe(0);
  }, SCALING_TEST_TIMEOUT_MS);

  oracleTest('the zstd CLI decodes multi-block frames made against a raw-content dictionary', ['zstd'], () => {
    const bin = getZstdBinaryPath();
    if (!bin) throw new Error('zstd CLI path unavailable although the oracle precondition passed.');
    const content = getRawDictionaryContent(DATA_DICTIONARY_JSON_CSV);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zstd-dict-multi-'));
    try {
      const dictFile = path.join(dir, 'content.dict');
      fs.writeFileSync(dictFile, content);
      for (const size of [BLOCK_MAX + 1, 300 * 1024]) {
        const input = jsonRows(size, size + 1);
        const frame = compressWithZstdDict(input, content, { dictId: 0 });
        const decoded = execFileSync(bin, ['-d', '-D', dictFile, '-c', '-q'], { input: frame, maxBuffer: 64 * MIB });
        expect(Buffer.compare(decoded, input), `${size} bytes`).toBe(0);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the stream compressor splits a large write into blocks the frame decoder accepts', () => {
    const input = jsonRows(300 * 1024, 77);
    const compressor = new ZstdDictionaryStreamCompressor({ dictionary: DATA_DICTIONARY_JSON_CSV });
    const frame = Buffer.concat([compressor.write(input), compressor.end()]);
    expect(Buffer.compare(decompressWithZstdDict(frame, DATA_DICTIONARY_JSON_CSV), input)).toBe(0);
  });
});

describe('dictionary frames produced by the zstd CLI', () => {
  function sampleRecords(count: number): Buffer[] {
    const rng = makeRng(31);
    const cities = ['Berlin', 'Lisbon', 'Osaka', 'Austin', 'Nairobi', 'Oslo', 'Quito', 'Hanoi'];
    const records: Buffer[] = [];
    for (let i = 0; i < count; i++) {
      records.push(
        Buffer.from(
          JSON.stringify({
            id: 1000 + i,
            user: `user-${Math.floor(rng() * 9000)}`,
            city: cities[Math.floor(rng() * cities.length)],
            active: rng() < 0.5,
            balance: Math.floor(rng() * 100000) / 100,
            tags: ['alpha', 'beta', 'gamma'].slice(0, 1 + Math.floor(rng() * 3)),
            note: 'order processed by the regional settlement service without errors',
          })
        )
      );
    }
    return records;
  }

  function withTempDir<T>(action: (dir: string) => T): T {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zstd-dict-'));
    try {
      return action(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  function zstd(args: string[], input?: Buffer): Buffer {
    const bin = getZstdBinaryPath();
    if (!bin) throw new Error('zstd CLI path unavailable although the oracle precondition passed.');
    return execFileSync(bin, args, { input, maxBuffer: 64 * MIB, stdio: ['pipe', 'pipe', 'pipe'] });
  }

  oracleTest('decodes frames made with a raw-content dictionary (zstd -D)', ['zstd'], () => {
    withTempDir((dir) => {
      const content = Buffer.concat(sampleRecords(40));
      const dictFile = path.join(dir, 'raw.dict');
      fs.writeFileSync(dictFile, content);
      for (const level of [1, 3, 19]) {
        for (const record of sampleRecords(12)) {
          const frame = zstd([`-${level}`, '-D', dictFile, '-c', '-q'], record);
          const decoded = decompressWithZstdDict(frame, content);
          expect(Buffer.compare(decoded, record), `level ${level}`).toBe(0);
        }
      }
    });
  });

  oracleTest('decodes multi-block CLI frames over 256 KiB whose matches reach back across blocks', ['zstd'], () => {
    withTempDir((dir) => {
      const content = Buffer.concat(sampleRecords(40));
      const dictFile = path.join(dir, 'raw.dict');
      fs.writeFileSync(dictFile, content);
      // Unique records, then a copy of the first 60 KB more than 256 KiB later: the copy only
      // compresses if the decoder keeps every earlier block as history.
      const unique = Buffer.concat(sampleRecords(2400).map((record, index) => Buffer.concat([record, Buffer.from(`#${index * 7919}\n`)])));
      expect(unique.length).toBeGreaterThan(256 * 1024);
      const head = unique.subarray(0, 60 * 1024);
      const payload = Buffer.concat([unique, head]);
      for (const level of [3, 19]) {
        const frame = zstd([`-${level}`, '-D', dictFile, '-c', '-q'], payload);
        const withoutCopy = zstd([`-${level}`, '-D', dictFile, '-c', '-q'], unique);
        expect(payload.length).toBeGreaterThan(256 * 1024);
        expect(frame.length - withoutCopy.length, `level ${level}: the far copy is a match`).toBeLessThan(2048);
        const decoded = decompressWithZstdDict(frame, content);
        expect(decoded.length).toBe(payload.length);
        expect(Buffer.compare(decoded, payload), `level ${level}`).toBe(0);
      }
    });
  });

  oracleTest('decodes frames made with a trained dictionary (entropy tables, repeat offsets and content)', ['zstd'], () => {
    withTempDir((dir) => {
      const samples = sampleRecords(800);
      const paths: string[] = [];
      samples.forEach((sample, index) => {
        const file = path.join(dir, `sample-${index}.json`);
        fs.writeFileSync(file, sample);
        paths.push(file);
      });
      const dictFile = path.join(dir, 'trained.dict');
      zstd(['--train', '-q', '--maxdict=4096', '-o', dictFile, ...paths]);
      const dictionary = fs.readFileSync(dictFile);
      expect(dictionary.readUInt32LE(0)).toBe(0xec30a437);

      const payloads = [
        samples[7],
        Buffer.concat(samples.slice(0, 30)),
        Buffer.concat(sampleRecords(900).slice(100, 700)),
        Buffer.from('completely unrelated text that the dictionary never saw, '.repeat(40)),
      ];
      for (const level of [1, 3, 9, 19]) {
        for (const payload of payloads) {
          const frame = zstd([`-${level}`, '-D', dictFile, '-c', '-q'], payload);
          expect(frame.readUInt8(4) & 0x03, 'frame carries a dictionary id').toBeGreaterThan(0);
          const decoded = decompressWithZstdDict(frame, dictionary);
          expect(decoded.length, `level ${level}`).toBe(payload.length);
          expect(Buffer.compare(decoded, payload), `level ${level}`).toBe(0);
        }
      }
      // A frame for another dictionary id is refused, not decoded against the wrong history.
      const frame = zstd(['-3', '-D', dictFile, '-c', '-q'], samples[0]);
      expect(captureError(() => decompressWithZstdDict(frame, DATA_DICTIONARY_JSON_CSV))).toBeInstanceOf(ConversionFailedError);
    });
  });

  /** Uneven write sizes, including a 1-byte write and sizes that straddle the 128 KiB block boundary. */
  const STREAM_WRITE_SIZES = [65537, 131072, 1, 200000, 3, 262145, 77777];

  function streamCompress(compressor: ZstdDictionaryStreamCompressor, payload: Buffer): Buffer {
    const parts: Buffer[] = [];
    let offset = 0;
    for (let step = 0; offset < payload.length; step++) {
      const size = STREAM_WRITE_SIZES[step % STREAM_WRITE_SIZES.length];
      parts.push(compressor.write(payload.subarray(offset, offset + size)));
      offset += size;
    }
    parts.push(compressor.end());
    return Buffer.concat(parts);
  }

  function jsonPayload(size: number, source: Buffer[]): Buffer {
    const rows = Buffer.concat(source);
    return Buffer.concat(Array.from({ length: Math.ceil(size / rows.length) }, () => rows)).subarray(0, size);
  }

  function sha256Hex(data: Buffer): string {
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  oracleTest('decodes stream-compressor output (raw dictionary, dictId 0, uneven writes) with zstd -D', ['zstd'], () => {
    withTempDir((dir) => {
      const content = Buffer.concat(sampleRecords(40));
      const dictFile = path.join(dir, 'raw.dict');
      fs.writeFileSync(dictFile, content);
      const source = sampleRecords(3000).map((record, index) => Buffer.concat([record, Buffer.from(`#${index}\n`)]));
      for (const size of [3_000_000, 4 * MIB]) {
        const payload = jsonPayload(size, source);
        const frame = streamCompress(new ZstdDictionaryStreamCompressor({ dictionary: content, dictId: 0 }), payload);
        assertFrameChecksum(frame, payload);
        const decoded = zstd(['-d', '-D', dictFile, '-c', '-q'], frame);
        expect(decoded.length, `${size} bytes`).toBe(size);
        expect(sha256Hex(decoded), `${size} bytes: sha256`).toBe(sha256Hex(payload));
        expect(Buffer.compare(decompressWithZstdDict(frame, content), payload), `${size} bytes: repo`).toBe(0);
        expect(frame.length, 'dictionary and repeats make the stream compress').toBeLessThan(payload.length / 2);
      }
    });
  });

  oracleTest('decodes stream-compressor output made with a trained dictionary under its real id', ['zstd'], () => {
    withTempDir((dir) => {
      const samples = sampleRecords(800);
      const paths: string[] = [];
      samples.forEach((sample, index) => {
        const file = path.join(dir, `sample-${index}.json`);
        fs.writeFileSync(file, sample);
        paths.push(file);
      });
      const dictFile = path.join(dir, 'trained.dict');
      zstd(['--train', '-q', '--maxdict=4096', '-o', dictFile, ...paths]);
      const dictionary = fs.readFileSync(dictFile);
      const realId = dictionary.readUInt32LE(4);
      expect(realId).not.toBe(0);

      const source = sampleRecords(3000).map((record, index) => Buffer.concat([record, Buffer.from(`#${index}\n`)]));
      for (const size of [3_000_000, 4 * MIB]) {
        const payload = jsonPayload(size, source);
        const compressor = new ZstdDictionaryStreamCompressor({ dictionary });
        expect(compressor.getDictionaryId()).toBe(realId);
        const frame = streamCompress(compressor, payload);
        assertFrameChecksum(frame, payload);
        // Frame_Header_Descriptor 0x?? | window byte | four-byte Dictionary_ID
        expect(frame.readUInt32LE(6), 'frame carries the dictionary id').toBe(realId);
        const decoded = zstd(['-d', '-D', dictFile, '-c', '-q'], frame);
        expect(decoded.length, `${size} bytes`).toBe(size);
        expect(sha256Hex(decoded), `${size} bytes: sha256`).toBe(sha256Hex(payload));
        expect(Buffer.compare(decompressWithZstdDict(frame, dictionary), payload), `${size} bytes: repo`).toBe(0);
      }
    });
  });
});

describe('archive conversion maps dictionary failures to typed errors', () => {
  it('round-trips a dictionary-compressed archive and auto-detects the dictionary from the frame id', async () => {
    const content = Buffer.from('{"id":7,"status":"active","name":"alpha"}\n'.repeat(200));
    for (const [name, dictionary, expectedId] of [
      ['data', DATA_DICTIONARY_JSON_CSV, ZSTD_DICT_MAGIC],
      ['office', OFFICE_XML_DICTIONARY, ZSTD_OFFICE_DICT_MAGIC],
    ] as const) {
      const created = await convertArchive(content, 'json', 'zst', { zstdDict: name }, 'records.json');
      // Frame_Header_Descriptor bit 5 is the single-segment flag; without it a window byte precedes the id.
      const idOffset = 5 + ((created.buffer[4] & 0x20) === 0 ? 1 : 0);
      expect(created.buffer[4] & 0x03, 'dictionary id field is four bytes').toBe(3);
      expect(created.buffer.readUInt32LE(idOffset)).toBe(expectedId);
      expect(Buffer.compare(decompressWithZstdDict(created.buffer, dictionary), content)).toBe(0);

      for (const options of [{}, { zstdDict: name }]) {
        const extracted = await convertArchive(created.buffer, 'zst', 'tar', options, 'records.json.zst');
        const files = extractTarArchive(extracted.buffer);
        expect(files.map((file) => file.filename)).toEqual(['records.json']);
        expect(Buffer.compare(files[0].buffer, content), `${name} ${JSON.stringify(options)}`).toBe(0);
      }
    }
  });

  it('wraps dictionary bombs and malformed dictionary frames in ConversionFailedError', async () => {
    const { payload } = maxExpansionPredefinedBlock(2000, 100000);
    const bomb = dictFrame([compressedBlock(payload)]);
    const attempts: Array<[() => Promise<unknown>, RegExp]> = [
      [() => convertArchive(bomb, 'zst', 'tar', { zstdDict: 'data' }, 'bomb.zst'), /block maximum|declared content size/],
      // The frame names the data dictionary, so the office dictionary is refused outright.
      [() => convertArchive(bomb, 'zst', 'tar', { zstdDict: 'office' }, 'bomb.zst'), /Dictionary mismatch/],
      [
        () => convertArchive(bomb.subarray(0, bomb.length - 5), 'zst', 'tar', { zstdDict: 'data' }, 'cut.zst'),
        /truncated|out of bounds|over-read|not fully consumed/i,
      ],
    ];
    for (const [attempt, message] of attempts) {
      await expect(attempt()).rejects.toBeInstanceOf(ConversionFailedError);
      await expect(attempt()).rejects.toThrow(message);
    }
  });

  it('maps a zstd decompression bomb to HTTP 400 at the convert route', async () => {
    const bomb = buildRleBombFrame(FLOOR_BLOCKS + 1);
    const formData = new FormData();
    formData.append('file', new File([new Uint8Array(bomb)], 'bomb.zst', { type: 'application/zstd' }));
    formData.append('targetFormat', 'zip');
    const response = await convertRoute(new NextRequest('http://localhost/api/convert', { method: 'POST', body: formData }));
    const body = (await response.json()) as { success: boolean; error: string };
    expect(response.status, body.error).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/Archive bomb detected/);
  });

  it('maps a dictionary frame that requires an unavailable dictionary to HTTP 400', async () => {
    const frame = dictFrame([rawBlock(Buffer.from('abc'))], 0x1234abcd);
    const formData = new FormData();
    formData.append('file', new File([new Uint8Array(frame)], 'needs-dict.zst', { type: 'application/zstd' }));
    formData.append('targetFormat', 'zip');
    const response = await convertRoute(new NextRequest('http://localhost/api/convert', { method: 'POST', body: formData }));
    expect(response.status).toBe(400);
  });
});

describe('cumulative decoded-size accounting', () => {
  it('rejects the 500 MB cap on data that was actually decoded, with no declared size and ratio below 100:1', () => {
    const cap = ZSTD_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE;
    const blocksAtCap = cap / BLOCK_MAX;
    const frame = denseFrame(blocksAtCap + 1);
    expect(cap / frame.length).toBeLessThan(ZSTD_SECURITY_LIMITS.MAX_RATIO);
    const error = captureError(() => decompressZstd(frame));
    expect(error).toBeInstanceOf(ConversionFailedError);
    expect((error as Error).message).toMatch(/uncompressed size exceeds limit of 524288000 bytes/);
  }, 120000);

  it('accumulates output across frames and ignores skippable frames when counting the cap', () => {
    const original = ZSTD_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE;
    ZSTD_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE = 40 * MIB;
    try {
      const oneFrame = denseFrame((24 * MIB) / BLOCK_MAX);
      const skippable = Buffer.alloc(8 + 1000);
      skippable.writeUInt32LE(0x184d2a50, 0);
      skippable.writeUInt32LE(1000, 4);
      expect(decompressZstd(Buffer.concat([skippable, oneFrame, skippable])).length).toBe(24 * MIB);
      const twice = Buffer.concat([skippable, oneFrame, skippable, oneFrame]);
      const error = captureError(() => decompressZstd(twice));
      expect(error).toBeInstanceOf(ConversionFailedError);
      expect((error as Error).message).toMatch(/uncompressed size exceeds limit of 41943040 bytes/);
    } finally {
      ZSTD_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE = original;
    }
  });

  it('counts output across frames toward the ratio guard once it passes the floor', () => {
    const half = buildRleBombFrame(FLOOR_BLOCKS / 2 + 1);
    expect(decompressZstd(half).length).toBe((FLOOR_BLOCKS / 2 + 1) * BLOCK_MAX);
    const error = captureError(() => decompressZstd(Buffer.concat([half, half])));
    expect(error).toBeInstanceOf(ConversionFailedError);
    expect((error as Error).message).toMatch(/compression ratio/);
  });

  it('applies the same cumulative cap in the dictionary decoder', () => {
    const original = ZSTD_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE;
    ZSTD_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE = 40 * MIB;
    try {
      const block = denseExpansionBlock(1500, BLOCK_MAX, 9);
      const blocks = Array.from({ length: (48 * MIB) / BLOCK_MAX }, () => compressedBlock(block));
      const error = captureError(() => decompressWithZstdDict(dictFrame(blocks), DATA_DICTIONARY_JSON_CSV));
      expect(error).toBeInstanceOf(ConversionFailedError);
      expect((error as Error).message).toMatch(/uncompressed size exceeds limit/);
    } finally {
      ZSTD_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE = original;
    }
  });
});
