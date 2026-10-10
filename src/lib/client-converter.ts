import { ConversionQueueItem } from './types';
import { tryProcessClientEdgeOcr } from './edge-ocr';
import { resolveConversionTier, resolveTierAfterEdgeFailure, checkOpfsSupport, ConversionTier } from './edge/tier-router';
import { isPureCadConvertible, convertPureCad } from './edge/pure/pure-cad';
import { isPureAudioConvertible, convertPureAudio } from './edge/pure/pure-audio';
import { isPureCanvasConvertible, convertPureCanvas, isCanvasSupported, encodeBmpFromImageData } from './edge/pure/pure-canvas';
import { OPFS_MAX_FILE_BYTES } from './edge/opfs/limits';
import { convertWithWebCodecs } from './edge/pipelines/webcodecs-pipeline';
import { canvasToBlob } from './edge/pipelines/canvas-blob';
import { assertEncodedBlob, BMP_MIME_TYPE, canvasMimeType } from './edge/canvas-encoding';
import { EdgeUnsupportedError } from './edge/workers/worker-errors';
import { requestedAudioChannels } from './edge/pipelines/webcodecs-options';
import { executeWasmTask } from './edge/pipelines/wasm-simd-pipeline';
import { deriveQuantizerLevels } from './edge/quantizer-levels';
import { streamConvertWithOpfs } from './edge/pipelines/opfs-streaming-pipeline';
import { executeServerlessCloudFallback } from './edge/pipelines/fallback-pipeline';
import {
  executeWebGpuCompute,
  isWebGpuComputeSupported,
  WebGpuComputeTask,
} from './edge/pipelines/webgpu-compute-pipeline';

/** The tier a conversion fell back from, and why that tier did not produce the result. */
export interface EdgeTierFallback {
  fallbackFrom: ConversionTier;
  escalationReason: string;
}

export interface ConvertItemCallbacks {
  onProgress: (progress: number) => void;
  onSuccess: (
    resultUrl: string,
    resultSize: number,
    edgeProcessed?: boolean,
    edgeTier?: string,
    fallback?: EdgeTierFallback
  ) => void;
  onError: (errorMessage: string) => void;
}

export interface ClientEdgeResult {
  resultUrl: string;
  resultSize: number;
  /** The tier that actually produced the result. */
  tier?: string;
  tierName?: string;
  /** Set when a higher tier failed first and this tier ran as its fallback. */
  fallbackFrom?: ConversionTier;
  escalationReason?: string;
}

/** Reason recorded when a tier returned no result without raising an error. */
const L1A_NO_RESULT_REASON = 'L1A returned no result';

/**
 * Raised when an edge tier failed and the conversion may escalate to the cloud tier (L4).
 * Carries the failed tier and its error so the cloud result can report why it ran.
 */
export class ClientEdgeEscalationError extends Error {
  readonly fallbackFrom: ConversionTier;

  constructor(fallbackFrom: ConversionTier, reason: string) {
    super(reason);
    this.name = 'ClientEdgeEscalationError';
    this.fallbackFrom = fallbackFrom;
  }
}

function describeEdgeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Returns dynamic maximum file size limit.
 * If browser supports OPFS, expands up to 2GB streaming limit; otherwise default 100MB.
 */
export function getEffectiveMaxFileSize(baseMax: number = 100 * 1024 * 1024): number {
  if (typeof window !== 'undefined' && checkOpfsSupport()) {
    return OPFS_MAX_FILE_BYTES; // 2 GB OPFS VFS ceiling
  }
  return baseMax;
}

/**
 * Attempts to process the conversion item directly in client edge memory (Tiers L0, L1, L2, L3).
 * Returns conversion result on success or null if server pipeline should be used.
 */
export async function tryProcessClientEdge(
  item: ConversionQueueItem,
  onProgress?: (progress: number) => void
): Promise<ClientEdgeResult | null> {
  // If user explicitly opted out of client-edge processing
  if (item.options.clientEdgeMode === false || typeof window === 'undefined') {
    return null;
  }

  const src = item.sourceFormat.toLowerCase();
  const tgt = item.targetFormat.toLowerCase();
  const resolution = resolveConversionTier(src, tgt, item.size, item.options);

  // 1. Level 0: Pure Isomorphic Fast-Paths (0 MB Wasm)
  if (resolution.tier === 'L0') {
    try {
      const l0Res = await processL0Conversion(item, src, tgt, onProgress);
      if (l0Res) return l0Res;
    } catch (err: unknown) {
      // The pure engine cannot convert this file (a layout it cannot mix, a mesh it cannot write): the router
      // names the server tier, which converts the original file. No edge result stands in for it.
      if (resolveTierAfterEdgeFailure('L0', err)) {
        throw new ClientEdgeEscalationError('L0', describeEdgeError(err));
      }
      throw err;
    }
  }

  // 2. Level 1: WebCodecs Hardware Media Pipeline (GPU/VPU)
  if (resolution.tier === 'L1') {
    try {
      const webcodecsRes = await convertWithWebCodecs(
        item.file,
        src,
        tgt,
        item.options,
        onProgress
      );
      return {
        resultUrl: webcodecsRes.url,
        resultSize: webcodecsRes.size,
        tier: 'L1',
        tierName: 'Edge L1 (Hardware VPU)',
      };
    } catch (err: unknown) {
      // The worker has no demuxer, decoder or encoder for this file: the router names the server tier, which
      // converts the original file. No edge result stands in for it.
      if (resolveTierAfterEdgeFailure('L1', err)) {
        throw new ClientEdgeEscalationError('L1', describeEdgeError(err));
      }
      // Adaptive cascade fallback: if WebCodecs hardware encoder fails,
      // cascade gracefully to L2 (Wasm) or L4 (Cloud Fallback)
      const l2Res = await processL2Conversion(item, src, tgt, onProgress);
      if (l2Res) return l2Res;
      return null;
    }
  }

  // 3. Level 1A: WebGPU Compute Pipeline
  if (resolution.tier === 'L1A') {
    let escalationReason = L1A_NO_RESULT_REASON;
    try {
      const l1aRes = await processL1AWebGpuConversion(item, src, tgt, onProgress);
      if (l1aRes) {
        return l1aRes;
      }
    } catch (err: unknown) {
      // Graceful cascade to L2 Wasm, keeping the reason
      escalationReason = describeEdgeError(err);
    }
    let l2Res: ClientEdgeResult | null;
    try {
      l2Res = await processL2Conversion(item, src, tgt, onProgress);
    } catch (err: unknown) {
      if (!(err instanceof ClientEdgeEscalationError)) {
        throw err;
      }
      // L2 failed too: escalate from L2, keeping both reasons in tier order
      throw new ClientEdgeEscalationError(
        err.fallbackFrom,
        `L1A: ${escalationReason}; ${err.fallbackFrom}: ${err.message}`
      );
    }
    if (l2Res) {
      return {
        ...l2Res,
        fallbackFrom: 'L1A',
        escalationReason,
      };
    }
  }

  // 4. Level 2: Client-side Edge OCR or SIMD Wasm Execution (Zero-Data Retention)
  if (resolution.tier === 'L2') {
    return await processL2Conversion(item, src, tgt, onProgress);
  }

  // 4. Level 3: OPFS Large File VFS Streaming Pipeline (100MB+ ~ 2GB)
  if (resolution.tier === 'L3') {
    try {
      const opfsRes = await streamConvertWithOpfs(
        item.file,
        src,
        tgt,
        item.options,
        onProgress
      );
      return {
        resultUrl: opfsRes.url,
        resultSize: opfsRes.size,
        tier: 'L3',
        tierName: 'Edge L3 (OPFS Stream)',
      };
    } catch (err: unknown) {
      // Escalate to the L4 cloud pipeline, keeping the reason
      throw new ClientEdgeEscalationError('L3', describeEdgeError(err));
    }
  }

  return null;
}

/** Source formats the filter tiers (L1A, L2) read through createImageBitmap. */
const EDGE_FILTER_IMAGE_SOURCES = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif']);
/** Targets whose format has no alpha channel: transparent pixels are flattened onto white, as the server does. */
const EDGE_OPAQUE_TARGETS = new Set(['jpg', 'jpeg', 'bmp']);
const EDGE_FILTER_DEFAULT_QUALITY = 90;
const PERCENT = 100;
const WHITE = '#FFFFFF';

/** An edge filter result is never resized: a requested size is the server's to apply. */
function assertNoResizeRequested(item: ConversionQueueItem): void {
  const { width, height, fit } = item.options;
  if (width !== undefined || height !== undefined || fit !== undefined) {
    throw new EdgeUnsupportedError('The edge filter pipeline does not resize the image (resize requested); the server converts it.');
  }
}

/** Throws EdgeUnsupportedError before any pixel work when the browser has no honest encoder for `tgt`. */
function assertEdgeImageTargetEncodable(tgt: string): void {
  if (tgt !== 'bmp') canvasMimeType(tgt);
}

interface FilterCanvasContext {
  fillStyle: unknown;
  globalCompositeOperation: unknown;
  fillRect(x: number, y: number, width: number, height: number): void;
  getImageData(x: number, y: number, width: number, height: number): { data: Uint8ClampedArray; width: number; height: number };
}

/**
 * Encodes the canvas as `tgt` and proves the bytes are that format. BMP is written by the TypedArray encoder (a canvas
 * cannot encode it); PNG, JPEG and WebP by the canvas, then checked against their file signature, so a browser that
 * answers a WebP request with a PNG, or with nothing, sends the file to the server instead of delivering a substitute.
 */
async function encodeEdgeImage(
  canvas: Parameters<typeof canvasToBlob>[0],
  ctx: FilterCanvasContext,
  width: number,
  height: number,
  tgt: string,
  quality: number
): Promise<Blob> {
  if (EDGE_OPAQUE_TARGETS.has(tgt)) {
    // Paint white behind the picture: a format without alpha would otherwise turn transparency black.
    ctx.globalCompositeOperation = 'destination-over';
    ctx.fillStyle = WHITE;
    ctx.fillRect(0, 0, width, height);
  }
  let blob: Blob;
  if (tgt === 'bmp') {
    const bytes = encodeBmpFromImageData(ctx.getImageData(0, 0, width, height));
    blob = new Blob([bytes as BlobPart], { type: BMP_MIME_TYPE });
  } else {
    blob = await canvasToBlob(canvas, canvasMimeType(tgt), quality);
  }
  await assertEncodedBlob(blob, tgt);
  return blob;
}

/**
 * Helper to process Level 0 (pure isomorphic) conversion: CAD tessellation, audio, canvas transcoding.
 */
async function processL0Conversion(
  item: ConversionQueueItem,
  src: string,
  tgt: string,
  onProgress?: (progress: number) => void
): Promise<ClientEdgeResult | null> {
  onProgress?.(25);

  // Structured data never resolves to L0: the router sends it to the server data engine.

  // Pure CAD tessellation (STEP, IGES -> STL, OBJ)
  if (isPureCadConvertible(src, tgt)) {
    const arrayBuf = await item.file.arrayBuffer();
    onProgress?.(50);
    const baseName = item.name.replace(/\.[^/.]+$/, '');
    const res = convertPureCad(new Uint8Array(arrayBuf), src, tgt, baseName);
    onProgress?.(95);
    const blob = new Blob([res.data as any], { type: res.mimeType });
    const resultUrl = URL.createObjectURL(blob);
    return {
      resultUrl,
      resultSize: blob.size,
      tier: 'L0',
      tierName: 'Edge L0 (Instant)',
    };
  }

  // Pure Audio conversion (WAV, PCM, MP3). The source layout and rate stay unless the request names others.
  if (isPureAudioConvertible(src, tgt)) {
    const arrayBuf = await item.file.arrayBuffer();
    onProgress?.(50);
    const res = convertPureAudio(new Uint8Array(arrayBuf), src, tgt, {
      sampleRate: item.options.audioSampleRate,
      channels: requestedAudioChannels(item.options.audioChannels),
      bitrate: item.options.audioBitrate,
    });
    onProgress?.(95);
    const blob = new Blob([res.data as any], { type: res.mimeType });
    const resultUrl = URL.createObjectURL(blob);
    return {
      resultUrl,
      resultSize: blob.size,
      tier: 'L0',
      tierName: 'Edge L0 (Instant)',
    };
  }

  // Pure Canvas 2D image transcoding (PNG, JPEG, WebP, BMP)
  if (isPureCanvasConvertible(src, tgt) && isCanvasSupported()) {
    onProgress?.(50);
    const res = await convertPureCanvas(item.file, src, tgt, {
      quality: item.options.quality,
      width: item.options.width,
      height: item.options.height,
      fit: item.options.fit,
    });
    onProgress?.(95);
    const blob = res.blob || new Blob([res.data as any], { type: res.mimeType });
    const resultUrl = URL.createObjectURL(blob);
    return {
      resultUrl,
      resultSize: blob.size,
      tier: 'L0',
      tierName: 'Edge L0 (Instant)',
    };
  }

  return null;
}

/**
 * The GPU task the options ask for, or null when they ask for no pixel change. Converting the format alone needs no
 * compute pass: choosing a default task here would change the picture (a grey one) that nobody asked to change.
 */
function selectWebGpuTask(item: ConversionQueueItem): WebGpuComputeTask | null {
  const options = item.options as ConversionQueueItem['options'] & {
    grayscale?: boolean;
    invert?: boolean;
    brightnessDelta?: number;
    blurRadius?: number;
    blurSigma?: number;
  };
  if (options.colorDepth === 1 || options.grayscale === true) {
    return { type: 'color-transform', options: { mode: 'grayscale' } };
  }
  if (options.invert === true) {
    return { type: 'color-transform', options: { mode: 'invert' } };
  }
  if (options.brightnessDelta !== undefined) {
    return { type: 'color-transform', options: { mode: 'brightness', param: options.brightnessDelta } };
  }
  if (options.blurRadius !== undefined) {
    return { type: 'gaussian-blur', options: { radius: options.blurRadius, sigma: options.blurSigma ?? 1.5 } };
  }
  if (options.palette === true || options.colorDepth !== undefined || options.colors !== undefined) {
    const maxColors = options.colors ?? (options.colorDepth ? 1 << options.colorDepth : 256);
    // The same levels the Wasm path derives, so both paths keep at most `maxColors` colours.
    const { r: rLevels, g: gLevels, b: bLevels } = deriveQuantizerLevels(maxColors);
    return { type: 'quantize', options: { rLevels, gLevels, bLevels } };
  }
  return null;
}

/**
 * Helper to process Level 1A (WebGPU Compute Shader) conversion.
 */
async function processL1AWebGpuConversion(
  item: ConversionQueueItem,
  src: string,
  tgt: string,
  onProgress?: (progress: number) => void
): Promise<ClientEdgeResult | null> {
  if (!EDGE_FILTER_IMAGE_SOURCES.has(src) || !isWebGpuComputeSupported()) {
    return null;
  }

  if (
    typeof createImageBitmap === 'undefined' ||
    (typeof OffscreenCanvas === 'undefined' && typeof document === 'undefined')
  ) {
    return null;
  }

  // No pixel task: the next tier re-encodes the picture as it is. Nothing is run on the GPU.
  const task = selectWebGpuTask(item);
  if (!task) {
    return null;
  }
  assertNoResizeRequested(item);
  assertEdgeImageTargetEncodable(tgt);

  onProgress?.(10);
  const bitmap = await createImageBitmap(item.file);
  const width = bitmap.width;
  const height = bitmap.height;

  let canvas: any;
  let ctx: any;
  if (typeof OffscreenCanvas !== 'undefined') {
    canvas = new OffscreenCanvas(width, height);
    ctx = canvas.getContext('2d');
  } else {
    canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    ctx = canvas.getContext('2d');
  }

  if (!ctx) {
    if (typeof bitmap.close === 'function') bitmap.close();
    return null;
  }

  ctx.drawImage(bitmap, 0, 0);
  if (typeof bitmap.close === 'function') bitmap.close();

  const imgData = ctx.getImageData(0, 0, width, height);
  const pixelBytes = new Uint8Array(
    imgData.data.buffer,
    imgData.data.byteOffset,
    imgData.data.byteLength
  );

  onProgress?.(30);

  onProgress?.(50);
  const computeRes = await executeWebGpuCompute({
    width,
    height,
    data: pixelBytes,
    task,
  });

  if (!computeRes) {
    return null;
  }

  onProgress?.(80);
  const processedClamped = new Uint8ClampedArray(computeRes.data);
  const newImgData = new ImageData(processedClamped as any, width, height);
  ctx.putImageData(newImgData, 0, 0);

  const resultBlob = await encodeEdgeImage(canvas, ctx, width, height, tgt, (item.options.quality || EDGE_FILTER_DEFAULT_QUALITY) / PERCENT);

  onProgress?.(100);
  const resultUrl = URL.createObjectURL(resultBlob);
  return {
    resultUrl,
    resultSize: resultBlob.size,
    tier: 'L1A',
    tierName: 'Edge L1A (WebGPU Compute)',
  };
}

/**
 * Helper to process Level 2 (SIMD Wasm & Edge OCR) conversion.
 */
async function processL2Conversion(
  item: ConversionQueueItem,
  src: string,
  tgt: string,
  onProgress?: (progress: number) => void
): Promise<ClientEdgeResult | null> {
  if (item.options.ocrEnabled || src === 'pdf') {
    let edgeOcrRes: Awaited<ReturnType<typeof tryProcessClientEdgeOcr>>;
    try {
      edgeOcrRes = await tryProcessClientEdgeOcr(item, onProgress);
    } catch (err: unknown) {
      // Edge OCR could not produce a searchable PDF: escalate to L4 and keep the reason
      throw new ClientEdgeEscalationError('L2', describeEdgeError(err));
    }
    if (!edgeOcrRes) {
      return null;
    }
    return {
      resultUrl: edgeOcrRes.resultUrl,
      resultSize: edgeOcrRes.resultSize,
      tier: 'L2',
      tierName: 'Edge L2 (SIMD Wasm)',
    };
  } else {
    const isImage = EDGE_FILTER_IMAGE_SOURCES.has(src);
    if (isImage) {
      try {
        if (typeof createImageBitmap !== 'undefined' && (typeof OffscreenCanvas !== 'undefined' || typeof document !== 'undefined')) {
          assertNoResizeRequested(item);
          assertEdgeImageTargetEncodable(tgt);
          const bitmap = await createImageBitmap(item.file);
          const width = bitmap.width;
          const height = bitmap.height;

          let canvas: any;
          let ctx: any;
          if (typeof OffscreenCanvas !== 'undefined') {
            canvas = new OffscreenCanvas(width, height);
            ctx = canvas.getContext('2d');
          } else {
            canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            ctx = canvas.getContext('2d');
          }

          if (!ctx) {
            if (typeof bitmap.close === 'function') bitmap.close();
            return null;
          }

          ctx.drawImage(bitmap, 0, 0);
          if (typeof bitmap.close === 'function') bitmap.close();

          const imgData = ctx.getImageData(0, 0, width, height);
          const pixelBuffer = imgData.data.buffer;

          // Determine appropriate Wasm task based on requested options
          let task: 'rgba-grayscale' | 'rgba-invert' | 'rgba-brightness' | 'rgba-quantize' | null = null;
          const wasmOpts: {
            width: number;
            height: number;
            colors?: number;
            palette?: boolean;
            dither?: boolean;
            colorDepth?: number;
            brightnessDelta?: number;
          } = {
            width,
            height,
            colors: item.options.colors,
            palette: item.options.palette,
            dither: item.options.dither,
            colorDepth: item.options.colorDepth,
          };

          if (item.options.colorDepth === 1 || (item.options as any).grayscale === true) {
            task = 'rgba-grayscale';
          } else if ((item.options as any).invert === true) {
            task = 'rgba-invert';
          } else if ((item.options as any).brightnessDelta !== undefined) {
            task = 'rgba-brightness';
            wasmOpts.brightnessDelta = (item.options as any).brightnessDelta;
          } else if (
            item.options.palette === true ||
            item.options.dither === true ||
            item.options.colorDepth !== undefined ||
            item.options.colors !== undefined
          ) {
            task = 'rgba-quantize';
            if (!wasmOpts.colors && item.options.colorDepth) {
              wasmOpts.colors = Math.min(256, 1 << item.options.colorDepth);
            }
          }

          if (task) {
            const taskRes = await executeWasmTask(task, pixelBuffer, wasmOpts, onProgress);
            const processedClamped = new Uint8ClampedArray(taskRes.buffer);
            const newImgData = new ImageData(processedClamped, width, height);
            ctx.putImageData(newImgData, 0, 0);
          }

          const resultBlob = await encodeEdgeImage(canvas, ctx, width, height, tgt, (item.options.quality || EDGE_FILTER_DEFAULT_QUALITY) / PERCENT);

          const resultUrl = URL.createObjectURL(resultBlob);
          return {
            resultUrl,
            resultSize: resultBlob.size,
            tier: 'L2',
            tierName: 'Edge L2 (SIMD Wasm)',
          };
        }
      } catch (err: unknown) {
        // The browser cannot produce this file (no encoder, a substituted or empty result): the server converts it.
        if (resolveTierAfterEdgeFailure('L2', err)) {
          throw new ClientEdgeEscalationError('L2', describeEdgeError(err));
        }
        // If bitmap decoding or canvas operation fails, gracefully fall back to serverless bridge
        return null;
      }
      return null;
    }
    return null;
  }
}

/**
 * Universal client conversion executor.
 * Handles client-side Edge fast-path (Zero-Data Retention) with automatic fallback
 * to server-side conversion pipeline when appropriate.
 */
export async function executeItemConversion(
  item: ConversionQueueItem,
  callbacks: ConvertItemCallbacks
): Promise<void> {
  // 1. Check for client-side Edge processing (L0 pure, L2 OCR, etc.)
  let escalation: EdgeTierFallback | undefined;
  try {
    const edgeRes = await tryProcessClientEdge(item, callbacks.onProgress);
    if (edgeRes) {
      const fallback =
        edgeRes.fallbackFrom && edgeRes.escalationReason
          ? { fallbackFrom: edgeRes.fallbackFrom, escalationReason: edgeRes.escalationReason }
          : undefined;
      callbacks.onSuccess(edgeRes.resultUrl, edgeRes.resultSize, true, edgeRes.tierName, fallback);
      return;
    }
  } catch (err: any) {
    if (err instanceof ClientEdgeEscalationError) {
      escalation = { fallbackFrom: err.fallbackFrom, escalationReason: err.message };
    } else if (item.options.clientEdgeMode === true) {
      // Fail-closed on client edge conversion errors: do not silently upload corrupted files to server
      callbacks.onError(err.message || 'Client edge conversion failed.');
      return;
    }
    // Otherwise cascade to cloud fallback
  }

  // 2. Fail-closed check: if user strictly mandated client-only execution, block cloud upload
  if (item.options.clientEdgeMode === true) {
    const blockedMessage = `Conversion from ${item.sourceFormat.toUpperCase()} to ${item.targetFormat.toUpperCase()} requires cloud serverless processing, but client-only edge mode is strictly enabled without cloud fallback consent.`;
    if (escalation) {
      callbacks.onError(
        `${blockedMessage} Edge tier ${escalation.fallbackFrom} failed: ${escalation.escalationReason}`
      );
      return;
    }
    callbacks.onError(blockedMessage);
    return;
  }

  // 3. Server-side conversion pipeline with Zero-Data Retention guarantee
  try {
    const cloudRes = await executeServerlessCloudFallback(
      item.file,
      item.targetFormat,
      item.options,
      callbacks.onProgress
    );
    callbacks.onSuccess(cloudRes.url, cloudRes.size, false, 'Cloud (Zero-Retention)', escalation);
  } catch (err: any) {
    callbacks.onError(err.message || 'Conversion failed. Please try another format.');
  }
}

/**
 * Factory creating the stateful single-item converter callback for React queue components.
 */
export function createItemConverter(
  setQueue: (action: (prev: ConversionQueueItem[]) => ConversionQueueItem[]) => void,
  maxFileSize?: number
) {
  return async (item: ConversionQueueItem): Promise<void> => {
    const effectiveLimit = maxFileSize !== undefined ? maxFileSize : getEffectiveMaxFileSize();
    if (item.file.size > effectiveLimit) {
      const limitMb = Math.round(effectiveLimit / (1024 * 1024));
      setQueue((prev) =>
        prev.map((i) =>
          i.id === item.id
            ? { ...i, status: 'error', error: `File size exceeds ${limitMb} MB limit.` }
            : i
        )
      );
      return;
    }

    setQueue((prev) =>
      prev.map((i) =>
        i.id === item.id ? { ...i, status: 'converting', progress: 15, error: undefined } : i
      )
    );

    await executeItemConversion(item, {
      onProgress: (progress) => {
        setQueue((prev) =>
          prev.map((i) => (i.id === item.id && i.status === 'converting' ? { ...i, progress } : i))
        );
      },
      onSuccess: (resultUrl, resultSize, edgeProcessed, edgeTier) => {
        setQueue((prev) =>
          prev.map((i) =>
            i.id === item.id
              ? {
                  ...i,
                  status: 'completed',
                  progress: 100,
                  resultUrl,
                  resultSize,
                  edgeProcessed,
                  edgeTier,
                }
              : i
          )
        );
      },
      onError: (msg) => {
        setQueue((prev) =>
          prev.map((i) => (i.id === item.id ? { ...i, status: 'error', error: msg, progress: 0 } : i))
        );
      },
    });
  };
}
