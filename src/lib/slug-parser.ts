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
    copy: { kind: 'format', name: { id: rawFmt, display: prefix }, group },
  };
}

/** A slug as the parser reads it: lowercased, without leading slashes or surrounding space. */
function normalizeSlug(slug: string): string {
  return slug.toLowerCase().replace(/^\/+/, '').trim();
}

/** The one canonical path of a converter slug page, however its slug was cased. */
export function canonicalSlugPath(slug: string): string {
  return `/${normalizeSlug(slug)}`;
}

const isRegistered = (format: string): boolean => Object.hasOwn(FORMAT_REGISTRY, format);

/**
 * Whether search engines should index the page of a slug: a site page, or a page of formats the registry has. Any other
 * slug still opens a converter page, but only names what it converts.
 */
export function isIndexableSlug(parsed: ParsedSlug): boolean {
  const { copy } = parsed;
  switch (copy.kind) {
    case 'generic':
      return false;
    case 'pair':
    case 'format':
      return isRegistered(parsed.sourceFormat) && (parsed.targetFormat === 'any' || isRegistered(parsed.targetFormat));
    case 'merge':
    case 'compress':
    case 'websiteScreenshot':
      return isRegistered(copy.format);
    default:
      return true;
  }
}

export function parseConverterSlug(slug: string): ParsedSlug {
  const cleanSlug = normalizeSlug(slug);

  if (OCR_SLUGS.has(cleanSlug)) {
    return {
      isInfoPage: false,
      sourceFormat: 'pdf',
      targetFormat: 'pdf',
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
    copy: { kind: 'generic', name: title },
  };
}
