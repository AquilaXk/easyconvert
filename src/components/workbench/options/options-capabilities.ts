import { ConversionOptions, FormatCategory } from '@/lib/types';
import { FORMAT_REGISTRY } from '@/lib/registry';

export type PasswordMode = 'archive-encrypt' | 'archive-reencrypt' | 'pdf-decrypt';

export const DEFAULT_OPTIONS: ConversionOptions = {};

const IMAGE_CATEGORIES: ReadonlyArray<FormatCategory> = ['image', 'vector', 'cad'];
const ENCRYPTABLE_ARCHIVES: ReadonlySet<string> = new Set(['zip', '7z']);
const DECRYPTABLE_ARCHIVES: ReadonlySet<string> = new Set(['zip', '7z', 'rar']);
const DELIMITED_FORMATS: ReadonlySet<string> = new Set(['csv', 'tsv']);
const TIFF_SOURCES: ReadonlySet<string> = new Set(['tiff', 'tif']);
const LOSSLESS_AUDIO_TARGETS: ReadonlySet<string> = new Set([
  'wav',
  'flac',
  'aiff',
  'aif',
  'aifc',
  'alac',
  'au',
  'caf',
  'voc',
  'pcm',
]);
const TEXT_PDF_ORIENTATION_SOURCES: ReadonlySet<string> = new Set([
  'txt',
  'md',
  'markdown',
  'html',
  'htm',
  'xhtml',
  'hwp',
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

export function isLosslessAudioTarget(targetFormat: string): boolean {
  return LOSSLESS_AUDIO_TARGETS.has(targetFormat.toLowerCase());
}

export function resolvePasswordMode(sourceFormat: string, targetFormat: string): PasswordMode | null {
  const src = sourceFormat.toLowerCase();
  const tgt = targetFormat.toLowerCase();
  if (ENCRYPTABLE_ARCHIVES.has(tgt)) {
    return DECRYPTABLE_ARCHIVES.has(src) ? 'archive-reencrypt' : 'archive-encrypt';
  }
  if (src === 'pdf') return 'pdf-decrypt';
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
  return sourceCategory === 'image' || TEXT_PDF_ORIENTATION_SOURCES.has(src);
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
  const ocrAlwaysEnabled = tgt === 'hocr' || tgt === 'alto';
  const showDocument = canSelectPages || canConfigureLayout || canConfigureOcr;
  return { canSelectPages, canConfigureLayout, canConfigureOcr, ocrAlwaysEnabled, showDocument };
}

function computeDataCaps(src: string, tgt: string, sourceCategory: FormatCategory | undefined) {
  const canConfigureDelimiter =
    isDelimitedFormat(src) || ((sourceCategory === 'spreadsheet' || src === 'pdf') && tgt === 'csv');
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
export type VisibleOptionSections = VisibleOptionsSections;
