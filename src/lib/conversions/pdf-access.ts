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
 * `ignoreEncryption`, which parses ciphertext as if it were plain and reports success for a broken result:
 *
 *  - a file that needs an open (user) password and gets none, or a wrong one: PdfPasswordRequiredError (422). A file
 *    with no open password opens with the empty password, so a request that carries none is enough for it;
 *  - the owner restricts a right the edit needs (modifying, annotating, assembling; unlocking and re-protecting need every right, because the new file replaces the old restrictions):
 *    PdfPermissionDeniedError (422), unless the request confirms the caller may edit the document
 *    (`confirmEditRights: true`) or supplies the owner password, which qpdf verifies;
 *  - otherwise qpdf decrypts the PDF into a private directory and the plain bytes are returned.
 *
 * The edited copy is written without encryption, so a confirmed edit also drops the owner's restrictions.
 * The password reaches qpdf through a 0600 file (see pdf-decrypt) and appears in no message, log or return value.
 */

/** Longest qpdf may spend on one decrypt or inspection; a hostile document cannot hold a job beyond it. */
const PDF_ACCESS_TIMEOUT_MS = 60_000;

const REQUIRED_MESSAGE =
  'The PDF is encrypted. Supply the document password to edit it; encrypted PDFs are never edited without one.';

export type PdfEditOperation = 'watermark' | 'merge' | 'unlock' | 'protect';

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

const OPERATION_VERBS: Readonly<Record<PdfEditOperation, string>> = {
  watermark: 'watermark',
  merge: 'merge',
  unlock: 'unlock',
  protect: 'protection',
};

export interface PdfAccess {
  /** Open password of the PDF (user or owner). Omitted or empty: the empty password, which only a file with no open password accepts. */
  password?: string;
  /** True when the caller states that they may edit the document, which lifts the owner's restrictions. Only `true` counts. */
  confirmEditRights?: boolean;
}

/** The rights the edit needs, as groups of which at least one right must be allowed. */
function neededRights(operation: PdfEditOperation, capabilities: Readonly<Record<string, boolean>>): string[][] {
  switch (operation) {
    case 'watermark':
      return [['modifyother'], ['modifyannotations']];
    case 'merge':
      return [['modifyassembly', 'modifyother']];
    case 'unlock':
    case 'protect':
      return Object.keys(capabilities).filter((key) => key !== 'modify').map((key) => [key]);
  }
}

/** Names of the rights the edit needs that the document forbids; empty when the edit is allowed. */
function forbiddenRights(operation: PdfEditOperation, capabilities: Readonly<Record<string, boolean>>): string[] {
  return neededRights(operation, capabilities)
    .filter((group) => !group.some((right) => capabilities[right] === true))
    .map((group) => group.map((right) => RIGHT_LABELS[right] ?? right).join(' or '));
}

async function decryptWithAccessCheck(pdf: Buffer, operation: PdfEditOperation, access: PdfAccess): Promise<Buffer> {
  const tempDir = createWorkerSandboxDir('easyconvert-pdf-access_');
  try {
    const inputPath = path.join(tempDir, 'input.pdf');
    fs.writeFileSync(inputPath, pdf, { mode: 0o600 });
    const request = { inputPath, tempDir, password: access.password ?? '', timeoutMs: PDF_ACCESS_TIMEOUT_MS };

    // A confirmed edit needs no verdict: the confirmation lifts every restriction, and a wrong password still fails the
    // decryption below. Only an unconfirmed request asks qpdf which rights the password grants.
    if (access.confirmEditRights !== true) {
      const verdict = await readPdfAccess(request);
      const forbidden = forbiddenRights(operation, verdict.capabilities);
      if (forbidden.length > 0 && !verdict.ownerPasswordMatched) {
        throw new PdfPermissionDeniedError(
          `The PDF's permissions forbid ${forbidden.join(' and ')}, which the ${OPERATION_VERBS[operation]} needs. ` +
            'Set confirmEditRights to true to confirm that you may edit this document, or supply its owner password as the password.'
        );
      }
    }
    return await withQpdfDecryptedPdf(request, async (plainPath) => fs.readFileSync(plainPath));
  } finally {
    cleanupWorkerSandboxDir(tempDir);
  }
}

/**
 * The bytes of `pdf` as an unencrypted PDF that `operation` may edit with `access`.
 *
 * @throws PdfStructureError (400) when the trailer cannot be read.
 * @throws PdfPasswordRequiredError (422) when the PDF needs an open password and it is missing or wrong.
 * @throws PdfPermissionDeniedError (422) when the owner forbids the edit and neither the confirmation nor the owner
 *   password was supplied.
 * @throws EngineUnavailableError when the PDF is encrypted and qpdf is not installed.
 */
export async function openPdfForEditing(pdf: Buffer, operation: PdfEditOperation, access: PdfAccess = {}): Promise<Buffer> {
  if (!inspectPdfEncryption(pdf).encrypted) return pdf;
  return decryptWithAccessCheck(pdf, operation, access);
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
