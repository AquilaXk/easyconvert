import { FORMAT_REGISTRY } from './registry';
import {
  INFO_PAGE_MAP,
  UNIT_CONVERTER_INFO_PAGE,
  parseUnitPairSlug,
  parseUtilitySlug,
  type FormatCopyGroup,
  type PairCopyGroup,
  type ParsedSlug,
} from './slug-info-pages';

export type { FormatCopyGroup, PairCopyGroup, ParsedSlug, SlugCopy, SlugName } from './slug-info-pages';

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

function pairCopyGroup(src: string, tgt: string): PairCopyGroup {
  const srcCat = FORMAT_REGISTRY[src]?.category || 'document';
  const tgtCat = FORMAT_REGISTRY[tgt]?.category || 'document';
  const either = (...cats: string[]) => cats.includes(srcCat) || cats.includes(tgtCat);
  if (srcCat === 'video' && tgtCat === 'audio') return 'videoToAudio';
  if (either('audio', 'video')) return 'media';
  if (either('image', 'vector')) return 'image';
  if (either('archive')) return 'archive';
  if (either('spreadsheet', 'data')) return 'data';
  return 'document';
}

const PAIR_DESCRIPTIONS: Readonly<Record<PairCopyGroup, (srcD: string, tgtD: string) => string>> = {
  videoToAudio: (srcD, tgtD) =>
    `Convert ${srcD} to ${tgtD} online and free. Extract clean, high-fidelity audio from video files directly in your browser with zero server storage.`,
  media: (srcD, tgtD) =>
    `Convert ${srcD} to ${tgtD} online and free. Fast, high-fidelity media transcoding directly in your browser with zero server retention.`,
  image: (srcD, tgtD) =>
    `Convert ${srcD} to ${tgtD} online and free. High-precision rendering and lossless rasterization straight from your browser.`,
  archive: (srcD, tgtD) => `Convert and extract ${srcD} to ${tgtD} archives safely in your browser with zero cloud storage.`,
  data: (srcD, tgtD) =>
    `Convert ${srcD} to ${tgtD} datasets and tables directly in your browser. Clean data structure preserved with zero retention.`,
  document: (srcD, tgtD) =>
    `Convert ${srcD} to ${tgtD} online and free. High-fidelity document conversion preserving layouts, formatting, and typography with zero server storage.`,
};

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
  const group = pairCopyGroup(src, tgt);

  return {
    isInfoPage: false,
    sourceFormat: src,
    targetFormat: tgt,
    pageTitle: `${srcDisplay} to ${tgtDisplay} Converter`,
    pageDescription: PAIR_DESCRIPTIONS[group](srcDisplay, tgtDisplay),
    copy: { kind: 'pair', src: { id: rawSrc, display: srcDisplay }, tgt: { id: rawTgt, display: tgtDisplay }, group },
  };
}

function formatCopyGroup(src: string): FormatCopyGroup {
  const cat = FORMAT_REGISTRY[src]?.category || 'document';
  switch (cat) {
    case 'audio':
    case 'video':
    case 'archive':
    case 'presentation':
    case 'ebook':
      return cat;
    case 'image':
    case 'vector':
      return 'image';
    case 'spreadsheet':
    case 'data':
      return 'data';
    default:
      return 'document';
  }
}

const FORMAT_DESCRIPTIONS: Readonly<Record<FormatCopyGroup, (prefix: string) => string>> = {
  audio: (prefix) =>
    `Convert ${prefix} audio files online and free to MP3, WAV, AAC, and more. High-fidelity audio encoding with zero server storage.`,
  video: (prefix) =>
    `Convert ${prefix} video files online and free to MP4, WebM, AVI, and other media formats directly in your browser.`,
  image: (prefix) =>
    `Convert ${prefix} files online and free to PNG, JPG, WebP, SVG, and other graphic formats with lossless visual quality.`,
  archive: (prefix) => `Convert and extract ${prefix} compressed archives safely in your browser with zero cloud uploads.`,
  data: (prefix) =>
    `Convert ${prefix} spreadsheets and datasets to CSV, Excel, JSON, and other structured formats with high precision.`,
  presentation: (prefix) =>
    `Convert ${prefix} presentation slides to PDF, PPTX, images, and other formats with preserved layouts.`,
  ebook: (prefix) => `Convert ${prefix} ebooks to EPUB, PDF, MOBI, and other reader formats directly in your browser.`,
  document: (prefix) =>
    `Convert ${prefix} documents online and free to PDF, DOCX, and other formats. Preserves layouts, typography, and tables with zero server storage.`,
};

function parseFormatConverterSlug(cleanSlug: string): ParsedSlug {
  const rawFmt = cleanSlug.replace('-converter', '').trim();
  if (rawFmt === 'unit') {
    return UNIT_CONVERTER_INFO_PAGE;
  }

  const src = CANONICAL_FORMAT_MAP[rawFmt] || rawFmt;
  const prefix = FORMAT_ACRONYMS[rawFmt] || `${rawFmt.charAt(0).toUpperCase()}${rawFmt.slice(1)}`;
  const group = formatCopyGroup(src);

  return {
    isInfoPage: false,
    sourceFormat: src,
    targetFormat: 'any',
    pageTitle: `${prefix} Converter`,
    pageDescription: FORMAT_DESCRIPTIONS[group](prefix),
    copy: { kind: 'format', name: { id: rawFmt, display: prefix }, group },
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
      copy: { kind: 'ocr' },
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
    copy: { kind: 'generic', name: title },
  };
}
