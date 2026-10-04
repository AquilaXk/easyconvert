import type { ConversionOptions, ResourceClass } from '../types';
import { getFormatByExtension } from '../registry';

export type { ResourceClass };
export const RESOURCE_CLASSES: readonly ResourceClass[] = ['light', 'cpu', 'memory', 'gpu'] as const;

const VIDEO_FORMATS: ReadonlySet<string> = new Set([
  'mp4',
  'webm',
  'mkv',
  'avi',
  'mov',
  'wmv',
  'flv',
  'm4v',
  '3gp',
  'ts',
  'm2ts',
  'vob',
  'ogv',
]);

const CAD_FORMATS: ReadonlySet<string> = new Set([
  'step',
  'stp',
  'iges',
  'igs',
  'dxf',
  'dwg',
  'brep',
  'stl',
  'obj',
  'ply',
  'gltf',
  'glb',
  'fbx',
  '3ds',
]);

const RAW_CAMERA_FORMATS: ReadonlySet<string> = new Set([
  'dng',
  'cr2',
  'cr3',
  'nef',
  'arw',
  'rw2',
  'orf',
  'pef',
  'raf',
  'raw',
]);

const HEAVY_DOC_FORMATS: ReadonlySet<string> = new Set([
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'odt',
  'ods',
  'odp',
  'rtf',
  'pdf',
  'hwp',
  'hwpx',
  'epub',
]);

const ARCHIVE_FORMATS: ReadonlySet<string> = new Set([
  'zip',
  '7z',
  'tar',
  'gz',
  'tgz',
  'bz2',
  'xz',
  'rar',
  'zst',
  'zstd',
]);

const AUDIO_FORMATS: ReadonlySet<string> = new Set([
  'mp3',
  'wav',
  'aac',
  'ogg',
  'flac',
  'm4a',
  'wma',
  'opus',
  'aiff',
]);

const MEMORY_SIZE_THRESHOLD_BYTES = 50 * 1024 * 1024; // 50 MiB
const CPU_SIZE_THRESHOLD_BYTES = 10 * 1024 * 1024; // 10 MiB

/**
 * Resolves the target resource class ('light' | 'cpu' | 'memory' | 'gpu') for a conversion job
 * based on input/target formats, payload size, and conversion options.
 */
export function resolveResourceClass(
  sourceFormat: string,
  targetFormat: string,
  sizeBytes?: number,
  options?: ConversionOptions
): ResourceClass {
  const src = (sourceFormat || '').trim().toLowerCase().replace(/^\./, '');
  const tgt = (targetFormat || '').trim().toLowerCase().replace(/^\./, '');

  // 1. GPU Acceleration or Heavy Video Transcoding
  if (
    options?.useWebGpu ||
    options?.gpuAcceleration ||
    (options as Record<string, unknown> | undefined)?.hwaccel
  ) {
    return 'gpu';
  }
  if (VIDEO_FORMATS.has(src) || VIDEO_FORMATS.has(tgt)) {
    return 'gpu';
  }

  // 2. High-Memory Operations (OCR, CAD/B-Rep, RAW Camera Sensors, or Large Payloads > 50MB)
  if (options?.ocrEnabled || (typeof options?.dpi === 'number' && options.dpi >= 300)) {
    return 'memory';
  }
  if (CAD_FORMATS.has(src) || CAD_FORMATS.has(tgt)) {
    return 'memory';
  }
  if (RAW_CAMERA_FORMATS.has(src)) {
    return 'memory';
  }
  if (sizeBytes !== undefined && sizeBytes > MEMORY_SIZE_THRESHOLD_BYTES) {
    return 'memory';
  }

  // 3. CPU-Bound Heavy Processing (LibreOffice Office/Docs, Archives, Audio codecs, or Medium Payloads > 10MB)
  if (HEAVY_DOC_FORMATS.has(src) || HEAVY_DOC_FORMATS.has(tgt)) {
    return 'cpu';
  }
  if (ARCHIVE_FORMATS.has(src) || ARCHIVE_FORMATS.has(tgt)) {
    return 'cpu';
  }
  if (AUDIO_FORMATS.has(src) || AUDIO_FORMATS.has(tgt)) {
    return 'cpu';
  }
  if (sizeBytes !== undefined && sizeBytes > CPU_SIZE_THRESHOLD_BYTES) {
    return 'cpu';
  }

  // 4. Registry-level explicit resourceClass override
  const srcDef = getFormatByExtension(src);
  const tgtDef = getFormatByExtension(tgt);
  if (tgtDef?.resourceClass) {
    return tgtDef.resourceClass;
  }
  if (srcDef?.resourceClass) {
    return srcDef.resourceClass;
  }

  // 5. Default lightweight conversion (text, data, markdown, fonts, small web images)
  return 'light';
}

/**
 * Returns canonical queue name for a given resource class.
 */
export function resolveQueueName(resourceClass: ResourceClass): string {
  return `easyconvert-jobs:${resourceClass}`;
}

/**
 * Maps account tier ('enterprise' | 'pro' | 'free') to scheduling priority.
 * BullMQ priority: 1 (highest) to 3 (lowest).
 */
export function tierToPriority(tier?: string): number {
  const normalized = (tier || '').toLowerCase().trim();
  switch (normalized) {
    case 'enterprise':
      return 1;
    case 'pro':
      return 2;
    case 'free':
    default:
      return 3;
  }
}

/**
 * Resolves the resource class for a graph node ('light' | 'cpu' | 'memory' | 'gpu').
 */
export function resolveNodeResourceClass(node: any): ResourceClass {
  if (!node || !node.op) return 'light';
  switch (node.op) {
    case 'import.upload':
    case 'import.url':
    case 'export.url':
    case 'export.internal':
      return 'light';
    case 'ocr':
      return 'memory';
    case 'archive.create':
    case 'archive.extract':
      return 'cpu';
    case 'convert':
      return resolveResourceClass('bin', node.targetFormat || 'bin', 0, node.options);
    case 'optimize':
      return resolveResourceClass('bin', 'bin', 0, node.options);
    default:
      return 'light';
  }
}
