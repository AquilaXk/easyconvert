import { describe, expect, it } from 'vitest';
import { oracleTest } from '../../helpers/oracle-test';
import {
  OracleToolMissingError,
  verifyArchiveWith7z,
  verifyPdfWithPoppler,
  verifyVideoBitstreamWithFfprobe,
} from '../../helpers/differential-oracle';

/**
 * Run only by tests/oracle-integrity-and-security-audit.test.ts, in a child vitest process whose tool search path
 * is empty (ORACLE_TOOL_DIRS). The file name does not match the suite's include pattern, so a normal run never
 * collects it. The parent reads this run's JSON report: with ORACLE_STRICT_MODE=1 the oracle tests must fail,
 * without it they must be skipped, and the verification helpers must throw OracleToolMissingError either way.
 */
describe('toolchain without tools', () => {
  oracleTest('needs pdfinfo (body must never run)', ['pdfinfo'], () => {
    throw new Error('oracle test body ran although pdfinfo is missing');
  });

  oracleTest('needs ffmpeg and ffprobe (body must never run)', ['ffmpeg', 'ffprobe'], () => {
    throw new Error('oracle test body ran although ffmpeg is missing');
  });

  it('verifyPdfWithPoppler throws OracleToolMissingError naming pdfinfo', () => {
    expect(() => verifyPdfWithPoppler(Buffer.from('%PDF-1.4\n'))).toThrow(OracleToolMissingError);
    try {
      verifyPdfWithPoppler(Buffer.from('%PDF-1.4\n'));
    } catch (err) {
      expect((err as OracleToolMissingError).tool).toBe('pdfinfo');
    }
  });

  it('verifyArchiveWith7z throws OracleToolMissingError naming 7z', () => {
    const sevenZip = Buffer.concat([Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]), Buffer.alloc(30)]);
    try {
      verifyArchiveWith7z(sevenZip);
      throw new Error('verifyArchiveWith7z returned although 7z is missing');
    } catch (err) {
      expect(err).toBeInstanceOf(OracleToolMissingError);
      expect((err as OracleToolMissingError).tool).toBe('7z');
    }
  });

  it('verifyVideoBitstreamWithFfprobe throws OracleToolMissingError instead of answering', () => {
    try {
      verifyVideoBitstreamWithFfprobe(Buffer.alloc(100), 'mp4');
      throw new Error('verifyVideoBitstreamWithFfprobe returned although ffmpeg is missing');
    } catch (err) {
      expect(err).toBeInstanceOf(OracleToolMissingError);
      expect((err as OracleToolMissingError).tool).toBe('ffmpeg');
    }
  });
});
