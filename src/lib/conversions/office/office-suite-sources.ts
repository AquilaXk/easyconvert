/**
 * Source formats of the office suite (LibreOffice) that the in-process readers do not cover, and the formats that are
 * another format's file layout under a different name.
 *
 * Two kinds of source live here:
 *
 * - Aliases: a template or slideshow whose bytes are those of a plain format (a Word template is a Word 97-2003
 *   document, an Excel template a workbook, a PowerPoint slideshow a presentation, an OpenDocument template an
 *   OpenDocument file with another mimetype). They are read by the reader of the plain format.
 * - Office-suite-only sources: formats with no in-process reader (Works, WordPerfect, Lotus Word Pro, OpenOffice.org 1.x, StarOffice,
 *   AbiWord, Quattro Pro, Numbers, Pages, Publisher, the Sony and Palm e-books, the Visio and CorelDRAW drawings, the Windows and Computer Graphics metafiles). Their bytes are never read as text;
 *   the office suite imports them and either writes the target itself or writes an interchange file that the in-process
 *   converter of that format turns into the target.
 */

import { EngineUnavailableError } from '../../types';
import { CGM_ENCODING_PROBE_BYTES, isClearTextCgm } from '../../format-signatures';
import { OOXML_VARIANT_FAMILY } from '../ooxml-variants';

export type OfficeSuiteApplication = 'writer' | 'calc' | 'impress' | 'draw';

/** Formats read by the reader of another format: Word, Excel and PowerPoint templates and slideshows, OpenDocument templates. */
export const OFFICE_FORMAT_ALIAS: Readonly<Record<string, string>> = {
  dot: 'doc',
  xlt: 'xls',
  pps: 'ppt',
  pot: 'ppt',
  ott: 'odt',
  otp: 'odp',
  ots: 'ods',
};

interface OfficeSuiteOnlySource {
  /** The application of the office suite that imports the format, which decides the export filter. */
  application: OfficeSuiteApplication;
  /** The format the suite writes for a target it has no filter for; absent when the format has only targets the suite writes. */
  interchange?: string;
}

const TEXT_INTERCHANGE = 'txt';

/** Formats with no in-process reader: the office suite imports them. */
const OFFICE_SUITE_ONLY_SOURCES: Readonly<Record<string, OfficeSuiteOnlySource>> = {
  sxw: { application: 'writer', interchange: 'docx' },
  wps: { application: 'writer', interchange: 'docx' },
  wpd: { application: 'writer', interchange: 'docx' },
  lwp: { application: 'writer', interchange: 'docx' },
  lrf: { application: 'writer', interchange: 'docx' },
  pdb: { application: 'writer', interchange: 'docx' },
  numbers: { application: 'calc', interchange: 'xlsx' },
  sxi: { application: 'impress', interchange: 'pptx' },
  // Kingsoft Presentation: the suite's PowerPoint 97 import lists `dps` among its extensions (`impress_MS_PowerPoint_97.xcu`), so it opens the file as the application that wrote it.
  dps: { application: 'impress', interchange: 'pptx' },
  sxd: { application: 'draw' },
  pub: { application: 'draw' },
  sda: { application: 'draw' },
  vsd: { application: 'draw' },
  cdr: { application: 'draw' },
  emf: { application: 'draw' },
  wmf: { application: 'draw' },
  // The Computer Graphics Metafile import of the suite opens the file in Impress.
  cgm: { application: 'impress' },
  sdw: { application: 'writer', interchange: 'docx' },
  zabw: { application: 'writer', interchange: 'docx' },
  // AbiWord's plain XML is read by the same importer as its gzip form; the in-process text extractor returned the XML markup as the text.
  abw: { application: 'writer', interchange: 'docx' },
  // iWork Pages: the suite's libetonyek importer opens a document as a word processor (it has no export to a spreadsheet or a presentation).
  pages: { application: 'writer', interchange: 'docx' },
  sdc: { application: 'calc', interchange: 'xlsx' },
  qpw: { application: 'calc', interchange: 'xlsx' },
};

/** Targets the in-process engine writes from plain text only: XPS and the Hangul formats. */
export const TEXT_ONLY_TARGETS: ReadonlySet<string> = new Set(['xps', 'hwp', 'hwpx']);
/** Sources of the ebook readers of the office suite: their targets written from text only are written from the text the suite exports. */
const EBOOK_SOURCES: ReadonlySet<string> = new Set(['lrf', 'pdb']);

/**
 * The application of the office suite that opens each format it reads in its own right. A template or slide show is listed
 * under the format whose reader reads it (`officeReadingFormat`) and a macro enabled or template variant under its plain
 * format (`OOXML_VARIANT_FAMILY`). This is the one table behind the export filter, the check that an application writes only
 * its own formats and the import of the formats only the office suite reads.
 */
const APPLICATION_OF_READING_FORMAT: Readonly<Record<string, OfficeSuiteApplication>> = {
  doc: 'writer',
  docx: 'writer',
  odt: 'writer',
  rtf: 'writer',
  xls: 'calc',
  xlsx: 'calc',
  ods: 'calc',
  csv: 'calc',
  tsv: 'calc',
  ppt: 'impress',
  pptx: 'impress',
  odp: 'impress',
  potx: 'impress',
  key: 'impress',
  odg: 'draw',
  odd: 'draw',
};

/**
 * The import filter of the office suite for each declared format (`soffice --infilter=<name>`), so that the suite opens a file with the
 * importer of the format it was declared and checked as, and never with the one its own type detection picks from the bytes. A file that
 * is not what it was declared as is then refused instead of being read by another importer. The names are those of the filter registry
 * of the installation (`registry/*.xcd`; `tests/office-import-filters.test.ts` reads them from it). A macro enabled variant has its
 * macros removed before the suite sees it (`officeInputWithoutMacros`) and is opened as the plain format.
 *
 * Absent on purpose: the legacy binary Word, Excel and PowerPoint formats and their templates (`doc`, `xls`, `ppt` and the rest of
 * their extensions) and Works (`wps`), because the suite has one filter for each generation of the format behind one extension and a file
 * of an older generation is refused by the newest filter; the Palm databases (`pdb`, three filters) and the text formats (`txt`, `csv`,
 * `tsv`, `md`, `html`), whose filters need an encoding or separators; the metafiles (`emf`, `wmf`, `cgm`), which the graphic filters
 * import; and a format the installed suite has no filter for (`qpw`, `dps`). Those are opened by the suite's type detection, as before.
 */
export const OFFICE_IMPORT_FILTERS: Readonly<Record<string, string>> = {
  docx: 'MS Word 2007 XML',
  docm: 'MS Word 2007 XML',
  dotx: 'MS Word 2007 XML Template',
  dotm: 'MS Word 2007 XML Template',
  xlsx: 'Calc MS Excel 2007 XML',
  xlsm: 'Calc MS Excel 2007 XML',
  xltx: 'Calc MS Excel 2007 XML Template',
  xltm: 'Calc MS Excel 2007 XML Template',
  pptx: 'Impress MS PowerPoint 2007 XML',
  pptm: 'Impress MS PowerPoint 2007 XML',
  potx: 'Impress MS PowerPoint 2007 XML Template',
  potm: 'Impress MS PowerPoint 2007 XML Template',
  ppsx: 'Impress MS PowerPoint 2007 XML AutoPlay',
  ppsm: 'Impress MS PowerPoint 2007 XML AutoPlay',
  odt: 'writer8',
  ott: 'writer8_template',
  ods: 'calc8',
  ots: 'calc8_template',
  odp: 'impress8',
  otp: 'impress8_template',
  odg: 'draw8',
  rtf: 'Rich Text Format',
  sxw: 'StarOffice XML (Writer)',
  sxc: 'StarOffice XML (Calc)',
  sxi: 'StarOffice XML (Impress)',
  sxd: 'StarOffice XML (Draw)',
  sdw: 'StarOffice_Writer',
  sdc: 'StarOffice_Spreadsheet',
  sda: 'StarOffice_Drawing',
  wpd: 'WordPerfect',
  lwp: 'LotusWordPro',
  abw: 'AbiWord',
  zabw: 'AbiWord',
  pages: 'Apple Pages',
  numbers: 'Apple Numbers',
  key: 'Apple Keynote',
  vsd: 'Visio Document',
  cdr: 'Corel Draw Document',
  pub: 'Publisher Document',
  lrf: 'BroadBand eBook',
  pdf: 'draw_pdf_import',
};

/** The import filter the office suite is told to open a file of `format` with, or undefined for a format it detects itself (see OFFICE_IMPORT_FILTERS). */
export function officeImportFilter(format: string): string | undefined {
  const lower = format.toLowerCase();
  return Object.hasOwn(OFFICE_IMPORT_FILTERS, lower) ? OFFICE_IMPORT_FILTERS[lower] : undefined;
}

/** The `soffice` arguments that name the import filter of a declared format: none for a format the suite detects itself. */
export function officeImportFilterArgs(format: string): string[] {
  const filter = officeImportFilter(format);
  return filter === undefined ? [] : [`--infilter=${filter}`];
}

/** Every source format of this table: the formats only the office suite reads and the aliases. */
export const OFFICE_SUITE_SOURCE_FORMATS: readonly string[] = [...Object.keys(OFFICE_SUITE_ONLY_SOURCES), ...Object.keys(OFFICE_FORMAT_ALIAS)];

/**
 * The interchange format of the legacy binary Office formats, which the in-process readers read strictly: a document that
 * a reader refuses as malformed is tried by the office suite, which reads damaged files the way the application that wrote
 * them does.
 */
const LEGACY_BINARY_INTERCHANGE: Readonly<Record<string, string>> = { doc: 'docx', xls: 'xlsx', ppt: 'pptx' };

/**
 * The format to retry a refused legacy binary Office document with (templates and slide shows included): the plain text
 * the suite's writer exports for a Word document's text target or a target written from plain text only, else the
 * interchange format. Undefined for any other format.
 */
export function legacyReaderRetryInterchange(format: string, target: string): string | undefined {
  const reader = officeReadingFormat(format);
  if (!Object.hasOwn(LEGACY_BINARY_INTERCHANGE, reader)) return undefined;
  return reader === 'doc' && (target === TEXT_INTERCHANGE || TEXT_ONLY_TARGETS.has(target)) ? TEXT_INTERCHANGE : LEGACY_BINARY_INTERCHANGE[reader];
}

export function isOfficeSuiteOnlySource(format: string): boolean {
  return Object.hasOwn(OFFICE_SUITE_ONLY_SOURCES, format);
}

/** The format whose reader reads `format`: a template or slide show is read as the format it is a layout of, any other format as itself. */
export function officeReadingFormat(format: string): string {
  const lower = format.toLowerCase();
  return Object.hasOwn(OFFICE_FORMAT_ALIAS, lower) ? OFFICE_FORMAT_ALIAS[lower] : lower;
}

/** Whether `format` is a variant of a plain Office format (a macro enabled, template or slide show file) that the reader of the plain format reads. */
export function isPlainOfficeVariant(format: string): boolean {
  return Object.hasOwn(OOXML_VARIANT_FAMILY, format) || Object.hasOwn(OFFICE_FORMAT_ALIAS, format);
}

export { CGM_ENCODING_PROBE_BYTES, isClearTextCgm };

/** Whether the office suite reads a file of `format` that starts with `head`: every format of its table except a clear-text CGM. */
export function officeSuiteReadsBytes(format: string, head: Buffer): boolean {
  return isOfficeSuiteOnlySource(format) && !(format === 'cgm' && isClearTextCgm(head));
}

/** The in-process engine has no reader for a format only the office suite imports, so it never sees its bytes: the answer is an unavailable engine. */
export function assertReadableInProcess(format: string, head: Buffer): void {
  if (officeSuiteReadsBytes(format, head)) {
    throw new EngineUnavailableError('soffice', `.${format} files are imported by LibreOffice; the in-process engine has no reader for them.`);
  }
}

/** The application of the office suite that opens a format; undefined for a format it does not open (an image, a PDF). */
export function officeSuiteApplication(format: string): OfficeSuiteApplication | undefined {
  if (Object.hasOwn(OFFICE_SUITE_ONLY_SOURCES, format)) return OFFICE_SUITE_ONLY_SOURCES[format].application;
  const reading = officeReadingFormat(format);
  const plain = Object.hasOwn(OOXML_VARIANT_FAMILY, reading) ? OOXML_VARIANT_FAMILY[reading] : reading;
  return Object.hasOwn(APPLICATION_OF_READING_FORMAT, plain) ? APPLICATION_OF_READING_FORMAT[plain] : undefined;
}

/** Whether the office suite writes plain text itself for this source: its writer applications (word processors and ebook readers). */
export function officeSuiteWritesText(format: string, target: string): boolean {
  return target === TEXT_INTERCHANGE && isOfficeSuiteOnlySource(format) && OFFICE_SUITE_ONLY_SOURCES[format].application === 'writer';
}

/**
 * The format the office suite writes so that the in-process converter of that format can write `target`: plain text for
 * the ebook targets of an ebook source, the source's interchange format for every other target. Undefined for a
 * source that has none.
 */
export function officeSuiteInterchange(format: string, target: string): string | undefined {
  if (!isOfficeSuiteOnlySource(format)) return undefined;
  if (EBOOK_SOURCES.has(format) && TEXT_ONLY_TARGETS.has(target)) return TEXT_INTERCHANGE;
  return OFFICE_SUITE_ONLY_SOURCES[format].interchange;
}
