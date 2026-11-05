import { FORMAT_REGISTRY } from './registry';
import { isSameFormat } from './format-aliases';
import { CATEGORY_WORDS, isCategoryWord } from './category-words';
import {
  INFO_PAGE_MAP,
  UNIT_CONVERTER_INFO_PAGE,
  canonicalPathOf,
  isSelfConvertible,
  offersConversion,
  parseUnitPairSlug,
  parseUtilitySlug,
  type ParsedSlug,
  type SlugName,
  type SlugPage,
} from './slug-info-pages';

export { isSelfConvertible, offersConversion, type ParsedSlug, type SlugCopy, type SlugName } from './slug-info-pages';

const OCR_SLUG = 'pdf-ocr';
const CONVERTER_SUFFIX = '-converter';
const PAIR_SEPARATOR = '-to-';

/** The page of one format or category, the converter of anything it can be converted to. */
function formatPage(format: string, name: SlugName): SlugPage {
  return { isInfoPage: false, sourceFormat: format, targetFormat: 'any', copy: { kind: 'format', name } };
}

/**
 * The page of a pair of two format names that the registry converts (`png-to-jpg`), and of no other pair. A category word
 * stands for a format only as a representative (`video` for MP4), so a pair that holds one, like `any`, a name the registry
 * does not know and a conversion it does not list (`mp3-to-pdf`, `jpg-to-jpeg`), is no page. A pair of two names of one
 * format that the registry lists (`jpeg-to-jpg`, `pdf-to-pdf`) converts nothing, so its page is the page of its source.
 */
function parsePairSlug(cleanSlug: string): SlugPage | null {
  const [source, target, ...rest] = cleanSlug.split(PAIR_SEPARATOR);
  if (target === undefined || rest.length > 0) return null;

  const unitPair = parseUnitPairSlug(source, target);
  if (unitPair) return unitPair;

  if (!offersConversion(source, target)) return null;
  if (isSameFormat(source, target)) return formatPage(source, { kind: 'format', id: source, display: source.toUpperCase() });
  return { isInfoPage: false, sourceFormat: source, targetFormat: target, copy: { kind: 'pair', src: source, tgt: target } };
}

function parseFormatConverterSlug(cleanSlug: string): SlugPage | null {
  const word = cleanSlug.slice(0, -CONVERTER_SUFFIX.length);
  if (word === 'unit') return UNIT_CONVERTER_INFO_PAGE;
  if (isCategoryWord(word)) {
    return formatPage(CATEGORY_WORDS[word].format, { kind: 'category', id: word, display: CATEGORY_WORDS[word].display });
  }
  return Object.hasOwn(FORMAT_REGISTRY, word) ? formatPage(word, { kind: 'format', id: word, display: word.toUpperCase() }) : null;
}

/** The slug with `A` to `Z` lowercased and every other character as it came; the case folding of Unicode would read the Kelvin sign as `k`. */
const lowercaseAscii = (slug: string): string => slug.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());

function parseCleanSlug(cleanSlug: string): SlugPage | null {
  if (cleanSlug === OCR_SLUG) return { isInfoPage: false, sourceFormat: 'pdf', targetFormat: 'pdf', copy: { kind: 'ocr' } };
  if (Object.hasOwn(INFO_PAGE_MAP, cleanSlug)) return INFO_PAGE_MAP[cleanSlug];
  if (cleanSlug.includes(PAIR_SEPARATOR)) return parsePairSlug(cleanSlug);
  if (cleanSlug.endsWith(CONVERTER_SUFFIX)) return parseFormatConverterSlug(cleanSlug);
  return parseUtilitySlug(cleanSlug);
}

/**
 * What a slug is as a page of the site, or null when the site offers no page at that path. This is the one place that
 * decides, and the slug page answers 404 for null. A page exists for a site page, `pdf-ocr`, the converter of a registered
 * format or a category of the registry, a pair of two registered formats the registry converts, a utility page of a format
 * it works on, and a pair of units. A name the site does not know, `any`, a category word in a pair and a conversion the
 * registry does not list have none. The slug is read exactly as it came, so a space, a tab, a line break or a slash around
 * it makes it another path and no page. Lowercasing `A` to `Z` is the one tolerance, so `/PDF-to-JPG` shows the page of
 * `/pdf-to-jpg`, which it names as its canonical (`canonicalPath`, named here once for every page).
 */
export function parseConverterSlug(slug: string): ParsedSlug | null {
  const page = parseCleanSlug(lowercaseAscii(slug));
  return page && { ...page, canonicalPath: canonicalPathOf(page.copy) };
}
