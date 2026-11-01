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

/**
 * What a slug's title and description say, as data: the English `pageTitle` and `pageDescription` are worded from it here,
 * and the web interface words it again in the visitor's language.
 */
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
  pageTitle: string;
  pageDescription: string;
  copy: SlugCopy;
}

export const INFO_PAGE_MAP: Record<string, ParsedSlug> = {
  terms: {
    isInfoPage: true,
    infoType: 'terms',
    copy: { kind: 'info', page: 'terms' },
    sourceFormat: 'pdf',
    targetFormat: 'docx',
    pageTitle: 'Terms of Service',
    pageDescription: 'Review the terms and conditions governing your use of EasyConvert.',
  },
  privacy: {
    isInfoPage: true,
    infoType: 'privacy',
    copy: { kind: 'info', page: 'privacy' },
    sourceFormat: 'pdf',
    targetFormat: 'docx',
    pageTitle: 'Privacy Policy',
    pageDescription:
      'Learn about our strict zero data retention policy and transient in-memory processing.',
  },
  contact: {
    isInfoPage: true,
    infoType: 'contact',
    copy: { kind: 'info', page: 'contact' },
    sourceFormat: 'pdf',
    targetFormat: 'docx',
    pageTitle: 'Contact Us',
    pageDescription: 'Get in touch with our team for questions, feedback, or open-source issues.',
  },
  about: {
    isInfoPage: true,
    infoType: 'about',
    copy: { kind: 'info', page: 'about' },
    sourceFormat: 'pdf',
    targetFormat: 'docx',
    pageTitle: 'About Us',
    pageDescription:
      'EasyConvert provides free, private, client-side file and data conversions directly in your browser.',
  },
  security: {
    isInfoPage: true,
    infoType: 'security',
    copy: { kind: 'info', page: 'security' },
    sourceFormat: 'pdf',
    targetFormat: 'docx',
    pageTitle: 'Security Overview',
    pageDescription:
      'Explore our volatile memory pipeline, TLS encryption, and zero-storage architecture.',
  },
  status: {
    isInfoPage: true,
    infoType: 'status',
    copy: { kind: 'info', page: 'status' },
    sourceFormat: 'pdf',
    targetFormat: 'docx',
    pageTitle: 'System Status',
    pageDescription:
      'Real-time operational status and diagnostics of EasyConvert browser-edge conversion pipelines.',
  },
  accessibility: {
    isInfoPage: true,
    infoType: 'accessibility',
    copy: { kind: 'info', page: 'accessibility' },
    sourceFormat: 'pdf',
    targetFormat: 'docx',
    pageTitle: 'Accessibility Statement',
    pageDescription:
      'Keyboard navigation, screen reader landmarks, colour contrast, and WCAG 2.1 AA conformance details for EasyConvert.',
  },
};

export const UNIT_CONVERTER_INFO_PAGE: ParsedSlug = {
  isInfoPage: true,
  infoType: 'unit',
  copy: { kind: 'info', page: 'unit' },
  sourceFormat: 'lbs',
  targetFormat: 'kg',
  pageTitle: 'Unit Converter',
  pageDescription:
    'Convert weight, length, volume, and data units in real time with instant calculation precision.',
};

const UNIT_PAIR_SLUGS = new Set(['lbs-to-kg', 'kg-to-lbs', 'feet-to-meters', 'meters-to-feet']);

const UNIT_DISPLAY_LABELS: Record<string, string> = {
  lbs: 'Pounds (lbs)',
  kg: 'Kilograms (kg)',
  feet: 'Feet (ft)',
  meters: 'Meters (m)',
};

export function parseUnitPairSlug(rawSrc: string, rawTgt: string): ParsedSlug | null {
  if (!UNIT_PAIR_SLUGS.has(`${rawSrc}-to-${rawTgt}`)) {
    return null;
  }
  const srcLabel = UNIT_DISPLAY_LABELS[rawSrc] ?? rawSrc;
  const tgtLabel = UNIT_DISPLAY_LABELS[rawTgt] ?? rawTgt;
  return {
    isInfoPage: true,
    infoType: 'unit',
    sourceFormat: rawSrc,
    targetFormat: rawTgt,
    pageTitle: `${rawSrc.toUpperCase()} to ${rawTgt.toUpperCase()} Unit Converter`,
    pageDescription: `Convert ${srcLabel} to ${tgtLabel} in real time with instant calculation precision.`,
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
      pageTitle: `Merge ${fmt.toUpperCase()}`,
      pageDescription: `Merge multiple ${fmt.toUpperCase()} files into a single unified document in seconds. Zero data retention guaranteed.`,
      copy: { kind: 'merge', format: fmt },
    };
  }

  if (cleanSlug.startsWith('compress-')) {
    const fmt = cleanSlug.split('-').pop() || 'pdf';
    return {
      isInfoPage: false,
      sourceFormat: fmt,
      targetFormat: fmt,
      pageTitle: `Compress ${fmt.toUpperCase()}`,
      pageDescription: `Reduce ${fmt.toUpperCase()} file size while preserving optimum visual fidelity and text sharpness.`,
      copy: { kind: 'compress', format: fmt },
    };
  }

  if (cleanSlug === 'save-website-as-pdf') {
    return {
      isInfoPage: false,
      sourceFormat: 'html',
      targetFormat: 'pdf',
      pageTitle: 'Save Website as PDF',
      pageDescription:
        'Capture high-resolution PDF printouts of any public website URL with CSS and vector graphics intact.',
      copy: { kind: 'saveWebsiteAsPdf' },
    };
  }

  if (cleanSlug === 'website-png-screenshot' || cleanSlug === 'website-jpg-screenshot') {
    const outFmt = cleanSlug.includes('png') ? 'png' : 'jpg';
    return {
      isInfoPage: false,
      sourceFormat: 'html',
      targetFormat: outFmt,
      pageTitle: `Website ${outFmt.toUpperCase()} Screenshot`,
      pageDescription: `Render full-page or viewport snapshots of websites in lossless ${outFmt.toUpperCase()} format.`,
      copy: { kind: 'websiteScreenshot', format: outFmt },
    };
  }

  return null;
}
