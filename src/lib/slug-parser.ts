import { FORMAT_REGISTRY } from './registry';
import {
  INFO_PAGE_MAP,
  UNIT_CONVERTER_INFO_PAGE,
  parseUnitPairSlug,
  parseUtilitySlug,
  type ParsedSlug,
} from './slug-info-pages';

export type { ParsedSlug } from './slug-info-pages';

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
  if (
    srcCat === 'spreadsheet' ||
    srcCat === 'data' ||
    tgtCat === 'spreadsheet' ||
    tgtCat === 'data'
  ) {
    return `Convert ${srcD} to ${tgtD} datasets and tables directly in your browser. Clean data structure preserved with zero retention.`;
  }
  return `Convert ${srcD} to ${tgtD} online and free. High-fidelity document conversion preserving layouts, formatting, and typography with zero server storage.`;
}

function parsePairSlug(cleanSlug: string): ParsedSlug {
  const parts = cleanSlug.split('-to-');
  const rawSrc = parts[0]?.trim() || 'pdf';
  const rawTgt = parts[1]?.trim() || 'docx';

  const unitPair = parseUnitPairSlug(rawSrc, rawTgt);
  if (unitPair) {
    return unitPair;
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
    return UNIT_CONVERTER_INFO_PAGE;
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

export function parseConverterSlug(slug: string): ParsedSlug {
  const cleanSlug = slug.toLowerCase().replace(/^\/+/, '').trim();

  if (OCR_SLUGS.has(cleanSlug)) {
    return {
      isInfoPage: false,
      sourceFormat: 'pdf',
      targetFormat: 'pdf',
      pageTitle: 'PDF OCR Converter',
      pageDescription:
        'Optical character recognition utility producing searchable, selectable documents with zero data retention.',
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
