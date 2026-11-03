import { MERGE_FORMATS } from './jobs/graph-operations';
import { OPTIMIZABLE_FORMATS } from './jobs/optimize-formats';
import { FORMAT_REGISTRY } from './registry';
import type { CategoryWord } from './category-words';

export type SlugInfoType =
  | 'terms'
  | 'privacy'
  | 'contact'
  | 'about'
  | 'security'
  | 'status'
  | 'unit'
  | 'accessibility';

/** How a format page names what it converts: a format by its id in capitals, a category by the word of its title. */
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

export interface ParsedSlug {
  isInfoPage: boolean;
  infoType?: SlugInfoType;
  sourceFormat: string;
  targetFormat: string;
  copy: SlugCopy;
  /** The one path the page is at, in lowercase; a page that is a copy of another (`/jpeg-to-jpg`) names the path of the page it copies. */
  canonicalPath: string;
}

const INFO_PAGES = ['terms', 'privacy', 'contact', 'about', 'security', 'status', 'accessibility'] as const;

export const INFO_PAGE_MAP: Readonly<Record<string, ParsedSlug>> = Object.fromEntries(
  INFO_PAGES.map((page) => [
    page,
    { isInfoPage: true, infoType: page, copy: { kind: 'info', page }, sourceFormat: 'pdf', targetFormat: 'docx', canonicalPath: `/${page}` } satisfies ParsedSlug,
  ])
);

export const UNIT_CONVERTER_INFO_PAGE: ParsedSlug = {
  isInfoPage: true,
  infoType: 'unit',
  copy: { kind: 'info', page: 'unit' },
  sourceFormat: 'lbs',
  targetFormat: 'kg',
  canonicalPath: '/unit-converter',
};

const UNIT_PAIR_SLUGS = new Set(['lbs-to-kg', 'kg-to-lbs', 'feet-to-meters', 'meters-to-feet']);

export function parseUnitPairSlug(rawSrc: string, rawTgt: string): ParsedSlug | null {
  if (!UNIT_PAIR_SLUGS.has(`${rawSrc}-to-${rawTgt}`)) {
    return null;
  }
  return {
    isInfoPage: true,
    infoType: 'unit',
    sourceFormat: rawSrc,
    targetFormat: rawTgt,
    copy: { kind: 'unitPair', src: rawSrc, tgt: rawTgt },
    canonicalPath: `/${rawSrc}-to-${rawTgt}`,
  };
}

/** The formats of `formats` that the registry converts to themselves, as a utility page does: its upload converts a file of the format to the same format. */
const selfConvertible = (formats: Iterable<string>): ReadonlySet<string> =>
  new Set([...formats].filter((format) => FORMAT_REGISTRY[format]?.targetFormats.includes(format)));

/** What each utility page works on: a merge joins what a merge node of a job graph takes, a compress page runs the optimiser of the job graph, which only some formats have. */
const UTILITY_FORMATS = {
  merge: selfConvertible(MERGE_FORMATS),
  compress: selfConvertible(OPTIMIZABLE_FORMATS),
} as const satisfies Record<'merge' | 'compress', ReadonlySet<string>>;

export function parseUtilitySlug(cleanSlug: string): ParsedSlug | null {
  for (const utility of ['merge', 'compress'] as const) {
    if (!cleanSlug.startsWith(`${utility}-`)) continue;
    const format = cleanSlug.slice(`${utility}-`.length);
    return UTILITY_FORMATS[utility].has(format)
      ? { isInfoPage: false, sourceFormat: format, targetFormat: format, copy: { kind: utility, format }, canonicalPath: `/${cleanSlug}` }
      : null;
  }

  if (cleanSlug === 'save-website-as-pdf') {
    return {
      isInfoPage: false,
      sourceFormat: 'html',
      targetFormat: 'pdf',
      copy: { kind: 'saveWebsiteAsPdf' },
      canonicalPath: `/${cleanSlug}`,
    };
  }

  if (cleanSlug === 'website-png-screenshot' || cleanSlug === 'website-jpg-screenshot') {
    const outFmt = cleanSlug.includes('png') ? 'png' : 'jpg';
    return {
      isInfoPage: false,
      sourceFormat: 'html',
      targetFormat: outFmt,
      copy: { kind: 'websiteScreenshot', format: outFmt },
      canonicalPath: `/${cleanSlug}`,
    };
  }

  return null;
}
