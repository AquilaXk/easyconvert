import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ConversionFailedError, EngineUnavailableError, PdfPasswordRequiredError } from '../lib/types';
import { getQpdfBinaryPath } from '../lib/conversions/pdf-postprocess/protect';
import {
  executeSandboxedBinary,
  SandboxedBufferLimitError,
  SandboxedProcessError,
  type SandboxedExecutionResult,
} from './sandbox';

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
/**
 * qpdf only strips encryption, so the decrypted copy stays close to the input size. The write limit
 * is a named multiple of the input (with a floor for tiny files) and stops a hostile document from
 * making qpdf fill the disk.
 */
const QPDF_OUTPUT_SIZE_FACTOR = 4;
const QPDF_MIN_OUTPUT_BYTES = 1024 * 1024;
/** `--password-file` uses only the first line, so a line break would silently shorten the password. */
const PASSWORD_FILE_UNSAFE_CHARS = /[\r\n\0]/;

/** Engine name carried by the EngineUnavailableError raised when qpdf is not installed. */
export const QPDF_ENGINE_NAME = 'qpdf';
export const PDF_PASSWORD_REJECTED_MESSAGE = 'PDF is password-protected: the password is missing or incorrect.';
export const PDF_PASSWORD_UNSAFE_MESSAGE = 'PDF password contains invalid newline or null characters.';
export const PDF_DECRYPT_FAILED_MESSAGE = 'PDF could not be decrypted: the file is malformed or uses an unsupported encryption.';
export const PDF_DECRYPT_TOO_LARGE_MESSAGE = 'PDF could not be decrypted: the decrypted document exceeds the allowed size.';

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
 * Maps a Poppler failure caused by a missing or incorrect password to the typed conversion error (HTTP 422).
 * Returns null for every other failure so callers keep their own handling.
 */
export function toPopplerPasswordError(err: unknown): ConversionFailedError | null {
  if (err instanceof SandboxedProcessError && POPPLER_INCORRECT_PASSWORD_PATTERN.test(err.stderr)) {
    return new PdfPasswordRequiredError(PDF_PASSWORD_REJECTED_MESSAGE);
  }
  return null;
}

/**
 * True when a password was supplied but qpdf, the only component that can honour it, is missing.
 * No other engine can open the document, so callers must not fall back to one.
 */
export function isPasswordHandlingUnavailable(err: unknown, password: string | undefined): err is EngineUnavailableError {
  return Boolean(password) && err instanceof EngineUnavailableError && err.engineName === QPDF_ENGINE_NAME;
}

function removeQuietly(filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // The job sandbox directory is removed by its owner as well; never mask the real outcome.
  }
}

function toDecryptError(err: unknown): unknown {
  if (err instanceof SandboxedBufferLimitError) {
    return new ConversionFailedError(PDF_DECRYPT_TOO_LARGE_MESSAGE);
  }
  if (!(err instanceof SandboxedProcessError)) {
    return err;
  }
  if (QPDF_INVALID_PASSWORD_PATTERN.test(err.stderr)) {
    return new PdfPasswordRequiredError(PDF_PASSWORD_REJECTED_MESSAGE);
  }
  return new ConversionFailedError(PDF_DECRYPT_FAILED_MESSAGE);
}

/**
 * Runs qpdf with the password handed over in a 0600 file inside the job's private directory, and removes the file
 * when qpdf exits, whatever the outcome. Failures are mapped to the typed conversion errors.
 */
async function runQpdfWithPassword(
  qpdf: string,
  request: PdfDecryptRequest,
  password: string,
  nonce: string,
  buildArgs: (passwordFile: string) => string[],
  maxFileSize: number
): Promise<SandboxedExecutionResult> {
  const passwordFile = path.join(request.tempDir, `qpdf-password-${nonce}.txt`);
  try {
    fs.writeFileSync(passwordFile, password, { mode: PRIVATE_FILE_MODE, flag: 'wx' });
    return await executeSandboxedBinary(qpdf, buildArgs(passwordFile), {
      cwd: request.tempDir,
      timeoutMs: request.timeoutMs,
      maxBuffer: QPDF_MAX_OUTPUT_BYTES,
      maxFileSize,
      networkIsolated: true,
      signal: request.signal,
    });
  } catch (err) {
    throw toDecryptError(err);
  } finally {
    // The credential must not outlive qpdf, even while the rendering step still runs.
    removeQuietly(passwordFile);
  }
}

async function decryptIntoFile(qpdf: string, request: PdfDecryptRequest, password: string, decryptedPath: string, nonce: string): Promise<void> {
  const maxFileSize = Math.max(fs.statSync(request.inputPath).size * QPDF_OUTPUT_SIZE_FACTOR, QPDF_MIN_OUTPUT_BYTES);
  await runQpdfWithPassword(
    qpdf,
    request,
    password,
    nonce,
    (passwordFile) => [`--password-file=${passwordFile}`, '--warning-exit-0', '--decrypt', path.resolve(request.inputPath), decryptedPath],
    maxFileSize
  );
  if (fs.statSync(decryptedPath).size === 0) {
    throw new ConversionFailedError(PDF_DECRYPT_FAILED_MESSAGE);
  }
}

function requireQpdf(password: string): string {
  if (PASSWORD_FILE_UNSAFE_CHARS.test(password)) {
    throw new ConversionFailedError(PDF_PASSWORD_UNSAFE_MESSAGE);
  }
  const qpdf = getQpdfBinaryPath();
  if (!qpdf) {
    throw new EngineUnavailableError(QPDF_ENGINE_NAME, 'qpdf binary is not installed or not in PATH');
  }
  return qpdf;
}

/** What qpdf reports about the rights a password grants on an encrypted PDF. */
export interface PdfAccessVerdict {
  /** True when the supplied password is the owner password, which lifts every permission restriction. */
  ownerPasswordMatched: boolean;
  /** Permission flags of the document (`modifyother`, `extract`, `printhigh`, ...); false means the owner forbids it. */
  capabilities: Readonly<Record<string, boolean>>;
}

/**
 * Asks qpdf which rights `request.password` grants on the PDF. The password may be empty, which is the empty user
 * password of a document that only restricts permissions.
 *
 * @throws PdfPasswordRequiredError when qpdf rejects the password.
 * @throws EngineUnavailableError when qpdf is not installed.
 */
export async function readPdfAccess(request: PdfDecryptRequest & { password: string }): Promise<PdfAccessVerdict> {
  const qpdf = requireQpdf(request.password);
  const result = await runQpdfWithPassword(
    qpdf,
    request,
    request.password,
    crypto.randomUUID(),
    (passwordFile) => [
      `--password-file=${passwordFile}`,
      '--warning-exit-0',
      '--json=2',
      '--json-key=encrypt',
      path.resolve(request.inputPath),
    ],
    QPDF_MIN_OUTPUT_BYTES
  );
  return parseAccessVerdict(result.stdout.toString('utf-8'));
}

function parseAccessVerdict(json: string): PdfAccessVerdict {
  let encrypt: unknown;
  try {
    encrypt = (JSON.parse(json) as { encrypt?: unknown }).encrypt;
  } catch {
    throw new ConversionFailedError(PDF_DECRYPT_FAILED_MESSAGE);
  }
  const { ownerpasswordmatched, capabilities } = (encrypt ?? {}) as { ownerpasswordmatched?: unknown; capabilities?: unknown };
  const flags = Object.entries((capabilities ?? {}) as Record<string, unknown>);
  if (
    typeof ownerpasswordmatched !== 'boolean' ||
    flags.length === 0 ||
    flags.some(([, allowed]) => typeof allowed !== 'boolean')
  ) {
    // No verdict means no permission: an unknown answer is never read as "unrestricted".
    throw new ConversionFailedError(PDF_DECRYPT_FAILED_MESSAGE);
  }
  return { ownerPasswordMatched: ownerpasswordmatched, capabilities: Object.fromEntries(flags) as Record<string, boolean> };
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
  if (!request.password) {
    return operation(request.inputPath);
  }
  return withQpdfDecryptedPdf({ ...request, password: request.password }, operation);
}

/**
 * Like `withDecryptedPdf`, but a password that is the empty string is a supplied password too: the document is
 * decrypted with the empty user password instead of being handed over untouched. Callers that must never read an
 * encrypted file as if it were plain use this.
 */
export async function withQpdfDecryptedPdf<T>(
  request: PdfDecryptRequest & { password: string },
  operation: (readablePdfPath: string) => Promise<T>
): Promise<T> {
  const qpdf = requireQpdf(request.password);
  const nonce = crypto.randomUUID();
  const decryptedPath = path.join(request.tempDir, `decrypted-${nonce}.pdf`);
  try {
    // Create the plaintext copy owner-only before qpdf writes into it.
    fs.writeFileSync(decryptedPath, '', { mode: PRIVATE_FILE_MODE, flag: 'wx' });
    await decryptIntoFile(qpdf, request, request.password, decryptedPath, nonce);
    return await operation(decryptedPath);
  } finally {
    removeQuietly(decryptedPath);
  }
}
