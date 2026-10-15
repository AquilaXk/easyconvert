import { describe, it, expect } from 'vitest';
import { DATA_DICTIONARY_JSON_CSV, ZstdDictionaryStreamCompressor, decompressWithZstdDict } from '../src/lib/conversions/zstd-dict';
import { expectLinearOnInputs, SCALING_FACTOR, SCALING_TEST_TIMEOUT_MS } from './helpers/timing';

/**
 * Timing-ratio checks moved out of zstd-streaming-dict.test.ts.
 * They compare runs of the same work and need a quiet machine, so they run in the nightly performance workflow
 * (`npx vitest run --no-file-parallelism .perf.test.ts`) and not in the PR gate.
 */

describe('RFC 8878 Chunked Streaming Zstandard Dictionary Compression (#191)', () => {
  // Helper: Generates realistic repetitive JSON/CSV payload
  function generateSyntheticDataPayload(recordCount = 2000): Buffer {
    const records = [];
    for (let i = 0; i < recordCount; i++) {
      records.push({
        id: i,
        name: `CustomerRecord_${i}`,
        type: 'enterprise_account',
        status: i % 2 === 0 ? 'active' : 'pending',
        created_at: '2026-09-28T12:00:00Z',
        updated_at: '2026-09-28T12:30:00Z',
        timestamp: 1790684400 + i,
        success: true,
        error: null,
        message: 'ok',
        code: 200,
        data: {
          results: [i, i * 2, i * 3],
          count: 3,
          total: 1000,
          offset: 0,
          limit: 100,
          version: '1.0',
          encoding: 'utf-8',
        },
      });
    }
    return Buffer.from(JSON.stringify(records), 'utf-8');
  }

  describe('3. Bandwidth Reduction (>= 70%) and Throughput Benchmark', () => {
    const CHUNK_SIZE = 64 * 1024;

    /** Records of the smaller payload in the scaling comparison (about 0.3 MB of JSON); the larger one has SCALING_FACTOR times as many. */
    const SCALING_BASE_RECORDS = 1000;

    function compressInChunks(payload: Buffer): Buffer {
      const compressor = new ZstdDictionaryStreamCompressor({ dictionary: DATA_DICTIONARY_JSON_CSV });
      const compressedChunks: Buffer[] = [];
      for (let offset = 0; offset < payload.length; offset += CHUNK_SIZE) {
        const comp = compressor.write(payload.subarray(offset, offset + CHUNK_SIZE));
        if (comp.length > 0) compressedChunks.push(comp);
      }
      const finalBytes = compressor.end();
      if (finalBytes.length > 0) compressedChunks.push(finalBytes);
      return Buffer.concat(compressedChunks);
    }

    it('compresses in time linear in the payload size, restoring each payload', async () => {
      const small = generateSyntheticDataPayload(SCALING_BASE_RECORDS);
      const large = generateSyntheticDataPayload(SCALING_BASE_RECORDS * SCALING_FACTOR);
      const { largeResult: compressed } = await expectLinearOnInputs('ZstdDictionaryStreamCompressor', (payload: Buffer) => compressInChunks(payload), { small, large });
      expect(decompressWithZstdDict(compressed, DATA_DICTIONARY_JSON_CSV).equals(large)).toBe(true);
    }, SCALING_TEST_TIMEOUT_MS);
  });
});
