import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { UnsupportedOptionError } from '../src/lib/types';
import { HAS_SOFFICE } from './helpers/native-tools';
import { getOracleToolPath } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';

const SAMPLE_DOCX = readFileSync(path.resolve(__dirname, 'fixtures', 'sample.docx'));
const PDFINFO = getOracleToolPath('pdfinfo');
const USER_PASSWORD = 'dispatch-user-pw';
const CONVERT_TIMEOUT_MS = 120_000;

/** Runs pdfinfo (an independent Poppler reader) over a PDF and returns its output. */
function pdfinfo(pdf: Buffer, extraArgs: string[]): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dispatch-pdfinfo-'));
  const file = path.join(dir, 'in.pdf');
  try {
    writeFileSync(file, pdf);
    return execFileSync(PDFINFO as string, [...extraArgs, file], { encoding: 'utf-8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('PDF post-processing on native-routed output', () => {
  it('rejects pdfa together with protect before any conversion starts', async () => {
    const run = dispatchConversion(
      SAMPLE_DOCX,
      'docx',
      'pdf',
      { pdfa: { conformance: 'pdfa-1b' }, protect: { userPassword: USER_PASSWORD } },
      'sample.docx'
    );
    await expect(run).rejects.toBeInstanceOf(UnsupportedOptionError);
    await expect(run).rejects.toThrow(/PDF\/A output cannot be encrypted/);
  });

  it.skipIf(!HAS_SOFFICE || !PDFINFO)(
    'encrypts docx->pdf output when protect is requested (needs soffice, pdfinfo)',
    async () => {
      const result = await dispatchConversion(
        SAMPLE_DOCX,
        'docx',
        'pdf',
        { protect: { userPassword: USER_PASSWORD, keyLength: 256 } },
        'sample.docx'
      );
      expect(result.engineUsed).toMatch(/^native-soffice/);
      expect(result.buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(result.buffer.toString('latin1')).toContain('/Encrypt');
      expect(result.size).toBe(result.buffer.length);
      expect(pdfinfo(result.buffer, ['-upw', USER_PASSWORD])).toMatch(/Encrypted:\s+yes/);
    },
    CONVERT_TIMEOUT_MS
  );

  oracleTest(
    'embeds PDF/A identification metadata in docx->pdf output when pdfa is requested',
    ['soffice', 'pdfinfo', 'verapdf'],
    async () => {
      const result = await dispatchConversion(
        SAMPLE_DOCX,
        'docx',
        'pdf',
        { pdfa: { conformance: 'pdfa-2b' } },
        'sample.docx'
      );
      expect(result.engineUsed).toMatch(/^native-soffice/);
      const xmp = pdfinfo(result.buffer, ['-meta']);
      expect(xmp).toMatch(/<pdfaid:part>2<\/pdfaid:part>/);
      expect(xmp).toMatch(/<pdfaid:conformance>B<\/pdfaid:conformance>/);
      expect(result.metadata).toMatchObject({ pdfaValidated: true, pdfaProfile: 'pdfa-2b' });
    },
    CONVERT_TIMEOUT_MS
  );

  it.skipIf(!PDFINFO)(
    'encrypts in-process pdf output exactly once (needs pdfinfo)',
    async () => {
      const result = await dispatchConversion(
        Buffer.from('plain text body for an in-process pdf'),
        'txt',
        'pdf',
        { protect: { userPassword: USER_PASSWORD, keyLength: 256 } },
        'in.txt'
      );
      expect(result.engineUsed).toBe('internal-fallback');
      expect(result.buffer.toString('latin1').match(/\/Encrypt\s/g)).toHaveLength(1);
      expect(pdfinfo(result.buffer, ['-upw', USER_PASSWORD])).toMatch(/Encrypted:\s+yes/);
    },
    CONVERT_TIMEOUT_MS
  );
});
