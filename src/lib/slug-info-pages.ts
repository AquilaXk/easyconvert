import type { FormatCategory } from './types';
import { MERGE_FORMATS } from './jobs/graph-operations';
import { FORMAT_REGISTRY } from './registry';

export type SlugInfoType =
  | 'terms'
  | 'privacy'
  | 'contact'
  | 'about'
  | 'security'
  | 'status'
  | 'unit'
  | 'accessibility';

/** A word a slug names a category of the registry by (`/video-converter`): the id of the category. */
export type CategoryWord = FormatCategory;

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
}

export const INFO_PAGE_MAP: Record<string, ParsedSlug> = {
  terms: {
    isInfoPage: true,
    infoType: 'terms',
    copy: { kind: 'info', page: 'terms' },
    sourceFormat: 'pdf',
    targetFormat: 'docx',
  },
  privacy: {
    isInfoPage: true,
    infoType: 'privacy',
    copy: { kind: 'info', page: 'privacy' },
    sourceFormat: 'pdf',
    targetFormat: 'docx',
  },
  contact: {
    isInfoPage: true,
    infoType: 'contact',
    copy: { kind: 'info', page: 'contact' },
    sourceFormat: 'pdf',
    targetFormat: 'docx',
  },
  about: {
    isInfoPage: true,
    infoType: 'about',
    copy: { kind: 'info', page: 'about' },
    sourceFormat: 'pdf',
    targetFormat: 'docx',
  },
  security: {
    isInfoPage: true,
    infoType: 'security',
    copy: { kind: 'info', page: 'security' },
    sourceFormat: 'pdf',
    targetFormat: 'docx',
  },
  status: {
    isInfoPage: true,
    infoType: 'status',
    copy: { kind: 'info', page: 'status' },
    sourceFormat: 'pdf',
    targetFormat: 'docx',
  },
  accessibility: {
    isInfoPage: true,
    infoType: 'accessibility',
    copy: { kind: 'info', page: 'accessibility' },
    sourceFormat: 'pdf',
    targetFormat: 'docx',
  },
};

export const UNIT_CONVERTER_INFO_PAGE: ParsedSlug = {
  isInfoPage: true,
  infoType: 'unit',
  copy: { kind: 'info', page: 'unit' },
  sourceFormat: 'lbs',
  targetFormat: 'kg',
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
  };
}

/** What each utility page works on: a merge joins what a merge node of a job graph takes, a compress page rewrites a PDF or re-encodes an image. */
const UTILITY_FORMATS = {
  merge: MERGE_FORMATS,
  compress: new Set(['pdf', 'png', 'jpg']),
} as const satisfies Record<'merge' | 'compress', ReadonlySet<string>>;

/** The format a utility slug names, when the utility works on it and the registry converts it to itself, as the page does. */
function utilityFormat(utility: keyof typeof UTILITY_FORMATS, slug: string): string | null {
  const format = slug.slice(`${utility}-`.length);
  return UTILITY_FORMATS[utility].has(format) && FORMAT_REGISTRY[format]?.targetFormats.includes(format) ? format : null;
}

export function parseUtilitySlug(cleanSlug: string): ParsedSlug | null {
  for (const utility of ['merge', 'compress'] as const) {
    if (!cleanSlug.startsWith(`${utility}-`)) continue;
    const format = utilityFormat(utility, cleanSlug);
    return format ? { isInfoPage: false, sourceFormat: format, targetFormat: format, copy: { kind: utility, format } } : null;
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
