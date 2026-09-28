import { describe, it, expect } from 'vitest';
import {
  runDifferentialComparison,
  assertFormatIntegrity,
} from './helpers/differential-oracle';

describe('Phase 5: Differential Oracle Integrity & Fail-Closed Validation', () => {
  describe('1. assertFormatIntegrity hard gates', () => {
    it('throws error for buffers shorter than 8 bytes', () => {
      expect(() => assertFormatIntegrity(Buffer.from('short'), 'pdf')).toThrow(
        /Integrity Violation: pdf buffer is too short/
      );
    });

    it('validates PDF magic header and %%EOF trailer', () => {
      const validPdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF');
      expect(() => assertFormatIntegrity(validPdf, 'pdf')).not.toThrow();

      const invalidHeader = Buffer.from('FAKE-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF');
      expect(() => assertFormatIntegrity(invalidHeader, 'pdf')).toThrow(
        /Missing PDF magic header/
      );

      const missingEof = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\nTRAILING');
      expect(() => assertFormatIntegrity(missingEof, 'pdf')).toThrow(
        /Missing PDF EOF marker/
      );
    });

    it('validates 7z archive signature', () => {
      const valid7zHeader = Buffer.from([
        0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00, 0x04,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      ]);
      expect(() => assertFormatIntegrity(valid7zHeader, '7z')).not.toThrow();

      const invalid7z = Buffer.from([0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77]);
      expect(() => assertFormatIntegrity(invalid7z, '7z')).toThrow(
        /Missing 7z/
      );
    });

    it('validates Zstandard frame magic 0xFD2FB528', () => {
      const validZstd = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x00, 0x00, 0x00]);
      expect(() => assertFormatIntegrity(validZstd, 'zstd')).not.toThrow();

      const invalidZstd = Buffer.from([0x12, 0x34, 0x56, 0x78, 0x00, 0x00, 0x00, 0x00]);
      expect(() => assertFormatIntegrity(invalidZstd, 'zstd')).toThrow(
        /Missing RFC 8878 Zstandard magic/
      );
    });
  });

  describe('2. runDifferentialComparison fail-closed behavior', () => {
    it('returns matched=false and records integrity discrepancy on corrupt actual buffer', async () => {
      const corruptPdf = Buffer.from('NOT_A_VALID_PDF_PAYLOAD_AT_ALL');
      const validRefPdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF');

      const report = await runDifferentialComparison(corruptPdf, validRefPdf, 'pdf');
      expect(report.matched).toBe(false);
      expect(report.structuralScore).toBe(0);
      expect(report.discrepancies.length).toBeGreaterThan(0);
      expect(report.discrepancies[0]).toContain('Actual buffer integrity violation');
    });

    it('detects native archive integrity failure when tool is absent or corrupt', async () => {
      const corrupt7z = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00, 0x00]);
      const validRef7z = Buffer.from([
        0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00, 0x04,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      ]);

      const report = await runDifferentialComparison(corrupt7z, validRef7z, '7z');
      expect(report.matched).toBe(false);
      expect(report.structuralScore).toBe(0);
      expect(report.discrepancies.length).toBeGreaterThan(0);
    });

    it('returns matched=false and records integrity discrepancy on corrupt reference buffer without crashing', async () => {
      const validActualPdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF');
      const corruptRefPdf = Buffer.from('NOT_A_VALID_REF_PDF_PAYLOAD');

      const report = await runDifferentialComparison(validActualPdf, corruptRefPdf, 'pdf');
      expect(report.matched).toBe(false);
      expect(report.structuralScore).toBe(0);
      expect(report.discrepancies.length).toBeGreaterThan(0);
      expect(report.discrepancies[0]).toContain('Reference buffer integrity violation');
    });
  });
});
