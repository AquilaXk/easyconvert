import { MERGE_FORMATS } from './jobs/graph-operations';
import { OPTIMIZABLE_FORMATS } from './jobs/optimize-formats';
import { COMPRESSED_IMAGE_FORMATS } from './image-compression';
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

/** The pages of the tools that work on several files or on the pages of one, each at its own path. */
export const PAGE_TOOL_SLUGS = {
  archiveCreate: 'create-zip-archive',
  archiveExtract: 'extract-zip-archive',
  splitPdf: 'split-pdf',
  rotatePdf: 'rotate-pdf',
} as const;
export type PageToolKind = keyof typeof PAGE_TOOL_SLUGS;

/** The format a tool page names as its source: the registry holds it, and the page's own tiles never show it. */
const PAGE_TOOL_FORMATS: Readonly<Record<PageToolKind, string>> = {
  archiveCreate: 'zip',
  archiveExtract: 'zip',
  splitPdf: 'pdf',
  rotatePdf: 'pdf',
};

export type SlugInfoType =
  | 'contact'
  | 'about'
  | 'security'
  | 'accessibility';

export type SlugName =
  | { kind: 'format'; id: string; display: string }
  | { kind: 'category'; id: CategoryWord; display: string };

/** What a slug's title and description say, as data, for the web interface to word in the visitor's language. */
export type SlugCopy =
  | { kind: 'info'; page: SlugInfoType }
  | { kind: 'ocr' }
  | { kind: 'pdfa' }
  | { kind: 'pair'; src: string; tgt: string }
  | { kind: 'format'; name: SlugName }
  | { kind: 'merge'; format: string }
  | { kind: 'compress'; format: string }
  | { kind: PageToolKind }
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
      return `/${copy.page}`;
    case 'ocr':
      return '/pdf-ocr';
    case 'pdfa':
      return '/pdfa-converter';
    case 'pair':
      return `/${copy.src}-to-${copy.tgt}`;
    case 'format':
      return `/${copy.name.id}-converter`;
    case 'merge':
    case 'compress':
      return `/${copy.kind}-${copy.format}`;
    case 'archiveCreate':
    case 'archiveExtract':
    case 'splitPdf':
    case 'rotatePdf':
      return `/${PAGE_TOOL_SLUGS[copy.kind]}`;
    case 'saveWebsiteAsPdf':
      return '/save-website-as-pdf';
    case 'websiteScreenshot':
      return `/website-${copy.format}-screenshot`;
  }
}

const INFO_PAGES = ['contact', 'about', 'security', 'accessibility'] as const;

export const INFO_PAGE_MAP: Readonly<Record<string, SlugPage>> = Object.fromEntries(
  INFO_PAGES.map((page) => [
    page,
    { isInfoPage: true, infoType: page, copy: { kind: 'info', page }, sourceFormat: 'pdf', targetFormat: 'docx' } satisfies SlugPage,
  ])
);

const selfConvertible = (formats: Iterable<string>): ReadonlySet<string> => new Set([...formats].filter(isSelfConvertible));

const UTILITY_FORMATS = {
  merge: selfConvertible(MERGE_FORMATS),
  compress: selfConvertible([...OPTIMIZABLE_FORMATS, ...COMPRESSED_IMAGE_FORMATS]),
} as const satisfies Record<'merge' | 'compress', ReadonlySet<string>>;

export function parseUtilitySlug(cleanSlug: string): SlugPage | null {
  for (const utility of ['merge', 'compress'] as const) {
    if (!cleanSlug.startsWith(`${utility}-`)) continue;
    const format = cleanSlug.slice(`${utility}-`.length);
    return UTILITY_FORMATS[utility].has(format)
      ? { isInfoPage: false, sourceFormat: format, targetFormat: format, copy: { kind: utility, format } }
      : null;
  }

  const tool = (Object.keys(PAGE_TOOL_SLUGS) as PageToolKind[]).find((kind) => PAGE_TOOL_SLUGS[kind] === cleanSlug);
  if (tool) {
    return { isInfoPage: false, sourceFormat: PAGE_TOOL_FORMATS[tool], targetFormat: PAGE_TOOL_FORMATS[tool], copy: { kind: tool } };
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
