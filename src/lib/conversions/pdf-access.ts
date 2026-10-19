import { EncryptedPDFError, PDFDocument } from 'pdf-lib';
import { decryptPdfToBuffer, pdfPageTreeLoops, readPdfAccess } from '../../worker/pdf-decrypt';
import { PdfPasswordRequiredError, PdfPermissionDeniedError } from '../types';
import { PdfStructureError } from './pdf-document';
import { withQpdfInputFile } from './pdf-postprocess/qpdf-run';
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
 *
 * Reading is a different gate: `openPdfForReading` below serves the converters that read a PDF in the process (text,
 * Markdown, HTML, hOCR, ALTO, the Office targets, OCR). The owner's permission flags do not stop a conversion, which
 * reads what any viewer shows, so only the open password matters there.
 */

/** Longest qpdf may spend on one decrypt or inspection; a hostile document cannot hold a job beyond it. */
const PDF_ACCESS_TIMEOUT_MS = 60_000;

const REQUIRED_MESSAGE =
  'The PDF is encrypted. Supply the document password to edit it; encrypted PDFs are never edited without one.';

export type PdfEditOperation =
  | 'watermark'
  | 'merge'
  | 'unlock'
  | 'protect'
  | 'split'
  | 'extract'
  | 'delete'
  | 'reorder'
  | 'rotate'
  | 'compress';

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
  split: 'split',
  extract: 'page extraction',
  delete: 'page deletion',
  reorder: 'page reordering',
  rotate: 'rotation',
  compress: 'compression',
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
    case 'split':
    case 'extract':
    case 'delete':
    case 'reorder':
    case 'rotate':
      return [['modifyassembly', 'modifyother']];
    case 'compress':
      return [['modifyother']];
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

/** A decrypted PDF, and whether qpdf refused its pages because the page tree loops (asked only when the caller wants to know). */
interface DecryptedPdf {
  plain: Buffer;
  pageTreeLoops: boolean;
}

async function decryptWithAccessCheck(pdf: Buffer, operation: PdfEditOperation, access: PdfAccess, askPageTree = false): Promise<DecryptedPdf> {
  return withQpdfInputFile(pdf, async ({ inputPath, dir }) => {
    const request = { inputPath, tempDir: dir, password: access.password ?? '', timeoutMs: PDF_ACCESS_TIMEOUT_MS };

    // The plain bytes are printed by qpdf on standard output, so no decrypted copy is written to disk. A confirmed
    // edit needs no verdict: the confirmation lifts every restriction, and a wrong password still fails the
    // decryption. Only an unconfirmed request asks qpdf which rights the password grants, and it asks beside the
    // decryption: the two read the same file, so the check costs no wall time. The question whether the page tree
    // loops is asked beside them for the same reason, and never delays or fails them.
    const stop = new AbortController();
    const decrypting = decryptPdfToBuffer({ ...request, signal: stop.signal });
    const looping = askPageTree ? pdfPageTreeLoops({ ...request, signal: stop.signal }) : Promise.resolve(false);
    // A decryption that fails while the verdict is awaited must not surface as an unhandled rejection.
    decrypting.catch(() => undefined);
    try {
      if (access.confirmEditRights !== true) await assertEditAllowed(request, operation);
      const [plain, pageTreeLoops] = await Promise.all([decrypting, looping]);
      return { plain, pageTreeLoops };
    } catch (error) {
      stop.abort();
      throw error;
    }
  });
}

async function assertEditAllowed(request: Parameters<typeof readPdfAccess>[0], operation: PdfEditOperation): Promise<void> {
  const verdict = await readPdfAccess(request);
  const forbidden = forbiddenRights(operation, verdict.capabilities);
  if (forbidden.length > 0 && !verdict.ownerPasswordMatched) {
    throw new PdfPermissionDeniedError(
      `The PDF's permissions forbid ${forbidden.join(' and ')}, which the ${OPERATION_VERBS[operation]} needs. ` +
        'Set confirmEditRights to true to confirm that you may edit this document, or supply its owner password as the password.'
    );
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
  return (await decryptWithAccessCheck(pdf, operation, access)).plain;
}

/**
 * `openPdfForEditing` for a caller that returns the decrypted document itself, and so must mend a page tree that loops
 * (see pdf-postprocess/page-tree): `pageTreeLoops` says whether qpdf refused the pages of the encrypted file, asked beside
 * the decryption. An unencrypted PDF is returned as it is, with no question asked.
 */
export async function openPdfForUnlocking(pdf: Buffer, access: PdfAccess = {}): Promise<DecryptedPdf> {
  if (!inspectPdfEncryption(pdf).encrypted) return { plain: pdf, pageTreeLoops: false };
  return decryptWithAccessCheck(pdf, 'unlock', access, true);
}

/**
 * `openPdfForEditing` for a route that rebuilds the document from its pages (a searchable PDF from OCR): a file whose
 * cross-reference data cannot be read is returned as it is, as `openPdfForReading` does, so the rebuild repairs it or
 * refuses it with its own error; pdf-lib refuses one that is still encrypted.
 *
 * @throws PdfPasswordRequiredError, PdfPermissionDeniedError (422) as `openPdfForEditing`.
 */
export async function openPdfForRebuilding(pdf: Buffer, operation: PdfEditOperation, access: PdfAccess = {}): Promise<Buffer> {
  return isEncrypted(pdf) ? (await decryptWithAccessCheck(pdf, operation, access)).plain : pdf;
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

/**
 * The bytes of `pdf` as a PDF the in-process readers can parse. A file that is not encrypted is returned as it is. An
 * encrypted one is decrypted by qpdf with `password`, or with the empty password when the request carries none: a file
 * with no open password opens that way, whatever its owner restricts, and a file whose owner password is empty does
 * too, as in every reader that takes the owner password for an open password. The plain copy is for reading only: a
 * result that carries the document itself (a PDF returned as it came) still returns the original bytes.
 *
 * A file whose cross-reference data cannot be read is returned as it is: the readers repair what they can, and a
 * document that needs a password still refuses there (they never read ciphertext as text).
 *
 * @throws PdfPasswordRequiredError (422) when the PDF needs an open password that the request lacks or got wrong.
 * @throws EngineUnavailableError when the PDF is encrypted and qpdf is not installed.
 */
export async function openPdfForReading(pdf: Buffer, password?: string, signal?: AbortSignal): Promise<Buffer> {
  if (!isEncrypted(pdf)) return pdf;
  return withQpdfInputFile(pdf, ({ inputPath, dir }) =>
    decryptPdfToBuffer({ inputPath, tempDir: dir, password: password ?? '', timeoutMs: PDF_ACCESS_TIMEOUT_MS, signal })
  );
}

function isEncrypted(pdf: Buffer): boolean {
  try {
    return inspectPdfEncryption(pdf).encrypted;
  } catch (error) {
    if (error instanceof PdfStructureError) return false;
    throw error;
  }
}
