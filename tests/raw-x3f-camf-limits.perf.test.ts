import { describe, it, expect } from 'vitest';
import { decodeCamfBytes } from '../src/lib/conversions/raw-x3f';
import { RawDecodeError } from '../src/lib/types';
import { expectSizeIndependentOnInputs, SCALING_TEST_TIMEOUT_MS } from './helpers/timing';

/**
 * Timing-ratio checks moved out of raw-x3f-camf-limits.test.ts.
 * They compare runs of the same work and need a quiet machine, so they run in the nightly performance workflow
 * (`npx vitest run --no-file-parallelism .perf.test.ts`) and not in the PR gate.
 * The PR gate keeps a hang guard on the same hostile input in raw-x3f-camf-limits.test.ts.
 */

const CAMF_HEADER_BYTES = 28;
const CAMF_TYPE_BLOCK_HUFFMAN = 4;
const TABLE_AND_PAD_BYTES = 32;
const STREAM_BYTES = 64;
const DECODED_BYTES = 10;
const UINT32_MAX = 0xffffffff;
/** Block count of the modest header the huge one is compared with. */
const MODEST_BLOCK_COUNT = 1000;

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

function decode(file: Buffer): { error: unknown } {
  try {
    decodeCamfBytes(file, { offset: 0, length: file.length, type: 'CAMF' });
    return { error: null };
  } catch (error) {
    return { error };
  }
}

describe('CAMF type-4 block grid bounds', () => {
  it('rejects a block count of four billion after the same work as a count of a thousand', async () => {
    // A reader that trusts the declared grid walks it: four billion blocks take seconds, a thousand take
    // microseconds. The comparison is made in-process (tests/helpers/timing.ts), so it holds on a slow runner.
    const { largeResult } = await expectSizeIndependentOnInputs('CAMF block count', (file: Buffer) => decode(file), {
      modest: camfSection(0, MODEST_BLOCK_COUNT),
      huge: camfSection(0, UINT32_MAX),
    });
    expect(largeResult.error).toBeInstanceOf(RawDecodeError);
    expect((largeResult.error as RawDecodeError).message).toMatch(/CAMF block grid/);
  }, SCALING_TEST_TIMEOUT_MS);
});
