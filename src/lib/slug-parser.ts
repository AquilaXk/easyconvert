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

/** The words a slug names a category by, the categories of the registry: the format its page converts and the word its title shows. */
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
};

const OCR_SLUG = 'pdf-ocr';
const CONVERTER_SUFFIX = '-converter';
const PAIR_SEPARATOR = '-to-';

/** The page of one format or category, the converter of anything it can be converted to. */
function formatPage(format: string, name: SlugName): ParsedSlug {
  return { isInfoPage: false, sourceFormat: format, targetFormat: 'any', copy: { kind: 'format', name } };
}

/**
 * The page of a pair of two format names that the registry converts (`png-to-jpg`), and of no other pair. A category word
 * stands for a format only as a representative (`video` for MP4), so a pair that holds one, like `any`, a name the registry
 * does not know and a conversion it does not list (`mp3-to-pdf`, `jpg-to-jpeg`), is no page. A pair of two names of one
 * format that the registry lists (`jpeg-to-jpg`, `pdf-to-pdf`) converts nothing: its page is the page of its source.
 */
function parsePairSlug(cleanSlug: string): ParsedSlug | null {
  const [source, target, ...rest] = cleanSlug.split(PAIR_SEPARATOR);
  if (target === undefined || rest.length > 0) return null;

  const unitPair = parseUnitPairSlug(source, target);
  if (unitPair) return unitPair;

  if (!offersConversion(source, target)) return null;
  if (isSameFormat(source, target)) return formatPage(source, { kind: 'format', id: source, display: source.toUpperCase() });
  return { isInfoPage: false, sourceFormat: source, targetFormat: target, copy: { kind: 'pair', src: source, tgt: target } };
}

function parseFormatConverterSlug(cleanSlug: string): ParsedSlug | null {
  const word = cleanSlug.slice(0, -CONVERTER_SUFFIX.length);
  if (word === 'unit') return UNIT_CONVERTER_INFO_PAGE;
  if (Object.hasOwn(CATEGORY_WORDS, word)) {
    const id = word as CategoryWord;
    return formatPage(CATEGORY_WORDS[id].format, { kind: 'category', id, display: CATEGORY_WORDS[id].display });
  }
  return isRegistered(word) ? formatPage(word, { kind: 'format', id: word, display: word.toUpperCase() }) : null;
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
export function canonicalSlugPath(slug: string, { copy }: ParsedSlug): string {
  return copy.kind === 'format' ? `/${copy.name.id}${CONVERTER_SUFFIX}` : `/${normalizeSlug(slug)}`;
}

const isRegistered = (format: string): boolean => Object.hasOwn(FORMAT_REGISTRY, format);

/** Whether two names are formats of the registry, not category words, and the registry lists the conversion between them: the pair has a page. */
export function offersConversion(source: string, target: string): boolean {
  return (
    isRegistered(source) &&
    isRegistered(target) &&
    !Object.hasOwn(CATEGORY_WORDS, source) &&
    !Object.hasOwn(CATEGORY_WORDS, target) &&
    FORMAT_REGISTRY[source].targetFormats.includes(target)
  );
}

const DOTTED_FORMAT_PREFIX = 'tar.';

/**
 * The suffixes of the registry's dotted format ids (`tar.gz`), the only dots a page path holds. The matcher of
 * src/middleware.ts lists them as a literal, which tests/i18n-routing.test.ts holds to this list.
 */
export const DOTTED_FORMAT_SUFFIXES: readonly string[] = Object.keys(FORMAT_REGISTRY)
  .filter((id) => id.startsWith(DOTTED_FORMAT_PREFIX))
  .map((id) => id.slice(DOTTED_FORMAT_PREFIX.length));

/**
 * What a slug is as a page of the site, or null when the site offers no page at that path. This is the one place that
 * decides: the slug page answers 404 for null. A page exists for a site page, `pdf-ocr`, the converter of a registered
 * format or a category of the registry, a pair of two registered formats the registry converts, a utility page of a format
 * it works on, and a pair of units. A name the site does not know, `any`, a category word in a pair and a conversion the
 * registry does not list have none.
 */
export function parseConverterSlug(slug: string): ParsedSlug | null {
  const cleanSlug = normalizeSlug(slug);

  if (cleanSlug === OCR_SLUG) {
    return { isInfoPage: false, sourceFormat: 'pdf', targetFormat: 'pdf', copy: { kind: 'ocr' } };
  }
  if (Object.hasOwn(INFO_PAGE_MAP, cleanSlug)) return INFO_PAGE_MAP[cleanSlug];
  if (cleanSlug.includes(PAIR_SEPARATOR)) return parsePairSlug(cleanSlug);
  if (cleanSlug.endsWith(CONVERTER_SUFFIX)) return parseFormatConverterSlug(cleanSlug);
  return parseUtilitySlug(cleanSlug);
}
