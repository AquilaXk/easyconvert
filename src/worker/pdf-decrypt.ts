import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ConversionFailedError, EngineUnavailableError } from '../lib/types';
import { getQpdfBinaryPath } from '../lib/conversions/pdf-postprocess/protect';
import { executeSandboxedBinary, SandboxedProcessError } from './sandbox';

/**
 * Password-protected PDFs are decrypted once with qpdf into a private copy that the Poppler tools
 * read without any credential. The password travels to qpdf through a 0600 file inside the job's
 * private sandbox directory, never through argv (readable by every local process through
 * /proc/<pid>/cmdline) and never through the environment.
 */

/** Owner-only access for the password file and for the decrypted copy of the document. */
const PRIVATE_FILE_MODE = 0o600;
/** qpdf prints nothing but diagnostics on stdout/stderr when decrypting to a file. */
const QPDF_MAX_OUTPUT_BYTES = 1024 * 1024;
/** qpdf reports a rejected password as "<file>: invalid password" with a generic error exit code. */
const QPDF_INVALID_PASSWORD_PATTERN = /invalid password/i;
/** Poppler tools report a missing or rejected password as "Command Line Error: Incorrect password". */
const POPPLER_INCORRECT_PASSWORD_PATTERN = /incorrect password/i;
/** `--password-file` uses only the first line, so a line break would silently shorten the password. */
const PASSWORD_FILE_UNSAFE_CHARS = /[\r\n\0]/;

export const PDF_PASSWORD_REJECTED_MESSAGE = 'PDF is password-protected: the password is missing or incorrect.';
export const PDF_PASSWORD_UNSAFE_MESSAGE = 'PDF password contains invalid newline or null characters.';
export const PDF_DECRYPT_FAILED_MESSAGE = 'PDF could not be decrypted: the file is malformed or uses an unsupported encryption.';

export interface PdfDecryptRequest {
  /** Absolute or process-relative path of the (possibly encrypted) PDF. */
  inputPath: string;
  /** Private per-job directory that receives the password file and the decrypted copy. */
  tempDir: string;
  /** User or owner password. When absent or empty the PDF is handed over untouched. */
  password?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

/**
 * Maps a Poppler failure caused by a missing or incorrect password to the typed conversion error.
 * Returns null for every other failure so callers keep their own handling.
 */
export function toPopplerPasswordError(err: unknown): ConversionFailedError | null {
  if (err instanceof SandboxedProcessError && POPPLER_INCORRECT_PASSWORD_PATTERN.test(err.stderr)) {
    return new ConversionFailedError(PDF_PASSWORD_REJECTED_MESSAGE);
  }
  return null;
}

function removeQuietly(filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // The job sandbox directory is removed by its owner as well; never mask the real outcome.
  }
}

function toDecryptError(err: unknown): unknown {
  if (!(err instanceof SandboxedProcessError)) {
    return err;
  }
  if (QPDF_INVALID_PASSWORD_PATTERN.test(err.stderr)) {
    return new ConversionFailedError(PDF_PASSWORD_REJECTED_MESSAGE);
  }
  return new ConversionFailedError(PDF_DECRYPT_FAILED_MESSAGE);
}

async function decryptIntoFile(qpdf: string, request: PdfDecryptRequest, password: string, decryptedPath: string, nonce: string): Promise<void> {
  const passwordFile = path.join(request.tempDir, `qpdf-password-${nonce}.txt`);
  try {
    fs.writeFileSync(passwordFile, password, { mode: PRIVATE_FILE_MODE, flag: 'wx' });
    await executeSandboxedBinary(
      qpdf,
      [`--password-file=${passwordFile}`, '--warning-exit-0', '--decrypt', path.resolve(request.inputPath), decryptedPath],
      {
        cwd: request.tempDir,
        timeoutMs: request.timeoutMs,
        maxBuffer: QPDF_MAX_OUTPUT_BYTES,
        networkIsolated: true,
        signal: request.signal,
      }
    );
  } catch (err) {
    throw toDecryptError(err);
  } finally {
    // The credential must not outlive qpdf, even while the rendering step still runs.
    removeQuietly(passwordFile);
  }
  if (fs.statSync(decryptedPath).size === 0) {
    throw new ConversionFailedError(PDF_DECRYPT_FAILED_MESSAGE);
  }
}

/**
 * Runs `operation` with a path Poppler can read without a password.
 *
 * Without a password that is the input itself. With a password it is a decrypted copy in
 * `tempDir`, created through qpdf; the copy and the password file are removed when the operation
 * settles, whether it succeeds, fails, or the job is aborted.
 *
 * @throws ConversionFailedError when the password is wrong, unsafe, or the PDF cannot be decrypted.
 * @throws EngineUnavailableError when a password is supplied but qpdf is not installed.
 */
export async function withDecryptedPdf<T>(
  request: PdfDecryptRequest,
  operation: (readablePdfPath: string) => Promise<T>
): Promise<T> {
  const { password } = request;
  if (!password) {
    return operation(request.inputPath);
  }
  if (PASSWORD_FILE_UNSAFE_CHARS.test(password)) {
    throw new ConversionFailedError(PDF_PASSWORD_UNSAFE_MESSAGE);
  }
  const qpdf = getQpdfBinaryPath();
  if (!qpdf) {
    throw new EngineUnavailableError('qpdf', 'qpdf binary is not installed or not in PATH');
  }

  const nonce = crypto.randomUUID();
  const decryptedPath = path.join(request.tempDir, `decrypted-${nonce}.pdf`);
  try {
    // Create the plaintext copy owner-only before qpdf writes into it.
    fs.writeFileSync(decryptedPath, '', { mode: PRIVATE_FILE_MODE, flag: 'wx' });
    await decryptIntoFile(qpdf, request, password, decryptedPath, nonce);
    return await operation(decryptedPath);
  } finally {
    removeQuietly(decryptedPath);
  }
}
