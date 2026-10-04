/**
 * Tier Capability Router & Runtime Probing Engine
 *
 * Implements 5-Tier Adaptive Edge routing across:
 * - Level 0: Pure Isomorphic Fast-Path (0 MB Wasm, pure TS/Data/CAD/Audio/Canvas)
 * - Level 1: WebCodecs Hardware Media (GPU/VPU)
 * - Level 2: Zero-COOP SIMD Wasm (Wasm-vips, Tesseract OCR, pdf-lib)
 * - Level 3: OPFS Streaming VFS (100MB+ ~ GB large files)
 * - Level 4: Serverless API Fallback (Cloud Zero-Retention)
 */

import { ConversionOptions } from '../types';
import { isPureDataConvertible } from './pure/pure-data';
import { isPureCadConvertible } from './pure/pure-cad';
import { isPureAudioConvertible } from './pure/pure-audio';
import { isPureCanvasConvertible, isCanvasSupported } from './pure/pure-canvas';

export type ConversionTier = 'L0' | 'L1' | 'L1A' | 'L2' | 'L3' | 'L4';

export interface WebGpuCapabilities {
  hasWebGpu: boolean;
  adapterInfo?: {
    vendor?: string;
    architecture?: string;
    device?: string;
    description?: string;
  };
  limits?: {
    maxComputeWorkgroupSizeX?: number;
    maxComputeWorkgroupSizeY?: number;
    maxComputeWorkgroupSizeZ?: number;
    maxComputeInvocationsPerWorkgroup?: number;
    maxBufferSize?: number;
    maxStorageBufferBindingSize?: number;
  };
  features?: string[];
  supportedShaderFormats?: string[];
}

export interface EdgeCapabilities {
  hasWebCodecsVideo: boolean;
  hasWebCodecsAudio: boolean;
  hasOpfsSyncAccess: boolean;
  hasWasmSimd: boolean;
  hasCanvas: boolean;
  isCrossOriginIsolated: boolean;
  hardwareConcurrency: number;
  supportedVideoEncoders: string[];
  supportedAudioEncoders: string[];
  hasWebGpu?: boolean;
  webGpu?: WebGpuCapabilities;
  deviceMemory?: number;
}

export interface TierResolution {
  tier: ConversionTier;
  tierName: string;
  isClientEdge: boolean;
  reason: string;
}

/**
 * Checks browser WebAssembly SIMD-128 bytecode execution support.
 */
export function checkWasmSimdSupport(): boolean {
  if (typeof WebAssembly === 'undefined' || typeof WebAssembly.validate !== 'function') {
    return false;
  }
  try {
    // 0x41 0x00 = i32.const 0, 0xfd 0x11 = i32x4.splat
    return WebAssembly.validate(
      new Uint8Array([
        0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x05, 0x01, 0x60,
        0x00, 0x01, 0x7b, 0x03, 0x02, 0x01, 0x00, 0x0a, 0x08, 0x01, 0x06, 0x00,
        0x41, 0x00, 0xfd, 0x11, 0x0b,
      ])
    );
  } catch {
    return false;
  }
}

/**
 * Checks Origin Private File System (OPFS) support.
 */
export function checkOpfsSupport(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'storage' in navigator &&
    typeof navigator.storage?.getDirectory === 'function'
  );
}

/**
 * Probes browser WebCodecs hardware encoder/decoder capabilities.
 */
export async function checkWebCodecsSupport(): Promise<{
  video: boolean;
  audio: boolean;
  supportedVideoEncoders: string[];
  supportedAudioEncoders: string[];
}> {
  const video =
    typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined';
  const audio =
    typeof AudioEncoder !== 'undefined' && typeof AudioDecoder !== 'undefined';
  const supportedVideoEncoders: string[] = [];
  const supportedAudioEncoders: string[] = [];

  if (video && typeof VideoEncoder.isConfigSupported === 'function') {
    const candidates = ['avc1.42001e', 'avc1.4d002a', 'vp09.00.10.08', 'av01.0.04M.08'];
    for (const codec of candidates) {
      try {
        const res = await VideoEncoder.isConfigSupported({
          codec,
          width: 1280,
          height: 720,
          bitrate: 1_000_000,
          framerate: 30,
        });
        if (res.supported) supportedVideoEncoders.push(codec);
      } catch {
        // Ignored in unsupported test/browser environments
      }
    }
  }

  if (audio && typeof AudioEncoder.isConfigSupported === 'function') {
    const candidates = ['mp4a.40.2', 'opus'];
    for (const codec of candidates) {
      try {
        const res = await AudioEncoder.isConfigSupported({
          codec,
          sampleRate: 44100,
          numberOfChannels: 2,
          bitrate: 128_000,
        });
        if (res.supported) supportedAudioEncoders.push(codec);
      } catch {
        // Ignored
      }
    }
  }

  return { video, audio, supportedVideoEncoders, supportedAudioEncoders };
}

/**
 * Checks browser WebGPU API existence.
 */
export function checkWebGpuSupport(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'gpu' in navigator &&
    Boolean((navigator as any).gpu)
  );
}

/**
 * Probes browser WebGPU adapter limits, features, and compute shader capabilities.
 */
export async function probeWebGpuCapabilities(): Promise<WebGpuCapabilities> {
  if (!checkWebGpuSupport()) {
    return { hasWebGpu: false };
  }

  try {
    const gpu = (navigator as any).gpu;
    if (typeof gpu.requestAdapter !== 'function') {
      return { hasWebGpu: false };
    }

    const adapter = await gpu.requestAdapter({
      powerPreference: 'high-performance',
    });

    if (!adapter) {
      return { hasWebGpu: false };
    }

    const adapterInfo =
      typeof adapter.requestAdapterInfo === 'function'
        ? await adapter.requestAdapterInfo().catch(() => undefined)
        : (adapter.info ?? undefined);

    const limits = adapter.limits
      ? {
          maxComputeWorkgroupSizeX: adapter.limits.maxComputeWorkgroupSizeX,
          maxComputeWorkgroupSizeY: adapter.limits.maxComputeWorkgroupSizeY,
          maxComputeWorkgroupSizeZ: adapter.limits.maxComputeWorkgroupSizeZ,
          maxComputeInvocationsPerWorkgroup: adapter.limits.maxComputeInvocationsPerWorkgroup,
          maxBufferSize: adapter.limits.maxBufferSize,
          maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
        }
      : undefined;

    const features: string[] = [];
    if (adapter.features) {
      if (typeof (adapter.features as any)[Symbol.iterator] === 'function') {
        for (const f of adapter.features) {
          features.push(f);
        }
      } else if (typeof (adapter.features as any).forEach === 'function') {
        (adapter.features as any).forEach((f: string) => features.push(f));
      }
    }

    return {
      hasWebGpu: true,
      adapterInfo: adapterInfo
        ? {
            vendor: adapterInfo.vendor,
            architecture: adapterInfo.architecture,
            device: adapterInfo.device,
            description: adapterInfo.description,
          }
        : undefined,
      limits,
      features,
      supportedShaderFormats: ['wgsl'],
    };
  } catch {
    return { hasWebGpu: false };
  }
}

/**
 * Probes complete runtime capabilities of current environment.
 */
export async function probeEdgeCapabilities(): Promise<EdgeCapabilities> {
  const hasWasmSimd = checkWasmSimdSupport();
  const hasOpfsSyncAccess = checkOpfsSupport();
  const hasCanvas = isCanvasSupported();
  const isCrossOriginIsolated =
    typeof crossOriginIsolated !== 'undefined' ? crossOriginIsolated : false;
  const hardwareConcurrency =
    typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
  const deviceMemory =
    typeof navigator !== 'undefined' ? (navigator as any).deviceMemory : undefined;

  const [webcodecs, webGpu] = await Promise.all([
    checkWebCodecsSupport(),
    probeWebGpuCapabilities(),
  ]);

  return {
    hasWebCodecsVideo: webcodecs.video,
    hasWebCodecsAudio: webcodecs.audio,
    hasOpfsSyncAccess,
    hasWasmSimd,
    hasCanvas,
    isCrossOriginIsolated,
    hardwareConcurrency,
    deviceMemory,
    hasWebGpu: webGpu.hasWebGpu,
    webGpu,
    supportedVideoEncoders: webcodecs.supportedVideoEncoders,
    supportedAudioEncoders: webcodecs.supportedAudioEncoders,
  };
}

/**
 * Whitelist of supported streaming transformations in OPFS worker.
 */
export const SUPPORTED_OPFS_STREAMING_CONVERSIONS = new Set<string>([
  'pcm:pcm_be',
  'pcm_be:pcm',
  'pcm_le:pcm_be',
  'pcm_be:pcm_le',
  'pcm:pcm_u8',
  'pcm:u8',
  'wav:pcm_u8',
  'wav:u8',
  'wav:pcm',
  'pcm:adpcm',
  'wav:adpcm',
  'adpcm:pcm',
  'tar:tar_gz',
  'tar:gz',
  'gz:tar',
  'tar_gz:tar',
  'csv:tsv',
  'csv:tab',
  'tsv:csv',
  'tab:csv',
  'rgba:grayscale',
  'rgba:gray',
  'raw:grayscale',
  'raw:gray',
]);

/**
 * Validates whether the given conversion pair is supported by L3 OPFS streaming pipeline.
 */
export function isOpfsStreamingSupported(
  sourceFormat: string,
  targetFormat: string,
  options?: ConversionOptions & { allowPassThrough?: boolean }
): boolean {
  const src = sourceFormat.toLowerCase();
  const tgt = targetFormat.toLowerCase();
  if (options?.allowPassThrough && src === tgt) {
    return true;
  }
  return SUPPORTED_OPFS_STREAMING_CONVERSIONS.has(`${src}:${tgt}`);
}

/**
 * Section 7 MicroVM Payload Offload Budgets
 */
export const MICROVM_PAYLOAD_BUDGETS = {
  OFFICE_MAX_BYTES: 30 * 1024 * 1024, // 30 MB
  OCR_MAX_PAGES: 50,                  // 50 pages
  RAW_MAX_BYTES: 35 * 1024 * 1024,    // 35 MB
  CAD_MAX_BYTES: 15 * 1024 * 1024,    // 15 MB
  VIDEO_MAX_BYTES: 100 * 1024 * 1024, // 100 MB
  LOW_SPEC_CONCURRENCY_THRESHOLD: 2,  // <= 2 CPU cores
  LOW_SPEC_MEMORY_GB_THRESHOLD: 4,    // < 4 GB device memory
  LOW_SPEC_PAYLOAD_MAX_BYTES: 5 * 1024 * 1024, // 5 MB threshold on low-spec devices
} as const;

export interface MicroVMOffloadEvaluation {
  shouldOffload: boolean;
  reason?: string;
  category: 'office' | 'ocr' | 'raw' | 'cad' | 'video' | 'low-spec' | 'none';
  budgetLimit?: number;
}

/**
 * Parses and computes the total count of distinct requested pages from a range string.
 * Handles single pages ("5"), ranges ("1-10"), comma-separated lists ("1,3,5"),
 * and overlapping intervals ("1-10, 5-15" => 15 pages).
 */
export function parsePageRangeCount(pagesStr: string): number | undefined {
  if (!pagesStr || typeof pagesStr !== 'string') return undefined;

  const intervals: Array<{ start: number; end: number }> = [];
  const tokens = pagesStr.split(',');

  for (const token of tokens) {
    const trimmed = token.trim();
    if (!trimmed) continue;

    if (trimmed.includes('-')) {
      const parts = trimmed.split('-');
      if (parts.length === 2) {
        const p1 = parseInt(parts[0].trim(), 10);
        const p2 = parseInt(parts[1].trim(), 10);
        if (!isNaN(p1) && !isNaN(p2) && p1 > 0 && p2 > 0) {
          intervals.push({
            start: Math.min(p1, p2),
            end: Math.max(p1, p2),
          });
        }
      }
    } else {
      const p = parseInt(trimmed, 10);
      if (!isNaN(p) && p > 0) {
        intervals.push({ start: p, end: p });
      }
    }
  }

  if (intervals.length === 0) return undefined;

  // Sort intervals by start ascending
  intervals.sort((a, b) => a.start - b.start);

  // Merge overlapping or contiguous intervals
  const merged: Array<{ start: number; end: number }> = [];
  let current = { ...intervals[0] };

  for (let i = 1; i < intervals.length; i++) {
    const next = intervals[i];
    if (next.start <= current.end + 1) {
      current.end = Math.max(current.end, next.end);
    } else {
      merged.push(current);
      current = { ...next };
    }
  }
  merged.push(current);

  // Calculate total distinct pages
  let total = 0;
  for (const range of merged) {
    total += range.end - range.start + 1;
  }

  return total > 0 ? total : undefined;
}

/**
 * Evaluates whether a workload exceeds client-edge memory/compute budgets
 * and must be offloaded to an isolated serverless MicroVM.
 */
export function evaluateMicroVMOffload(
  sourceFormat: string,
  fileSize: number,
  options: ConversionOptions = {},
  capabilities?: Partial<EdgeCapabilities>
): MicroVMOffloadEvaluation {
  const src = (sourceFormat || '').toLowerCase();

  // 1. OCR page count budget (> 50 pages)
  const isOcr = Boolean(options.ocrEnabled || src === 'ocr');
  let pageCount = options.pageCount;
  if (pageCount === undefined && typeof options.pages === 'string') {
    pageCount = parsePageRangeCount(options.pages);
  }
  if (isOcr && pageCount !== undefined && pageCount > MICROVM_PAYLOAD_BUDGETS.OCR_MAX_PAGES) {
    return {
      shouldOffload: true,
      category: 'ocr',
      reason: `OCR document exceeds client edge budget of ${MICROVM_PAYLOAD_BUDGETS.OCR_MAX_PAGES} pages (${pageCount} pages requested)`,
      budgetLimit: MICROVM_PAYLOAD_BUDGETS.OCR_MAX_PAGES,
    };
  }

  // 2. Office document budget (> 30 MB)
  const OFFICE_FORMATS = new Set([
    'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'odt', 'ods', 'odp', 'rtf', 'pdf',
    'hwp', 'hwpx', 'wps', 'et', 'dps', 'pages', 'numbers', 'key',
  ]);
  if (OFFICE_FORMATS.has(src) && fileSize > MICROVM_PAYLOAD_BUDGETS.OFFICE_MAX_BYTES) {
    return {
      shouldOffload: true,
      category: 'office',
      reason: `Office payload (${(fileSize / (1024 * 1024)).toFixed(1)}MB) exceeds client edge budget of 30MB`,
      budgetLimit: MICROVM_PAYLOAD_BUDGETS.OFFICE_MAX_BYTES,
    };
  }

  // 3. RAW camera budget (> 35 MB)
  const RAW_FORMATS = new Set([
    'cr2', 'cr3', 'nef', 'arw', 'dng', 'raf', 'rw2', 'orf', 'pef', 'raw',
    'sr2', 'srf', 'kdc', 'mrw', 'x3f', 'erf',
  ]);
  if (RAW_FORMATS.has(src) && fileSize > MICROVM_PAYLOAD_BUDGETS.RAW_MAX_BYTES) {
    return {
      shouldOffload: true,
      category: 'raw',
      reason: `RAW camera image payload (${(fileSize / (1024 * 1024)).toFixed(1)}MB) exceeds client edge budget of 35MB`,
      budgetLimit: MICROVM_PAYLOAD_BUDGETS.RAW_MAX_BYTES,
    };
  }

  // 4. CAD model budget (> 15 MB)
  const CAD_FORMATS = new Set([
    'step', 'stp', 'iges', 'igs', 'brep', 'dxf', 'dwg', 'stl', 'obj', 'ply', '3ds', 'dae', 'ifc',
  ]);
  if (CAD_FORMATS.has(src) && fileSize > MICROVM_PAYLOAD_BUDGETS.CAD_MAX_BYTES) {
    return {
      shouldOffload: true,
      category: 'cad',
      reason: `CAD geometry payload (${(fileSize / (1024 * 1024)).toFixed(1)}MB) exceeds client edge budget of 15MB`,
      budgetLimit: MICROVM_PAYLOAD_BUDGETS.CAD_MAX_BYTES,
    };
  }

  // 5. Video budget (> 100 MB)
  const VIDEO_FORMATS = new Set([
    'mp4', 'mkv', 'avi', 'mov', 'webm', 'flv', 'wmv', 'm4v', '3gp', 'ts', 'ogv', 'vob', 'mts', 'm2ts',
  ]);
  if (VIDEO_FORMATS.has(src) && fileSize > MICROVM_PAYLOAD_BUDGETS.VIDEO_MAX_BYTES) {
    return {
      shouldOffload: true,
      category: 'video',
      reason: `Video payload (${(fileSize / (1024 * 1024)).toFixed(1)}MB) exceeds client edge budget of 100MB`,
      budgetLimit: MICROVM_PAYLOAD_BUDGETS.VIDEO_MAX_BYTES,
    };
  }

  // 6. Low-spec device heuristics
  const cores =
    capabilities?.hardwareConcurrency ??
    (typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : undefined);
  const memoryGb =
    capabilities?.deviceMemory ??
    (typeof navigator !== 'undefined' ? (navigator as any).deviceMemory : undefined);

  const isLowSpec =
    (cores !== undefined && cores <= MICROVM_PAYLOAD_BUDGETS.LOW_SPEC_CONCURRENCY_THRESHOLD) ||
    (memoryGb !== undefined && memoryGb < MICROVM_PAYLOAD_BUDGETS.LOW_SPEC_MEMORY_GB_THRESHOLD);

  if (isLowSpec && fileSize > MICROVM_PAYLOAD_BUDGETS.LOW_SPEC_PAYLOAD_MAX_BYTES) {
    return {
      shouldOffload: true,
      category: 'low-spec',
      reason: `Low-spec client device (${cores ?? 'unknown'} cores, ${memoryGb ?? 'unknown'}GB RAM) offloading payload to isolated MicroVM to prevent tab OOM crash`,
      budgetLimit: MICROVM_PAYLOAD_BUDGETS.LOW_SPEC_PAYLOAD_MAX_BYTES,
    };
  }

  return {
    shouldOffload: false,
    category: 'none',
  };
}

/**
 * Checks whether the given conversion task should be offloaded to MicroVM.
 */
export function shouldOffloadToMicroVM(
  sourceFormat: string,
  fileSize: number,
  options: ConversionOptions = {},
  capabilities?: Partial<EdgeCapabilities>
): boolean {
  return evaluateMicroVMOffload(sourceFormat, fileSize, options, capabilities).shouldOffload;
}

/**
 * Resolves the optimal conversion tier given format pair, file size, options, and capabilities.
 */
export function resolveConversionTier(
  sourceFormat: string,
  targetFormat: string,
  fileSize: number,
  options: ConversionOptions = {},
  capabilities?: Partial<EdgeCapabilities>
): TierResolution {
  const src = sourceFormat.toLowerCase();
  const tgt = targetFormat.toLowerCase();

  // 1. Explicit user opt-out to server
  if (options.clientEdgeMode === false) {
    return {
      tier: 'L4',
      tierName: 'Cloud (Zero-Retention)',
      isClientEdge: false,
      reason: 'Client edge mode disabled by user options',
    };
  }

  // 2. High-volume streaming file (> 100 MB)
  const isLargeFile = fileSize > 100 * 1024 * 1024;
  const opfsAvailable = capabilities?.hasOpfsSyncAccess ?? checkOpfsSupport();
  const isOpfsEligible = isLargeFile && opfsAvailable && isOpfsStreamingSupported(src, tgt, options);

  if (isLargeFile) {
    if (isOpfsEligible) {
      return {
        tier: 'L3',
        tierName: 'Edge L3 (OPFS Stream)',
        isClientEdge: true,
        reason: 'Large file stream routed to OPFS VFS memory-bounded pipeline',
      };
    }
    return {
      tier: 'L4',
      tierName: 'Cloud (Zero-Retention)',
      isClientEdge: false,
      reason: opfsAvailable
        ? 'Format conversion requires cloud serverless streaming engine'
        : 'Large file exceeds client RAM and OPFS is unavailable in this browser',
    };
  }

  // 3. Evaluate MicroVM payload offload budgets (Section 7)
  const offloadEval = evaluateMicroVMOffload(src, fileSize, options, capabilities);
  if (offloadEval.shouldOffload) {
    return {
      tier: 'L4',
      tierName: 'Cloud (Zero-Retention)',
      isClientEdge: false,
      reason: offloadEval.reason || 'Payload exceeds edge budget, offloading to serverless MicroVM',
    };
  }

  // Helper flags for image transformations & filters
  const isImageSrc = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tiff', 'avif'].includes(src);
  const isImageTgt = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tiff', 'avif'].includes(tgt);
  const isWasmFilterRequested = isImageSrc && isImageTgt && (
    options.colorDepth !== undefined ||
    options.palette === true ||
    options.dither === true ||
    options.ditherMethod !== undefined ||
    Boolean(options.quantizer) ||
    (options as any).grayscale === true ||
    (options as any).invert === true ||
    (options as any).brightnessDelta !== undefined ||
    options.colors !== undefined
  );

  const hasWebGpu =
    capabilities?.hasWebGpu !== undefined
      ? Boolean(capabilities.hasWebGpu || capabilities.webGpu?.hasWebGpu)
      : (capabilities?.webGpu?.hasWebGpu ?? checkWebGpuSupport());

  const isWebGpuRequested = Boolean(options.useWebGpu || options.gpuAcceleration);
  const isWebGpuComputeEligible =
    (isWebGpuRequested || (isWasmFilterRequested && options.quantizer === 'oklab')) &&
    hasWebGpu;

  // 4. Level 0: Pure Isomorphic Fast-Path (0 MB Wasm, instant execution)
  if (isPureDataConvertible(src, tgt)) {
    return {
      tier: 'L0',
      tierName: 'Edge L0 (Instant)',
      isClientEdge: true,
      reason: 'Pure isomorphic structured data conversion (CSV/TSV/JSON/YAML)',
    };
  }

  if (isPureCadConvertible(src, tgt)) {
    return {
      tier: 'L0',
      tierName: 'Edge L0 (Instant)',
      isClientEdge: true,
      reason: 'Pure mathematical CAD B-spline tessellation (STEP/IGES to STL/OBJ)',
    };
  }

  if (isPureAudioConvertible(src, tgt)) {
    return {
      tier: 'L0',
      tierName: 'Edge L0 (Instant)',
      isClientEdge: true,
      reason: 'Pure TypedArray WAV/PCM/MP3 audio encoding',
    };
  }

  const canvasAvailable = capabilities?.hasCanvas ?? isCanvasSupported();
  if (
    isPureCanvasConvertible(src, tgt) &&
    canvasAvailable &&
    !isWasmFilterRequested &&
    !isWebGpuRequested
  ) {
    return {
      tier: 'L0',
      tierName: 'Edge L0 (Instant)',
      isClientEdge: true,
      reason: 'Browser Canvas 2D rasterization (PNG/JPEG/WebP/BMP)',
    };
  }

  // 5. Level 1: WebCodecs Hardware Media
  const isVideoTarget = ['mp4', 'webm', 'mov'].includes(tgt);
  if (isVideoTarget && capabilities?.hasWebCodecsVideo) {
    return {
      tier: 'L1',
      tierName: 'Edge L1 (Hardware VPU)',
      isClientEdge: true,
      reason: 'WebCodecs GPU/VPU hardware-accelerated media pipeline',
    };
  }

  if (tgt === 'opus') {
    const supportsOpus =
      Boolean(capabilities?.hasWebCodecsAudio) &&
      (!capabilities?.supportedAudioEncoders ||
        capabilities.supportedAudioEncoders.includes('opus'));
    if (supportsOpus) {
      return {
        tier: 'L1',
        tierName: 'Edge L1 (Hardware VPU)',
        isClientEdge: true,
        reason: 'WebCodecs AudioEncoder hardware Opus pipeline',
      };
    }
    return {
      tier: 'L4',
      tierName: 'Cloud (Zero-Retention)',
      isClientEdge: false,
      reason: 'Opus encoding requires WebCodecs AudioEncoder or native cloud worker engine',
    };
  }

  if (tgt === 'aac' || tgt === 'm4a') {
    const supportsAac =
      Boolean(capabilities?.hasWebCodecsAudio) &&
      (!capabilities?.supportedAudioEncoders ||
        capabilities.supportedAudioEncoders.includes('mp4a.40.2'));
    if (supportsAac) {
      return {
        tier: 'L1',
        tierName: 'Edge L1 (Hardware VPU)',
        isClientEdge: true,
        reason: 'WebCodecs AudioEncoder hardware AAC pipeline',
      };
    }
  }

  if (tgt === 'ogg' || tgt === 'vorbis') {
    return {
      tier: 'L4',
      tierName: 'Cloud (Zero-Retention)',
      isClientEdge: false,
      reason: 'Ogg Vorbis encoding requires native FFmpeg cloud worker engine (Fail-Closed on edge)',
    };
  }

  // 6. Level 1A: WebGPU Compute Pipeline (with graceful cascade to L2 Wasm)
  if (isWebGpuComputeEligible) {
    return {
      tier: 'L1A',
      tierName: 'Edge L1A (WebGPU Compute)',
      isClientEdge: true,
      reason: 'WebGPU parallel compute shader execution pipeline',
    };
  }

  // 7. Level 2: Wasm SIMD OCR & Image Filter Pipeline (fallback cascade from L1A).
  // Edge OCR only produces a searchable PDF, so other OCR targets are not routed here.
  const isEdgeOcrRequested = Boolean(options.ocrEnabled) && tgt === 'pdf';
  if (isEdgeOcrRequested || src === 'pdf' || isWasmFilterRequested || isWebGpuRequested) {
    return {
      tier: 'L2',
      tierName: 'Edge L2 (SIMD Wasm)',
      isClientEdge: true,
      reason: isEdgeOcrRequested || src === 'pdf'
        ? 'Client Wasm OCR and PDF memory vector processing'
        : 'Wasm SIMD vector image processing pipeline',
    };
  }

  // 8. Level 4: Serverless API fallback (Fail-closed or Zero-Data Retention cloud)
  return {
    tier: 'L4',
    tierName: 'Cloud (Zero-Retention)',
    isClientEdge: false,
    reason: 'Format conversion requires cloud serverless engine',
  };
}
