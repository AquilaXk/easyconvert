export type SlugInfoType =
  | 'terms'
  | 'privacy'
  | 'contact'
  | 'about'
  | 'security'
  | 'status'
  | 'unit'
  | 'accessibility';

export interface ParsedSlug {
  isInfoPage: boolean;
  infoType?: SlugInfoType;
  sourceFormat: string;
  targetFormat: string;
  pageTitle: string;
  pageDescription: string;
}

export const INFO_PAGE_MAP: Record<string, ParsedSlug> = {
  terms: {
    isInfoPage: true,
    infoType: 'terms',
    sourceFormat: 'pdf',
    targetFormat: 'docx',
    pageTitle: 'Terms of Service',
    pageDescription: 'Review the terms and conditions governing your use of EasyConvert.',
  },
  privacy: {
    isInfoPage: true,
    infoType: 'privacy',
    sourceFormat: 'pdf',
    targetFormat: 'docx',
    pageTitle: 'Privacy Policy',
    pageDescription:
      'Learn about our strict zero data retention policy and transient in-memory processing.',
  },
  contact: {
    isInfoPage: true,
    infoType: 'contact',
    sourceFormat: 'pdf',
    targetFormat: 'docx',
    pageTitle: 'Contact Us',
    pageDescription: 'Get in touch with our team for questions, feedback, or open-source issues.',
  },
  about: {
    isInfoPage: true,
    infoType: 'about',
    sourceFormat: 'pdf',
    targetFormat: 'docx',
    pageTitle: 'About Us',
    pageDescription:
      'EasyConvert provides free, private, client-side file and data conversions directly in your browser.',
  },
  security: {
    isInfoPage: true,
    infoType: 'security',
    sourceFormat: 'pdf',
    targetFormat: 'docx',
    pageTitle: 'Security Overview',
    pageDescription:
      'Explore our volatile memory pipeline, TLS encryption, and zero-storage architecture.',
  },
  status: {
    isInfoPage: true,
    infoType: 'status',
    sourceFormat: 'pdf',
    targetFormat: 'docx',
    pageTitle: 'System Status',
    pageDescription:
      'Real-time operational status and diagnostics of EasyConvert browser-edge conversion pipelines.',
  },
  accessibility: {
    isInfoPage: true,
    infoType: 'accessibility',
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
    };
  }

  return null;
}
