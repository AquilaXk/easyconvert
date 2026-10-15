import { describe, it, expect, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { request } from 'undici';
import {
  isBlockedIp,
  validateUrlForSsrf,
  createSsrfSafeAgent,
} from '../src/lib/security/ssrf';
import {
  ARCHIVE_SECURITY_LIMITS,
  extractZipArchive,
  createZipArchive,
} from '../src/lib/conversions/archive';
import { parseFontToSfnt } from '../src/lib/conversions/font';
import { resolveChunkTransformer } from '../src/lib/edge/workers/opfs-vfs.worker';
import JSZip from 'jszip';

describe('Phase 0: Emergency Security Hardening & Fail-Closed Enforcement', () => {
  describe('1. SSRF Socket-Level IP Pinning & Validation', () => {
    it('blocks internal, loopback, link-local, and cloud metadata addresses', () => {
      expect(isBlockedIp('127.0.0.1')).toBe(true);
      expect(isBlockedIp('10.0.0.1')).toBe(true);
      expect(isBlockedIp('192.168.1.1')).toBe(true);
      expect(isBlockedIp('172.16.0.1')).toBe(true);
      expect(isBlockedIp('169.254.169.254')).toBe(true);
      expect(isBlockedIp('::1')).toBe(true);
      expect(isBlockedIp('fe80::1')).toBe(true);
      expect(isBlockedIp('fc00::1')).toBe(true);

      // Public addresses must not be blocked
      expect(isBlockedIp('8.8.8.8')).toBe(false);
      expect(isBlockedIp('1.1.1.1')).toBe(false);
    });

    it('rejects internal and loopback hostnames via validateUrlForSsrf', async () => {
      expect(await validateUrlForSsrf(new URL('http://localhost:3000'))).toBe(false);
      expect(await validateUrlForSsrf(new URL('http://server.local'))).toBe(false);
      expect(await validateUrlForSsrf(new URL('http://metadata.internal'))).toBe(false);
      expect(await validateUrlForSsrf(new URL('http://169.254.169.254/latest/meta-data'))).toBe(false);
    });

    it('creates an Undici Custom Agent that pins IP and blocks private destination lookups', async () => {
      // A real server on the loopback interface, reached by name so that the connect-time lookup runs.
      const server = http.createServer((_request, response) => response.end('reached'));
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as AddressInfo;
      const agent = createSsrfSafeAgent();
      try {
        // Control: an ordinary client reaches the server, so a refusal below is the agent's doing.
        const control = await request(`http://localhost:${port}/`);
        expect(await control.body.text()).toBe('reached');

        const blocked = await request(`http://localhost:${port}/`, { dispatcher: agent }).catch((err: unknown) => err);
        expect(blocked).toBeInstanceOf(Error);
        expect((blocked as NodeJS.ErrnoException).code ?? (blocked as { cause?: NodeJS.ErrnoException }).cause?.code).toBe('ESSRFBLOCKED');
        expect(String((blocked as Error).message + (blocked as { cause?: Error }).cause?.message)).toMatch(/SSRF blocked: host localhost is restricted/);
      } finally {
        await agent.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  describe('2. Archive Zip Bomb 100:1 Threshold & Normal File Acceptance', () => {
    it('sets MAX_RATIO to 100:1 and accepts normal high-ratio text files without false positives', async () => {
      expect(ARCHIVE_SECURITY_LIMITS.MAX_RATIO).toBe(100);
      expect(ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE).toBe(500 * 1024 * 1024);

      // Moderate compression (e.g. 25:1 CSV text): should be accepted under 100:1 threshold
      // whereas the old 10:1 threshold would have rejected it falsely
      const sourceText = 'timestamp,user_id,action,metadata\n'.repeat(400); // ~13.6KB
      const zip = new JSZip();
      zip.file('normal.csv', sourceText, { compression: 'DEFLATE', compressionOptions: { level: 9 } });
      const normalZipBuffer = await zip.generateAsync({ type: 'nodebuffer' });

      const ratio = Buffer.byteLength(sourceText) / normalZipBuffer.length;
      expect(ratio).toBeGreaterThan(10); // would fail 10:1
      expect(ratio).toBeLessThan(100); // passes 100:1

      const extracted = await extractZipArchive(normalZipBuffer);
      expect(extracted).toHaveLength(1);
      expect(extracted[0].filename).toBe('normal.csv');
      expect(extracted[0].buffer.toString('utf-8')).toBe(sourceText);
    });

    it('rejects extreme zip bombs that exceed 100:1 ratio', async () => {
      const hugeZeroes = Buffer.alloc(4 * 1024 * 1024, 0); // 4 MiB, past the 1 MiB output the ratio is judged from
      const zip = new JSZip();
      zip.file('bomb.bin', hugeZeroes, { compression: 'DEFLATE', compressionOptions: { level: 9 } });
      const bombBuffer = await zip.generateAsync({ type: 'nodebuffer' });

      const bombRatio = hugeZeroes.length / bombBuffer.length;
      expect(bombRatio).toBeGreaterThan(100);

      await expect(extractZipArchive(bombBuffer)).rejects.toThrow(
        /Archive bomb detected: compression ratio .* exceeds 100:1 limit/
      );
    });
  });

  describe('3. Font Engine Fail-Closed Enforcement', () => {
    it('throws deterministic error when input is corrupted or non-font binary', () => {
      const garbage = Buffer.from('NOT_A_FONT_BINARY_DATA_JUST_SOME_GARBAGE');
      expect(() => parseFontToSfnt(garbage, 'ttf', 'TestFont')).toThrow(
        /Unsupported or corrupted font format: input is not a valid SFNT\/WOFF\/WOFF2\/EOT\/SVG font/
      );
    });

    it('throws deterministic error for truncated 5-byte header', () => {
      const truncated = Buffer.from([0x00, 0x01, 0x00, 0x00, 0x00]);
      expect(() => parseFontToSfnt(truncated, 'ttf', 'Truncated')).toThrow(
        /Unsupported or corrupted font format/
      );
    });
  });

  describe('4. OPFS Streaming Transformer Fail-Closed Enforcement', () => {
    it('rejects unsupported streaming transformation pairs with descriptive error', () => {
      expect(() => resolveChunkTransformer('mp4', 'webm')).toThrow(
        /Unsupported streaming transformation: mp4 to webm/
      );
      expect(() => resolveChunkTransformer('pdf', 'docx')).toThrow(
        /Unsupported streaming transformation: pdf to docx/
      );
      expect(() => resolveChunkTransformer('png', 'zip')).toThrow(
        /Unsupported streaming transformation: png to zip/
      );
    });

    it('refuses an identity transformation, including an explicit pass-through opt-in', () => {
      expect(() => resolveChunkTransformer('bin', 'bin')).toThrow(/Unsupported streaming transformation: bin to bin/);
      expect(() => resolveChunkTransformer('raw', 'dat', { allowPassThrough: true })).toThrow(
        /Unsupported streaming transformation: raw to dat/
      );
    });
  });
});
