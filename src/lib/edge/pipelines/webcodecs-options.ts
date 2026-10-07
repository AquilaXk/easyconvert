/**
 * The conversion options the edge WebCodecs path applies, and the refusal of every other option a request sets.
 *
 * A request that asks for something the edge worker cannot do (a frame-rate change, a trim, a crop) must reach
 * the server tier, which can; dropping the option and returning a different file is not an answer. Each key of
 * ConversionOptions is therefore classified, and a key added to the type without a classification here fails
 * type-checking.
 */

import type { ConversionOptions } from '../../types';
import type { WebCodecsConversionRequest } from '../workers/webcodecs.worker';
import { EdgeUnsupportedError } from '../workers/worker-errors';

const KBPS = 1000;
const MONO_CHANNELS = 1;
const STEREO_CHANNELS = 2;
/** `<digits>k` of ConversionOptions['audioBitrate']; at most four digits keeps the value a bitrate. */
const AUDIO_BITRATE_PATTERN = /^([1-9]\d{0,3})k$/;
/** `fill` is the one fit that stretches the picture to the given size, which is what the edge resize does. */
const STRETCH_FIT = 'fill';

/** Options the edge path applies to the media it writes. */
const HONOURED = [
  'width', 'height', 'videoBitrate', 'videoCodec', 'audioBitrate', 'audioSampleRate', 'audioChannels',
] as const satisfies readonly (keyof ConversionOptions)[];

/**
 * Options about the picture, document, data or archive formats, and plain request plumbing. They say nothing
 * about an audio or video file, so setting one (the queue sets several on every item) asks the edge for nothing.
 * `fit` belongs here and is checked against a resize separately.
 */
const NOT_ABOUT_MEDIA = [
  'quality', 'fit', 'stripMetadata', 'background', 'dpi', 'layout', 'colorDepth', 'colors', 'palette', 'dither',
  'quantizer', 'ditherMethod', 'useWebGpu', 'gpuAcceleration', 'falseColorSuppression', 'allowEmbeddedPreview',
  'demosaicMethod', 'kelvin', 'tint', 'highlightReconstruction', 'targetColorSpace', 'outputDepth', 'gainMap',
  'uSamples', 'vSamples', 'allowOpenMesh', 'smoothingAngleDeg', 'outputUnit', 'page', 'pages', 'multiPageOutput',
  'pageCount', 'password', 'orientation', 'preserveTables', 'ocrEnabled', 'ocrLanguage', 'ocrMode',
  'ocrDensityThreshold', 'clientEdgeMode', 'margin', 'validateMagicBytes', 'delimiter', 'encoding', 'bom',
  'escapeFormulas', 'hasHeaders', 'sheetMode', 'sheetIndex', 'range', 'lineEnding', 'recalculate',
  'compressionLevel', 'archiveCoder', 'splitVolumeBytes', 'zstdDict', 'archiveParts', 'useNative7z', 'solid',
  'collisionPolicy', 'entries', 'skipLinks', 'repair', 'timeoutMs', 'signal', 'disableNativeEngine',
  'pdfStandard', 'pdfVersion', 'libreOfficeFilter', 'losslessImageCompression',
  'imageDpi', 'jpegQuality', 'watermark', 'protect', 'pdfa',
] as const satisfies readonly (keyof ConversionOptions)[];

/** Media options the edge worker has no way to apply. */
const NOT_APPLIED = [
  'audio', 'audioVolume', 'video', 'trim', 'subtitles', 'thumbnail', 'packaging', 'videoResolution', 'videoFps',
  'duration', 'useFfmpeg', 'fastStart', 'disableHwaccel',
] as const satisfies readonly (keyof ConversionOptions)[];

type Classified = (typeof HONOURED)[number] | (typeof NOT_ABOUT_MEDIA)[number] | (typeof NOT_APPLIED)[number];
/** Type-checking fails here, naming the key, when ConversionOptions gains a key none of the lists above holds. */
const EVERY_OPTION_IS_CLASSIFIED: [Exclude<keyof ConversionOptions, Classified>] extends [never] ? true : never = true;
void EVERY_OPTION_IS_CLASSIFIED;

const HONOURED_OPTIONS: ReadonlySet<string> = new Set(HONOURED);
const NOT_ABOUT_MEDIA_OPTIONS: ReadonlySet<string> = new Set(NOT_ABOUT_MEDIA);

function refuse(message: string): EdgeUnsupportedError {
  return new EdgeUnsupportedError(`The edge worker ${message}; the server engine converts it.`);
}

function describeValue(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

function invalidValue(name: string, value: unknown): EdgeUnsupportedError {
  return refuse(`cannot use ${name} ${describeValue(value)}`);
}

/** An option is asked for when it is set; `false` is the off state of a flag and `null` is as good as unset. */
function isRequested(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false;
}

function assertEveryRequestedOptionIsApplied(options: ConversionOptions): void {
  const refused = Object.entries(options)
    .filter(([name, value]) => isRequested(value) && !HONOURED_OPTIONS.has(name) && !NOT_ABOUT_MEDIA_OPTIONS.has(name))
    .map(([name]) => name)
    .sort((a, b) => a.localeCompare(b));
  if (refused.length === 1) throw refuse(`does not apply the ${refused[0]} option`);
  if (refused.length > 1) throw refuse(`does not apply the ${refused.join(', ')} options`);
}

function positiveInteger(name: string, value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw invalidValue(name, value);
  return value;
}

function positiveNumber(name: string, value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw invalidValue(name, value);
  return value;
}

/** Bits per second of an `audioBitrate` such as `128k`; anything else throws instead of becoming NaN. */
function audioBitrateBps(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const match = typeof value === 'string' ? AUDIO_BITRATE_PATTERN.exec(value) : null;
  if (!match) throw invalidValue('audioBitrate', value);
  return Number(match[1]) * KBPS;
}

/**
 * Channel count a request names. Only mono and stereo are channel counts the edge can state; a request that
 * names nothing leaves the count to the source audio, and any other layout is not expressible here.
 */
function requestedAudioChannels(channels: ConversionOptions['audioChannels']): number | undefined {
  if (channels === undefined) return undefined;
  if (channels === 'mono') return MONO_CHANNELS;
  if (channels === 'stereo') return STEREO_CHANNELS;
  throw new EdgeUnsupportedError(`The edge worker cannot write ${channels} audio.`);
}

/** A resize stretches the picture; a request for another fit would be answered with a different picture. */
function assertResizeFitIsStretch(options: ConversionOptions): void {
  const resizes = options.width !== undefined || options.height !== undefined;
  if (resizes && options.fit !== undefined && options.fit !== STRETCH_FIT) {
    throw refuse(`stretches a resized picture and does not apply fit ${JSON.stringify(options.fit)}`);
  }
}

/** The worker's options for a request, or EdgeUnsupportedError when the request asks for more than the edge applies. */
export function toWorkerOptions(options: ConversionOptions): WebCodecsConversionRequest['options'] {
  assertEveryRequestedOptionIsApplied(options);
  assertResizeFitIsStretch(options);
  return {
    width: positiveInteger('width', options.width),
    height: positiveInteger('height', options.height),
    videoBitrate: positiveNumber('videoBitrate', options.videoBitrate),
    audioBitrate: audioBitrateBps(options.audioBitrate),
    audioSampleRate: positiveNumber('audioSampleRate', options.audioSampleRate),
    audioChannels: requestedAudioChannels(options.audioChannels),
    codec: options.videoCodec,
  };
}
