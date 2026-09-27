import { ConversionQueueItem } from './types';
import { tryProcessClientEdgeOcr } from './edge-ocr';
import { resolveConversionTier, checkOpfsSupport } from './edge/tier-router';
import { isPureDataConvertible, convertPureData } from './edge/pure/pure-data';
import { isPureCadConvertible, convertPureCad } from './edge/pure/pure-cad';
import { isPureAudioConvertible, convertPureAudio } from './edge/pure/pure-audio';
import { isPureCanvasConvertible, convertPureCanvas, isCanvasSupported } from './edge/pure/pure-canvas';
import { convertWithWebCodecs } from './edge/pipelines/webcodecs-pipeline';
import { executeWasmTask } from './edge/pipelines/wasm-simd-pipeline';
import { streamConvertWithOpfs } from './edge/pipelines/opfs-streaming-pipeline';
import { executeServerlessCloudFallback } from './edge/pipelines/fallback-pipeline';

export interface ConvertItemCallbacks {
  onProgress: (progress: number) => void;
  onSuccess: (resultUrl: string, resultSize: number, edgeProcessed?: boolean, edgeTier?: string) => void;
  onError: (errorMessage: string) => void;
}

export interface ClientEdgeResult {
  resultUrl: string;
  resultSize: number;
  tier?: string;
  tierName?: string;
}

/**
 * Returns dynamic maximum file size limit.
 * If browser supports OPFS, expands up to 2GB streaming limit; otherwise default 100MB.
 */
export function getEffectiveMaxFileSize(baseMax: number = 100 * 1024 * 1024): number {
  if (typeof window !== 'undefined' && checkOpfsSupport()) {
    return 2 * 1024 * 1024 * 1024; // 2 GB OPFS VFS ceiling
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
    onProgress?.(25);

    // Pure Data conversion (CSV, TSV, JSON, YAML)
    if (isPureDataConvertible(src, tgt)) {
      const arrayBuf = await item.file.arrayBuffer();
      onProgress?.(50);
      const res = convertPureData(new Uint8Array(arrayBuf), src, tgt, item.options);
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

    // Pure Audio conversion (WAV, PCM, MP3)
    if (isPureAudioConvertible(src, tgt)) {
      const arrayBuf = await item.file.arrayBuffer();
      onProgress?.(50);
      const res = convertPureAudio(new Uint8Array(arrayBuf), src, tgt, {
        sampleRate: item.options.audioSampleRate,
        channels: item.options.audioChannels === 'mono' ? 1 : 2,
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
    } catch {
      // Adaptive cascade fallback: if WebCodecs hardware encoder fails or is unsupported,
      // cascade gracefully to L2 (Wasm) or L4 (Cloud Fallback)
      const l2Res = await processL2Conversion(item, src, tgt, onProgress);
      if (l2Res) return l2Res;
      return null;
    }
  }

  // 3. Level 2: Client-side Edge OCR or SIMD Wasm Execution (Zero-Data Retention)
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
    } catch {
      // Graceful fallback to L4 cloud pipeline
      return null;
    }
  }

  return null;
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
    try {
      const edgeOcrRes = await tryProcessClientEdgeOcr(item, onProgress);
      if (edgeOcrRes) {
        return {
          resultUrl: edgeOcrRes.resultUrl,
          resultSize: edgeOcrRes.resultSize,
          tier: 'L2',
          tierName: 'Edge L2 (SIMD Wasm)',
        };
      }
    } catch (err: unknown) {
      // Propagate OCR error to respect fail-closed invariant
      throw err;
    }
    return null;
  } else {
    const isImage = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'].includes(src);
    if (isImage) {
      try {
        if (typeof createImageBitmap !== 'undefined' && (typeof OffscreenCanvas !== 'undefined' || typeof document !== 'undefined')) {
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

          const taskRes = await executeWasmTask('rgba-grayscale', pixelBuffer, { width, height }, onProgress);

          const processedClamped = new Uint8ClampedArray(taskRes.buffer);
          const newImgData = new ImageData(processedClamped, width, height);
          ctx.putImageData(newImgData, 0, 0);

          const mimeType = tgt === 'jpg' || tgt === 'jpeg' ? 'image/jpeg' : (tgt === 'webp' ? 'image/webp' : 'image/png');
          let resultBlob: Blob;
          if ('convertToBlob' in canvas) {
            resultBlob = await canvas.convertToBlob({ type: mimeType, quality: (item.options.quality || 90) / 100 });
          } else {
            resultBlob = await new Promise<Blob>((resolve) => {
              canvas.toBlob((b: Blob | null) => resolve(b || new Blob([])), mimeType, (item.options.quality || 90) / 100);
            });
          }

          const resultUrl = URL.createObjectURL(resultBlob);
          return {
            resultUrl,
            resultSize: resultBlob.size,
            tier: 'L2',
            tierName: 'Edge L2 (SIMD Wasm)',
          };
        }
      } catch {
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
  try {
    const edgeRes = await tryProcessClientEdge(item, callbacks.onProgress);
    if (edgeRes) {
      callbacks.onSuccess(edgeRes.resultUrl, edgeRes.resultSize, true, edgeRes.tierName);
      return;
    }
  } catch (err: any) {
    if (item.options.clientEdgeMode === true) {
      // Fail-closed on client edge conversion errors: do not silently upload corrupted files to server
      callbacks.onError(err.message || 'Client edge conversion failed.');
      return;
    }
    // Otherwise cascade to cloud fallback
  }

  // 2. Fail-closed check: if user strictly mandated client-only execution, block cloud upload
  if (item.options.clientEdgeMode === true) {
    callbacks.onError(
      `Conversion from ${item.sourceFormat.toUpperCase()} to ${item.targetFormat.toUpperCase()} requires cloud serverless processing, but client-only edge mode is strictly enabled without cloud fallback consent.`
    );
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
    callbacks.onSuccess(cloudRes.url, cloudRes.size, false, 'Cloud (Zero-Retention)');
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
