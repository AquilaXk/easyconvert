import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { applyPdfWatermark } from '../src/lib/conversions/pdf-postprocess';
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

describe.skipIf(toolsMissing)('watermark of an encrypted PDF', () => {
  for (const variant of [AES_256, RC4_128]) {
    describe(variant.name, () => {
      const fixtures = async (): Promise<Record<string, Buffer>> => {
        const plain = await plainPdf(['Secret body text']);
        return {
          'empty user password, no owner restriction': qpdfEncrypt(plain, { variant, userPassword: '', ownerPassword: '' }),
          'empty user password, owner password': qpdfEncrypt(plain, { variant, userPassword: '', ownerPassword: OWNER_PASSWORD }),
          'empty user password, owner password, modify none': qpdfEncrypt(plain, {
            variant,
            userPassword: '',
            ownerPassword: OWNER_PASSWORD,
            modify: 'none',
          }),
          'user password': qpdfEncrypt(plain, { variant, userPassword: USER_PASSWORD, ownerPassword: OWNER_PASSWORD }),
        };
      };

      it('answers PdfPasswordRequiredError (422) for every fixture when no password is supplied', async () => {
        for (const [label, pdf] of Object.entries(await fixtures())) {
          const error = await rejection(applyPdfWatermark(pdf, WATERMARK));
          expect(error, label).toBeInstanceOf(PdfPasswordRequiredError);
          expect((error as PdfPasswordRequiredError).status, label).toBe(HTTP_UNPROCESSABLE);
        }
      });

      it('answers PdfPasswordRequiredError for a wrong password, without echoing it', async () => {
        const wrong = 'not-the-password-xyz';
        const pdf = (await fixtures())['user password'];
        const error = await rejection(applyPdfWatermark(pdf, WATERMARK, { password: wrong }));
        expectPasswordRequired(error);
        expect((error as Error).message).not.toContain(wrong);
      });

      it('watermarks with the user password; the output is unencrypted, passes qpdf --check and keeps its text', async () => {
        const pdf = (await fixtures())['user password'];
        const out = await applyPdfWatermark(pdf, WATERMARK, { password: USER_PASSWORD });

        expect(containsEncryptKey(out)).toBe(false);
        expect(qpdfCheckPasses(out)).toBe(true);
        const text = pdftotext(out);
        expect(text).toContain(MARK);
        expect(text).toContain('Secret body text');
      });

      it('watermarks with the explicit empty user password of an unrestricted file', async () => {
        const pdf = (await fixtures())['empty user password, no owner restriction'];
        const out = await applyPdfWatermark(pdf, WATERMARK, { password: '' });
        expect(qpdfCheckPasses(out)).toBe(true);
        expect(pdftotext(out)).toContain(MARK);
      });

      it('refuses a modify-restricted file with the user password: PdfPermissionDeniedError (422)', async () => {
        const restricted = qpdfEncrypt(await plainPdf(), {
          variant,
          userPassword: USER_PASSWORD,
          ownerPassword: OWNER_PASSWORD,
          modify: 'none',
        });
        const error = await rejection(applyPdfWatermark(restricted, WATERMARK, { password: USER_PASSWORD }));
        expect(error).toBeInstanceOf(PdfPermissionDeniedError);
        expect((error as PdfPermissionDeniedError).status).toBe(HTTP_UNPROCESSABLE);
        expect((error as Error).message).toMatch(/owner password/i);
        expect((error as Error).message).not.toContain(USER_PASSWORD);
      });

      it('refuses the empty password on a modify-restricted file with an empty user password', async () => {
        const restricted = (await fixtures())['empty user password, owner password, modify none'];
        const error = await rejection(applyPdfWatermark(restricted, WATERMARK, { password: '' }));
        expect(error).toBeInstanceOf(PdfPermissionDeniedError);
      });

      it('watermarks a modify-restricted file when the owner password is supplied and verified by qpdf', async () => {
        const restricted = qpdfEncrypt(await plainPdf(['Restricted body']), {
          variant,
          userPassword: USER_PASSWORD,
          ownerPassword: OWNER_PASSWORD,
          modify: 'none',
        });
        const out = await applyPdfWatermark(restricted, WATERMARK, { password: OWNER_PASSWORD });
        expect(containsEncryptKey(out)).toBe(false);
        expect(qpdfCheckPasses(out)).toBe(true);
        expect(pdftotext(out)).toContain(MARK);
        expect(pdftotext(out)).toContain('Restricted body');
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

  it('leaves an unencrypted PDF working without any password', async () => {
    const out = await applyPdfWatermark(await plainPdf(['Open body']), WATERMARK);
    expect(qpdfCheckPasses(out)).toBe(true);
    expect(pdftotext(out)).toContain(MARK);
  });

  it('refuses a PDF whose structure cannot be inspected with a typed 400 instead of loading it', async () => {
    const error = await rejection(applyPdfWatermark(Buffer.from('%PDF-1.7\nnot a real file\n'), WATERMARK));
    expect(error).toBeInstanceOf(PdfStructureError);
  });
});

describe.skipIf(toolsMissing)('merge of encrypted PDFs', () => {
  const secondPlain = async (): Promise<Buffer> => plainPdf(['Second body']);

  for (const variant of [AES_256, RC4_128]) {
    describe(variant.name, () => {
      it('answers PdfPasswordRequiredError (422) when an input is encrypted and no password is supplied', async () => {
        const encrypted = qpdfEncrypt(await plainPdf(['First body']), { variant, userPassword: '', ownerPassword: '' });
        expectPasswordRequired(await rejection(mergePdfBuffers([encrypted, await secondPlain()])));
        expectPasswordRequired(await rejection(mergePdfBuffers([await secondPlain(), encrypted])));
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

      it('refuses a modify-restricted input with only its user password: PdfPermissionDeniedError (422)', async () => {
        const restricted = qpdfEncrypt(await plainPdf(['Restricted']), {
          variant,
          userPassword: USER_PASSWORD,
          ownerPassword: OWNER_PASSWORD,
          modify: 'none',
        });
        const error = await rejection(mergePdfBuffers([restricted, await secondPlain()], { passwords: [USER_PASSWORD] }));
        expect(error).toBeInstanceOf(PdfPermissionDeniedError);
        expect((error as PdfPermissionDeniedError).status).toBe(HTTP_UNPROCESSABLE);
      });

      it('merges a modify-restricted input when its owner password is supplied', async () => {
        const restricted = qpdfEncrypt(await plainPdf(['Restricted']), {
          variant,
          userPassword: USER_PASSWORD,
          ownerPassword: OWNER_PASSWORD,
          modify: 'none',
        });
        const merged = await mergePdfBuffers([restricted, await secondPlain()], { passwords: [OWNER_PASSWORD] });
        expect(qpdfCheckPasses(merged)).toBe(true);
        expect(pdfinfoPages(merged)).toBe(2);
        expect(pdftotext(merged)).toContain('Restricted');
      });
    });
  }

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

  it('finds no `ignoreEncryption: true` under src', () => {
    const offenders = sourceFiles(SRC_DIR).filter((file) => /ignoreEncryption\s*:\s*true/.test(fs.readFileSync(file, 'utf-8')));
    expect(offenders.map((file) => path.relative(SRC_DIR, file))).toEqual([]);
  });

  it('keeps the scan itself honest: it sees the pdf-lib loads under src', () => {
    const loads = sourceFiles(SRC_DIR).filter((file) => fs.readFileSync(file, 'utf-8').includes('PDFDocument.load('));
    expect(loads.length).toBeGreaterThan(0);
  });
});
