import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import JSZip from 'jszip';
import {
  getOracleToolPath,
  requireOracleTool,
  OracleToolMissingError,
} from '../../helpers/differential-oracle';
import { renderPdfPagesWithPdftoppm } from './pdf-oracle';

export interface OfficeStructureComparisonResult {
  matched: boolean;
  structuralScore: number;
  format: 'docx' | 'xlsx' | 'pptx';
  actualPartCount: number;
  referencePartCount: number;
  actualTextLength: number;
  referenceTextLength: number;
  discrepancies: string[];
}

/**
 * Headless LibreOffice (`soffice`) Oracle:
 * Renders office documents (DOCX, XLSX, PPTX, RTF, ODT) into rasterized PNG pages
 * by routing through headless LibreOffice export to PDF, then Poppler `pdftoppm`.
 */
export async function renderOfficeDocumentWithSoffice(
  docBuffer: Buffer,
  extension: string
): Promise<Buffer[]> {
  const sofficePath = requireOracleTool('soffice');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-oracle-render-'));
  const inputPath = path.join(tempDir, `document.${extension.replace(/^\./, '')}`);

  try {
    fs.writeFileSync(inputPath, docBuffer);

    // Run headless LibreOffice conversion to PDF
    execFileSync(
      sofficePath,
      ['--headless', '--convert-to', 'pdf', inputPath, '--outdir', tempDir],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );

    const pdfPath = path.join(tempDir, 'document.pdf');
    if (!fs.existsSync(pdfPath)) {
      throw new Error(`LibreOffice failed to generate PDF output for ${extension}`);
    }

    const pdfBuffer = fs.readFileSync(pdfPath);
    return await renderPdfPagesWithPdftoppm(pdfBuffer);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Extracts all plain text inside XML tags (e.g. `<w:t>`, `<a:t>`, `<t>`, `<v>`).
 */
function extractXmlText(xmlContent: string): string {
  const matches = xmlContent.match(/<[^:>]*:?t[^>]*>([^<]*)<\/[^:>]*:?t>/g) ||
    xmlContent.match(/<v>([^<]*)<\/v>/g) || [];
  return matches
    .map((m) => m.replace(/<[^>]+>/g, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Compares OOXML (DOCX, XLSX, PPTX) structure and content between actual and reference
 * documents using pure independent JSZip and DOM/XML inspection without production converters.
 */
export async function compareOfficeDocumentStructure(
  actualBuffer: Buffer,
  referenceBuffer: Buffer,
  format: 'docx' | 'xlsx' | 'pptx'
): Promise<OfficeStructureComparisonResult> {
  const discrepancies: string[] = [];
  let structuralScore = 1.0;

  const [actualZip, refZip] = await Promise.all([
    JSZip.loadAsync(actualBuffer),
    JSZip.loadAsync(referenceBuffer),
  ]);

  const actualFiles = Object.keys(actualZip.files);
  const refFiles = Object.keys(refZip.files);

  // 1. Check Content_Types
  const actualContentTypes = actualZip.file('[Content_Types].xml');
  const refContentTypes = refZip.file('[Content_Types].xml');

  if (!actualContentTypes) {
    discrepancies.push('Missing [Content_Types].xml in actual document');
    structuralScore -= 0.3;
  }
  if (!refContentTypes) {
    discrepancies.push('Missing [Content_Types].xml in reference document');
  }

  // 2. Format specific primary part checks
  let primaryPart = '';
  if (format === 'docx') primaryPart = 'word/document.xml';
  else if (format === 'xlsx') primaryPart = 'xl/workbook.xml';
  else if (format === 'pptx') primaryPart = 'ppt/presentation.xml';

  const actualPrimary = actualZip.file(primaryPart);
  const refPrimary = refZip.file(primaryPart);

  if (!actualPrimary) {
    discrepancies.push(`Missing primary structural part: ${primaryPart}`);
    structuralScore -= 0.4;
  }

  // 3. Extract and compare text content
  let actualText = '';
  let refText = '';

  if (actualPrimary && refPrimary) {
    actualText = extractXmlText(await actualPrimary.async('text'));
    refText = extractXmlText(await refPrimary.async('text'));

    if (refText.length > 0 && actualText.length === 0) {
      discrepancies.push('Actual document contains zero extracted text while reference has content');
      structuralScore -= 0.3;
    }
  }

  // 4. Multi-part inventory checks
  if (format === 'pptx') {
    const actualSlides = actualFiles.filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f));
    const refSlides = refFiles.filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f));
    if (actualSlides.length !== refSlides.length) {
      discrepancies.push(
        `PPTX slide count mismatch: actual=${actualSlides.length}, ref=${refSlides.length}`
      );
      structuralScore -= 0.2;
    }
  } else if (format === 'xlsx') {
    const actualSheets = actualFiles.filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f));
    const refSheets = refFiles.filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f));
    if (actualSheets.length !== refSheets.length) {
      discrepancies.push(
        `XLSX sheet count mismatch: actual=${actualSheets.length}, ref=${refSheets.length}`
      );
      structuralScore -= 0.2;
    }
  }

  structuralScore = Math.max(0, Math.min(1.0, structuralScore));
  const matched = discrepancies.length === 0 && structuralScore >= 0.95;

  return {
    matched,
    structuralScore,
    format,
    actualPartCount: actualFiles.length,
    referencePartCount: refFiles.length,
    actualTextLength: actualText.length,
    referenceTextLength: refText.length,
    discrepancies,
  };
}
