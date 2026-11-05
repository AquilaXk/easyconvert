import crypto from 'node:crypto';
import {
  PdfProtectOptions,
  PdfPostprocessError,
} from '../../types';
import { PDF_PASSWORD_UNSAFE_MESSAGE } from '../../../worker/pdf-decrypt';
import { requireQpdfBinary, runQpdfToBuffer, withQpdfWorkspace, type QpdfWorkspace } from './qpdf-run';
import { pageTreeLoops } from './mend-page-tree';
import { openPdfForEditing, type PdfAccess } from '../pdf-access';
import { PdfStructureError } from '../pdf-document';
import { repairPageTree } from './page-tree';

export { getQpdfBinaryPath } from './qpdf-path';

/** The argument file holds one argument per line, so a password with a line break would become several arguments. */
const ARGUMENT_FILE_UNSAFE_CHARS = /[\r\n\0]/;
export const MAX_PDF_PROTECT_PASSWORD_LENGTH = 256;
export const VALID_PDF_PRINT_PERMISSIONS: ReadonlySet<string> = new Set(['none', 'low', 'full']);
export const VALID_PDF_MODIFY_PERMISSIONS: ReadonlySet<string> = new Set(['none', 'assembly', 'annotate', 'form', 'all']);

function validateProtectPassword(value: unknown, field: 'userPassword' | 'ownerPassword'): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new PdfPostprocessError(`${field} must be a string.`);
  }
  if (value.length > MAX_PDF_PROTECT_PASSWORD_LENGTH) {
    throw new PdfPostprocessError(`${field} exceeds maximum length of ${MAX_PDF_PROTECT_PASSWORD_LENGTH} characters.`);
  }
  if (ARGUMENT_FILE_UNSAFE_CHARS.test(value)) {
    throw new PdfPostprocessError(PDF_PASSWORD_UNSAFE_MESSAGE);
  }
  return value;
}

function validateProtectKeyLength(value: unknown): 128 | 256 {
  const keyLength = value ?? 256;
  if (keyLength !== 128 && keyLength !== 256) {
    throw new PdfPostprocessError(`Unsupported key length: ${String(keyLength)}. Supported lengths are 128 and 256.`);
  }
  return keyLength;
}

function validateProtectPermissions(permsRaw: unknown): NonNullable<PdfProtectOptions['permissions']> {
  if (permsRaw !== undefined && (typeof permsRaw !== 'object' || permsRaw === null || Array.isArray(permsRaw))) {
    throw new PdfPostprocessError('permissions must be an object.');
  }
  const perms = (permsRaw ?? {}) as Record<string, unknown>;
  if (perms.print !== undefined && (typeof perms.print !== 'string' || !VALID_PDF_PRINT_PERMISSIONS.has(perms.print))) {
    throw new PdfPostprocessError(`Unsupported print permission: ${String(perms.print)}. Supported values are none, low, and full.`);
  }
  if (perms.modify !== undefined && (typeof perms.modify !== 'string' || !VALID_PDF_MODIFY_PERMISSIONS.has(perms.modify))) {
    throw new PdfPostprocessError(`Unsupported modify permission: ${String(perms.modify)}. Supported values are none, assembly, annotate, form, and all.`);
  }
  if (perms.extract !== undefined && typeof perms.extract !== 'boolean') {
    throw new PdfPostprocessError('Unsupported extract permission: must be a boolean.');
  }
  if (perms.annotate !== undefined && typeof perms.annotate !== 'boolean') {
    throw new PdfPostprocessError('Unsupported annotate permission: must be a boolean.');
  }
  return {
    print: (perms.print as 'none' | 'low' | 'full' | undefined) ?? 'full',
    modify: (perms.modify as 'none' | 'assembly' | 'annotate' | 'form' | 'all' | undefined) ?? 'none',
    extract: Boolean(perms.extract),
    ...(perms.annotate !== undefined ? { annotate: perms.annotate } : {}),
  };
}

export function validatePdfProtectOptions(options: unknown = {}): PdfProtectOptions {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new PdfPostprocessError('PDF protection options must be an object.');
  }
  const raw = options as Record<string, unknown>;
  return {
    userPassword: validateProtectPassword(raw.userPassword, 'userPassword'),
    ownerPassword: validateProtectPassword(raw.ownerPassword, 'ownerPassword'),
    keyLength: validateProtectKeyLength(raw.keyLength),
    permissions: validateProtectPermissions(raw.permissions),
  };
}

/**
 * Protect a PDF document using AES-256 encryption and fine-grained permission controls
 * via qpdf CLI. Passwords are passed in an argument file on standard input (`@-`), which keeps them out of the
 * process argument list and off the disk.
 *
 * An encrypted input is decrypted first, through the same gate as every other PDF edit (see pdf-access): the open
 * password it needs comes from `access.password`, and a file whose owner restricts any right is only re-protected with
 * `access.confirmEditRights` or the owner password, because the new protection replaces the old restrictions.
 */
export async function protectPdf(
  pdfBuffer: Buffer,
  options: PdfProtectOptions = {},
  access: PdfAccess = {}
): Promise<Buffer> {
  await Promise.resolve();
  if (!pdfBuffer || pdfBuffer.length === 0) {
    throw new PdfPostprocessError('PDF buffer is empty.');
  }

  requireQpdfBinary();

  const validated = validatePdfProtectOptions(options);
  const userPassword = validated.userPassword ?? '';
  const ownerPassword = validated.ownerPassword || userPassword || crypto.randomBytes(16).toString('hex');
  const keyLength = validated.keyLength ?? 256;

  let plain: Buffer;
  try {
    plain = await openPdfForEditing(pdfBuffer, 'protect', access);
  } catch (err) {
    // A file whose trailer cannot be read is a protection failure of this step, as it always was.
    if (err instanceof PdfStructureError) throw new PdfPostprocessError(`PDF protection failed: ${err.message}`);
    throw err;
  }

  const perms = validated.permissions || {};
  const printPerm = perms.print ?? 'full';
  const modifyPerm = perms.modify ?? 'none';
  const extractPerm = perms.extract ? 'y' : 'n';

  const encryptArguments = (inputPath: string): string =>
    [
      '--encrypt',
      userPassword,
      ownerPassword,
      String(keyLength),
      `--print=${printPerm}`,
      `--modify=${modifyPerm}`,
      `--extract=${extractPerm}`,
      '--',
      inputPath,
      '-',
    ].join('\n');

  const encrypt = async (workspace: QpdfWorkspace, signal?: AbortSignal): Promise<Buffer> => {
    try {
      // The argument file holds the passwords, so it goes to qpdf on standard input and never touches the disk.
      return await runQpdfToBuffer(workspace, {
        args: ['@-'],
        stdin: Buffer.from(encryptArguments(workspace.inputPath), 'utf8'),
        action: 'PDF protection',
        signal,
      });
    } catch (err) {
      // The command line and stderr hold sandbox paths: log them here, keep them out of the response.
      console.error('[protect] qpdf failed:', (err as Error)?.message ?? '');
      throw new PdfPostprocessError('PDF protection failed: qpdf could not encrypt the document.');
    }
  };

  // qpdf encrypts a looping page tree without reading the pages, so the tree is asked about beside the encryption: a
  // document that is fine waits for one run. Only a loop discards the result and encrypts the mended bytes again, so
  // the plain bytes go no further than the private (0700) directories of these runs.
  const { protectedPdf, loops } = await withQpdfWorkspace(plain, async (workspace) => {
    const stop = new AbortController();
    const [protectedPdf, loops] = await Promise.all([
      encrypt(workspace, stop.signal).catch((error: unknown) => {
        stop.abort();
        throw error;
      }),
      pageTreeLoops(workspace, stop.signal),
    ]);
    return { protectedPdf, loops };
  });
  if (!loops) return protectedPdf;
  const mended = await repairPageTree(plain, { knownLooping: true });
  return mended === plain ? protectedPdf : withQpdfWorkspace(mended, (workspace) => encrypt(workspace));
}
