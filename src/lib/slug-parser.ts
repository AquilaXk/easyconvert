import { FORMAT_REGISTRY } from './registry';
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

/** The words a slug may name a category by instead of a format: the format its page converts and the word of its title. */
const CATEGORY_WORDS: Readonly<Record<CategoryWord, { format: string; title: string }>> = {
  video: { format: 'mp4', title: 'Video' },
  audio: { format: 'mp3', title: 'Audio' },
  image: { format: 'jpg', title: 'Image' },
  document: { format: 'docx', title: 'Document' },
  ebook: { format: 'epub', title: 'Ebook' },
  archive: { format: 'zip', title: 'Archive' },
  vector: { format: 'svg', title: 'Vector' },
  font: { format: 'ttf', title: 'Font' },
  cad: { format: 'dxf', title: 'CAD' },
  spreadsheet: { format: 'xlsx', title: 'Spreadsheet' },
  presentation: { format: 'pptx', title: 'Presentation' },
  data: { format: 'csv', title: 'Data' },
  word: { format: 'docx', title: 'Word' },
  excel: { format: 'xlsx', title: 'Excel' },
  powerpoint: { format: 'pptx', title: 'PowerPoint' },
  photo: { format: 'jpg', title: 'Photo' },
  picture: { format: 'jpg', title: 'Picture' },
  music: { format: 'mp3', title: 'Music' },
};

const OCR_SLUGS = new Set(['pdf-ocr', 'ocr-pdf', 'ocr']);

/** The format a word of a slug converts and how a title names it: a category by its word, a format in capitals. */
function readSlugWord(raw: string): { format: string; name: SlugName } {
  if (Object.hasOwn(CATEGORY_WORDS, raw)) {
    const id = raw as CategoryWord;
    return { format: CATEGORY_WORDS[id].format, name: { kind: 'category', id, display: CATEGORY_WORDS[id].title } };
  }
  return { format: raw, name: { kind: 'format', id: raw, display: raw.toUpperCase() } };
}

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

  const { format, name } = readSlugWord(rawFmt);
  return {
    isInfoPage: false,
    sourceFormat: format,
    targetFormat: 'any',
    copy: { kind: 'format', name },
  };
}

/** A slug as the parser reads it: lowercased, without leading slashes or surrounding space. */
function normalizeSlug(slug: string): string {
  return slug.toLowerCase().replace(/^\/+/, '').trim();
}

/** The one canonical path of a converter slug page, however its slug was cased. */
export function canonicalSlugPath(slug: string): string {
  return `/${normalizeSlug(slug)}`;
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
