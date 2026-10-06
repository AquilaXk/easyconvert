import { UnsupportedOptionError, type ConversionOptions, type PdfAConformance } from '../types';

/** Accepted range for `imageDpi`: the resolution images are downsampled to in a PDF export. */
export const PDF_IMAGE_DPI_MIN = 72;
export const PDF_IMAGE_DPI_MAX = 1200;
/** Accepted range for `jpegQuality`: the JPEG quality images are re-encoded with in a PDF export. */
export const PDF_JPEG_QUALITY_MIN = 1;
export const PDF_JPEG_QUALITY_MAX = 100;

/** PDF/A level a `pdfa` request without a `conformance` gets. */
export const DEFAULT_PDFA_CONFORMANCE: PdfAConformance = 'pdfa-1b';

/** `pdfStandard` / `pdfVersion` spellings that request PDF/A, and the level each one means. */
const PDFA_CONFORMANCE_BY_NAME: ReadonlyMap<string, PdfAConformance> = new Map([
  ['pdfa', 'pdfa-1b'],
  ['pdfa-1b', 'pdfa-1b'],
  ['pdf/a-1b', 'pdfa-1b'],
  ['pdfa-2b', 'pdfa-2b'],
  ['pdf/a-2b', 'pdfa-2b'],
  ['pdfa-3b', 'pdfa-3b'],
  ['pdf/a-3b', 'pdfa-3b'],
]);
const PDFA_CONFORMANCE_LEVELS: ReadonlySet<string> = new Set(PDFA_CONFORMANCE_BY_NAME.values());

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
  const named = PDFA_CONFORMANCE_BY_NAME.get((options.pdfVersion || options.pdfStandard || '').toLowerCase());
  if (named) requested.add(named);
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
  type: 'boolean' | 'long';
  value: string;
}

const booleanEntry = (value: boolean): FilterDataEntry => ({ type: 'boolean', value: String(value) });
const longEntry = (value: number): FilterDataEntry => ({ type: 'long', value: String(value) });

/**
 * FilterData of the PDF export filters. By default the export keeps embedded JPEG streams byte for
 * byte (no downsampling, quality 100) and writes the heading outline; `imageDpi` and `jpegQuality`
 * opt into a compression profile, and a PDF/A request selects the PDF version in the same export.
 */
export function buildPdfExportFilterData(options: ConversionOptions): Record<string, FilterDataEntry> {
  const data: Record<string, FilterDataEntry> = {
    ReduceImageResolution: booleanEntry(options.imageDpi !== undefined),
    Quality: longEntry(options.jpegQuality ?? PDF_EXPORT_PASS_THROUGH_JPEG_QUALITY),
    ExportBookmarks: booleanEntry(true),
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
  return data;
}

/** Result metadata that reports the PDF/A verdict: whether veraPDF validated the file, and against which profile. */
export function pdfaMetadata(pdfaValidated: boolean, pdfaProfile: string): Record<string, unknown> {
  return { pdfaValidated, pdfaProfile };
}
