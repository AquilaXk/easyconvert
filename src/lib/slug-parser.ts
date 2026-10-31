import { FORMAT_REGISTRY } from './registry';

export interface ParsedSlug {
  isInfoPage: boolean;
  infoType?: 'terms' | 'privacy' | 'contact' | 'about' | 'security' | 'status' | 'unit' | 'accessibility';
  sourceFormat: string;
  targetFormat: string;
  pageTitle: string;
  pageDescription: string;
}

const CANONICAL_FORMAT_MAP: Record<string, string> = {
  video: 'mp4',
  audio: 'mp3',
  image: 'jpg',
  document: 'docx',
  ebook: 'epub',
  archive: 'zip',
  vector: 'svg',
  font: 'ttf',
  cad: 'dxf',
  spreadsheet: 'xlsx',
  presentation: 'pptx',
  data: 'csv',
  word: 'docx',
  excel: 'xlsx',
  powerpoint: 'pptx',
  photo: 'jpg',
  picture: 'jpg',
  music: 'mp3',
};

const OCR_SLUGS = new Set(['pdf-ocr', 'ocr-pdf', 'ocr']);

const INFO_PAGE_MAP: Record<string, ParsedSlug> = {
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
    pageDescription: 'Learn about our strict zero data retention policy and transient in-memory processing.',
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
    pageDescription: 'EasyConvert provides free, private, client-side file and data conversions directly in your browser.',
  },
  security: {
    isInfoPage: true,
    infoType: 'security',
    sourceFormat: 'pdf',
    targetFormat: 'docx',
    pageTitle: 'Security Overview',
    pageDescription: 'Explore our volatile memory pipeline, TLS encryption, and zero-storage architecture.',
  },
  status: {
    isInfoPage: true,
    infoType: 'status',
    sourceFormat: 'pdf',
    targetFormat: 'docx',
    pageTitle: 'System Status',
    pageDescription: 'Real-time operational status and diagnostics of EasyConvert browser-edge conversion pipelines.',
  },
  accessibility: {
    isInfoPage: true,
    infoType: 'accessibility',
    sourceFormat: 'pdf',
    targetFormat: 'docx',
    pageTitle: 'Accessibility Statement',
    pageDescription: 'Keyboard navigation, screen reader landmarks, colour contrast, and WCAG 2.1 AA conformance details for EasyConvert.',
  },
};

const UNIT_PAIR_SLUGS = new Set(['lbs-to-kg', 'kg-to-lbs', 'feet-to-meters', 'meters-to-feet']);

const UNIT_DISPLAY_LABELS: Record<string, string> = {
  lbs: 'Pounds (lbs)',
  kg: 'Kilograms (kg)',
  feet: 'Feet (ft)',
  meters: 'Meters (m)',
};

const TITLE_NAME_OVERRIDES: Record<string, string> = {
  word: 'Word',
  excel: 'Excel',
  powerpoint: 'PowerPoint',
  video: 'Video',
  audio: 'Audio',
  image: 'Image',
  cad: 'CAD',
  vector: 'Vector',
};

const FORMAT_ACRONYMS: Record<string, string> = {
  pdf: 'PDF',
  docx: 'DOCX',
  doc: 'DOC',
  mp4: 'MP4',
  mp3: 'MP3',
  wav: 'WAV',
  png: 'PNG',
  jpg: 'JPG',
  jpeg: 'JPEG',
  cad: 'CAD',
  ocr: 'OCR',
  csv: 'CSV',
  xlsx: 'XLSX',
  svg: 'SVG',
  xml: 'XML',
  json: 'JSON',
  html: 'HTML',
};

function getPairDescription(srcD: string, tgtD: string, src: string, tgt: string): string {
  const srcCat = FORMAT_REGISTRY[src]?.category || 'document';
  const tgtCat = FORMAT_REGISTRY[tgt]?.category || 'document';

  if (srcCat === 'video' && tgtCat === 'audio') {
    return `Convert ${srcD} to ${tgtD} online and free. Extract clean, high-fidelity audio from video files directly in your browser with zero server storage.`;
  }
  if (srcCat === 'audio' || tgtCat === 'audio' || srcCat === 'video' || tgtCat === 'video') {
    return `Convert ${srcD} to ${tgtD} online and free. Fast, high-fidelity media transcoding directly in your browser with zero server retention.`;
  }
  if (srcCat === 'image' || srcCat === 'vector' || tgtCat === 'image' || tgtCat === 'vector') {
    return `Convert ${srcD} to ${tgtD} online and free. High-precision rendering and lossless rasterization straight from your browser.`;
  }
  if (srcCat === 'archive' || tgtCat === 'archive') {
    return `Convert and extract ${srcD} to ${tgtD} archives safely in your browser with zero cloud storage.`;
  }
  if (srcCat === 'spreadsheet' || srcCat === 'data' || tgtCat === 'spreadsheet' || tgtCat === 'data') {
    return `Convert ${srcD} to ${tgtD} datasets and tables directly in your browser. Clean data structure preserved with zero retention.`;
  }
  return `Convert ${srcD} to ${tgtD} online and free. High-fidelity document conversion preserving layouts, formatting, and typography with zero server storage.`;
}

function parsePairSlug(cleanSlug: string): ParsedSlug {
  const parts = cleanSlug.split('-to-');
  const rawSrc = parts[0]?.trim() || 'pdf';
  const rawTgt = parts[1]?.trim() || 'docx';

  if (UNIT_PAIR_SLUGS.has(`${rawSrc}-to-${rawTgt}`)) {
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

  const src = CANONICAL_FORMAT_MAP[rawSrc] || rawSrc;
  const tgt = CANONICAL_FORMAT_MAP[rawTgt] || rawTgt;
  const srcDisplay = TITLE_NAME_OVERRIDES[rawSrc] ?? src.toUpperCase();
  const tgtDisplay = TITLE_NAME_OVERRIDES[rawTgt] ?? tgt.toUpperCase();

  return {
    isInfoPage: false,
    sourceFormat: src,
    targetFormat: tgt,
    pageTitle: `${srcDisplay} to ${tgtDisplay} Converter`,
    pageDescription: getPairDescription(srcDisplay, tgtDisplay, src, tgt),
  };
}

function getFormatDescription(prefix: string, src: string): string {
  const cat = FORMAT_REGISTRY[src]?.category || 'document';
  switch (cat) {
    case 'audio':
      return `Convert ${prefix} audio files online and free to MP3, WAV, AAC, and more. High-fidelity audio encoding with zero server storage.`;
    case 'video':
      return `Convert ${prefix} video files online and free to MP4, WebM, AVI, and other media formats directly in your browser.`;
    case 'image':
    case 'vector':
      return `Convert ${prefix} files online and free to PNG, JPG, WebP, SVG, and other graphic formats with lossless visual quality.`;
    case 'archive':
      return `Convert and extract ${prefix} compressed archives safely in your browser with zero cloud uploads.`;
    case 'spreadsheet':
    case 'data':
      return `Convert ${prefix} spreadsheets and datasets to CSV, Excel, JSON, and other structured formats with high precision.`;
    case 'presentation':
      return `Convert ${prefix} presentation slides to PDF, PPTX, images, and other formats with preserved layouts.`;
    case 'ebook':
      return `Convert ${prefix} ebooks to EPUB, PDF, MOBI, and other reader formats directly in your browser.`;
    default:
      return `Convert ${prefix} documents online and free to PDF, DOCX, and other formats. Preserves layouts, typography, and tables with zero server storage.`;
  }
}

function parseFormatConverterSlug(cleanSlug: string): ParsedSlug {
  const rawFmt = cleanSlug.replace('-converter', '').trim();
  if (rawFmt === 'unit') {
    return {
      isInfoPage: true,
      infoType: 'unit',
      sourceFormat: 'lbs',
      targetFormat: 'kg',
      pageTitle: 'Unit Converter',
      pageDescription: 'Convert weight, length, volume, and data units in real time with instant calculation precision.',
    };
  }

  const src = CANONICAL_FORMAT_MAP[rawFmt] || rawFmt;
  const prefix = FORMAT_ACRONYMS[rawFmt] || `${rawFmt.charAt(0).toUpperCase()}${rawFmt.slice(1)}`;

  return {
    isInfoPage: false,
    sourceFormat: src,
    targetFormat: 'any',
    pageTitle: `${prefix} Converter`,
    pageDescription: getFormatDescription(prefix, src),
  };
}

function parseUtilitySlug(cleanSlug: string): ParsedSlug | null {
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
      pageDescription: 'Capture high-resolution PDF printouts of any public website URL with CSS and vector graphics intact.',
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

export function parseConverterSlug(slug: string): ParsedSlug {
  const cleanSlug = slug.toLowerCase().replace(/^\/+/, '').trim();

  if (OCR_SLUGS.has(cleanSlug)) {
    return {
      isInfoPage: false,
      sourceFormat: 'pdf',
      targetFormat: 'pdf',
      pageTitle: 'PDF OCR Converter',
      pageDescription: 'Optical character recognition utility producing searchable, selectable documents with zero data retention.',
    };
  }

  const infoPage = INFO_PAGE_MAP[cleanSlug];
  if (infoPage) {
    return infoPage;
  }

  if (cleanSlug.includes('-to-')) {
    return parsePairSlug(cleanSlug);
  }

  if (cleanSlug.endsWith('-converter')) {
    return parseFormatConverterSlug(cleanSlug);
  }

  const utilityPage = parseUtilitySlug(cleanSlug);
  if (utilityPage) {
    return utilityPage;
  }

  const title = cleanSlug
    .split('-')
    .map((w) => `${w.charAt(0).toUpperCase()}${w.slice(1)}`)
    .join(' ');
  return {
    isInfoPage: false,
    sourceFormat: 'pdf',
    targetFormat: 'docx',
    pageTitle: `${title} Converter`,
    pageDescription: `Convert ${title} files instantly in your browser with zero data retention.`,
  };
}
