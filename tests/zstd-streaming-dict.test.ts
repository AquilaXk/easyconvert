import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import {
  DATA_DICTIONARY_JSON_CSV,
  OFFICE_XML_DICTIONARY,
  ZSTD_DICT_MAGIC,
  ZSTD_OFFICE_DICT_MAGIC,
  ZstdDictionaryStreamCompressor,
  ZstdDictionaryStreamDecompressor,
  createZstdDictionaryTransformStream,
  createZstdDictionaryDecompressTransformStream,
} from '../src/lib/conversions/zstd-dict';

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

  // Helper: Generates realistic Office DrawingML / OpenXML payload
  function generateSyntheticOfficeXmlPayload(elementCount = 1500): Buffer {
    const parts = [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><w:body>',
    ];
    for (let i = 0; i < elementCount; i++) {
      parts.push(
        `<w:p><w:r><w:t>Section Paragraph Content ${i}</w:t></w:r></w:p>`,
        `<p:sp><p:nvSpPr><p:cNvPr id="${i}" name="Shape${i}"/><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${i * 100}" cy="${i * 200}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:nvSpPr></p:sp>`,
        `<c:chart><c:plotArea><c:barChart><c:grouping val="standard"/><c:ser><c:idx val="${i}"/><c:order val="${i}"/></c:ser></c:barChart></c:plotArea></c:chart>`
      );
    }
    parts.push('</w:body></w:document>');
    return Buffer.from(parts.join(''), 'utf-8');
  }

  // Helper to read all chunks from a W3C ReadableStream
  async function streamToBuffer(readable: ReadableStream<Uint8Array>): Promise<Buffer> {
    const reader = readable.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c)));
  }

  describe('1. RFC 8878 Frame Header & 4-byte Dictionary ID Injection', () => {
    it('injects 4-byte Dictionary ID 0xEC012026 into the streaming frame header at exact offset', () => {
      const compressor = new ZstdDictionaryStreamCompressor({
        dictionary: DATA_DICTIONARY_JSON_CSV,
      });

      const chunk = Buffer.from('{"id":101,"status":"active","success":true}', 'utf-8');
      const compressedFirstChunk = compressor.write(chunk);

      // 1. Zstandard Magic Number (0xFD2FB528 -> [0x28, 0xb5, 0x2f, 0xfd])
      expect(compressedFirstChunk.readUInt32LE(0)).toBe(0xfd2fb528);

      // 2. Frame Header Descriptor (FHD)
      // DictID_Flag = 3 (4 bytes DictID), Content_Checksum_Flag = 1, Single_Segment = 0, FCS_Flag = 0
      const fhd = compressedFirstChunk[4];
      expect(fhd & 0x03).toBe(3); // 4-byte DictID flag
      expect((fhd >> 2) & 0x01).toBe(1); // Content Checksum flag enabled
      expect((fhd >> 5) & 0x01).toBe(0); // Single Segment = 0 (streaming)

      // 3. Window Descriptor byte at offset 5
      expect(compressedFirstChunk[5]).toBeGreaterThan(0);

      // 4. 4-byte Dictionary ID at offset 6 (0xEC012026 Little Endian)
      const injectedDictId = compressedFirstChunk.readUInt32LE(6);
      expect(injectedDictId).toBe(ZSTD_DICT_MAGIC);
      expect(injectedDictId).toBe(0xec012026);
    });

    it('injects 4-byte Office Dictionary ID 0xEC012027 when compressing Office XML streams', () => {
      const compressor = new ZstdDictionaryStreamCompressor({
        dictionary: OFFICE_XML_DICTIONARY,
      });

      const chunk = Buffer.from('<w:document><w:body><w:p><w:r><w:t>Sample Text</w:t></w:r></w:p></w:body></w:document>', 'utf-8');
      const compressedFirstChunk = compressor.write(chunk);

      const injectedDictId = compressedFirstChunk.readUInt32LE(6);
      expect(injectedDictId).toBe(ZSTD_OFFICE_DICT_MAGIC);
      expect(injectedDictId).toBe(0xec012027);
    });
  });

  describe('2. W3C TransformStream Pipeline & Lossless Roundtrip', () => {
    it('compresses and decompresses chunked JSON stream losslessly preserving exact SHA-256 hash', async () => {
      const originalPayload = generateSyntheticDataPayload(3000);
      const originalHash = crypto.createHash('sha256').update(originalPayload).digest('hex');

      // Split original payload into 64KB stream chunks
      const chunkSize = 64 * 1024;
      const chunks: Buffer[] = [];
      for (let i = 0; i < originalPayload.length; i += chunkSize) {
        chunks.push(originalPayload.subarray(i, i + chunkSize));
      }

      // W3C ReadableStream of raw chunks
      const rawStream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const c of chunks) {
            controller.enqueue(new Uint8Array(c));
          }
          controller.close();
        },
      });

      // Pipe through W3C Compress and Decompress TransformStreams
      const compressedStream = rawStream.pipeThrough(
        createZstdDictionaryTransformStream({ dictionary: DATA_DICTIONARY_JSON_CSV })
      );

      const decompressedStream = compressedStream.pipeThrough(
        createZstdDictionaryDecompressTransformStream({ dictionary: DATA_DICTIONARY_JSON_CSV })
      );

      const restoredBuffer = await streamToBuffer(decompressedStream);
      const restoredHash = crypto.createHash('sha256').update(restoredBuffer).digest('hex');

      expect(restoredBuffer.length).toBe(originalPayload.length);
      expect(restoredHash).toBe(originalHash);
      expect(restoredBuffer.equals(originalPayload)).toBe(true);
    });

    it('compresses and decompresses Office XML streams losslessly through TransformStreams', async () => {
      const originalPayload = generateSyntheticOfficeXmlPayload(2000);
      const originalHash = crypto.createHash('sha256').update(originalPayload).digest('hex');

      const chunkSize = 32 * 1024;
      const chunks: Buffer[] = [];
      for (let i = 0; i < originalPayload.length; i += chunkSize) {
        chunks.push(originalPayload.subarray(i, i + chunkSize));
      }

      const rawStream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const c of chunks) controller.enqueue(new Uint8Array(c));
          controller.close();
        },
      });

      const compressedStream = rawStream.pipeThrough(
        createZstdDictionaryTransformStream({ dictionary: OFFICE_XML_DICTIONARY })
      );

      const decompressedStream = compressedStream.pipeThrough(
        createZstdDictionaryDecompressTransformStream({ dictionary: OFFICE_XML_DICTIONARY })
      );

      const restoredBuffer = await streamToBuffer(decompressedStream);
      const restoredHash = crypto.createHash('sha256').update(restoredBuffer).digest('hex');

      expect(restoredBuffer.length).toBe(originalPayload.length);
      expect(restoredHash).toBe(originalHash);
    });
  });

  describe('3. Bandwidth Reduction (>= 70%) and Throughput (>= 180MB/s) Benchmark', () => {
    it('achieves >= 70% bandwidth reduction and sustains >= 180 MB/s streaming throughput', () => {
      const payload = generateSyntheticDataPayload(5000); // ~1.5MB realistic JSON
      const originalSize = payload.length;
      const chunkSize = 64 * 1024;

      // JIT compiler warmup to allow V8 TurboFan native optimization
      const warmupCompressor = new ZstdDictionaryStreamCompressor({
        dictionary: DATA_DICTIONARY_JSON_CSV,
      });
      for (let offset = 0; offset < payload.length; offset += chunkSize) {
        warmupCompressor.write(payload.subarray(offset, offset + chunkSize));
      }
      warmupCompressor.end();

      const compressor = new ZstdDictionaryStreamCompressor({
        dictionary: DATA_DICTIONARY_JSON_CSV,
      });
      const compressedChunks: Buffer[] = [];

      const startTime = performance.now();

      for (let offset = 0; offset < payload.length; offset += chunkSize) {
        const chunk = payload.subarray(offset, offset + chunkSize);
        const comp = compressor.write(chunk);
        if (comp.length > 0) compressedChunks.push(comp);
      }
      const finalBytes = compressor.end();
      if (finalBytes.length > 0) compressedChunks.push(finalBytes);

      const elapsedMs = performance.now() - startTime;
      const compressedTotal = Buffer.concat(compressedChunks);

      // Bandwidth reduction: 1 - (compressed / original)
      const reduction = 1.0 - compressedTotal.length / originalSize;

      // Acceptance Criteria: Network bandwidth reduction >= 70%
      expect(reduction).toBeGreaterThanOrEqual(0.70);

      // Throughput calculation: (bytes / 1024 / 1024) / (elapsedMs / 1000) = MB/s
      const durationSec = elapsedMs / 1000;
      const throughputMbPerSec = (originalSize / (1024 * 1024)) / (durationSec || 0.001);

      // Acceptance Criteria: Sustains high throughput (>= 180 MB/s in native TS)
      expect(throughputMbPerSec).toBeGreaterThanOrEqual(180);

      // Verify decompression roundtrip
      const decompressor = new ZstdDictionaryStreamDecompressor({
        dictionary: DATA_DICTIONARY_JSON_CSV,
      });
      const decomp1 = decompressor.write(compressedTotal);
      const decompFinal = decompressor.end();
      const restored = Buffer.concat([decomp1, decompFinal]);

      expect(restored.equals(payload)).toBe(true);
    });
  });

  describe('4. Fail-Closed Error Handling & Corrupt Stream Protection', () => {
    it('rejects streams with mismatched Dictionary ID fail-closed', () => {
      // Compress with DATA_DICTIONARY_JSON_CSV (0xEC012026)
      const compressor = new ZstdDictionaryStreamCompressor({
        dictionary: DATA_DICTIONARY_JSON_CSV,
      });
      const compressed = Buffer.concat([
        compressor.write(Buffer.from('{"status":"ok"}', 'utf-8')),
        compressor.end(),
      ]);

      // Attempt to decompress expecting OFFICE_XML_DICTIONARY (0xEC012027)
      const decompressor = new ZstdDictionaryStreamDecompressor({
        dictionary: OFFICE_XML_DICTIONARY,
        expectedDictId: ZSTD_OFFICE_DICT_MAGIC,
      });

      expect(() => {
        decompressor.write(compressed);
      }).toThrow(/dictionary ID mismatch/i);
    });

    it('rejects corrupted magic bytes fail-closed', () => {
      const decompressor = new ZstdDictionaryStreamDecompressor({
        dictionary: DATA_DICTIONARY_JSON_CSV,
      });

      const invalidBuffer = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x07, 0x50, 0x26, 0x20, 0x01, 0xec, 0x01, 0x00, 0x00]);
      expect(() => {
        decompressor.write(invalidBuffer);
      }).toThrow(/missing magic number/i);
    });
  });
});
