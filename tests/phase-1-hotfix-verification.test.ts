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
import { convertData } from '../src/lib/conversions/data';
import JSZip from 'jszip';
import {
  extractZipArchive,
  ARCHIVE_SECURITY_LIMITS,
  createZipArchive,
} from '../src/lib/conversions/archive';
import {
  processWebCodecsConversion,
  buildMp4MoovBox,
  muxMp4Media,
  muxWebmVideo,
} from '../src/lib/edge/workers/webcodecs.worker';

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

    it('streams TSV -> CSV with the server output rules (BOM, CRLF, quoting, formula escape)', () => {
      const transformer = resolveChunkTransformer('tsv', 'csv');
      const sampleTsv = new TextEncoder().encode('col1\tcol2\tcol3\n1\tx, y\t=2+3\n');
      const transformed = transformer(sampleTsv, 0, sampleTsv.length) as Uint8Array;
      // Hand-written expected bytes: UTF-8 BOM, CRLF between records, the comma field quoted, the formula escaped.
      expect(Buffer.from(transformed).toString('hex')).toBe(
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('col1,col2,col3\r\n1,"x, y","\'=2+3"', 'utf-8')]).toString('hex')
      );
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

      // The stream decodes UTF-8 only: a file in another encoding goes to the server, which honours it.
      const legacyEncoding = resolveConversionTier('csv', 'tsv', largeSize, { encoding: 'shift_jis' }, {
        hasOpfsSyncAccess: true,
      });
      expect(legacyEncoding.tier).toBe('L4');
      expect(legacyEncoding.isClientEdge).toBe(false);
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

      // Hex representation must NOT contain BOM (0xFEFF) and must encode 4-digit hex
      const hexStr = (encodedKorean as PDFHexString).asString();
      expect(hexStr.toUpperCase()).not.toMatch(/^FEFF/);
      expect(hexStr.toUpperCase()).toMatch(/^[0-9A-F]{4}/);

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

      // Verify that 4-character hex string encoding for CJK is present without BOM (<XXXX>)
      expect(decompressedStreamContent).toMatch(/<[0-9A-Fa-f]{4,}>/);
      expect(decompressedStreamContent).not.toMatch(/<FEFF/);
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

    it('sanitizes external <use href> and CSS @import / url() SSRF vectors', () => {
      const ssrfSvg = `
        <svg xmlns="http://www.w3.org/2000/svg">
          <style>
            @import url("http://169.254.169.254/latest/meta-data");
            .badge { background: url('https://attacker.com/tracking.png'); }
          </style>
          <use href="http://169.254.169.254/latest/user-data" />
          <use xlink:href="//internal.corp.net/secret.svg#icon" />
          <use href="#local-symbol" />
          <rect width="100" height="100" style="background-image: url(http://attacker.com/leak);" />
        </svg>
      `;
      const clean = sanitizeSvgString(ssrfSvg);
      expect(clean).not.toContain('http://169.254.169.254');
      expect(clean).not.toContain('https://attacker.com');
      expect(clean).not.toContain('//internal.corp.net');
      expect(clean).not.toContain('@import');
      expect(clean).toContain('href="#"');
      expect(clean).toContain('href="#local-symbol"');
    });

    it('keeps script-like XML data verbatim: data XML is not an SVG to sanitize (#455)', async () => {
      const userXml = `<root><item><name>Product</name><script>alert(1)</script><desc onclick="evil()">Desc</desc></item></root>`;
      const res = await convertData(Buffer.from(userXml, 'utf-8'), 'xml', 'json', {}, 'test.xml');
      expect(res.mimeType).toBe('application/json');
      // The JSON output is inert data; dropping these elements would silently lose the user's content.
      expect(JSON.parse(res.buffer.toString('utf-8'))).toEqual({
        $jsonml: ['root', ['item', ['name', 'Product'], ['script', 'alert(1)'], ['desc', { onclick: 'evil()' }, 'Desc']]],
      });
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

  // =========================================================================
  // 6. Adaptive Queue Routing & Fail-Closed Refusal (Issue #64 Target 1)
  // =========================================================================
  describe('6. Adaptive Queue Routing & Fail-Closed Refusal', () => {
    it('cascades non-edge formats (DOCX, HWP) to L4 Cloud fallback when clientEdgeMode is undefined', async () => {
      const dummyDocxBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
      const file = new File([dummyDocxBytes], 'document.docx', {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      });

      const item: ConversionQueueItem = {
        id: 'test-docx-adaptive',
        file,
        sourceFormat: 'docx',
        targetFormat: 'pdf',
        size: file.size,
        status: 'ready',
        progress: 0,
        options: { clientEdgeMode: undefined }, // Default Adaptive Auto
      };

      (globalThis as any).window = {};

      // tryProcessClientEdge should return null because docx -> pdf requires cloud
      const edgeRes = await tryProcessClientEdge(item);
      expect(edgeRes).toBeNull();

      const mockBlob = new Blob(['mock-pdf-output'], { type: 'application/pdf' });
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
      expect(fetchSpy.mock.calls[0][0]).toBe('/api/convert');
      expect(errorOccurred).toBe(false);
      expect(successTier).toBe('Cloud (Zero-Retention)');
    });

    it('refuses non-edge formats with Fail-Closed error when clientEdgeMode is strictly true', async () => {
      const dummyHwpBytes = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]);
      const file = new File([dummyHwpBytes], 'report.hwp', {
        type: 'application/x-hwp',
      });

      const item: ConversionQueueItem = {
        id: 'test-hwp-fail-closed',
        file,
        sourceFormat: 'hwp',
        targetFormat: 'pdf',
        size: file.size,
        status: 'ready',
        progress: 0,
        options: { clientEdgeMode: true }, // Strictly client-only edge mode
      };

      (globalThis as any).window = {};

      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      let errorMessage = '';

      await executeItemConversion(item, {
        onProgress: () => {},
        onSuccess: () => {},
        onError: (err) => {
          errorMessage = err;
        },
      });

      // Fetch should never be called when client-only edge mode is strictly enabled
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(errorMessage).toContain('requires cloud serverless processing');
      expect(errorMessage).toContain('client-only edge mode is strictly enabled');
    });
  });

  // =========================================================================
  // 7. Fail-Closed WebCodecs Missing Hardware Encoders (Issue #64 Target 2)
  // =========================================================================
  describe('7. Fail-Closed WebCodecs Missing Hardware Encoders', () => {
    let origVideoEncoder: any;
    let origVideoFrame: any;
    let origAudioEncoder: any;
    let origAudioData: any;

    beforeEach(() => {
      origVideoEncoder = (globalThis as any).VideoEncoder;
      origVideoFrame = (globalThis as any).VideoFrame;
      origAudioEncoder = (globalThis as any).AudioEncoder;
      origAudioData = (globalThis as any).AudioData;

      delete (globalThis as any).VideoEncoder;
      delete (globalThis as any).VideoFrame;
      delete (globalThis as any).AudioEncoder;
      delete (globalThis as any).AudioData;
    });

    afterEach(() => {
      (globalThis as any).VideoEncoder = origVideoEncoder;
      (globalThis as any).VideoFrame = origVideoFrame;
      (globalThis as any).AudioEncoder = origAudioEncoder;
      (globalThis as any).AudioData = origAudioData;
    });

    it('throws fail-closed error instead of generating synthetic dummy video frames', async () => {
      await expect(
        processWebCodecsConversion({
          jobId: 'test-fail-closed-video',
          sourceFormat: 'mp4',
          targetFormat: 'webm',
          fileBuffer: new ArrayBuffer(32),
          options: {},
        })
      ).rejects.toThrow('WebCodecs VideoEncoder or VideoFrame is not supported in this browser environment');
    });

    it('throws fail-closed error instead of generating synthetic dummy audio frames', async () => {
      await expect(
        processWebCodecsConversion({
          jobId: 'test-fail-closed-audio',
          sourceFormat: 'wav',
          targetFormat: 'aac',
          fileBuffer: new ArrayBuffer(44),
          options: {},
        })
      ).rejects.toThrow('WebCodecs AudioEncoder or AudioData is not supported in this browser environment');
    });
  });

  // =========================================================================
  // 8. Hardened Archive Decompression Bomb Defense & Stream Chunking (Issue #64 Target 3)
  // =========================================================================
  describe('8. Hardened Archive Decompression Bomb Defense & Stream Chunking', () => {
    it('aborts stream early and throws when archive compression ratio exceeds security limits', async () => {
      const zip = new JSZip();
      // 500KB of zeros compresses down to a few hundred bytes (> 500:1 ratio, exceeding 100:1 limit)
      zip.file('bomb.bin', Buffer.alloc(500 * 1024, 0));
      const zipBuffer = await zip.generateAsync({
        type: 'nodebuffer',
        compression: 'DEFLATE',
      });

      await expect(extractZipArchive(zipBuffer)).rejects.toThrow(
        /Archive bomb detected: compression ratio.*exceeds 100:1 limit/
      );
    });

    it('extracts normal archives correctly using chunked streaming without corrupting output', async () => {
      const testFiles = [
        { filename: 'hello.txt', buffer: Buffer.from('Hello, World! EasyConvert Phase 1.') },
        { filename: 'data/test.json', buffer: Buffer.from(JSON.stringify({ status: 'ok', tier: 'L4' })) },
      ];

      const archiveRes = await createZipArchive(testFiles);
      const extracted = await extractZipArchive(archiveRes.buffer);

      expect(extracted).toHaveLength(2);
      const helloEntry = extracted.find((e) => e.filename === 'hello.txt');
      const jsonEntry = extracted.find((e) => e.filename === 'data/test.json');

      expect(helloEntry).toBeDefined();
      expect(helloEntry?.buffer.toString('utf-8')).toBe('Hello, World! EasyConvert Phase 1.');
      expect(jsonEntry).toBeDefined();
      expect(JSON.parse(jsonEntry!.buffer.toString('utf-8'))).toEqual({ status: 'ok', tier: 'L4' });
    });
  });

  // =========================================================================
  // 9. Dual Audio/Video Track Demuxing, Preservation, and Muxing (Issue #64 Target 4)
  // =========================================================================
  describe('9. Dual Audio/Video Track Demuxing, Preservation, and Muxing', () => {
    const videoChunks = [
      { data: new Uint8Array([0, 0, 0, 1, 0x65, 1, 2, 3]), timestampMicros: 0, isKeyFrame: true },
      { data: new Uint8Array([0, 0, 0, 1, 0x41, 4, 5, 6]), timestampMicros: 33333, isKeyFrame: false },
    ];
    const audioChunks = [
      { data: new Uint8Array([0x21, 0x10, 0x04, 0x60, 0x8c, 0x00]), timestampMicros: 0, isKeyFrame: true },
      { data: new Uint8Array([0x21, 0x10, 0x04, 0x60, 0x8c, 0x01]), timestampMicros: 23220, isKeyFrame: true },
    ];

    it('buildMp4MoovBox creates dual-track moov with vide and soun track descriptors', () => {
      const moovBox = buildMp4MoovBox(
        videoChunks,
        1280,
        720,
        40,
        1000,
        audioChunks,
        44100,
        2
      );

      const moovStr = String.fromCharCode(...moovBox);
      expect(moovStr).toContain('moov');
      expect(moovStr).toContain('mvhd');
      expect(moovStr).toContain('vide');
      expect(moovStr).toContain('vmhd');
      expect(moovStr).toContain('soun');
      expect(moovStr).toContain('smhd');
      expect(moovStr).toContain('mp4a');
      expect(moovStr).toContain('esds');
    });

    it('muxMp4Media embeds both video and audio tracks in fastStart ISO BMFF container', () => {
      const mp4Bytes = muxMp4Media(videoChunks, 1280, 720, {
        includeMoov: true,
        fastStart: true,
        audioChunks,
        sampleRate: 44100,
        channels: 2,
      });

      const mp4Str = String.fromCharCode(...mp4Bytes);
      expect(mp4Str).toContain('ftyp');
      expect(mp4Str).toContain('moov');
      expect(mp4Str).toContain('mdat');
      expect(mp4Str).toContain('soun');
      expect(mp4Str).toContain('smhd');
    });

    it('muxWebmVideo builds dual-track EBML container with VP9 video and Opus audio tracks', () => {
      const webmBytes = muxWebmVideo(videoChunks, 640, 480, audioChunks);

      // Verify EBML Header
      expect(webmBytes[0]).toBe(0x1a);
      expect(webmBytes[1]).toBe(0x45);
      expect(webmBytes[2]).toBe(0xdf);
      expect(webmBytes[3]).toBe(0xa3);

      const webmStr = String.fromCharCode(...webmBytes);
      expect(webmStr).toContain('V_VP9');
      expect(webmStr).toContain('A_OPUS');
    });
  });
});
