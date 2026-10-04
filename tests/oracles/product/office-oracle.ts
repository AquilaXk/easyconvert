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

const XML_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function decodeXmlEntities(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_, entity: string) => {
    if (entity.startsWith('#x')) return String.fromCodePoint(parseInt(entity.slice(2), 16));
    if (entity.startsWith('#')) return String.fromCodePoint(parseInt(entity.slice(1), 10));
    return XML_ENTITIES[entity];
  });
}

type OfficeFormat = 'docx' | 'xlsx' | 'pptx';

/** Separates paragraphs, string items, cells, and sheets in the extracted text. */
const ITEM_SEPARATOR = ' ';

/**
 * Matches a text run or the end of the paragraph/string item that contains it. Runs inside one
 * item are concatenated as-is (run boundaries are formatting, not text); items are separated.
 * WordprocessingML: `w:t` in `w:p`; DrawingML: `a:t` in `a:p`; SpreadsheetML: `t` in `si`/`is`.
 */
const PARAGRAPH_RUN_PATTERNS: Readonly<Record<'docx' | 'pptx' | 'spreadsheet', RegExp>> = {
  docx: /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<\/w:p>/g,
  pptx: /<a:t(?:\s[^>]*)?>([^<]*)<\/a:t>|<\/a:p>/g,
  spreadsheet: /<t(?:\s[^>]*)?>([^<]*)<\/t>/g,
};

/** Phonetic guide runs (`rPh`) annotate a string item; they are not part of its value. */
const PHONETIC_RUN = /<rPh\b[\s\S]*?<\/rPh>/g;
const SHARED_STRING_ITEM = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>|<si(?:\s[^>]*)?\/>/g;
const SHEET_CELL = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
const CELL_VALUE = /<v(?:\s[^>]*)?>([^<]*)<\/v>/;
const INLINE_STRING = /<is(?:\s[^>]*)?>([\s\S]*?)<\/is>/;
const SHARED_STRING_TYPE = 's';
const INLINE_STRING_TYPE = 'inlineStr';

function partNumber(name: string): number {
  return Number(/(\d+)\.xml$/.exec(name)?.[1] ?? 0);
}

function numberedParts(files: string[], pattern: RegExp): string[] {
  return files.filter((f) => pattern.test(f)).sort((a, b) => partNumber(a) - partNumber(b));
}

function normalizeText(items: string[]): string {
  return items.join(ITEM_SEPARATOR).replace(/\s+/g, ' ').trim();
}

/** Splits WordprocessingML or DrawingML into paragraphs, each the concatenation of its runs. */
function extractParagraphs(xml: string, pattern: RegExp): string[] {
  const paragraphs: string[] = [];
  let current = '';
  for (const match of xml.matchAll(pattern)) {
    if (match[1] === undefined) {
      paragraphs.push(current);
      current = '';
    } else {
      current += decodeXmlEntities(match[1]);
    }
  }
  paragraphs.push(current);
  return paragraphs.filter((paragraph) => paragraph.length > 0);
}

/** The value of one `si` or `is` string item: its plain or rich-text runs joined without gaps. */
function stringItemText(itemXml: string): string {
  let text = '';
  for (const match of itemXml.replace(PHONETIC_RUN, '').matchAll(PARAGRAPH_RUN_PATTERNS.spreadsheet)) {
    text += decodeXmlEntities(match[1]);
  }
  return text;
}

function attribute(attributes: string, name: string): string | undefined {
  return new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attributes)?.[1];
}

/** Resolves one cell to `ref=value`, or undefined when the cell carries no value. */
function resolveCell(attributes: string, body: string, sharedStrings: string[]): string | undefined {
  const ref = attribute(attributes, 'r') ?? '';
  const type = attribute(attributes, 't');
  if (type === INLINE_STRING_TYPE) {
    const inline = INLINE_STRING.exec(body);
    if (!inline) throw new Error(`Inline-string cell ${ref} has no <is> element`);
    return `${ref}=${stringItemText(inline[1])}`;
  }
  const value = CELL_VALUE.exec(body)?.[1];
  if (value === undefined) {
    if (type === SHARED_STRING_TYPE) throw new Error(`Shared-string cell ${ref} has no <v> index`);
    return undefined;
  }
  if (type !== SHARED_STRING_TYPE) return `${ref}=${decodeXmlEntities(value)}`;
  const index = Number(value);
  if (!Number.isInteger(index) || index < 0 || index >= sharedStrings.length) {
    throw new Error(`Cell ${ref} references shared string ${value}, but the table has ${sharedStrings.length} items`);
  }
  return `${ref}=${sharedStrings[index]}`;
}

/** Every sheet's cells resolved to their values, sheet by sheet and in document (reference) order. */
async function extractWorkbookCells(zip: JSZip, files: string[]): Promise<string[]> {
  const sharedStringsXml = files.includes('xl/sharedStrings.xml')
    ? await zip.file('xl/sharedStrings.xml')!.async('text')
    : '';
  const sharedStrings = [...sharedStringsXml.matchAll(SHARED_STRING_ITEM)].map((m) => stringItemText(m[1] ?? ''));

  const cells: string[] = [];
  const sheets = numberedParts(files, /^xl\/worksheets\/sheet\d+\.xml$/);
  for (const [sheetIndex, name] of sheets.entries()) {
    const xml = await zip.file(name)!.async('text');
    for (const match of xml.matchAll(SHEET_CELL)) {
      const cell = resolveCell(match[1], match[2] ?? '', sharedStrings);
      if (cell !== undefined) cells.push(`${sheetIndex + 1}!${cell}`);
    }
  }
  return cells;
}

async function extractDocumentText(zip: JSZip, format: OfficeFormat): Promise<string> {
  const files = Object.keys(zip.files);
  if (format === 'xlsx') {
    return normalizeText(await extractWorkbookCells(zip, files));
  }
  const parts =
    format === 'docx'
      ? files.filter((f) => f === 'word/document.xml')
      : numberedParts(files, /^ppt\/slides\/slide\d+\.xml$/);
  const paragraphs: string[] = [];
  for (const name of parts) {
    const xml = await zip.file(name)!.async('text');
    paragraphs.push(...extractParagraphs(xml, PARAGRAPH_RUN_PATTERNS[format]));
  }
  return normalizeText(paragraphs);
}

/**
 * Compares OOXML (DOCX, XLSX, PPTX) structure and content between actual and reference
 * documents using pure independent JSZip and DOM/XML inspection without production converters.
 */
export async function compareOfficeDocumentStructure(
  actualBuffer: Buffer,
  referenceBuffer: Buffer,
  format: OfficeFormat
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

  // 3. Extract and compare the visible text from each format's text-bearing parts
  const [actualText, refText] = await Promise.all([
    extractDocumentText(actualZip, format),
    extractDocumentText(refZip, format),
  ]);

  if (actualText !== refText) {
    discrepancies.push(
      `Document text differs: actual has ${actualText.length} characters, reference has ${refText.length}`
    );
    structuralScore -= 0.3;
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
