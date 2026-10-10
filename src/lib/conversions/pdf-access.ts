import fs from 'node:fs';
import path from 'node:path';
import { EncryptedPDFError, PDFDocument } from 'pdf-lib';
import { cleanupWorkerSandboxDir, createWorkerSandboxDir } from '../../worker/sandbox';
import { readPdfAccess, withQpdfDecryptedPdf } from '../../worker/pdf-decrypt';
import { PdfPasswordRequiredError, PdfPermissionDeniedError } from '../types';
import { inspectPdfEncryption } from './pdf-encryption';

/**
 * The gate every PDF edit passes before pdf-lib loads the file (#571).
 *
 * An unencrypted PDF passes through untouched. An encrypted one is never opened through pdf-lib's
 * `ignoreEncryption`, which parses ciphertext as if it were plain and reports success for a broken result, and
 * never edited past its owner's restrictions:
 *
 *  - no password: PdfPasswordRequiredError (422);
 *  - a password qpdf rejects: PdfPasswordRequiredError (422);
 *  - a password that opens the file while the owner restricts any right (printing, copying, modifying, annotating,
 *    assembling): PdfPermissionDeniedError (422), because the edited copy is written without encryption and would
 *    drop those restrictions. Only the owner password, verified by qpdf, lifts them;
 *  - otherwise the PDF is decrypted by qpdf into a private directory and the plain bytes are returned.
 *
 * The password reaches qpdf through a 0600 file (see pdf-decrypt) and appears in no message, log or return value.
 */

/** Longest qpdf may spend on one decrypt or inspection; a hostile document cannot hold a job beyond it. */
const PDF_ACCESS_TIMEOUT_MS = 60_000;

const REQUIRED_MESSAGE =
  'The PDF is encrypted. Supply the document password to edit it; encrypted PDFs are never edited without one.';

/** Plain-language names of the rights qpdf reports, used in the message that tells the caller what is forbidden. */
const RIGHT_LABELS: Readonly<Record<string, string>> = {
  accessibility: 'text extraction for accessibility',
  extract: 'copying content',
  modify: 'modification',
  modifyannotations: 'annotating',
  modifyassembly: 'page assembly',
  modifyforms: 'form filling',
  modifyother: 'modifying content',
  printhigh: 'high-resolution printing',
  printlow: 'printing',
};

export interface PdfAccess {
  /** Open password of the PDF (user or owner). An empty string is the empty user password. */
  password?: string;
}

function deniedRights(capabilities: Readonly<Record<string, boolean>>): string {
  return Object.entries(capabilities)
    .filter(([key, allowed]) => !allowed && key !== 'modify')
    .map(([key]) => RIGHT_LABELS[key] ?? key)
    .join(', ');
}

async function decryptWithAccessCheck(pdf: Buffer, password: string): Promise<Buffer> {
  const tempDir = createWorkerSandboxDir('easyconvert-pdf-access_');
  try {
    const inputPath = path.join(tempDir, 'input.pdf');
    fs.writeFileSync(inputPath, pdf, { mode: 0o600 });
    const request = { inputPath, tempDir, password, timeoutMs: PDF_ACCESS_TIMEOUT_MS };

    const verdict = await readPdfAccess(request);
    const restricted = Object.values(verdict.capabilities).some((allowed) => !allowed);
    if (restricted && !verdict.ownerPasswordMatched) {
      throw new PdfPermissionDeniedError(
        `The PDF's permissions forbid ${deniedRights(verdict.capabilities)}, so it cannot be edited with the user password. ` +
          'Supply the owner password of the document to edit it.'
      );
    }
    return await withQpdfDecryptedPdf(request, async (plainPath) => fs.readFileSync(plainPath));
  } finally {
    cleanupWorkerSandboxDir(tempDir);
  }
}

/**
 * The bytes of `pdf` as an unencrypted PDF that is allowed to be edited with `access`.
 *
 * @throws PdfStructureError (400) when the trailer cannot be read.
 * @throws PdfPasswordRequiredError (422) when the PDF is encrypted and the password is missing or wrong.
 * @throws PdfPermissionDeniedError (422) when the owner forbids the edit and the owner password was not supplied.
 * @throws EngineUnavailableError when the PDF is encrypted and qpdf is not installed.
 */
export async function openPdfForEditing(pdf: Buffer, access: PdfAccess = {}): Promise<Buffer> {
  if (!inspectPdfEncryption(pdf).encrypted) return pdf;
  if (access.password === undefined) throw new PdfPasswordRequiredError(REQUIRED_MESSAGE);
  return decryptWithAccessCheck(pdf, access.password);
}

/**
 * Loads an unencrypted PDF with pdf-lib. A file pdf-lib still finds encrypted, because its parser reads the trailer
 * differently from ours, is refused like any other encrypted input instead of being read as plain.
 */
export async function loadPdfDocument(plain: Buffer): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(plain);
  } catch (error) {
    if (error instanceof EncryptedPDFError) {
      throw new PdfPasswordRequiredError(REQUIRED_MESSAGE);
    }
    throw error;
  }
}
