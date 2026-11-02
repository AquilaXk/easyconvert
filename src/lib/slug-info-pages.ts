export type SlugInfoType =
  | 'terms'
  | 'privacy'
  | 'contact'
  | 'about'
  | 'security'
  | 'status'
  | 'unit'
  | 'accessibility';

/** The words a pair or format page's title is built from. `display` is how the English copy names it. */
export interface SlugName {
  id: string;
  display: string;
}

/** Which description a pair page gets, by the categories of its two formats. */
export type PairCopyGroup = 'videoToAudio' | 'media' | 'image' | 'archive' | 'data' | 'document';

/** Which description a format converter page gets, by the category of its format. */
export type FormatCopyGroup = 'audio' | 'video' | 'image' | 'archive' | 'data' | 'presentation' | 'ebook' | 'document';

/** What a slug's title and description say, as data, for the web interface to word in the visitor's language. */
export type SlugCopy =
  | { kind: 'info'; page: SlugInfoType }
  | { kind: 'ocr' }
  | { kind: 'unitPair'; src: string; tgt: string }
  | { kind: 'pair'; src: SlugName; tgt: SlugName; group: PairCopyGroup }
  | { kind: 'format'; name: SlugName; group: FormatCopyGroup }
  | { kind: 'merge'; format: string }
  | { kind: 'compress'; format: string }
  | { kind: 'saveWebsiteAsPdf' }
  | { kind: 'websiteScreenshot'; format: string }
  | { kind: 'generic'; name: string };

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

export function parseUtilitySlug(cleanSlug: string): ParsedSlug | null {
  if (cleanSlug.startsWith('merge-')) {
    const fmt = cleanSlug.split('-').pop() || 'pdf';
    return {
      isInfoPage: false,
      sourceFormat: fmt,
      targetFormat: fmt,
      copy: { kind: 'merge', format: fmt },
    };
  }

  if (cleanSlug.startsWith('compress-')) {
    const fmt = cleanSlug.split('-').pop() || 'pdf';
    return {
      isInfoPage: false,
      sourceFormat: fmt,
      targetFormat: fmt,
      copy: { kind: 'compress', format: fmt },
    };
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
