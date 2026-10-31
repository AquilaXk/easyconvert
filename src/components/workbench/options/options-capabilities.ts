import { ConversionOptions, FormatCategory } from '@/lib/types';
import { FORMAT_REGISTRY } from '@/lib/registry';

export type PasswordMode = 'archive-encrypt' | 'pdf-decrypt' | 'archive-decrypt';

export const DEFAULT_OPTIONS: ConversionOptions = {
  quality: 85,
  fit: 'contain',
  stripMetadata: false,
  orientation: 'portrait',
  compressionLevel: 6,
};

const IMAGE_CATEGORIES: ReadonlyArray<FormatCategory> = ['image', 'vector', 'cad'];
const ENCRYPTABLE_ARCHIVES: ReadonlySet<string> = new Set(['zip', '7z']);
const DECRYPTABLE_ARCHIVES: ReadonlySet<string> = new Set(['zip', '7z', 'rar']);
const DELIMITED_FORMATS: ReadonlySet<string> = new Set(['csv', 'tsv']);
const TIFF_SOURCES: ReadonlySet<string> = new Set(['tiff', 'tif']);

const PDF_ORIENTATION_SOURCE_CATEGORIES: ReadonlySet<FormatCategory> = new Set([
  'image',
  'vector',
  'document',
  'spreadsheet',
  'presentation',
  'ebook',
  'data',
]);

export const OCR_TARGETS: ReadonlySet<string> = new Set([
  'pdf',
  'hocr',
  'alto',
  'txt',
  'md',
  'docx',
  'rtf',
  'html',
]);

function inCategories(
  category: FormatCategory | undefined,
  allowed: ReadonlyArray<FormatCategory>
): boolean {
  return Boolean(category && allowed.includes(category));
}

export function resolvePasswordMode(src: string, tgt: string): PasswordMode | null {
  const cleanSrc = src.toLowerCase();
  const cleanTgt = tgt.toLowerCase();
  if (ENCRYPTABLE_ARCHIVES.has(cleanTgt)) return 'archive-encrypt';
  if (cleanSrc === 'pdf') return 'pdf-decrypt';
  if (DECRYPTABLE_ARCHIVES.has(cleanSrc)) return 'archive-decrypt';
  return null;
}

export function isDelimitedFormat(fmt: string): boolean {
  if (DELIMITED_FORMATS.has(fmt)) return true;
  return fmt !== 'json' && Boolean(FORMAT_REGISTRY[fmt]?.optionsSchema?.delimiter);
}

function isImageCapablePair(
  sourceCategory: FormatCategory | undefined,
  targetCategory: FormatCategory | undefined,
  tgt: string
): boolean {
  if (inCategories(targetCategory, IMAGE_CATEGORIES)) return true;
  return inCategories(sourceCategory, IMAGE_CATEGORIES) && tgt === 'pdf';
}

function computeMediaCaps(
  sourceCategory: FormatCategory | undefined,
  targetCategory: FormatCategory | undefined,
  tgt: string
) {
  const showVideo = targetCategory === 'video' || (sourceCategory === 'video' && tgt === 'gif');
  const showImage = !showVideo && isImageCapablePair(sourceCategory, targetCategory, tgt);
  const hasAudioSource = sourceCategory === 'video' || sourceCategory === 'audio';
  const showAudio = targetCategory === 'audio' || (targetCategory === 'video' && hasAudioSource);
  return { showVideo, showImage, showAudio };
}

function canSelectSourcePages(
  src: string,
  tgt: string,
  targetCategory: FormatCategory | undefined
): boolean {
  if (TIFF_SOURCES.has(src)) return true;
  return src === 'pdf' && (targetCategory === 'image' || tgt === 'svg');
}

function canConfigurePdfOrientation(
  src: string,
  tgt: string,
  sourceCategory: FormatCategory | undefined
): boolean {
  if (tgt !== 'pdf' || src === 'pdf') return false;
  return Boolean(sourceCategory && PDF_ORIENTATION_SOURCE_CATEGORIES.has(sourceCategory));
}

function computeDocumentCaps(
  src: string,
  tgt: string,
  sourceCategory: FormatCategory | undefined,
  targetCategory: FormatCategory | undefined
) {
  const canSelectPages = canSelectSourcePages(src, tgt, targetCategory);
  const canConfigureLayout = canConfigurePdfOrientation(src, tgt, sourceCategory);
  const canConfigureOcr = (src === 'pdf' || sourceCategory === 'image') && OCR_TARGETS.has(tgt);
  const showDocument = canSelectPages || canConfigureLayout || canConfigureOcr;
  return { canSelectPages, canConfigureLayout, canConfigureOcr, showDocument };
}

function computeDataCaps(src: string, tgt: string, sourceCategory: FormatCategory | undefined) {
  const canConfigureDelimiter = isDelimitedFormat(src) || isDelimitedFormat(tgt);
  const canConfigureSheetIndex =
    sourceCategory === 'spreadsheet' || Boolean(FORMAT_REGISTRY[src]?.optionsSchema?.sheetIndex);
  const showData = canConfigureDelimiter || canConfigureSheetIndex;
  return { canConfigureDelimiter, canConfigureSheetIndex, showData };
}

export function computeVisibleSections(sourceFormat: string, targetFormat: string) {
  const src = sourceFormat.toLowerCase();
  const tgt = targetFormat.toLowerCase();
  const sourceCategory = FORMAT_REGISTRY[src]?.category;
  const targetCategory = tgt ? FORMAT_REGISTRY[tgt]?.category : undefined;
  const media = computeMediaCaps(sourceCategory, targetCategory, tgt);
  const doc = computeDocumentCaps(src, tgt, sourceCategory, targetCategory);
  const data = computeDataCaps(src, tgt, sourceCategory);
  const passwordMode = resolvePasswordMode(src, tgt);
  const showArchive = targetCategory === 'archive' && tgt !== 'tar';
  const hasAny = [
    media.showImage,
    doc.showDocument,
    passwordMode !== null,
    media.showVideo,
    media.showAudio,
    data.showData,
    showArchive,
  ].some(Boolean);
  return { src, tgt, targetCategory, ...media, ...doc, ...data, passwordMode, showArchive, hasAny };
}

export type VisibleOptionsSections = ReturnType<typeof computeVisibleSections>;
