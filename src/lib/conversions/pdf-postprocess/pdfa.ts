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
  PdfAValidationError,
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
/** veraPDF validation profile (`--flavour`) for each supported conformance level. */
const VERAPDF_FLAVOUR: Record<PdfAConformance, string> = { 'pdfa-1b': '1b', 'pdfa-2b': '2b', 'pdfa-3b': '3b' };
const SOFFICE_TIMEOUT_MS = 60_000;
const VERAPDF_TIMEOUT_MS = 60_000;
/** Upper bound for veraPDF's JSON report on stdout. */
const VERAPDF_MAX_REPORT_BYTES = 16 * 1024 * 1024;
/** The report lists rules, so one displayed failed check per rule is enough and keeps it small. */
const VERAPDF_MAX_FAILURES_DISPLAYED = '1';
/** Most rule IDs one validation error carries; a profile defines far fewer rules than this. */
const MAX_FAILED_RULES_REPORTED = 200;
/** Engine name of the EngineUnavailableError raised when veraPDF is missing or cannot run. */
export const VERAPDF_ENGINE_NAME = 'verapdf';
/** Detail of the 422 for a document the validator could not process; it never carries paths or commands. */
const VALIDATOR_UNPROCESSABLE_MESSAGE = 'The PDF/A validator could not process the document.';
const PDF_UNREADABLE_MESSAGE = 'The PDF/A output could not be read as a PDF document.';

export interface VerapdfVerdict {
  compliant: boolean;
  /** Failed rule IDs as `<clause>-<test number>`, in report order, without duplicates. */
  failedRules: string[];
}

/**
 * Reads the verdict and the failed rules from a veraPDF JSON report. Supports the array form
 * (`validationResult: [{ compliant }]`) and the object form (`validationResult: { isCompliant }`).
 * Throws when the report has no validation result, so an unknown format is never read as a pass.
 */
export function parseVerapdfVerdict(json: string): VerapdfVerdict {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new PdfPostprocessError(VALIDATOR_UNPROCESSABLE_MESSAGE);
  }
  const jobs = (parsed as { report?: { jobs?: unknown[] } })?.report?.jobs;
  const results = Array.isArray(jobs) ? jobs.map((job) => (job as { validationResult?: unknown }).validationResult) : [];
  const verdicts: boolean[] = [];
  const failedRules = new Set<string>();
  for (const result of results) {
    for (const entry of Array.isArray(result) ? result : [result]) {
      const record = (entry ?? {}) as {
        compliant?: unknown;
        isCompliant?: unknown;
        details?: { ruleSummaries?: unknown };
      };
      const verdict = typeof record.compliant === 'boolean' ? record.compliant : record.isCompliant;
      if (typeof verdict === 'boolean') {
        verdicts.push(verdict);
      }
      const summaries = Array.isArray(record.details?.ruleSummaries) ? record.details.ruleSummaries : [];
      for (const summary of summaries) {
        const rule = (summary ?? {}) as { clause?: unknown; testNumber?: unknown; status?: unknown };
        const failed = typeof rule.status === 'string' && rule.status.toLowerCase() === 'failed';
        if (failed && typeof rule.clause === 'string' && typeof rule.testNumber === 'number') {
          failedRules.add(`${rule.clause}-${rule.testNumber}`);
        }
        if (failedRules.size >= MAX_FAILED_RULES_REPORTED) break;
      }
    }
  }
  if (verdicts.length === 0) {
    throw new PdfPostprocessError(VALIDATOR_UNPROCESSABLE_MESSAGE);
  }
  return { compliant: verdicts.every(Boolean), failedRules: [...failedRules] };
}

/** Whether a veraPDF JSON report says the file is compliant. */
export function parseVerapdfReport(json: string): boolean {
  return parseVerapdfVerdict(json).compliant;
}

/** `pdfaid:part` and `pdfaid:conformance` from the document's XMP metadata, if present. */
async function readPdfAIdentification(pdf: Buffer): Promise<{ part?: string; conformance?: string }> {
  try {
    const doc = await PDFDocument.load(pdf, { updateMetadata: false });
    const metadata = doc.catalog.lookup(PDFName.of('Metadata'));
    if (!(metadata instanceof PDFRawStream)) {
      return {};
    }
    const xmp = Buffer.from(decodePDFRawStream(metadata).decode()).toString('utf-8');
    const field = (name: string) =>
      xmp.match(new RegExp(`pdfaid:${name}\\s*(?:=\\s*["']([^"']+)["']|>\\s*([^<\\s]+)\\s*<)`))?.slice(1).find(Boolean);
    return { part: field('part'), conformance: field('conformance') };
  } catch {
    // The parser's own message can quote offsets and object contents of an untrusted file.
    throw new PdfPostprocessError(PDF_UNREADABLE_MESSAGE);
  }
}

/** The veraPDF binary, or an EngineUnavailableError (HTTP 503): an unvalidated PDF/A is never returned. */
export function requireVerapdf(): string {
  const verapdf = getVerapdfBinaryPath();
  if (!verapdf) {
    throw new EngineUnavailableError(
      VERAPDF_ENGINE_NAME,
      'veraPDF is required to validate PDF/A output but is not installed or not in PATH'
    );
  }
  return verapdf;
}

/** Runs veraPDF with an explicit flavour and returns its JSON report; a validator that cannot run is unavailable. */
function runVerapdf(verapdf: string, file: string, conformance: PdfAConformance): string {
  const args = [
    '--flavour',
    VERAPDF_FLAVOUR[conformance],
    '--format',
    'json',
    '--maxfailuresdisplayed',
    VERAPDF_MAX_FAILURES_DISPLAYED,
    file,
  ];
  try {
    return execFileSync(verapdf, args, {
      timeout: VERAPDF_TIMEOUT_MS,
      maxBuffer: VERAPDF_MAX_REPORT_BYTES,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString('utf-8');
  } catch (err: any) {
    // veraPDF exits non-zero for a non-compliant file but still prints the report.
    const report = err?.stdout?.toString('utf-8') ?? '';
    if (report) return report;
    throw new EngineUnavailableError(
      VERAPDF_ENGINE_NAME,
      `veraPDF could not validate the output: ${err?.code ?? err?.signal ?? err?.message}`
    );
  }
}

/**
 * Checks that a PDF identifies itself as the requested PDF/A level and that veraPDF validates it
 * against that level's flavour. Without veraPDF the request fails with an EngineUnavailableError,
 * and a file that fails validation with a PdfAValidationError that lists the failed rule IDs.
 * Used for the Draw round trip and for Office exports that LibreOffice wrote as PDF/A directly.
 */
export async function verifyPdfA(
  pdf: Buffer,
  conformance: PdfAConformance
): Promise<{ pdfaValidated: true; conformanceLevel: PdfAConformance }> {
  const part = PDFA_PART[conformance];
  if (!part) {
    throw new PdfPostprocessError(`Unsupported PDF/A conformance level: ${conformance}`);
  }
  const verapdf = requireVerapdf();
  const id = await readPdfAIdentification(pdf);
  if (id.part !== part || (id.conformance ?? '').toUpperCase() !== 'B') {
    throw new PdfPostprocessError(
      `PDF/A conversion failed: PDF/A identification is part "${id.part ?? 'none'}" conformance "${id.conformance ?? 'none'}", expected ${part}B.`
    );
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'easyconvert_verapdf_'));
  try {
    const candidate = path.join(workDir, 'candidate.pdf');
    fs.writeFileSync(candidate, pdf);
    const verdict = parseVerapdfVerdict(runVerapdf(verapdf, candidate, conformance));
    if (!verdict.compliant) {
      throw new PdfAValidationError(conformance, verdict.failedRules);
    }
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
  return { pdfaValidated: true, conformanceLevel: conformance };
}

/**
 * Converts a PDF to PDF/A-1b, 2b, or 3b with LibreOffice (a lossy Draw round trip, for PDF inputs).
 * The result must be a new file whose XMP identifies the requested part and that veraPDF validates
 * against the requested flavour; see verifyPdfA for the errors.
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
  // Fail before converting: a result veraPDF cannot validate is never returned.
  requireVerapdf();

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
      // The command line and stderr hold sandbox paths: log them here, keep them out of the response.
      console.error('[pdfa] LibreOffice PDF/A conversion failed:', (err?.message || '') + (err?.stderr?.toString() || ''));
      throw new PdfPostprocessError('PDF/A conversion failed: LibreOffice could not convert the document.');
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
