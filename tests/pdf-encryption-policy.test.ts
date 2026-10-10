import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { applyPdfWatermark, unlockPdf } from '../src/lib/conversions/pdf-postprocess';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { PdfStructureError } from '../src/lib/conversions/pdf-document';
import { extractArtifactMetadata, mergePdfBuffers } from '../src/lib/jobs';
import { classifyJobFailure } from '../src/lib/queue/job-failure';
import { getPdfPageCount } from '../src/worker/engines';
import { PdfPasswordRequiredError, PdfPermissionDeniedError } from '../src/lib/types';
import {
  AES_256,
  ENCRYPTION_VARIANTS,
  RC4_128,
  containsEncryptKey,
  pdfinfoPages,
  pdftotext,
  plainPdf,
  qpdfCheckPasses,
  qpdfEncrypt,
  qpdfEncryptionReport,
  type EncryptionVariant,
} from './helpers/encrypted-pdf-fixtures';
import { withMissingBinary } from './helpers/native-tools';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * #571: watermark, merge and the artifact metadata never open an encrypted PDF through `ignoreEncryption`.
 *
 * Fixtures are written by `qpdf --encrypt` (RC4-40, RC4-128, AES-128, AES-256, with and without
 * `--modify=none`). The oracles are qpdf (`--check` on the output with no password proves it is no longer
 * encrypted and is structurally sound), `pdftotext` and `pdfinfo`, never the code under test.
 */

const USER_PASSWORD = 'user-secret-1';
const OWNER_PASSWORD = 'owner-secret-1';
const MARK = 'WMARK571';
/** Horizontal, so pdftotext reads the mark as one word instead of one letter per line. */
const WATERMARK = { text: MARK, rotation: 0 };
const HTTP_UNPROCESSABLE = 422;
const SRC_DIR = path.resolve(__dirname, '../src');

const toolsMissing = skipWithoutTools('qpdf', 'pdftotext', 'pdfinfo');

function expectPasswordRequired(error: unknown): void {
  expect(error).toBeInstanceOf(PdfPasswordRequiredError);
  expect((error as PdfPasswordRequiredError).status).toBe(HTTP_UNPROCESSABLE);
}

async function rejection(run: Promise<unknown>): Promise<unknown> {
  try {
    await run;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the operation to be rejected, but it resolved');
}

const CONFIRM = { confirmEditRights: true } as const;

/** What a refusal for restrictions tells the caller: confirm the rights, or supply the owner password. */
const PERMISSION_HINT = /confirmEditRights.*owner password/is;

function expectPermissionDenied(error: unknown): void {
  expect(error).toBeInstanceOf(PdfPermissionDeniedError);
  expect((error as PdfPermissionDeniedError).status).toBe(HTTP_UNPROCESSABLE);
  expect((error as Error).message).toMatch(PERMISSION_HINT);
}

describe.skipIf(toolsMissing)('watermark of an encrypted PDF', () => {
  for (const variant of [AES_256, RC4_128]) {
    describe(variant.name, () => {
      const userProtected = async (modify?: 'none'): Promise<Buffer> =>
        qpdfEncrypt(await plainPdf(['Secret body text']), { variant, userPassword: USER_PASSWORD, ownerPassword: OWNER_PASSWORD, modify });
      const ownerOnly = async (modify?: 'none'): Promise<Buffer> =>
        qpdfEncrypt(await plainPdf(['Secret body text']), { variant, userPassword: '', ownerPassword: OWNER_PASSWORD, modify });

      it('answers PdfPasswordRequiredError (422) when a user password is needed and none is supplied', async () => {
        for (const modify of [undefined, 'none'] as const) {
          expectPasswordRequired(await rejection(applyPdfWatermark(await userProtected(modify), WATERMARK)));
          expectPasswordRequired(await rejection(applyPdfWatermark(await userProtected(modify), WATERMARK, CONFIRM)));
        }
      });

      it('answers PdfPasswordRequiredError for a wrong password, without echoing it, even with the rights confirmed', async () => {
        const wrong = 'not-the-password-xyz';
        const error = await rejection(applyPdfWatermark(await userProtected(), WATERMARK, { password: wrong, ...CONFIRM }));
        expectPasswordRequired(error);
        expect((error as Error).message).not.toContain(wrong);
      });

      it('watermarks with the user password; the output is unencrypted, passes qpdf --check and keeps its text', async () => {
        const out = await applyPdfWatermark(await userProtected(), WATERMARK, { password: USER_PASSWORD });

        expect(containsEncryptKey(out)).toBe(false);
        expect(qpdfCheckPasses(out)).toBe(true);
        const text = pdftotext(out);
        expect(text).toContain(MARK);
        expect(text).toContain('Secret body text');
      });

      it('watermarks a file with no open password and no restriction without any option', async () => {
        const out = await applyPdfWatermark(await ownerOnly(), WATERMARK);
        expect(qpdfCheckPasses(out)).toBe(true);
        expect(pdftotext(out)).toContain(MARK);
      });

      it('refuses an owner-restricted file with no open password until the rights are confirmed', async () => {
        const restricted = await ownerOnly('none');
        expectPermissionDenied(await rejection(applyPdfWatermark(restricted, WATERMARK)));
        expectPermissionDenied(await rejection(applyPdfWatermark(restricted, WATERMARK, { password: '' })));
        expectPermissionDenied(await rejection(applyPdfWatermark(restricted, WATERMARK, { confirmEditRights: false })));
        // Only the boolean true confirms; a string a form might send does not.
        expectPermissionDenied(await rejection(applyPdfWatermark(restricted, WATERMARK, { confirmEditRights: 'true' as never })));
      });

      it('watermarks an owner-restricted file with no open password when the rights are confirmed', async () => {
        const out = await applyPdfWatermark(await ownerOnly('none'), WATERMARK, CONFIRM);
        expect(containsEncryptKey(out)).toBe(false);
        expect(qpdfCheckPasses(out)).toBe(true);
        expect(pdftotext(out)).toContain(MARK);
        expect(pdftotext(out)).toContain('Secret body text');
      });

      it('refuses a restricted file opened with its user password until the rights are confirmed', async () => {
        const error = await rejection(applyPdfWatermark(await userProtected('none'), WATERMARK, { password: USER_PASSWORD }));
        expectPermissionDenied(error);
        expect((error as Error).message).not.toContain(USER_PASSWORD);
      });

      it('watermarks a restricted file opened with its user password when the rights are confirmed', async () => {
        const out = await applyPdfWatermark(await userProtected('none'), WATERMARK, { password: USER_PASSWORD, ...CONFIRM });
        expect(qpdfCheckPasses(out)).toBe(true);
        expect(pdftotext(out)).toContain(MARK);
      });

      it('watermarks a restricted file with the owner password verified by qpdf, with no confirmation', async () => {
        const out = await applyPdfWatermark(await userProtected('none'), WATERMARK, { password: OWNER_PASSWORD });
        expect(containsEncryptKey(out)).toBe(false);
        expect(qpdfCheckPasses(out)).toBe(true);
        expect(pdftotext(out)).toContain(MARK);
      });
    });
  }

  for (const variant of ENCRYPTION_VARIANTS) {
    it(`${variant.name}: watermarks an unrestricted file with the user password (cross-reference stream and table)`, async () => {
      for (const structure of ['classic', 'objstm'] as const) {
        const pdf = qpdfEncrypt(await plainPdf(['Variant body']), { variant, userPassword: USER_PASSWORD, ownerPassword: OWNER_PASSWORD, structure });
        const out = await applyPdfWatermark(pdf, WATERMARK, { password: USER_PASSWORD });
        expect(qpdfCheckPasses(out)).toBe(true);
        expect(pdftotext(out)).toContain(MARK);
        expect(pdftotext(out)).toContain('Variant body');
      }
    });
  }

  it('only asks for confirmation when a right the edit needs is forbidden', async () => {
    // Copying forbidden, editing allowed: a watermark does not need the copy right.
    const noCopy = qpdfEncrypt(await plainPdf(['Copy body']), { variant: AES_256, userPassword: '', ownerPassword: OWNER_PASSWORD, extractAllowed: false });
    expect(qpdfEncryptionReport(noCopy, OWNER_PASSWORD).capabilities).toMatchObject({ extract: false, modifyother: true });
    const out = await applyPdfWatermark(noCopy, WATERMARK);
    expect(qpdfCheckPasses(out)).toBe(true);
    expect(pdftotext(out)).toContain(MARK);
  });

  it('refuses a document that allows page assembly but not content changes', async () => {
    const assemblyOnly = qpdfEncrypt(await plainPdf(), { variant: AES_256, userPassword: '', ownerPassword: OWNER_PASSWORD, modify: 'assembly' });
    expectPermissionDenied(await rejection(applyPdfWatermark(assemblyOnly, WATERMARK)));
  });

  it('leaves an unencrypted PDF working without any option', async () => {
    const out = await applyPdfWatermark(await plainPdf(['Open body']), WATERMARK);
    expect(qpdfCheckPasses(out)).toBe(true);
    expect(pdftotext(out)).toContain(MARK);
  });

  it('refuses a PDF whose structure cannot be inspected with a typed 400 instead of loading it', async () => {
    const error = await rejection(applyPdfWatermark(Buffer.from('%PDF-1.7\nnot a real file\n'), WATERMARK));
    expect(error).toBeInstanceOf(PdfStructureError);
    expect((error as Error).message).toMatch(/no startxref/);
    expect(classifyJobFailure(error)).toMatchObject({ code: 'PdfStructureError', status: 400, retryable: false });
  });
});

describe.skipIf(toolsMissing)('merge of encrypted PDFs', () => {
  const secondPlain = async (): Promise<Buffer> => plainPdf(['Second body']);

  for (const variant of [AES_256, RC4_128]) {
    describe(variant.name, () => {
      it('answers PdfPasswordRequiredError (422) when an input needs a user password and none is supplied', async () => {
        const encrypted = qpdfEncrypt(await plainPdf(['First body']), { variant, userPassword: USER_PASSWORD, ownerPassword: OWNER_PASSWORD });
        expectPasswordRequired(await rejection(mergePdfBuffers([encrypted, await secondPlain()])));
        expectPasswordRequired(await rejection(mergePdfBuffers([await secondPlain(), encrypted], CONFIRM)));
      });

      it('merges with the password of each encrypted input; the output passes qpdf --check and keeps all pages and text', async () => {
        const first = qpdfEncrypt(await plainPdf(['First body']), { variant, userPassword: USER_PASSWORD, ownerPassword: OWNER_PASSWORD });
        const second = qpdfEncrypt(await plainPdf(['Second body']), { variant, userPassword: 'other-user-pw', ownerPassword: OWNER_PASSWORD });
        const merged = await mergePdfBuffers([first, await secondPlain(), second], {
          passwords: [USER_PASSWORD, undefined, 'other-user-pw'],
        });

        expect(containsEncryptKey(merged)).toBe(false);
        expect(qpdfCheckPasses(merged)).toBe(true);
        expect(pdfinfoPages(merged)).toBe(3);
        const text = pdftotext(merged);
        expect(text).toContain('First body');
        expect(text).toContain('Second body');
      });

      it('merges a file with no open password and no restriction without any option', async () => {
        const open = qpdfEncrypt(await plainPdf(['Open owner file']), { variant, userPassword: '', ownerPassword: OWNER_PASSWORD });
        const merged = await mergePdfBuffers([open, await secondPlain()]);
        expect(qpdfCheckPasses(merged)).toBe(true);
        expect(pdfinfoPages(merged)).toBe(2);
      });

      it('refuses a restricted input until the rights are confirmed, with or without an open password', async () => {
        const withUserPassword = qpdfEncrypt(await plainPdf(['Restricted']), { variant, userPassword: USER_PASSWORD, ownerPassword: OWNER_PASSWORD, modify: 'none' });
        const withoutOpenPassword = qpdfEncrypt(await plainPdf(['Restricted']), { variant, userPassword: '', ownerPassword: OWNER_PASSWORD, modify: 'none' });
        expectPermissionDenied(await rejection(mergePdfBuffers([withUserPassword, await secondPlain()], { passwords: [USER_PASSWORD] })));
        expectPermissionDenied(await rejection(mergePdfBuffers([withoutOpenPassword, await secondPlain()])));
      });

      it('merges restricted inputs when the rights are confirmed', async () => {
        const withUserPassword = qpdfEncrypt(await plainPdf(['Restricted one']), { variant, userPassword: USER_PASSWORD, ownerPassword: OWNER_PASSWORD, modify: 'none' });
        const withoutOpenPassword = qpdfEncrypt(await plainPdf(['Restricted two']), { variant, userPassword: '', ownerPassword: OWNER_PASSWORD, modify: 'none' });
        const merged = await mergePdfBuffers([withUserPassword, withoutOpenPassword], { passwords: [USER_PASSWORD], ...CONFIRM });
        expect(containsEncryptKey(merged)).toBe(false);
        expect(qpdfCheckPasses(merged)).toBe(true);
        expect(pdfinfoPages(merged)).toBe(2);
        expect(pdftotext(merged)).toContain('Restricted one');
        expect(pdftotext(merged)).toContain('Restricted two');
      });

      it('merges a restricted input when its owner password is supplied, with no confirmation', async () => {
        const restricted = qpdfEncrypt(await plainPdf(['Restricted']), { variant, userPassword: USER_PASSWORD, ownerPassword: OWNER_PASSWORD, modify: 'none' });
        const merged = await mergePdfBuffers([restricted, await secondPlain()], { passwords: [OWNER_PASSWORD] });
        expect(qpdfCheckPasses(merged)).toBe(true);
        expect(pdfinfoPages(merged)).toBe(2);
        expect(pdftotext(merged)).toContain('Restricted');
      });
    });
  }

  it('merges a document that forbids content changes but allows page assembly, with no confirmation', async () => {
    const assemblyOnly = qpdfEncrypt(await plainPdf(['Assembly body']), { variant: AES_256, userPassword: '', ownerPassword: OWNER_PASSWORD, modify: 'assembly' });
    const merged = await mergePdfBuffers([assemblyOnly, await secondPlain()]);
    expect(qpdfCheckPasses(merged)).toBe(true);
    expect(pdftotext(merged)).toContain('Assembly body');
  });

  it('does not use the password of one input to open another', async () => {
    const first = qpdfEncrypt(await plainPdf(['First']), { variant: AES_256, userPassword: USER_PASSWORD, ownerPassword: OWNER_PASSWORD });
    const second = qpdfEncrypt(await plainPdf(['Second']), { variant: AES_256, userPassword: 'other-user-pw', ownerPassword: OWNER_PASSWORD });
    const error = await rejection(mergePdfBuffers([first, second], { passwords: [USER_PASSWORD] }));
    expectPasswordRequired(error);
  });

  it('still merges plain PDFs with no options', async () => {
    const merged = await mergePdfBuffers([await plainPdf(['A body']), await secondPlain()]);
    expect(qpdfCheckPasses(merged)).toBe(true);
    expect(pdfinfoPages(merged)).toBe(2);
  });
});

describe.skipIf(toolsMissing)('unlock of a PDF', () => {
  it('removes the encryption of a restricted file opened with its user password once the rights are confirmed', async () => {
    const locked = qpdfEncrypt(await plainPdf(['Unlock body']), { variant: AES_256, userPassword: USER_PASSWORD, ownerPassword: OWNER_PASSWORD, modify: 'none' });
    const out = await unlockPdf(locked, { password: USER_PASSWORD, ...CONFIRM });

    expect(containsEncryptKey(out)).toBe(false);
    expect(qpdfCheckPasses(out)).toBe(true);
    expect(qpdfEncryptionReport(out).encrypted).toBe(false);
    expect(pdftotext(out)).toContain('Unlock body');
    expect(pdfinfoPages(out)).toBe(1);
  });

  it('unlocks every encryption variant that has no open password once the rights are confirmed', async () => {
    for (const variant of ENCRYPTION_VARIANTS) {
      const locked = qpdfEncrypt(await plainPdf(['Variant unlock']), { variant, userPassword: '', ownerPassword: OWNER_PASSWORD, modify: 'none' });
      const out = await unlockPdf(locked, CONFIRM);
      expect(qpdfEncryptionReport(out).encrypted, variant.name).toBe(false);
      expect(qpdfCheckPasses(out), variant.name).toBe(true);
      expect(pdftotext(out), variant.name).toContain('Variant unlock');
    }
  });

  it('requires the user password when the file has one, even with the rights confirmed', async () => {
    const locked = qpdfEncrypt(await plainPdf(), { variant: RC4_128, userPassword: USER_PASSWORD, ownerPassword: OWNER_PASSWORD, modify: 'none' });
    expectPasswordRequired(await rejection(unlockPdf(locked, CONFIRM)));
    expectPasswordRequired(await rejection(unlockPdf(locked, { password: 'wrong-guess', ...CONFIRM })));
  });

  it('refuses restrictions of any kind until the rights are confirmed', async () => {
    const noCopy = qpdfEncrypt(await plainPdf(), { variant: AES_256, userPassword: '', ownerPassword: OWNER_PASSWORD, extractAllowed: false });
    expectPermissionDenied(await rejection(unlockPdf(noCopy)));
    const out = await unlockPdf(noCopy, CONFIRM);
    expect(qpdfEncryptionReport(out).encrypted).toBe(false);
  });

  it('unlocks with the owner password and no confirmation', async () => {
    const locked = qpdfEncrypt(await plainPdf(['Owner unlock']), { variant: AES_256, userPassword: USER_PASSWORD, ownerPassword: OWNER_PASSWORD, modify: 'none' });
    const out = await unlockPdf(locked, { password: OWNER_PASSWORD });
    expect(qpdfEncryptionReport(out).encrypted).toBe(false);
    expect(pdftotext(out)).toContain('Owner unlock');
  });

  it('decrypts a file whose only protection is that it is encrypted, with no confirmation', async () => {
    const open = qpdfEncrypt(await plainPdf(['Unrestricted']), { variant: AES_256, userPassword: '', ownerPassword: OWNER_PASSWORD });
    const out = await unlockPdf(open);
    expect(qpdfEncryptionReport(out).encrypted).toBe(false);
  });

  it('returns an unencrypted PDF unchanged', async () => {
    const plain = await plainPdf(['Already open']);
    expect(Buffer.compare(await unlockPdf(plain), plain)).toBe(0);
  });
});

describe.skipIf(toolsMissing)('artifact metadata of an encrypted PDF', () => {
  it('skips an encrypted file explicitly and records that, without reading it', async () => {
    const encrypted = qpdfEncrypt(await plainPdf(), { variant: AES_256, userPassword: '', ownerPassword: OWNER_PASSWORD });
    const meta = await extractArtifactMetadata(encrypted, 'locked.pdf', 'k/locked.pdf');
    expect(meta).toMatchObject({ format: 'pdf', encrypted: true, sizeBytes: encrypted.length, storageKey: 'k/locked.pdf' });
    expect(meta).not.toHaveProperty('pageCount');
    expect(meta).not.toHaveProperty('title');
    expect(meta).not.toHaveProperty('author');
  });

  it('still reports the page count of an unencrypted PDF and no encrypted flag', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([100, 100]);
    doc.setTitle('Open title');
    const meta = await extractArtifactMetadata(Buffer.from(await doc.save()), 'open.pdf');
    expect(meta).toMatchObject({ pageCount: 1, title: 'Open title' });
    expect(meta).not.toHaveProperty('encrypted');
  });
});

describe.skipIf(toolsMissing)('worker page count fallback', () => {
  async function pageCountWithoutPdfinfo(pdf: Buffer): Promise<number> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-571-pages-'));
    try {
      const inputPath = path.join(dir, 'in.pdf');
      fs.writeFileSync(inputPath, pdf);
      return await withMissingBinary('PDFINFO_PATH', () => getPdfPageCount(inputPath, dir, 30_000, undefined, pdf));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('counts the pages of an unencrypted PDF through the fallback', async () => {
    expect(await pageCountWithoutPdfinfo(await plainPdf(['a', 'b']))).toBe(2);
  });

  it('answers PdfPasswordRequiredError for an encrypted PDF instead of reading it with ignoreEncryption', async () => {
    const encrypted = qpdfEncrypt(await plainPdf(['a', 'b']), { variant: AES_256, userPassword: USER_PASSWORD, ownerPassword: OWNER_PASSWORD });
    expectPasswordRequired(await rejection(pageCountWithoutPdfinfo(encrypted)));
  });

  it('throws a typed PdfStructureError (400), not a bare Error, when the structure cannot be read', async () => {
    const error = await rejection(pageCountWithoutPdfinfo(Buffer.from('%PDF-1.4\ngarbage that is not a document\n')));
    expect(error).toBeInstanceOf(PdfStructureError);
    expect(classifyJobFailure(error)).toMatchObject({ code: 'PdfStructureError', status: 400, retryable: false });
  });
});

describe.skipIf(toolsMissing)('no conversion returns a 0-byte success for an encrypted input', () => {
  const TARGETS = ['txt', 'md', 'html', 'rtf', 'docx', 'pdf'];

  async function convertWithoutPassword(variant: EncryptionVariant, target: string): Promise<unknown> {
    const encrypted = qpdfEncrypt(await plainPdf(['Locked body']), { variant, userPassword: USER_PASSWORD, ownerPassword: OWNER_PASSWORD });
    const options = target === 'pdf' ? { watermark: WATERMARK } : {};
    try {
      return { resolved: await dispatchConversion(encrypted, 'pdf', target, options, 'locked.pdf') };
    } catch (error) {
      return { rejected: error };
    }
  }

  for (const variant of [AES_256, RC4_128]) {
    for (const target of TARGETS) {
      it(`${variant.name} pdf to ${target} is refused with a 422 and no output`, async () => {
        const outcome = (await convertWithoutPassword(variant, target)) as { resolved?: unknown; rejected?: { status?: number; name?: string } };
        expect(outcome.resolved).toBeUndefined();
        expect(outcome.rejected?.status).toBe(HTTP_UNPROCESSABLE);
      });
    }
  }
});

describe('ignoreEncryption stays out of the source tree', () => {
  function sourceFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return /\.(ts|tsx|mjs|js)$/.test(entry.name) ? [full] : [];
    });
  }

  function filesIgnoringEncryption(dir: string): string[] {
    return sourceFiles(dir)
      .filter((file) => /ignoreEncryption\s*:\s*true/.test(fs.readFileSync(file, 'utf-8')))
      .map((file) => path.relative(dir, file));
  }

  it('finds no `ignoreEncryption: true` under src', () => {
    expect(filesIgnoringEncryption(SRC_DIR)).toEqual([]);
  });

  it('would catch it: the scan reports a planted offender and ignores `ignoreEncryption: false`', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-571-scan-'));
    try {
      fs.mkdirSync(path.join(dir, 'nested'));
      fs.writeFileSync(path.join(dir, 'nested', 'bad.ts'), 'await PDFDocument.load(bytes, {ignoreEncryption:true});');
      fs.writeFileSync(path.join(dir, 'bad-spaced.ts'), 'PDFDocument.load(bytes, { ignoreEncryption : true })');
      fs.writeFileSync(path.join(dir, 'good.ts'), 'PDFDocument.load(bytes, { ignoreEncryption: false })');
      expect(filesIgnoringEncryption(dir).sort()).toEqual(['bad-spaced.ts', path.join('nested', 'bad.ts')]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
