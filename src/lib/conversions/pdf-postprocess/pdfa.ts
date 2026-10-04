import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PdfAOptions,
  PdfAConversionResult,
  PdfPostprocessError,
  EngineUnavailableError,
} from '../../types';
import {
  resolveSandboxedCommand,
  getSanitizedEnvironment,
} from '../../security/process-sandbox';

/**
 * Locate LibreOffice binary on the host or in container.
 */
export function getLibreOfficeBinaryPath(): string | null {
  const custom = process.env.SOFFICE_PATH;
  if (custom !== undefined) {
    return custom && fs.existsSync(custom) ? custom : null;
  }
  const candidates = [
    '/usr/bin/soffice',
    '/usr/local/bin/soffice',
    '/opt/homebrew/bin/soffice',
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return c;
    }
  }
  try {
    const whichOut = execFileSync('which', ['soffice'], { encoding: 'utf-8', timeout: 2000 }).trim();
    if (whichOut && fs.existsSync(whichOut)) {
      return whichOut;
    }
  } catch {}

  return null;
}

/**
 * Locate veraPDF binary for PDF/A validation, if installed.
 */
export function getVerapdfBinaryPath(): string | null {
  const custom = process.env.VERAPDF_PATH;
  if (custom !== undefined) {
    return custom && fs.existsSync(custom) ? custom : null;
  }
  const candidates = [
    '/usr/bin/verapdf',
    '/usr/local/bin/verapdf',
    '/opt/homebrew/bin/verapdf',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return c;
    }
  }
  try {
    const whichOut = execFileSync('which', ['verapdf'], { encoding: 'utf-8', timeout: 2000 }).trim();
    if (whichOut && fs.existsSync(whichOut)) {
      return whichOut;
    }
  } catch {}

  return null;
}

/**
 * Convert an existing PDF document to PDF/A (1b, 2b, or 3b) using LibreOffice headless
 * with SelectPdfVersion.
 *
 * Transparently reports whether external validation was executed (pdfaValidated: false
 * when veraPDF validator is absent).
 */
export async function convertToPdfA(
  pdfBuffer: Buffer,
  options: PdfAOptions = {}
): Promise<PdfAConversionResult> {
  if (!pdfBuffer || pdfBuffer.length === 0) {
    throw new PdfPostprocessError('PDF buffer is empty.');
  }

  const soffice = getLibreOfficeBinaryPath();
  if (!soffice) {
    throw new EngineUnavailableError('soffice', 'LibreOffice binary is not installed or not in PATH');
  }

  const conformance = options.conformance ?? 'pdfa-1b';
  let selectPdfVersion = '1';
  if (conformance === 'pdfa-2b') {
    selectPdfVersion = '2';
  } else if (conformance === 'pdfa-3b') {
    selectPdfVersion = '3';
  }

  const tmpDir = os.tmpdir();
  const token = crypto.randomBytes(8).toString('hex');
  const workDir = path.join(tmpDir, `easyconvert_pdfa_${Date.now()}_${token}`);
  fs.mkdirSync(workDir, { recursive: true });

  const inputPdf = path.join(workDir, 'source.pdf');
  const outputPdf = path.join(workDir, 'source.pdf');

  try {
    fs.writeFileSync(inputPdf, pdfBuffer);

    // Filter definition with SelectPdfVersion
    const filterDef = `pdf:writer_pdf_Export:{"SelectPdfVersion":{"type":"long","value":"${selectPdfVersion}"}}`;

    const sofficeArgs = [
      '--headless',
      '--convert-to',
      filterDef,
      '--outdir',
      workDir,
      inputPdf,
    ];

    const resolved = resolveSandboxedCommand(soffice, sofficeArgs, {
      networkIsolated: true,
    });

    try {
      execFileSync(resolved.binary, resolved.args, {
        cwd: workDir,
        env: getSanitizedEnvironment({
          SAL_USE_VCLPLUGIN: 'svp',
        }, true),
        timeout: 60000,
      });
    } catch (err: any) {
      const errMsg = (err?.message || '') + (err?.stderr?.toString() || '');
      throw new PdfPostprocessError(`PDF/A conversion via LibreOffice failed: ${errMsg}`);
    }

    if (!fs.existsSync(outputPdf)) {
      throw new PdfPostprocessError('PDF/A conversion failed: output file was not generated.');
    }

    const resultBuffer = fs.readFileSync(outputPdf);

    // Validate with veraPDF if available
    let pdfaValidated = false;
    const verapdf = getVerapdfBinaryPath();
    if (verapdf) {
      try {
        const vOut = execFileSync(verapdf, ['--format', 'json', outputPdf], { timeout: 15000 }).toString();
        const parsed = JSON.parse(vOut);
        pdfaValidated = Boolean(parsed?.report?.jobs?.[0]?.itemDetails?.passed);
      } catch {
        pdfaValidated = false;
      }
    }

    return {
      buffer: resultBuffer,
      pdfaValidated,
      conformanceLevel: conformance,
    };
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {}
  }
}
