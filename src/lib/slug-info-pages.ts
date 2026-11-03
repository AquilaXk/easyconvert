export type SlugInfoType =
  | 'contact'
  | 'about'
  | 'security'
  | 'status'
  | 'unit'
  | 'accessibility';

/** A word a slug may name a category by instead of a format (`/video-converter`, `/word-to-pdf`). */
export type CategoryWord =
  | 'video' | 'audio' | 'image' | 'document' | 'ebook' | 'archive' | 'vector' | 'font' | 'cad' | 'spreadsheet'
  | 'presentation' | 'data' | 'word' | 'excel' | 'powerpoint' | 'photo' | 'picture' | 'music';

/** How a pair or format page names one side: a format by its id in capitals, a category by the word of its title. */
export type SlugName =
  | { kind: 'format'; id: string; display: string }
  | { kind: 'category'; id: CategoryWord; display: string };

/** What a slug's title and description say, as data, for the web interface to word in the visitor's language. */
export type SlugCopy =
  | { kind: 'info'; page: SlugInfoType }
  | { kind: 'ocr' }
  | { kind: 'unitPair'; src: string; tgt: string }
  | { kind: 'pair'; src: SlugName; tgt: SlugName }
  | { kind: 'format'; name: SlugName }
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
