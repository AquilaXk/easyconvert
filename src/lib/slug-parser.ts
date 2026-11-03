import { FORMAT_REGISTRY } from './registry';
import { isSameFormat } from './format-aliases';
import {
  INFO_PAGE_MAP,
  UNIT_CONVERTER_INFO_PAGE,
  parseUnitPairSlug,
  parseUtilitySlug,
  type CategoryWord,
  type ParsedSlug,
  type SlugName,
} from './slug-info-pages';

export type { CategoryWord, ParsedSlug, SlugCopy, SlugName } from './slug-info-pages';

/** The words a slug may name a category by instead of a format: the format its page converts and the word its title shows. */
export const CATEGORY_WORDS: Readonly<Record<CategoryWord, { format: string; display: string }>> = {
  video: { format: 'mp4', display: 'Video' },
  audio: { format: 'mp3', display: 'Audio' },
  image: { format: 'jpg', display: 'Image' },
  document: { format: 'docx', display: 'Document' },
  ebook: { format: 'epub', display: 'Ebook' },
  archive: { format: 'zip', display: 'Archive' },
  vector: { format: 'svg', display: 'Vector' },
  font: { format: 'ttf', display: 'Font' },
  cad: { format: 'dxf', display: 'CAD' },
  spreadsheet: { format: 'xlsx', display: 'Spreadsheet' },
  presentation: { format: 'pptx', display: 'Presentation' },
  data: { format: 'csv', display: 'Data' },
  word: { format: 'docx', display: 'Word' },
  excel: { format: 'xlsx', display: 'Excel' },
  powerpoint: { format: 'pptx', display: 'PowerPoint' },
  photo: { format: 'jpg', display: 'Photo' },
  picture: { format: 'jpg', display: 'Picture' },
  music: { format: 'mp3', display: 'Music' },
};

const OCR_SLUGS = new Set(['pdf-ocr', 'ocr-pdf', 'ocr']);

/** The format a word of a slug converts and how a title names it: a category by its word, a format in capitals. */
function readSlugWord(raw: string): { format: string; name: SlugName } {
  if (Object.hasOwn(CATEGORY_WORDS, raw)) {
    const id = raw as CategoryWord;
    return { format: CATEGORY_WORDS[id].format, name: { kind: 'category', id, display: CATEGORY_WORDS[id].display } };
  }
  return { format: raw, name: { kind: 'format', id: raw, display: raw.toUpperCase() } };
}

/** The page of one format or category, the converter of anything it can be converted to. */
function formatPage({ format, name }: { format: string; name: SlugName }): ParsedSlug {
  return { isInfoPage: false, sourceFormat: format, targetFormat: 'any', copy: { kind: 'format', name } };
}

/**
 * A pair of a format and itself or another name of it (`jpeg-to-jpg`) converts nothing: its page is the page of its source.
 * A category word stands for a format only as a representative (`video` for MP4), so `video-to-mp4` converts videos to MP4
 * and stays a pair page: only two format words can be one format.
 */
function parsePairSlug(cleanSlug: string): ParsedSlug {
  const parts = cleanSlug.split('-to-');
  const rawSrc = parts[0]?.trim() || 'pdf';
  const rawTgt = parts[1]?.trim() || 'docx';

  const unitPair = parseUnitPairSlug(rawSrc, rawTgt);
  if (unitPair) {
    return unitPair;
  }

  const src = readSlugWord(rawSrc);
  const tgt = readSlugWord(rawTgt);
  if (src.name.kind === 'format' && tgt.name.kind === 'format' && isSameFormat(src.format, tgt.format)) return formatPage(src);
  return {
    isInfoPage: false,
    sourceFormat: src.format,
    targetFormat: tgt.format,
    copy: { kind: 'pair', src: src.name, tgt: tgt.name },
  };
}

function parseFormatConverterSlug(cleanSlug: string): ParsedSlug {
  const rawFmt = cleanSlug.replace('-converter', '').trim();
  if (rawFmt === 'unit') {
    return UNIT_CONVERTER_INFO_PAGE;
  }

  return formatPage(readSlugWord(rawFmt));
}

/** A slug as the parser reads it: lowercased, without leading slashes or surrounding space. */
function normalizeSlug(slug: string): string {
  return slug.toLowerCase().replace(/^\/+/, '').trim();
}

/**
 * The one canonical path of a converter slug page, however its slug was cased. A slug read as the page of a format
 * (`/jpeg-converter`, and `/jpeg-to-jpg` or `/pdf-to-pdf`, which are that page) names the converter path of that format, so
 * the pages that show the same content are copies of one URL.
 */
export function canonicalSlugPath(slug: string): string {
  const { copy } = parseConverterSlug(slug);
  return copy.kind === 'format' ? `/${copy.name.id}-converter` : `/${normalizeSlug(slug)}`;
}

const isRegistered = (format: string): boolean => Object.hasOwn(FORMAT_REGISTRY, format);

/**
 * Whether search engines should index the page of a slug: a site page, or a page of formats the registry has. Any other
 * slug still opens a converter page, but only names what it converts.
 */
export function isIndexableSlug(parsed: ParsedSlug): boolean {
  const { copy } = parsed;
  switch (copy.kind) {
    case 'generic':
      return false;
    case 'pair':
    case 'format':
      return isRegistered(parsed.sourceFormat) && (parsed.targetFormat === 'any' || isRegistered(parsed.targetFormat));
    case 'merge':
    case 'compress':
    case 'websiteScreenshot':
      return isRegistered(copy.format);
    case 'info':
    case 'ocr':
    case 'unitPair':
    case 'saveWebsiteAsPdf':
      return true;
    default: {
      const unhandled: never = copy;
      return unhandled;
    }
  }
}

const DOTTED_FORMAT_PREFIX = 'tar.';

/**
 * The suffixes of the registry's dotted format ids (`tar.gz`), the only dots a page path holds. The matcher of
 * src/middleware.ts lists them as a literal, which tests/i18n-routing.test.ts holds to this list.
 */
export const DOTTED_FORMAT_SUFFIXES: readonly string[] = Object.keys(FORMAT_REGISTRY)
  .filter((id) => id.startsWith(DOTTED_FORMAT_PREFIX))
  .map((id) => id.slice(DOTTED_FORMAT_PREFIX.length));

/** A dotted format id at the start of a slug or after a dash, and before a dash or the end, as the middleware matcher reads it. */
const DOTTED_FORMAT_ID = new RegExp(`(?<=^|-)tar\\.(?:${DOTTED_FORMAT_SUFFIXES.join('|')})(?=-|$)`, 'g');

/**
 * Whether a slug names a file rather than a page: any dot left once the dotted format ids are taken out (`backup.zip`,
 * `foo-to-bar.php`), the rule by which the middleware matcher leaves a path to the file routes. Such a path is answered 404.
 */
export function isFileSlug(slug: string): boolean {
  return normalizeSlug(slug).replace(DOTTED_FORMAT_ID, '').includes('.');
}

export function parseConverterSlug(slug: string): ParsedSlug {
  const cleanSlug = normalizeSlug(slug);

  if (OCR_SLUGS.has(cleanSlug)) {
    return {
      isInfoPage: false,
      sourceFormat: 'pdf',
      targetFormat: 'pdf',
      copy: { kind: 'ocr' },
    };
  }

  const infoPage = INFO_PAGE_MAP[cleanSlug];
  if (infoPage) {
    return infoPage;
  }

  if (cleanSlug.includes('-to-')) {
    return parsePairSlug(cleanSlug);
  }

  if (cleanSlug.endsWith('-converter')) {
    return parseFormatConverterSlug(cleanSlug);
  }

  const utilityPage = parseUtilitySlug(cleanSlug);
  if (utilityPage) {
    return utilityPage;
  }

  const title = cleanSlug
    .split('-')
    .map((w) => `${w.charAt(0).toUpperCase()}${w.slice(1)}`)
    .join(' ');
  return {
    isInfoPage: false,
    sourceFormat: 'pdf',
    targetFormat: 'docx',
    copy: { kind: 'generic', name: title },
  };
}
