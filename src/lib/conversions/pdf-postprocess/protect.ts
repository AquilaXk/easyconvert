import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PdfProtectOptions,
  PdfPostprocessError,
  EngineUnavailableError,
} from '../../types';
import {
  resolveSandboxedCommand,
  getSanitizedEnvironment,
} from '../../security/process-sandbox';
import { resolveBinaryPath } from './utils';

/**
 * Locate the qpdf binary on the system or return null if unavailable.
 */
export function getQpdfBinaryPath(): string | null {
  const candidates = [
    '/usr/bin/qpdf',
    '/usr/local/bin/qpdf',
    '/opt/homebrew/bin/qpdf',
    '/opt/homebrew/opt/qpdf/bin/qpdf',
  ];
  return resolveBinaryPath('QPDF_PATH', candidates, 'qpdf');
}

/**
 * Protect a PDF document using AES-256 encryption and fine-grained permission controls
 * via qpdf CLI. Passwords are securely passed via an @argfile with mode 0600
 * to prevent leaking credentials in the process argument list.
 */
export async function protectPdf(
  pdfBuffer: Buffer,
  options: PdfProtectOptions = {}
): Promise<Buffer> {
  await Promise.resolve();
  if (!pdfBuffer || pdfBuffer.length === 0) {
    throw new PdfPostprocessError('PDF buffer is empty.');
  }

  const qpdf = getQpdfBinaryPath();
  if (!qpdf) {
    throw new EngineUnavailableError('qpdf', 'qpdf binary is not installed or not in PATH');
  }

  const userPassword = options.userPassword ?? '';
  const ownerPassword = options.ownerPassword || userPassword || crypto.randomBytes(16).toString('hex');

  const keyLength = options.keyLength ?? 256;
  if (keyLength !== 128 && keyLength !== 256) {
    throw new PdfPostprocessError(`Unsupported key length: ${keyLength}. Supported lengths are 128 and 256.`);
  }

  const perms = options.permissions || {};
  const printPerm = perms.print ?? 'full';
  const modifyPerm = perms.modify ?? 'none';
  const extractPerm = perms.extract ? 'y' : 'n';

  const tmpDir = os.tmpdir();
  const token = crypto.randomBytes(8).toString('hex');
  const workDir = path.join(tmpDir, `easyconvert_qpdf_protect_${Date.now()}_${token}`);
  fs.mkdirSync(workDir, { recursive: true });

  const inputPdf = path.join(workDir, 'input.pdf');
  const outputPdf = path.join(workDir, 'output.pdf');
  const argFile = path.join(workDir, 'args.txt');

  try {
    fs.writeFileSync(inputPdf, pdfBuffer);

    // Build argument lines for @argfile
    const args: string[] = [
      '--encrypt',
      userPassword,
      ownerPassword,
      String(keyLength),
      `--print=${printPerm}`,
      `--modify=${modifyPerm}`,
      `--extract=${extractPerm}`,
      '--',
      inputPdf,
      outputPdf,
    ];

    // Restrict argfile to owner-read/write only (0600)
    fs.writeFileSync(argFile, args.join('\n'), { mode: 0o600 });

    const resolved = resolveSandboxedCommand(qpdf, ['@' + argFile], {
      networkIsolated: true,
    });

    try {
      execFileSync(resolved.binary, resolved.args, {
        cwd: workDir,
        env: getSanitizedEnvironment({}, true),
        timeout: 30000,
      });
    } catch (err: any) {
      const errMsg = (err?.message || '') + (err?.stderr?.toString() || '');
      throw new PdfPostprocessError(`PDF protection via qpdf failed: ${errMsg}`);
    }

    if (!fs.existsSync(outputPdf)) {
      throw new PdfPostprocessError('PDF protection failed: output file was not created.');
    }

    return fs.readFileSync(outputPdf);
  } finally {
    try {
      if (fs.existsSync(argFile)) {
        fs.unlinkSync(argFile);
      }
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {}
  }
}
