import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { requireOracleTool } from './differential-oracle';
import { flatOdp, flatOdt, normalizeWhitespace, sofficeConvert, xmlEscape } from './soffice-office';

/**
 * Inputs and reference readers for the advertised legacy Office pairs. Every source file is authored by the
 * reference office suite from flat OpenDocument text written here, so the expected text is the text below and never
 * the output of the module under test. The readers (unzip, xmllint, identify, tesseract, 7z and the office suite's own
 * text export) are independent of the converter.
 */

export const DOCUMENT_PARAGRAPHS: readonly string[] = ['Quarterly review heading', 'Second paragraph about revenue growth'];
export const SLIDES: readonly (readonly string[])[] = [
  ['Slide one title', 'alpha beta'],
  ['Slide two', 'gamma delta'],
];
export const SHEET_ROWS: readonly (readonly string[])[] = [
  ['Region', 'Outlook'],
  ['North', 'Growth'],
  ['South', 'Decline'],
];

const ODS_NAMESPACES = [
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"',
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"',
  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"',
].join(' ');

/** Flat OpenDocument spreadsheet with one sheet; cells that read as numbers are stored as floats. */
export function flatOds(rows: readonly (readonly string[])[]): Buffer {
  const cell = (value: string): string =>
    /^\d+$/.test(value)
      ? `<table:table-cell office:value-type="float" office:value="${value}"><text:p>${value}</text:p></table:table-cell>`
      : `<table:table-cell office:value-type="string"><text:p>${xmlEscape(value)}</text:p></table:table-cell>`;
  const body = rows.map((row) => `<table:table-row>${row.map(cell).join('')}</table:table-row>`).join('');
  return Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?><office:document ${ODS_NAMESPACES} office:version="1.2" office:mimetype="application/vnd.oasis.opendocument.spreadsheet"><office:body><office:spreadsheet><table:table table:name="Sheet1">${body}</table:table></office:spreadsheet></office:body></office:document>`,
    'utf-8'
  );
}

export type OfficeSource = 'ppt' | 'xls' | 'doc' | 'rtf' | 'odp' | 'odt' | 'ods' | 'pptx' | 'xlsx' | 'docx';

const FLAT_EXTENSION: Record<OfficeSource, string> = {
  ppt: 'fodp',
  odp: 'fodp',
  pptx: 'fodp',
  xls: 'fods',
  ods: 'fods',
  xlsx: 'fods',
  doc: 'fodt',
  rtf: 'fodt',
  odt: 'fodt',
  docx: 'fodt',
};

function flatSource(format: OfficeSource): Buffer {
  const extension = FLAT_EXTENSION[format];
  if (extension === 'fodp') return flatOdp(SLIDES);
  if (extension === 'fods') return flatOds(SHEET_ROWS);
  return flatOdt(DOCUMENT_PARAGRAPHS);
}

/** A file of `format` written by the reference office suite from the flat sources above. */
export function authorWithReferenceSuite(format: OfficeSource): Buffer {
  return sofficeConvert(flatSource(format), FLAT_EXTENSION[format], format, format);
}

export function withTempFile<T>(buffer: Buffer, extension: string, inspect: (file: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'office-pair-'));
  try {
    const file = path.join(dir, `out.${extension}`);
    fs.writeFileSync(file, buffer);
    return inspect(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const MAX_TOOL_OUTPUT = 64 * 1024 * 1024;

function run(tool: Parameters<typeof requireOracleTool>[0], args: string[]): string {
  return execFileSync(requireOracleTool(tool), args, { encoding: 'utf-8', maxBuffer: MAX_TOOL_OUTPUT });
}

export interface ZipEntries {
  names: string[];
  read(name: string): Buffer;
}

/** Entry names and bytes of a ZIP package, read with the unzip command-line tool. */
export function readZipWithUnzip<T>(buffer: Buffer, inspect: (entries: ZipEntries) => T): T {
  return withTempFile(buffer, 'zip', (file) =>
    inspect({
      names: run('unzip', ['-Z1', file]).split('\n').filter((line) => line.length > 0),
      read: (name) => execFileSync(requireOracleTool('unzip'), ['-p', file, name], { maxBuffer: MAX_TOOL_OUTPUT }),
    })
  );
}

/** Evaluates an XPath expression with xmllint over an XML document. */
export function xpath(xml: Buffer, expression: string): string {
  return withTempFile(xml, 'xml', (file) => run('xmllint', ['--xpath', expression, file]).trim());
}

/** `width height format` of an image as the identify tool decodes it. */
export function identifyImage(buffer: Buffer, extension: string): { width: number; height: number; format: string } {
  return withTempFile(buffer, extension, (file) => {
    const [width, height, format] = run('identify', ['-format', '%w %h %m', `${file}[0]`]).trim().split(' ');
    return { width: Number(width), height: Number(height), format };
  });
}

/** Standard deviation of the grey levels of an image (0 for a blank page), normalised to 0..1. */
export function pixelSpread(buffer: Buffer, extension: string): number {
  return withTempFile(buffer, extension, (file) => Number(run('identify', ['-format', '%[fx:standard_deviation]', `${file}[0]`]).trim()));
}

/** Text OCR reads from a raster page at three times its size, with filled shapes flattened to white so dark text stands out, whitespace collapsed. */
export function ocrText(buffer: Buffer, extension: string): string {
  return withTempFile(buffer, extension, (file) => {
    const enlarged = `${file}.large.png`;
    run('magick', [file, '-resize', '300%', '-colorspace', 'Gray', '-threshold', '25%', enlarged]);
    return normalizeWhitespace(run('tesseract', [enlarged, 'stdout', '--psm', '6']));
  });
}

/** Entry names and WordDocument stream size of an OLE compound file, read by a standard-library Python parser. */
export function compoundFileFacts(buffer: Buffer): { names: string[]; wordDocumentSize: number | null } {
  return withTempFile(buffer, 'doc', (file) => JSON.parse(run('python3', ['-I', path.join(__dirname, 'python', 'cfb_streams.py'), file])));
}

/** Plain text the reference office suite reads from a document of `extension`, whitespace collapsed. */
export function referenceDocumentText(buffer: Buffer, extension: string): string {
  return normalizeWhitespace(sofficeConvert(buffer, extension, 'txt:Text', 'txt').toString('utf-8'));
}

/** Slide texts of an OpenDocument presentation package: the paragraphs of each slide joined by a space. */
export function openDocumentSlideTexts(odp: Buffer): string[] {
  return readZipWithUnzip(odp, (entries) => {
    const content = entries.read('content.xml');
    const count = Number(xpath(content, 'count(//*[local-name()="page"])'));
    return Array.from({ length: count }, (_, i) => {
      const paragraphs = xpath(content, `(//*[local-name()="page"])[${i + 1}]//*[local-name()="p"]`);
      return normalizeWhitespace(paragraphs.replace(/<\/[^>]*>/g, ' ').replace(/<[^>]*>/g, ''));
    });
  });
}
