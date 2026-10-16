/**
 * Source formats of the office suite (LibreOffice) that the in-process readers do not cover, and the formats that are
 * another format's file layout under a different name.
 *
 * Two kinds of source live here:
 *
 * - Aliases: a template or slideshow whose bytes are those of a plain format (a Word template is a Word 97-2003
 *   document, an Excel template a workbook, a PowerPoint slideshow a presentation, an OpenDocument template an
 *   OpenDocument file with another mimetype). They are read by the reader of the plain format.
 * - Office-suite-only sources: formats with no in-process reader (Works, WordPerfect, OpenOffice.org 1.x, Numbers,
 *   Publisher, the Sony, Palm and RocketBook e-books). Their bytes are never read as text; the office suite imports them
 *   and either writes the target itself or writes an interchange file that the in-process converter of that format turns
 *   into the target.
 */

export type OfficeSuiteApplication = 'writer' | 'calc' | 'impress' | 'draw';

/** Formats read by the reader of another format: Word, Excel and PowerPoint templates and slideshows, OpenDocument templates. */
export const OFFICE_FORMAT_ALIAS: Readonly<Record<string, string>> = {
  dot: 'doc',
  xlt: 'xls',
  pps: 'ppt',
  pot: 'ppt',
  ott: 'odt',
  otp: 'odp',
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
  lrf: { application: 'writer', interchange: 'docx' },
  pdb: { application: 'writer', interchange: 'docx' },
  rb: { application: 'writer', interchange: 'docx' },
  numbers: { application: 'calc', interchange: 'xlsx' },
  sxi: { application: 'impress', interchange: 'pptx' },
  sxd: { application: 'draw' },
  pub: { application: 'draw' },
};

/** Targets the in-process e-book writers produce from plain text: the Palm family and the Sony and Open eBook formats. */
const TEXT_EBOOK_TARGETS: ReadonlySet<string> = new Set(['azw3', 'mobi', 'lrf', 'oeb', 'pdb']);
/** Sources of the e-book readers of the office suite: the writers of these targets read text, not a document package. */
const EBOOK_SOURCES: ReadonlySet<string> = new Set(['lrf', 'pdb', 'rb']);

/** The application of every format the office suite reads that the in-process engine cannot render: the sources above and their aliases. */
const APPLICATION_OF_ALIAS: Readonly<Record<string, OfficeSuiteApplication>> = {
  doc: 'writer',
  xls: 'calc',
  ppt: 'impress',
  odt: 'writer',
  odp: 'impress',
};

/** Every source format of this table: the office-suite-only formats and the aliases. */
export const OFFICE_SUITE_SOURCE_FORMATS: readonly string[] = [...Object.keys(OFFICE_SUITE_ONLY_SOURCES), ...Object.keys(OFFICE_FORMAT_ALIAS)];

/**
 * The interchange format of the legacy binary Office formats, which the in-process readers read strictly: a document that
 * a reader refuses as malformed is tried by the office suite, which reads damaged files the way the application that wrote
 * them does.
 */
const LEGACY_BINARY_INTERCHANGE: Readonly<Record<string, string>> = { doc: 'docx', xls: 'xlsx', ppt: 'pptx' };

/**
 * The format to retry a refused legacy binary Office document with (templates and slide shows included): the plain text
 * the suite's writer exports for a text target, else the interchange format. Undefined for any other format.
 */
export function legacyReaderRetryInterchange(format: string, target: string): string | undefined {
  const reader = OFFICE_FORMAT_ALIAS[format] ?? format;
  if (!Object.hasOwn(LEGACY_BINARY_INTERCHANGE, reader)) return undefined;
  return reader === 'doc' && target === TEXT_INTERCHANGE ? TEXT_INTERCHANGE : LEGACY_BINARY_INTERCHANGE[reader];
}

export function isOfficeSuiteOnlySource(format: string): boolean {
  return Object.hasOwn(OFFICE_SUITE_ONLY_SOURCES, format);
}

/** The application of the office suite that imports a source format; undefined for a format it does not import under this table. */
export function officeSuiteApplication(format: string): OfficeSuiteApplication | undefined {
  if (Object.hasOwn(OFFICE_SUITE_ONLY_SOURCES, format)) return OFFICE_SUITE_ONLY_SOURCES[format].application;
  if (Object.hasOwn(OFFICE_FORMAT_ALIAS, format)) return APPLICATION_OF_ALIAS[OFFICE_FORMAT_ALIAS[format]];
  return undefined;
}

/** Whether the office suite writes plain text itself for this source: its writer applications (word processors and e-book readers). */
export function officeSuiteWritesText(format: string, target: string): boolean {
  return target === TEXT_INTERCHANGE && isOfficeSuiteOnlySource(format) && OFFICE_SUITE_ONLY_SOURCES[format].application === 'writer';
}

/**
 * The format the office suite writes so that the in-process converter of that format can write `target`: plain text for
 * the e-book targets of an e-book source, the source's interchange format for every other target. Undefined for a
 * source that has none.
 */
export function officeSuiteInterchange(format: string, target: string): string | undefined {
  if (!isOfficeSuiteOnlySource(format)) return undefined;
  if (EBOOK_SOURCES.has(format) && TEXT_EBOOK_TARGETS.has(target)) return TEXT_INTERCHANGE;
  return OFFICE_SUITE_ONLY_SOURCES[format].interchange;
}
