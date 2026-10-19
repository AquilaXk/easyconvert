import crypto from 'node:crypto';
import {
  PdfProtectOptions,
  PdfPostprocessError,
} from '../../types';
import { PDF_PASSWORD_UNSAFE_MESSAGE } from '../../../worker/pdf-decrypt';
import { requireQpdfBinary, runQpdfToBuffer, withQpdfInputFile, type QpdfWorkspace } from './qpdf-run';
import { pageTreeLoops } from './mend-page-tree';
import { openPdfForEditing, type PdfAccess } from '../pdf-access';
import { PdfStructureError } from '../pdf-document';
import { repairPageTree } from './page-tree';

export { getQpdfBinaryPath } from './qpdf-path';

/** The argument file holds one argument per line, so a password with a line break would become several arguments. */
const ARGUMENT_FILE_UNSAFE_CHARS = /[\r\n\0]/;

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

  const userPassword = options.userPassword ?? '';
  const ownerPassword = options.ownerPassword || userPassword || crypto.randomBytes(16).toString('hex');
  if (ARGUMENT_FILE_UNSAFE_CHARS.test(userPassword) || ARGUMENT_FILE_UNSAFE_CHARS.test(ownerPassword)) {
    throw new PdfPostprocessError(PDF_PASSWORD_UNSAFE_MESSAGE);
  }

  const keyLength = options.keyLength ?? 256;
  if (keyLength !== 128 && keyLength !== 256) {
    throw new PdfPostprocessError(`Unsupported key length: ${keyLength}. Supported lengths are 128 and 256.`);
  }

  let plain: Buffer;
  try {
    plain = await openPdfForEditing(pdfBuffer, 'protect', access);
  } catch (err) {
    // A file whose trailer cannot be read is a protection failure of this step, as it always was.
    if (err instanceof PdfStructureError) throw new PdfPostprocessError(`PDF protection failed: ${err.message}`);
    throw err;
  }

  const perms = options.permissions || {};
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
  // the plain bytes go no further than the private directories of these runs.
  const { protectedPdf, loops } = await withQpdfInputFile(plain, async (workspace) => {
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
  const mended = await repairPageTree(plain);
  return mended === plain ? protectedPdf : withQpdfInputFile(mended, (workspace) => encrypt(workspace));
}
