import { UnsupportedOptionError, type ConversionOptions, type PdfAConformance } from '../types';

/** Accepted range for `imageDpi`: the resolution images are downsampled to in a PDF export. */
export const PDF_IMAGE_DPI_MIN = 72;
export const PDF_IMAGE_DPI_MAX = 1200;
/** Accepted range for `jpegQuality`: the JPEG quality images are re-encoded with in a PDF export. */
export const PDF_JPEG_QUALITY_MIN = 1;
export const PDF_JPEG_QUALITY_MAX = 100;

/** PDF/A level a request without an explicit level gets (`pdfa: {}`, `pdfStandard: 'pdfa'`). */
export const DEFAULT_PDFA_CONFORMANCE: PdfAConformance = 'pdfa-2b';

/** `pdfStandard` / `pdfVersion` spellings that request PDF/A, and the level each one means. */
const PDFA_CONFORMANCE_BY_NAME: ReadonlyMap<string, PdfAConformance> = new Map([
  ['pdfa', DEFAULT_PDFA_CONFORMANCE],
  ['pdfa-1b', 'pdfa-1b'],
  ['pdf/a-1b', 'pdfa-1b'],
  ['pdfa-2b', 'pdfa-2b'],
  ['pdf/a-2b', 'pdfa-2b'],
  ['pdfa-3b', 'pdfa-3b'],
  ['pdf/a-3b', 'pdfa-3b'],
]);
const PDFA_CONFORMANCE_LEVELS: ReadonlySet<string> = new Set(PDFA_CONFORMANCE_BY_NAME.values());

/** A value that starts like a PDF/A name: it must be a supported level, or it is an error. */
const PDFA_LOOKING_NAME = /^pdf\/?-?a/;

/**
 * The PDF/A level one string field names, or null when it names no PDF/A (for example a plain
 * PDF version such as `1.7`). A PDF/A-looking value that is not a supported level is a client
 * error: ignoring it would return a file that is not the PDF/A the request asked for.
 */
function namedPdfALevel(field: 'pdfVersion' | 'pdfStandard', value: unknown): PdfAConformance | null {
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string') {
    throw new UnsupportedOptionError(`The ${field} option must be a string.`);
  }
  const level = PDFA_CONFORMANCE_BY_NAME.get(value.toLowerCase());
  if (level) return level;
  if (PDFA_LOOKING_NAME.test(value.toLowerCase())) {
    throw new UnsupportedOptionError(`Unsupported PDF/A level in ${field}: ${value}`);
  }
  return null;
}

function assertIntegerInRange(name: string, value: unknown, min: number, max: number): void {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new UnsupportedOptionError(`The ${name} option must be an integer between ${min} and ${max}.`);
  }
}

/**
 * The PDF/A level a request asks for, or null when it asks for none. Both spellings are read:
 * the `pdfa` object and the `pdfStandard` / `pdfVersion` names. Two requests for different levels,
 * or an unknown level, are client errors.
 */
export function resolvePdfAConformance(options: ConversionOptions): PdfAConformance | null {
  const requested = new Set<PdfAConformance>();
  if (options.pdfa) {
    const level = options.pdfa.conformance ?? DEFAULT_PDFA_CONFORMANCE;
    if (!PDFA_CONFORMANCE_LEVELS.has(level)) {
      throw new UnsupportedOptionError(`Unsupported PDF/A conformance level: ${String(level)}`);
    }
    requested.add(level);
  }
  for (const field of ['pdfVersion', 'pdfStandard'] as const) {
    const named = namedPdfALevel(field, options[field]);
    if (named) requested.add(named);
  }
  if (requested.size > 1) {
    throw new UnsupportedOptionError(
      `Conflicting PDF/A levels requested: ${[...requested].join(', ')}. Request one level.`
    );
  }
  return requested.values().next().value ?? null;
}

/**
 * The PDF/A level LibreOffice writes while it exports an Office document, or null when the PDF
 * must be converted afterwards. A watermark is drawn on the finished PDF and would break a PDF/A
 * export, so a watermarked PDF/A request is exported plain and converted after the watermark.
 */
export function directPdfAExportConformance(options: ConversionOptions): PdfAConformance | null {
  if (options.watermark) return null;
  return resolvePdfAConformance(options);
}

/** Rejects `imageDpi`, `jpegQuality` and PDF/A level values the export cannot honour. */
export function assertPdfExportOptions(options: ConversionOptions): void {
  assertIntegerInRange('imageDpi', options.imageDpi, PDF_IMAGE_DPI_MIN, PDF_IMAGE_DPI_MAX);
  assertIntegerInRange('jpegQuality', options.jpegQuality, PDF_JPEG_QUALITY_MIN, PDF_JPEG_QUALITY_MAX);
  resolvePdfAConformance(options);
}

/** JPEG quality that leaves an embedded JPEG stream untouched by the PDF export. */
const PDF_EXPORT_PASS_THROUGH_JPEG_QUALITY = 100;

/** `SelectPdfVersion` value LibreOffice uses for each PDF/A level (the PDF/A part number). */
const LIBREOFFICE_PDF_VERSION: Record<PdfAConformance, number> = { 'pdfa-1b': 1, 'pdfa-2b': 2, 'pdfa-3b': 3 };

interface FilterDataEntry {
  type: 'boolean' | 'long' | 'string';
  value: string;
}

const booleanEntry = (value: boolean): FilterDataEntry => ({ type: 'boolean', value: String(value) });
const longEntry = (value: number): FilterDataEntry => ({ type: 'long', value: String(value) });
const stringEntry = (value: string): FilterDataEntry => ({ type: 'string', value });

/**
 * FilterData of the PDF export filters. By default the export keeps embedded JPEG streams byte for
 * byte (no downsampling, quality 100), writes the heading outline and leaves the comments of the document out of the pages;
 * the suite takes every property FilterData does not name from the export's own defaults, which turn comments into note
 * annotations (its plain export writes none), so that one is named; `imageDpi` and `jpegQuality`
 * opt into a compression profile, and a PDF/A request selects the PDF version in the same export. `pageRange` limits the
 * export to those pages of the printed document (the office suite's range syntax, `1` or `2-4`); the worker sets it, never a request.
 */
export function buildPdfExportFilterData(options: ConversionOptions, pageRange?: string): Record<string, FilterDataEntry> {
  const data: Record<string, FilterDataEntry> = {
    ReduceImageResolution: booleanEntry(options.imageDpi !== undefined),
    Quality: longEntry(options.jpegQuality ?? PDF_EXPORT_PASS_THROUGH_JPEG_QUALITY),
    ExportBookmarks: booleanEntry(true),
    ExportNotes: booleanEntry(false),
  };
  if (options.imageDpi !== undefined) {
    data.MaxImageResolution = longEntry(options.imageDpi);
  }
  if (options.losslessImageCompression) {
    data.UseLosslessCompression = booleanEntry(true);
  }
  const pdfa = directPdfAExportConformance(options);
  if (pdfa) {
    data.SelectPdfVersion = longEntry(LIBREOFFICE_PDF_VERSION[pdfa]);
  }
  if (pageRange !== undefined) {
    data.PageRange = stringEntry(pageRange);
  }
  return data;
}

/** Result metadata that reports the PDF/A verdict: whether veraPDF validated the file, and against which profile. */
export function pdfaMetadata(pdfaValidated: boolean, pdfaProfile: string): Record<string, unknown> {
  return { pdfaValidated, pdfaProfile };
}

export const ALLOWED_LIBREOFFICE_FILTERS_BY_TARGET: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  pdf: new Set(['writer_pdf_Export', 'calc_pdf_Export', 'impress_pdf_Export', 'draw_pdf_Export']),
  docx: new Set(['MS Word 2007 XML', 'Office Open XML Text']),
  doc: new Set(['MS Word 97']),
  odt: new Set(['writer8']),
  rtf: new Set(['Rich Text Format']),
  txt: new Set(['Text', 'Text (encoded)', 'Text (encoded):UTF8,LF,,,false']),
  html: new Set([
    'HTML (StarWriter)',
    'XHTML Writer File',
    'HTML (StarCalc)',
    'XHTML Calc File',
    'impress_html_Export',
    'draw_html_Export',
  ]),
  xlsx: new Set(['Calc MS Excel 2007 XML']),
  xls: new Set(['MS Excel 97']),
  ods: new Set(['calc8']),
  csv: new Set(['Text - txt - csv (StarCalc)']),
  pptx: new Set(['Impress MS PowerPoint 2007 XML']),
  ppt: new Set(['MS PowerPoint 97']),
  odp: new Set(['impress8']),
  odg: new Set(['draw8']),
  odd: new Set(['draw8_template']),
  otg: new Set(['draw8_template']),
});

export const ALLOWED_LIBREOFFICE_FILTERS: readonly string[] = Object.freeze([
  ...new Set(Object.values(ALLOWED_LIBREOFFICE_FILTERS_BY_TARGET).flatMap((set) => [...set])),
]);

export function assertAllowedLibreOfficeFilter(targetFormat: string, filter: unknown): string {
  const tgt = targetFormat.toLowerCase();
  const allowed = Object.hasOwn(ALLOWED_LIBREOFFICE_FILTERS_BY_TARGET, tgt)
    ? ALLOWED_LIBREOFFICE_FILTERS_BY_TARGET[tgt]
    : undefined;
  if (typeof filter !== 'string' || !allowed || !allowed.has(filter)) {
    throw new UnsupportedOptionError(
      `Unsupported LibreOffice export filter "${String(filter)}" for target format "${tgt}".`
    );
  }
  return filter;
}
