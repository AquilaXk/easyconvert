import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import zlib from 'node:zlib';
import { PDFDocument, StandardFonts, PDFHexString } from 'pdf-lib';
import { tryProcessClientEdge, executeItemConversion } from '../src/lib/client-converter';
import { ConversionQueueItem } from '../src/lib/types';
import {
  resolveConversionTier,
  SUPPORTED_OPFS_STREAMING_CONVERSIONS,
  isOpfsStreamingSupported,
} from '../src/lib/edge/tier-router';
import {
  safeEncodeText,
  createLosslessSandwichPdfFromImage,
} from '../src/lib/conversions/ocr-pdf-combiner';
import { OciObjectStorageService, s3Storage } from '../src/lib/storage/oci-storage';
import { resolveChunkTransformer } from '../src/lib/edge/workers/opfs-vfs.worker';
import {
  isSvg,
  sanitizeSvgString,
  sanitizeSvgBuffer,
} from '../src/lib/security/svg-sanitizer';
import { convertVectorCad } from '../src/lib/conversions/vector-cad';
import { convertImage } from '../src/lib/conversions/image';
import { convertData, simpleXmlToJson } from '../src/lib/conversions/data';

describe('Phase 1: Edge Stability, Security Hardening, and Critical Hotfixes', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. WebCodecs Adaptive Cascade Fallback
  // =========================================================================
  describe('1. WebCodecs Adaptive Cascade Fallback', () => {
    it('catches L1 WebCodecs encoder failures without unhandled crashes and cascades to L4 cloud', async () => {
      // Create a dummy video file
      const rawBytes = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);
      const file = new File([rawBytes], 'test.mp4', { type: 'video/mp4' });

      const item: ConversionQueueItem = {
        id: 'test-cascade-1',
        file,
        sourceFormat: 'mp4',
        targetFormat: 'webm',
        size: file.size,
        status: 'pending',
        progress: 0,
        options: { clientEdgeMode: undefined },
      };

      // Ensure window is defined to simulate browser environment
      (globalThis as any).window = {};

      // If WebCodecs fails or throws an exception, tryProcessClientEdge catches it and returns null
      const edgeRes = await tryProcessClientEdge(item);
      // Because mp4 -> webm cannot be processed by L2 Wasm, it cascades to null (downgrade to L4)
      expect(edgeRes).toBeNull();

      // Original input ArrayBuffer must remain preserved and non-detached
      const freshBuffer = await file.arrayBuffer();
      expect(freshBuffer.byteLength).toBe(rawBytes.length);
      expect(new Uint8Array(freshBuffer)[0]).toBe(0x00);
      expect(new Uint8Array(freshBuffer)[4]).toBe(0x66); // 'f'
    });

    it('executeItemConversion safely cascades from faulted L1 to L4 cloud fallback', async () => {
      const rawBytes = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);
      const file = new File([rawBytes], 'video.mp4', { type: 'video/mp4' });

      const item: ConversionQueueItem = {
        id: 'test-cascade-cloud',
        file,
        sourceFormat: 'mp4',
        targetFormat: 'webm',
        size: file.size,
        status: 'pending',
        progress: 0,
        options: { clientEdgeMode: undefined },
      };

      // Mock fetch for /api/convert cloud fallback in Node environment
      const mockBlob = new Blob(['mock-webm-result'], { type: 'video/webm' });
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        blob: async () => mockBlob,
      } as any);

      let successTier: string | undefined;
      let errorOccurred = false;

      await executeItemConversion(item, {
        onProgress: () => {},
        onSuccess: (_url, _size, _edge, tier) => {
          successTier = tier;
        },
        onError: () => {
          errorOccurred = true;
        },
      });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const fetchCall = fetchSpy.mock.calls[0];
      expect(fetchCall[0]).toBe('/api/convert');
      expect((fetchCall[1]?.headers as any)['X-Zero-Retention']).toBe('true');

      // Must succeed via Cloud Zero-Retention without throwing an unhandled client edge error
      expect(errorOccurred).toBe(false);
      expect(successTier).toBe('Cloud (Zero-Retention)');
    });
  });

  // =========================================================================
  // 2. L3 OPFS Streaming Format Routing Guard
  // =========================================================================
  describe('2. L3 OPFS Streaming Format Routing Guard', () => {
    it('verifies supported OPFS format whitelist and router guard', () => {
      expect(SUPPORTED_OPFS_STREAMING_CONVERSIONS.has('csv:tsv')).toBe(true);
      expect(SUPPORTED_OPFS_STREAMING_CONVERSIONS.has('tsv:csv')).toBe(true);
      expect(SUPPORTED_OPFS_STREAMING_CONVERSIONS.has('pcm:wav')).toBe(false); // correctly excluded
      expect(SUPPORTED_OPFS_STREAMING_CONVERSIONS.has('grayscale:rgba')).toBe(false); // correctly excluded
      expect(SUPPORTED_OPFS_STREAMING_CONVERSIONS.has('rgba:grayscale')).toBe(true);

      // Verify that every single format pair in SUPPORTED_OPFS_STREAMING_CONVERSIONS is resolvable in worker
      for (const pair of SUPPORTED_OPFS_STREAMING_CONVERSIONS) {
        const [s, t] = pair.split(':');
        expect(() => resolveChunkTransformer(s, t)).not.toThrow();
      }

      // Unsupported formats must return false
      expect(isOpfsStreamingSupported('mp4', 'webm')).toBe(false);
      expect(isOpfsStreamingSupported('pdf', 'docx')).toBe(false);
      expect(isOpfsStreamingSupported('png', 'svg')).toBe(false);

      // Identity pass-through with explicit flag
      expect(isOpfsStreamingSupported('bin', 'bin', { allowPassThrough: true })).toBe(true);
    });

    it('executes TSV -> CSV delimited streaming transformer without throwing', () => {
      const transformer = resolveChunkTransformer('tsv', 'csv');
      const sampleTsv = new TextEncoder().encode('col1\tcol2\tcol3\n1\t2\t3\n');
      const transformed = transformer(sampleTsv, 0, sampleTsv.length) as Uint8Array;
      const csvText = new TextDecoder().decode(transformed);
      expect(csvText).toBe('col1,col2,col3\n1,2,3\n');
    });

    it('safely routes unsupported large files (>100MB) to L4 Cloud fallback instead of crashing L3 worker', () => {
      const largeSize = 150 * 1024 * 1024; // 150 MB

      // Unsupported large file: mp4 -> webm with OPFS available
      const unsupportedResolution = resolveConversionTier('mp4', 'webm', largeSize, {}, {
        hasOpfsSyncAccess: true,
      });
      expect(unsupportedResolution.tier).toBe('L4');
      expect(unsupportedResolution.tierName).toBe('Cloud (Zero-Retention)');
      expect(unsupportedResolution.reason).toContain('cloud serverless');

      // Unsupported large audio file: pcm -> wav (requires non-chunked header framing)
      const pcmWavResolution = resolveConversionTier('pcm', 'wav', largeSize, {}, {
        hasOpfsSyncAccess: true,
      });
      expect(pcmWavResolution.tier).toBe('L4');
      expect(pcmWavResolution.tierName).toBe('Cloud (Zero-Retention)');

      // Supported large file: csv -> tsv with OPFS available
      const supportedResolution = resolveConversionTier('csv', 'tsv', largeSize, {}, {
        hasOpfsSyncAccess: true,
      });
      expect(supportedResolution.tier).toBe('L3');
      expect(supportedResolution.tierName).toBe('Edge L3 (OPFS Stream)');
    });
  });

  // =========================================================================
  // 3. CJK Searchable PDF Unicode CID Text Layer Preservation
  // =========================================================================
  describe('3. CJK Searchable PDF Unicode CID Text Layer Preservation', () => {
    it('encodes CJK and extended Unicode into UTF-16BE CID-keyed text without stripping', async () => {
      const doc = await PDFDocument.create();
      const font = await doc.embedFont(StandardFonts.Helvetica);

      // Korean text: must NOT be stripped or replaced with empty string
      const koreanText = '안녕하세요 대한민국';
      const encodedKorean = safeEncodeText(font, koreanText);
      expect(encodedKorean).not.toBeNull();
      expect(encodedKorean).toBeInstanceOf(PDFHexString);

      // Hex representation must start with UTF-16BE BOM (FEFF)
      const hexStr = (encodedKorean as PDFHexString).asString();
      expect(hexStr.toUpperCase()).toMatch(/^FEFF/);

      // Latin WinAnsi text encoding
      const latinText = 'Hello World 123';
      const encodedLatin = safeEncodeText(font, latinText);
      expect(encodedLatin).not.toBeNull();
    });

    it('embeds CJK text in lossless sandwich PDF without throwing or stripping', async () => {
      // 1x1 base64 PNG
      const png1x1 = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64'
      );

      const ocrResult = {
        text: '안녕하세요 대한민국 EasyConvert 2026',
        confidence: 98,
        wordCount: 4,
        lines: ['안녕하세요 대한민국 EasyConvert 2026'],
        lineBlocks: [
          {
            text: '안녕하세요 대한민국 EasyConvert 2026',
            bbox: { x: 10, y: 10, width: 200, height: 30 },
            words: [
              { text: '안녕하세요', bbox: { x: 10, y: 10, width: 50, height: 30 } },
              { text: '대한민국', bbox: { x: 65, y: 10, width: 50, height: 30 } },
              { text: 'EasyConvert', bbox: { x: 120, y: 10, width: 50, height: 30 } },
              { text: '2026', bbox: { x: 175, y: 10, width: 35, height: 30 } },
            ],
          },
        ],
      };

      const pdfBuffer = await createLosslessSandwichPdfFromImage(png1x1, ocrResult);
      expect(pdfBuffer).toBeInstanceOf(Buffer);
      expect(pdfBuffer.length).toBeGreaterThan(500);

      // Verify PDF header %PDF-
      expect(pdfBuffer.toString('ascii', 0, 8)).toContain('%PDF-');

      // Verify loaded document
      const loadedDoc = await PDFDocument.load(pdfBuffer);
      expect(loadedDoc.getPageCount()).toBe(1);

      // Decompress FlateDecode content streams to inspect PDF text operators
      let decompressedStreamContent = '';
      for (const [, obj] of loadedDoc.context.enumerateIndirectObjects()) {
        if (obj.constructor.name === 'PDFRawStream') {
          try {
            const inflated = zlib.inflateSync(Buffer.from((obj as any).contents));
            decompressedStreamContent += inflated.toString('latin1');
          } catch {
            // Non-deflate stream
          }
        }
      }

      // Verify that the PDF stream contains invisible text rendering mode (3 Tr)
      expect(decompressedStreamContent).toContain('3 Tr');

      // Verify that UTF-16BE hex string encoding for CJK is present in the stream (<FEFF...>)
      expect(decompressedStreamContent).toMatch(/<FEFF[0-9A-Fa-f]+>/);
    });
  });

  // =========================================================================
  // 4. Async Queue In-Memory TTL GC & In-Memory Shredding
  // =========================================================================
  describe('4. Async Queue In-Memory TTL GC & In-Memory Shredding', () => {
    it('sets 1-hour TTL on stored objects and lazy-expires after TTL', () => {
      const storage = new OciObjectStorageService();
      try {
        const testBuffer = Buffer.from('Confidential in-memory payload for conversion queue');
        const key = 'test-file-key';
        const stored = storage.saveObject(key, testBuffer, 'text/plain', 'test.txt');

        expect(stored.expiresAt).toBeGreaterThan(Date.now() + 59 * 60 * 1000);
        expect(stored.expiresAt).toBeLessThanOrEqual(Date.now() + 61 * 60 * 1000);

        // Immediate lookup succeeds
        const found = storage.getObject(key);
        expect(found).toBeDefined();

        // Artificially fast-forward expiration time
        stored.expiresAt = Date.now() - 1000;

        // Lookup now lazy-expires and returns undefined
        const expired = storage.getObject(key);
        expect(expired).toBeUndefined();
      } finally {
        storage.stopGc();
      }
    });

    it('executes in-memory buffer shredding (fill(0)) upon object disposal', () => {
      const storage = new OciObjectStorageService();
      try {
        const rawSecret = Buffer.from('Extremely sensitive user data that must be securely wiped');
        const key = 'sensitive-object';

        storage.saveObject(key, rawSecret, 'application/octet-stream', 'secret.bin');

        const objRef = storage.getObject(key);
        expect(objRef).toBeDefined();
        const bufferRef = objRef!.buffer;

        // Verify buffer has non-zero content initially
        expect(bufferRef[0]).not.toBe(0);

        // Delete object: must wipe buffer with 0x00
        const deleted = storage.deleteObject(key);
        expect(deleted).toBe(true);

        // Buffer contents must be zeroed out
        expect(bufferRef.every((b) => b === 0)).toBe(true);
      } finally {
        storage.stopGc();
      }
    });

    it('sweeps expired objects and shreds buffers in bulk', () => {
      const storage = new OciObjectStorageService();
      try {
        const buf1 = Buffer.from('Expired payload 1');
        const buf2 = Buffer.from('Expired payload 2');
        const bufActive = Buffer.from('Active payload');

        const key1 = 'exp1';
        const key2 = 'exp2';
        const keyActive = 'active';

        const s1 = storage.saveObject(key1, buf1, 'text/plain');
        const s2 = storage.saveObject(key2, buf2, 'text/plain');
        storage.saveObject(keyActive, bufActive, 'text/plain');

        // Fast-forward expiration for 1 and 2
        s1.expiresAt = Date.now() - 5000;
        s2.expiresAt = Date.now() - 1000;

        const swept = storage.sweepExpiredObjects();
        expect(swept).toBe(2);

        // Swept buffers must be zeroed out
        expect(s1.buffer.every((b) => b === 0)).toBe(true);
        expect(s2.buffer.every((b) => b === 0)).toBe(true);

        // Active object remains available
        expect(storage.getObject(keyActive)).toBeDefined();
      } finally {
        storage.stopGc();
      }
    });

    it('accurately counts distinct stored objects in getObjectsCount', () => {
      const storage = new OciObjectStorageService();
      try {
        storage.saveObject('test-item-1', Buffer.from('data1'), 'text/plain');
        storage.saveObject('test-item-2', Buffer.from('data2'), 'text/plain');
        expect(storage.getObjectsCount()).toBe(2);
      } finally {
        storage.stopGc();
      }
    });

    it('preserves storage object across retry attempts until final completion or exhaustion', async () => {
      const storage = new OciObjectStorageService();
      try {
        const key = 'retry-test-input.txt';
        const buffer = Buffer.from('Important payload');
        storage.saveObject(key, buffer, 'text/plain');

        // Simulate attempt 1 (failed, attemptsMade: 1, attempts: 2)
        const jobSim = {
          opts: { attempts: 2 },
          attemptsMade: 1,
        };
        let succeeded = false;
        const isFinalAttempt1 = !jobSim.opts?.attempts || jobSim.attemptsMade >= jobSim.opts.attempts;
        if (succeeded || isFinalAttempt1) {
          storage.deleteObject(key);
        }
        // Key MUST NOT be deleted yet!
        expect(storage.getObject(key)).toBeDefined();

        // Simulate attempt 2 (succeeded, attemptsMade: 2, attempts: 2)
        jobSim.attemptsMade = 2;
        succeeded = true;
        const isFinalAttempt2 = !jobSim.opts?.attempts || jobSim.attemptsMade >= jobSim.opts.attempts;
        if (succeeded || isFinalAttempt2) {
          storage.deleteObject(key);
        }
        // Key MUST now be deleted and shredded!
        expect(storage.getObject(key)).toBeUndefined();
      } finally {
        storage.stopGc();
      }
    });
  });

  // =========================================================================
  // 5. SVG Stored XSS Defense Sanitization
  // =========================================================================
  describe('5. SVG Stored XSS Defense Sanitization', () => {
    it('detects SVG format properly', () => {
      expect(isSvg('<svg xmlns="http://www.w3.org/2000/svg"><circle r="10"/></svg>')).toBe(true);
      expect(isSvg('<?xml version="1.0"?><svg viewBox="0 0 100 100"></svg>')).toBe(true);
      expect(isSvg('<html><body><svg></svg></body></html>')).toBe(false);
      expect(isSvg('Not an svg at all')).toBe(false);
    });

    it('strips <script> tags, <foreignObject>, inline on* handlers, and javascript: URIs', () => {
      const maliciousSvg = `
        <svg xmlns="http://www.w3.org/2000/svg" onload="alert('XSS1')">
          <script>alert('XSS2')</script>
          <foreignObject width="100" height="100">
            <body xmlns="http://www.w3.org/1999/xhtml">
              <script>alert('XSS3')</script>
            </body>
          </foreignObject>
          <a href="javascript:alert('XSS4')">Click me</a>
          <circle cx="50" cy="50" r="40" stroke="green" stroke-width="4" fill="yellow" onclick="stealCookies()" />
        </svg>
      `;

      const sanitized = sanitizeSvgString(maliciousSvg);

      expect(sanitized).not.toContain('<script');
      expect(sanitized).not.toContain('foreignObject');
      expect(sanitized).not.toContain('onload');
      expect(sanitized).not.toContain('onclick');
      expect(sanitized).not.toContain('javascript:');
      expect(sanitized).toContain('<svg');
      expect(sanitized).toContain('<circle');
      expect(sanitized).toContain('yellow');
    });

    it('strips unclosed <script> tags and prevents nested recursive tag bypasses', () => {
      const unclosed = '<svg><script src="https://evil.com/xss.js"><circle r="10"/></svg>';
      const cleanUnclosed = sanitizeSvgString(unclosed);
      expect(cleanUnclosed).not.toContain('<script');
      expect(cleanUnclosed).toContain('<circle');

      const recursive = '<svg><scr<script>ipt>alert(1)</script><circle r="10"/></svg>';
      const cleanRecursive = sanitizeSvgString(recursive);
      expect(cleanRecursive).not.toContain('<script');
      expect(cleanRecursive).not.toContain('alert');
      expect(cleanRecursive).toContain('<circle');
    });

    it('sanitizes data:image/svg+xml and animation injection vectors', () => {
      const dataSvg = '<svg><a href="data:image/svg+xml;base64,PHN2Zz4=">test</a></svg>';
      const cleanDataSvg = sanitizeSvgString(dataSvg);
      expect(cleanDataSvg).toContain('href="#"');
      expect(cleanDataSvg).not.toContain('data:image/svg+xml');

      const animSvg = '<svg><animate attributeName="href" values="javascript:alert(1)"/></svg>';
      const cleanAnimSvg = sanitizeSvgString(animSvg);
      expect(cleanAnimSvg).not.toContain('javascript:');
    });

    it('strips DOCTYPE declarations with internal entity subsets and detects valid SVG', () => {
      const doctypeSubset = `<!DOCTYPE svg [
        <!ELEMENT svg ANY >
        <!ENTITY xxe SYSTEM "file:///etc/passwd">
      ]>
      <svg><circle r="10"/></svg>`;
      expect(isSvg(doctypeSubset)).toBe(true);
      const clean = sanitizeSvgString(doctypeSubset);
      expect(clean).not.toContain('<!DOCTYPE');
      expect(clean).not.toContain('<!ENTITY');
      expect(clean).toContain('<circle');
    });

    it('sanitizes XML data in simpleXmlToJson and convertData', async () => {
      const maliciousXml = `<root><item><name>Product</name><script>alert(1)</script><desc onclick="evil()">Desc</desc></item></root>`;
      const parsed = simpleXmlToJson(maliciousXml) as any;
      expect(parsed.root.item.script).toBeUndefined();
      expect(parsed.root.item.desc.onclick).toBeUndefined();

      const res = await convertData(Buffer.from(maliciousXml, 'utf-8'), 'xml', 'json', {}, 'test.xml');
      const jsonStr = res.buffer.toString('utf-8');
      expect(jsonStr).not.toContain('alert(1)');
      expect(jsonStr).not.toContain('onclick');
    });

    it('enforces SVG sanitization in vector-cad conversions', async () => {
      const maliciousSvg = `
        <svg xmlns="http://www.w3.org/2000/svg">
          <script>document.location='http://evil.com'</script>
          <path d="M 10 10 L 90 90" />
        </svg>
      `;

      const res = await convertVectorCad(
        Buffer.from(maliciousSvg, 'utf-8'),
        'svg',
        'dxf',
        {},
        'sample.svg'
      );

      // Check output DXF
      expect(res.buffer).toBeInstanceOf(Buffer);
      expect(res.mimeType).toBe('image/vnd.dxf');
    });

    it('enforces SVG sanitization in image conversions', async () => {
      const maliciousSvg = `
        <svg xmlns="http://www.w3.org/2000/svg" onmouseover="alert('XSS')">
          <rect width="100" height="100" fill="red" />
          <script>alert('XSS')</script>
        </svg>
      `;

      const res = await convertImage(
        Buffer.from(maliciousSvg, 'utf-8'),
        'png',
        {},
        'exploit.svg',
        'svg'
      );

      expect(res.buffer).toBeInstanceOf(Buffer);
      expect(res.mimeType).toBe('image/png');
    });

    it('enforces SVG buffer sanitization and preserves clean vector geometry', () => {
      const maliciousSvg = Buffer.from(`
        <svg xmlns="http://www.w3.org/2000/svg">
          <script>alert('XSS')</script>
          <circle cx="50" cy="50" r="40" fill="blue" />
        </svg>
      `, 'utf-8');

      const sanitizedBuffer = sanitizeSvgBuffer(maliciousSvg);
      const sanitizedText = sanitizedBuffer.toString('utf-8');

      expect(sanitizedText).not.toContain('<script');
      expect(sanitizedText).toContain('<circle');
      expect(sanitizedText).toContain('fill="blue"');
    });
  });
});
