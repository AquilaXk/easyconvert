import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import {
  PdfAConformance,
  PdfAOptions,
  PdfAConversionResult,
  PdfPostprocessError,
  EngineUnavailableError,
} from '../../types';
import {
  resolveSandboxedCommand,
  getSanitizedEnvironment,
} from '../../security/process-sandbox';
import { resolveBinaryPath } from './utils';
import { buildPdfExportFilterData } from '../pdf-export-options';

/**
 * Locate LibreOffice binary on the host or in container.
 */
export function getLibreOfficeBinaryPath(): string | null {
  const candidates = [
    '/usr/bin/soffice',
    '/usr/local/bin/soffice',
    '/opt/homebrew/bin/soffice',
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
  ];
  return resolveBinaryPath('SOFFICE_PATH', candidates, 'soffice');
}

/**
 * Locate veraPDF binary for PDF/A validation, if installed.
 */
export function getVerapdfBinaryPath(): string | null {
  const candidates = [
    '/usr/bin/verapdf',
    '/usr/local/bin/verapdf',
    '/opt/homebrew/bin/verapdf',
  ];
  return resolveBinaryPath('VERAPDF_PATH', candidates, 'verapdf');
}

/** PDF/A part number written to XMP `pdfaid:part` for each supported conformance level. */
const PDFA_PART: Record<PdfAConformance, string> = { 'pdfa-1b': '1', 'pdfa-2b': '2', 'pdfa-3b': '3' };
const SOFFICE_TIMEOUT_MS = 60_000;
const VERAPDF_TIMEOUT_MS = 60_000;

/**
 * Reads compliance from a veraPDF JSON report. Supports the array form
 * (`validationResult: [{ compliant }]`) and the object form (`validationResult: { isCompliant }`).
 * Throws when the report has no validation result, so an unknown format is never read as a pass.
 */
export function parseVerapdfReport(json: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new PdfPostprocessError('veraPDF did not return a JSON report.');
  }
  const jobs = (parsed as { report?: { jobs?: unknown[] } })?.report?.jobs;
  const results = Array.isArray(jobs) ? jobs.map((job) => (job as { validationResult?: unknown }).validationResult) : [];
  const verdicts: boolean[] = [];
  for (const result of results) {
    for (const entry of Array.isArray(result) ? result : [result]) {
      const record = (entry ?? {}) as { compliant?: unknown; isCompliant?: unknown };
      const verdict = typeof record.compliant === 'boolean' ? record.compliant : record.isCompliant;
      if (typeof verdict === 'boolean') {
        verdicts.push(verdict);
      }
    }
  }
  if (verdicts.length === 0) {
    throw new PdfPostprocessError('veraPDF report contains no validation result.');
  }
  return verdicts.every(Boolean);
}

/** `pdfaid:part` and `pdfaid:conformance` from the document's XMP metadata, if present. */
async function readPdfAIdentification(pdf: Buffer): Promise<{ part?: string; conformance?: string }> {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  const metadata = doc.catalog.lookup(PDFName.of('Metadata'));
  if (!(metadata instanceof PDFRawStream)) {
    return {};
  }
  const xmp = Buffer.from(decodePDFRawStream(metadata).decode()).toString('utf-8');
  const field = (name: string) =>
    xmp.match(new RegExp(`pdfaid:${name}\\s*(?:=\\s*["']([^"']+)["']|>\\s*([^<\\s]+)\\s*<)`))?.slice(1).find(Boolean);
  return { part: field('part'), conformance: field('conformance') };
}

/**
 * Checks that a PDF identifies itself as the requested PDF/A level and, when veraPDF is installed,
 * that veraPDF reports it compliant. `pdfaValidated` is true only when veraPDF validated it.
 * Used for the Draw round trip and for Office exports that LibreOffice wrote as PDF/A directly.
 */
export async function verifyPdfA(
  pdf: Buffer,
  conformance: PdfAConformance
): Promise<{ pdfaValidated: boolean; conformanceLevel: PdfAConformance }> {
  const part = PDFA_PART[conformance];
  if (!part) {
    throw new PdfPostprocessError(`Unsupported PDF/A conformance level: ${conformance}`);
  }
  const id = await readPdfAIdentification(pdf);
  if (id.part !== part || (id.conformance ?? '').toUpperCase() !== 'B') {
    throw new PdfPostprocessError(
      `PDF/A conversion failed: PDF/A identification is part "${id.part ?? 'none'}" conformance "${id.conformance ?? 'none'}", expected ${part}B.`
    );
  }

  const verapdf = getVerapdfBinaryPath();
  if (!verapdf) {
    return { pdfaValidated: false, conformanceLevel: conformance };
  }
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'easyconvert_verapdf_'));
  try {
    const candidate = path.join(workDir, 'candidate.pdf');
    fs.writeFileSync(candidate, pdf);
    let report: string;
    try {
      report = execFileSync(verapdf, ['--format', 'json', candidate], { timeout: VERAPDF_TIMEOUT_MS }).toString('utf-8');
    } catch (err: any) {
      // veraPDF exits non-zero for non-compliant files but still prints the report.
      report = err?.stdout?.toString('utf-8') ?? '';
    }
    if (!parseVerapdfReport(report)) {
      throw new PdfPostprocessError(`PDF/A conversion failed: the output is not PDF/A compliant (${conformance}).`);
    }
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
  return { pdfaValidated: true, conformanceLevel: conformance };
}

/**
 * Converts a PDF to PDF/A-1b, 2b, or 3b with LibreOffice. The result must be a new file whose XMP
 * identifies the requested part; when veraPDF is installed it must also report compliance.
 * `pdfaValidated` is true only when veraPDF validated the output.
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
  const part = PDFA_PART[conformance];
  if (!part) {
    throw new PdfPostprocessError(`Unsupported PDF/A conformance level: ${conformance}`);
  }

  const token = crypto.randomBytes(8).toString('hex');
  const workDir = path.join(os.tmpdir(), `easyconvert_pdfa_${Date.now()}_${token}`);
  const outDir = path.join(workDir, 'out');
  fs.mkdirSync(outDir, { recursive: true });

  const inputPdf = path.join(workDir, 'source.pdf');
  const outputPdf = path.join(outDir, 'source.pdf');

  try {
    fs.writeFileSync(inputPdf, pdfBuffer);

    // LibreOffice opens a PDF in Draw, so the Draw PDF export filter applies.
    // The default image settings keep JPEG streams byte for byte, as in the Office export.
    const filterDef = `pdf:draw_pdf_Export:${JSON.stringify(buildPdfExportFilterData({ pdfa: { conformance } }))}`;
    // A private profile per job: concurrent jobs must not share (or lock) the default profile.
    const profileDir = path.join(workDir, 'profile');
    const resolved = resolveSandboxedCommand(
      soffice,
      [
        '--headless',
        '--norestore',
        '--nofirststartwizard',
        '--nologo',
        `-env:UserInstallation=file://${profileDir}`,
        '--convert-to',
        filterDef,
        '--outdir',
        outDir,
        inputPdf,
      ],
      { networkIsolated: true }
    );

    try {
      execFileSync(resolved.binary, resolved.args, {
        cwd: workDir,
        env: getSanitizedEnvironment({ SAL_USE_VCLPLUGIN: 'svp' }, true),
        timeout: SOFFICE_TIMEOUT_MS,
      });
    } catch (err: any) {
      const errMsg = (err?.message || '') + (err?.stderr?.toString() || '');
      throw new PdfPostprocessError(`PDF/A conversion via LibreOffice failed: ${errMsg}`);
    }

    if (!fs.existsSync(outputPdf)) {
      throw new PdfPostprocessError('PDF/A conversion failed: output file was not generated.');
    }
    const resultBuffer = fs.readFileSync(outputPdf);
    if (resultBuffer.equals(pdfBuffer)) {
      throw new PdfPostprocessError('PDF/A conversion failed: the document was not converted.');
    }

    const { pdfaValidated } = await verifyPdfA(resultBuffer, conformance);

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
