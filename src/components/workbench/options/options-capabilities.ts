import { AudioCodec, ConversionOptions, FormatCategory } from '@/lib/types';
import { FORMAT_REGISTRY } from '@/lib/registry';
import {
  FFMPEG_VIDEO_CONTAINERS,
  resolveAllowedVideoCodecs,
  resolveAudioCapabilities,
  sanitizeVideoOptionsForTarget,
} from './media-capabilities';

export {
  FFMPEG_VIDEO_CONTAINERS,
  resolveAllowedVideoCodecs,
  resolveAudioCapabilities,
  sanitizeVideoOptionsForTarget,
};
export {
  isLosslessAudioTarget,
  resolveSelectableVideoCodecs,
  type AudioCapabilities,
  type SelectableVideoCodec,
} from './media-capabilities';

export type PasswordMode = 'archive-encrypt' | 'archive-reencrypt' | 'pdf-decrypt';

export const DEFAULT_OPTIONS: ConversionOptions = {};

const IMAGE_CATEGORIES: ReadonlyArray<FormatCategory> = ['image', 'vector', 'cad'];
const ENCRYPTABLE_ARCHIVES: ReadonlySet<string> = new Set(['zip', '7z']);
const DECRYPTABLE_ARCHIVES: ReadonlySet<string> = new Set(['zip', '7z', 'rar']);
const TIFF_SOURCES: ReadonlySet<string> = new Set(['tiff', 'tif']);
const TEXT_PDF_ORIENTATION_SOURCES: ReadonlySet<string> = new Set([
  'txt',
  'md',
  'markdown',
  'html',
  'htm',
  'xhtml',
  'hwp',
]);

const SHEET_WORKBOOK_TARGETS: ReadonlySet<string> = new Set(['xlsx', 'ods', 'xls']);
const XLSX_TABULAR_SOURCES: ReadonlySet<string> = new Set([
  'xlsx',
  'xlsm',
  'xltx',
  'xltm',
  'numbers',
  'sdc',
  'qpw',
]);
const SHEET_INDEX_TARGETS: ReadonlySet<string> = new Set(['csv', 'tsv', 'json', 'html', 'xps']);
const DELIMITER_CSV_OUTPUT_SOURCES: ReadonlySet<string> = new Set([
  'xlsx',
  'xlsm',
  'xltx',
  'xltm',
  'xls',
  'xlt',
  'ods',
  'ots',
  'et',
  'docx',
  'numbers',
  'sdc',
  'qpw',
]);

const ZIP_PRINTABLE_ASCII_PATTERN = /^[\x20-\x7E]+$/;
const MAX_ZIP_PASSWORD_LENGTH = 99;
const MAX_GENERAL_PASSWORD_LENGTH = 256;

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

export function resolvePasswordMode(sourceFormat: string, targetFormat: string): PasswordMode | null {
  const src = sourceFormat.toLowerCase();
  const tgt = targetFormat.toLowerCase();
  if (ENCRYPTABLE_ARCHIVES.has(tgt)) {
    return DECRYPTABLE_ARCHIVES.has(src) ? 'archive-reencrypt' : 'archive-encrypt';
  }
  if (src === 'pdf') return 'pdf-decrypt';
  return null;
}

function isImageCapablePair(
  sourceCategory: FormatCategory | undefined,
  targetCategory: FormatCategory | undefined,
  tgt: string
): boolean {
  if (sourceCategory === 'video' || sourceCategory === 'audio') return false;
  if (inCategories(targetCategory, IMAGE_CATEGORIES)) return true;
  return inCategories(sourceCategory, IMAGE_CATEGORIES) && tgt === 'pdf';
}

function computeMediaCaps(
  sourceCategory: FormatCategory | undefined,
  targetCategory: FormatCategory | undefined,
  tgt: string
) {
  const showVideo = FFMPEG_VIDEO_CONTAINERS.has(tgt);
  const showVideoCodec = resolveAllowedVideoCodecs(tgt).length > 0;
  const showImage = !showVideo && isImageCapablePair(sourceCategory, targetCategory, tgt);
  const hasAudioSource = sourceCategory === 'video' || sourceCategory === 'audio';
  const showAudio =
    (targetCategory === 'audio' && tgt !== 'dss') || (targetCategory === 'video' && hasAudioSource);
  return { showVideo, showVideoCodec, showImage, showAudio };
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

function canConfigureTableDelimiter(
  src: string,
  tgt: string,
  targetCategory: FormatCategory | undefined
): boolean {
  if (!tgt || targetCategory === 'archive') return false;
  if (src === 'csv') return true;
  if (src === 'tsv' || src === 'tab') return !SHEET_WORKBOOK_TARGETS.has(tgt);
  if (tgt === 'csv') return DELIMITER_CSV_OUTPUT_SOURCES.has(src);
  return false;
}

function computeDataCaps(
  src: string,
  tgt: string,
  targetCategory: FormatCategory | undefined
) {
  const canConfigureDelimiter = canConfigureTableDelimiter(src, tgt, targetCategory);
  const canConfigureSheetIndex = XLSX_TABULAR_SOURCES.has(src) && SHEET_INDEX_TARGETS.has(tgt);
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
  const data = computeDataCaps(src, tgt, targetCategory);
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

function applySanitizedImageOptions(
  next: ConversionOptions,
  options: ConversionOptions,
  visible: VisibleOptionsSections
): void {
  if (!visible.showImage) return;
  if (options.width !== undefined) next.width = options.width;
  if (options.height !== undefined) next.height = options.height;
  if (options.fit !== undefined) next.fit = options.fit;
  if (options.quality !== undefined) next.quality = options.quality;
  if (options.stripMetadata === true) next.stripMetadata = true;
}

function applySanitizedOcrOptions(
  next: ConversionOptions,
  options: ConversionOptions,
  visible: VisibleOptionsSections
): void {
  if (!visible.canConfigureOcr) return;
  if (visible.ocrAlwaysEnabled) {
    if (options.ocrLanguage?.trim()) next.ocrLanguage = options.ocrLanguage;
    return;
  }
  if (options.ocrEnabled === true) {
    next.ocrEnabled = true;
    next.ocrLanguage = options.ocrLanguage || 'eng';
  }
}

function applySanitizedDocumentOptions(
  next: ConversionOptions,
  options: ConversionOptions,
  visible: VisibleOptionsSections
): void {
  if (visible.canSelectPages && options.pages?.trim()) {
    next.pages = options.pages.trim();
  }
  if (
    visible.canConfigureLayout &&
    (options.orientation === 'portrait' || options.orientation === 'landscape')
  ) {
    next.orientation = options.orientation;
  }
  applySanitizedOcrOptions(next, options, visible);
}

function hasForbiddenPasswordChars(value: string): boolean {
  if (value.includes('\r') || value.includes('\n') || value.includes('\0')) return true;
  let cursor = 0;
  while (cursor < value.length) {
    const code = value.codePointAt(cursor) ?? 0;
    if (code >= 0xd800 && code <= 0xdfff) return true;
    cursor += code > 0xffff ? 2 : 1;
  }
  return false;
}

export function isValidPasswordForTarget(password: string, targetFormat: string): boolean {
  if (targetFormat.toLowerCase() === 'zip') {
    return (
      password.length > 0 &&
      password.length <= MAX_ZIP_PASSWORD_LENGTH &&
      ZIP_PRINTABLE_ASCII_PATTERN.test(password)
    );
  }
  return (
    password.length > 0 &&
    password.length <= MAX_GENERAL_PASSWORD_LENGTH &&
    !hasForbiddenPasswordChars(password)
  );
}

export function getPasswordValidationError(
  sourceFormat: string,
  targetFormat: string,
  password: string | undefined
): string | null {
  if (!password || resolvePasswordMode(sourceFormat, targetFormat) === null) return null;
  if (isValidPasswordForTarget(password, targetFormat)) return null;
  if (targetFormat.toLowerCase() === 'zip') {
    return 'ZIP passwords support 1 to 99 printable ASCII characters only.';
  }
  if (hasForbiddenPasswordChars(password)) {
    return 'Passwords cannot contain line breaks, null bytes, or invalid Unicode.';
  }
  return 'Passwords must be 256 characters or fewer.';
}

function applySanitizedSecurityAndArchiveOptions(
  next: ConversionOptions,
  options: ConversionOptions,
  visible: VisibleOptionsSections
): void {
  if (visible.passwordMode !== null && options.password) {
    next.password = options.password;
  }
  if (visible.showArchive && options.compressionLevel !== undefined) {
    next.compressionLevel = options.compressionLevel;
  }
}

const AUDIO_CODEC_OMITTED_KEYS: ReadonlySet<string> = new Set(['codec']);

function copyDefinedFields(
  source: Record<string, unknown>,
  omittedKeys: ReadonlySet<string>
): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(source)) {
    if (val !== undefined && !omittedKeys.has(key)) clean[key] = val;
  }
  return clean;
}

function applySanitizedVideoOptions(
  next: ConversionOptions,
  options: ConversionOptions,
  visible: VisibleOptionsSections
): void {
  if (!visible.showVideo) return;
  const sanitized = sanitizeVideoOptionsForTarget(options, visible.tgt);
  if (sanitized.videoCodec !== undefined) next.videoCodec = sanitized.videoCodec;
  if (sanitized.videoFps !== undefined) next.videoFps = sanitized.videoFps;
  if (sanitized.video !== undefined) next.video = sanitized.video;
}

function sanitizeAudioEncodingOptions(
  audio: ConversionOptions['audio'],
  allowedCodecs: ReadonlyArray<AudioCodec>
): ConversionOptions['audio'] {
  if (!audio) return undefined;
  const clean = copyDefinedFields(audio as Record<string, unknown>, AUDIO_CODEC_OMITTED_KEYS);
  if (audio.codec && allowedCodecs.includes(audio.codec)) {
    clean.codec = audio.codec;
  }
  return Object.keys(clean).length > 0 ? (clean as NonNullable<ConversionOptions['audio']>) : undefined;
}

function applySanitizedAudioOptions(
  next: ConversionOptions,
  options: ConversionOptions,
  visible: VisibleOptionsSections
): void {
  if (!visible.showAudio) return;
  const initialCaps = resolveAudioCapabilities(visible.tgt, options.audio?.codec);
  const cleanAudio = sanitizeAudioEncodingOptions(options.audio, initialCaps.allowedCodecs);
  if (cleanAudio) next.audio = cleanAudio;
  const effectiveCaps = resolveAudioCapabilities(visible.tgt, cleanAudio?.codec);
  if (effectiveCaps.canConfigureBitrate && options.audioBitrate) {
    next.audioBitrate = options.audioBitrate;
  }
  if (
    options.audioSampleRate !== undefined &&
    effectiveCaps.allowedSampleRates.includes(options.audioSampleRate)
  ) {
    next.audioSampleRate = options.audioSampleRate;
  }
  if (
    options.audioChannels !== undefined &&
    effectiveCaps.allowedChannels.includes(options.audioChannels)
  ) {
    next.audioChannels = options.audioChannels;
  }
  if (options.audioVolume !== undefined && options.audioVolume !== 100) {
    next.audioVolume = options.audioVolume;
  }
}

function applySanitizedTrimOptions(
  next: ConversionOptions,
  options: ConversionOptions,
  visible: VisibleOptionsSections
): void {
  if (!visible.showVideo && !visible.showAudio) return;
  const start = options.trim?.start?.trim();
  const end = options.trim?.end?.trim();
  if (!start && !end) return;
  next.trim = {
    ...(start ? { start } : {}),
    ...(end ? { end } : {}),
  };
}

function applySanitizedDataOptions(
  next: ConversionOptions,
  options: ConversionOptions,
  visible: VisibleOptionsSections
): void {
  if (visible.canConfigureDelimiter && options.delimiter) {
    next.delimiter = options.delimiter;
  }
  if (
    visible.canConfigureSheetIndex &&
    options.sheetIndex !== undefined &&
    options.sheetIndex >= 0
  ) {
    next.sheetIndex = options.sheetIndex;
    next.sheetMode = 'index';
  }
}

export function sanitizeOptionsForPair(
  options: ConversionOptions,
  sourceFormat: string,
  targetFormat: string
): ConversionOptions {
  if (!targetFormat.trim()) return {};
  const visible = computeVisibleSections(sourceFormat, targetFormat);
  const next: ConversionOptions = {};
  applySanitizedImageOptions(next, options, visible);
  applySanitizedDocumentOptions(next, options, visible);
  applySanitizedSecurityAndArchiveOptions(next, options, visible);
  applySanitizedVideoOptions(next, options, visible);
  applySanitizedAudioOptions(next, options, visible);
  applySanitizedTrimOptions(next, options, visible);
  applySanitizedDataOptions(next, options, visible);
  return next;
}
