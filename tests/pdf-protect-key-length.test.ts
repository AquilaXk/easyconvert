import { describe, expect, it } from 'vitest';
import { protectPdf } from '../src/lib/conversions/pdf-postprocess';
import { AES_256, ENCRYPTION_VARIANTS, pdfinfoPages, pdftotext, plainPdf, qpdfCheckPasses, qpdfEncryptionReport } from './helpers/encrypted-pdf-fixtures';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * `keyLength: 128` protects a PDF with AES-128 (encryption revision 4, version 4), not with RC4: qpdf 12 refuses to write RC4
 * unless it is run with `--allow-weak-crypto`, which this service never passes, and AES is what a 128-bit key means for a
 * reader that wants a protection worth the name. 256 stays AES-256 (revision 6). The oracle is qpdf's own JSON report and
 * `pdftotext`, never the code under test.
 */

const AES_128 = ENCRYPTION_VARIANTS.find((variant) => variant.name === 'AES-128')!;
const USER_PASSWORD = 'user-secret-128';
const OWNER_PASSWORD = 'owner-secret-128';
const TEXT = 'Key length probe';

describe.skipIf(skipWithoutTools('qpdf', 'pdftotext', 'pdfinfo'))('PDF protection with a 128-bit key', () => {
  it('writes AES-128 and opens with the user password', async () => {
    const protectedPdf = await protectPdf(await plainPdf([TEXT]), { userPassword: USER_PASSWORD, ownerPassword: OWNER_PASSWORD, keyLength: 128 });
    const report = qpdfEncryptionReport(protectedPdf, USER_PASSWORD);
    expect({ R: report.R, V: report.V }).toEqual({ R: AES_128.revision, V: AES_128.version });
    expect(report.userPasswordMatched).toBe(true);
    expect(qpdfCheckPasses(protectedPdf, USER_PASSWORD)).toBe(true);
    expect(pdftotext(protectedPdf, USER_PASSWORD)).toContain(TEXT);
    expect(pdfinfoPages(protectedPdf, USER_PASSWORD)).toBe(1);
  });

  it('keeps AES-256 for 256 and for no key length', async () => {
    for (const keyLength of [256, undefined] as const) {
      const protectedPdf = await protectPdf(await plainPdf([TEXT]), { userPassword: USER_PASSWORD, ownerPassword: OWNER_PASSWORD, keyLength });
      const report = qpdfEncryptionReport(protectedPdf, USER_PASSWORD);
      expect({ R: report.R, V: report.V }, String(keyLength)).toEqual({ R: AES_256.revision, V: AES_256.version });
    }
  });

  it('applies the permissions to a 128-bit key too', async () => {
    const protectedPdf = await protectPdf(await plainPdf([TEXT]), {
      userPassword: USER_PASSWORD,
      ownerPassword: OWNER_PASSWORD,
      keyLength: 128,
      permissions: { print: 'none', modify: 'none', extract: false },
    });
    const report = qpdfEncryptionReport(protectedPdf, USER_PASSWORD);
    expect(report.capabilities.extract).toBe(false);
    expect(report.capabilities.modifyother).toBe(false);
  });
});
