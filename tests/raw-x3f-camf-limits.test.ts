import { describe, it, expect } from 'vitest';
import { decodeCamfBytes } from '../src/lib/conversions/raw-x3f';
import { RawDecodeError } from '../src/lib/types';

const CAMF_HEADER_BYTES = 28;
const CAMF_TYPE_BLOCK_HUFFMAN = 4;
const TABLE_AND_PAD_BYTES = 32;
const STREAM_BYTES = 64;
const DECODED_BYTES = 10;
const UINT32_MAX = 0xffffffff;
/** A hostile header must be rejected long before the worker thread's time limit. */
const REJECT_WITHIN_MS = 1000;

/** A type-4 CAMF section with a one-code table and the given block grid. */
function camfSection(blockSize: number, blockCount: number): Buffer {
  const header = Buffer.alloc(CAMF_HEADER_BYTES);
  header.write('SECc', 0, 'ascii');
  header.writeUInt32LE(CAMF_TYPE_BLOCK_HUFFMAN, 8);
  header.writeUInt32LE(DECODED_BYTES, 12);
  header.writeUInt32LE(0, 16);
  header.writeUInt32LE(blockSize, 20);
  header.writeUInt32LE(blockCount, 24);
  const table = Buffer.alloc(TABLE_AND_PAD_BYTES);
  table[0] = 0x01;
  table[1] = 0x80;
  return Buffer.concat([header, table, Buffer.alloc(STREAM_BYTES)]);
}

function decode(file: Buffer): { error: unknown; elapsedMs: number } {
  const started = Date.now();
  try {
    decodeCamfBytes(file, { offset: 0, length: file.length, type: 'CAMF' });
    return { error: null, elapsedMs: Date.now() - started };
  } catch (error) {
    return { error, elapsedMs: Date.now() - started };
  }
}

describe('CAMF type-4 block grid bounds', () => {
  it.each([
    ['an empty block size with a huge block count', 0, UINT32_MAX],
    ['a zero block count', 4, 0],
    ['a grid too small for the declared output', 1, 1],
  ])('rejects %s quickly with a typed error', (_label, blockSize, blockCount) => {
    const { error, elapsedMs } = decode(camfSection(blockSize, blockCount));
    expect(error).toBeInstanceOf(RawDecodeError);
    expect((error as RawDecodeError).message).toMatch(/CAMF block grid/);
    expect(elapsedMs).toBeLessThan(REJECT_WITHIN_MS);
  });
});
