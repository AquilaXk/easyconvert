import { MERGE_FORMATS } from './jobs/graph-operations';
import { OPTIMIZABLE_FORMATS } from './jobs/optimize-formats';
import { isCategoryWord, type CategoryWord } from './category-words';
import { FORMAT_REGISTRY } from './registry';

const isRegistered = (format: string): boolean => Object.hasOwn(FORMAT_REGISTRY, format);

/**
 * Whether two names are formats of the registry, not category words, and the registry lists the conversion between them.
 * A category word stands for a format only as a representative, so `presentation`, a format of the registry that is also
 * the word of a category, has the converter page of the category and no pair page of its own.
 */
export function offersConversion(source: string, target: string): boolean {
  return (
    isRegistered(source) &&
    isRegistered(target) &&
    !isCategoryWord(source) &&
    !isCategoryWord(target) &&
    FORMAT_REGISTRY[source].targetFormats.includes(target)
  );
}

export function isSelfConvertible(format: string): boolean {
  return offersConversion(format, format);
}

export type SlugInfoType =
  | 'contact'
  | 'about'
  | 'security'
  | 'status'
  | 'unit'
  | 'accessibility';

export type SlugName =
  | { kind: 'format'; id: string; display: string }
  | { kind: 'category'; id: CategoryWord; display: string };

/** What a slug's title and description say, as data, for the web interface to word in the visitor's language. */
export type SlugCopy =
  | { kind: 'info'; page: SlugInfoType }
  | { kind: 'ocr' }
  | { kind: 'unitPair'; src: string; tgt: string }
  | { kind: 'pair'; src: string; tgt: string }
  | { kind: 'format'; name: SlugName }
  | { kind: 'merge'; format: string }
  | { kind: 'compress'; format: string }
  | { kind: 'saveWebsiteAsPdf' }
  | { kind: 'websiteScreenshot'; format: string };

/** What a slug is as a page, before the path the page is at is named. */
export interface SlugPage {
  isInfoPage: boolean;
  infoType?: SlugInfoType;
  sourceFormat: string;
  targetFormat: string;
  copy: SlugCopy;
}

export interface ParsedSlug extends SlugPage {
  /** The one path the page is at, in lowercase; a page that is a copy of another (`/jpeg-to-jpg`) names the path of the page it copies. */
  canonicalPath: string;
}

/** The path a page is at, from what its copy says it is. */
export function canonicalPathOf(copy: SlugCopy): string {
  switch (copy.kind) {
    case 'info':
      return copy.page === 'unit' ? '/unit-converter' : `/${copy.page}`;
    case 'ocr':
      return '/pdf-ocr';
    case 'unitPair':
    case 'pair':
      return `/${copy.src}-to-${copy.tgt}`;
    case 'format':
      return `/${copy.name.id}-converter`;
    case 'merge':
    case 'compress':
      return `/${copy.kind}-${copy.format}`;
    case 'saveWebsiteAsPdf':
      return '/save-website-as-pdf';
    case 'websiteScreenshot':
      return `/website-${copy.format}-screenshot`;
  }
}

const INFO_PAGES = ['contact', 'about', 'security', 'status', 'accessibility'] as const;

export const INFO_PAGE_MAP: Readonly<Record<string, SlugPage>> = Object.fromEntries(
  INFO_PAGES.map((page) => [
    page,
    { isInfoPage: true, infoType: page, copy: { kind: 'info', page }, sourceFormat: 'pdf', targetFormat: 'docx' } satisfies SlugPage,
  ])
);

export const UNIT_CONVERTER_INFO_PAGE: SlugPage = {
  isInfoPage: true,
  infoType: 'unit',
  copy: { kind: 'info', page: 'unit' },
  sourceFormat: 'lbs',
  targetFormat: 'kg',
};

const UNIT_PAIR_SLUGS = new Set(['lbs-to-kg', 'kg-to-lbs', 'feet-to-meters', 'meters-to-feet']);

export function parseUnitPairSlug(rawSrc: string, rawTgt: string): SlugPage | null {
  if (!UNIT_PAIR_SLUGS.has(`${rawSrc}-to-${rawTgt}`)) {
    return null;
  }
  return {
    isInfoPage: true,
    infoType: 'unit',
    sourceFormat: rawSrc,
    targetFormat: rawTgt,
    copy: { kind: 'unitPair', src: rawSrc, tgt: rawTgt },
  };
}

const selfConvertible = (formats: Iterable<string>): ReadonlySet<string> => new Set([...formats].filter(isSelfConvertible));

const UTILITY_FORMATS = {
  merge: selfConvertible(MERGE_FORMATS),
  compress: selfConvertible(OPTIMIZABLE_FORMATS),
} as const satisfies Record<'merge' | 'compress', ReadonlySet<string>>;

export function parseUtilitySlug(cleanSlug: string): SlugPage | null {
  for (const utility of ['merge', 'compress'] as const) {
    if (!cleanSlug.startsWith(`${utility}-`)) continue;
    const format = cleanSlug.slice(`${utility}-`.length);
    return UTILITY_FORMATS[utility].has(format)
      ? { isInfoPage: false, sourceFormat: format, targetFormat: format, copy: { kind: utility, format } }
      : null;
  }

  if (cleanSlug === 'save-website-as-pdf') {
    return {
      isInfoPage: false,
      sourceFormat: 'html',
      targetFormat: 'pdf',
      copy: { kind: 'saveWebsiteAsPdf' },
    };
  }

  if (cleanSlug === 'website-png-screenshot' || cleanSlug === 'website-jpg-screenshot') {
    const outFmt = cleanSlug.includes('png') ? 'png' : 'jpg';
    return {
      isInfoPage: false,
      sourceFormat: 'html',
      targetFormat: outFmt,
      copy: { kind: 'websiteScreenshot', format: outFmt },
    };
  }

  return null;
}
