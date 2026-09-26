import { ConversionQueueItem } from './types';
import { tryProcessClientEdgeOcr } from './edge-ocr';
import { resolveConversionTier, checkOpfsSupport } from './edge/tier-router';
import { isPureDataConvertible, convertPureData } from './edge/pure/pure-data';
import { isPureCadConvertible, convertPureCad } from './edge/pure/pure-cad';
import { isPureAudioConvertible, convertPureAudio } from './edge/pure/pure-audio';
import { isPureCanvasConvertible, convertPureCanvas, isCanvasSupported } from './edge/pure/pure-canvas';

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
    try {
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
    } catch {
      // In case pure execution fails on corrupt input, fallback closed or to server
      return null;
    }
  }

  // 2. Level 2: Client-side Edge OCR (Zero-Data Retention)
  if (resolution.tier === 'L2' && item.options.ocrEnabled) {
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
    } catch {
      return null;
    }
  }

  return null;
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
    // If clientEdgeMode was strictly forced, fail-closed
    if (item.options.clientEdgeMode === true) {
      callbacks.onError(err.message || 'Client edge conversion failed.');
      return;
    }
  }

  // 2. Server-side conversion pipeline
  try {
    const formData = new FormData();
    formData.append('file', item.file);
    formData.append('targetFormat', item.targetFormat);
    formData.append('options', JSON.stringify(item.options));

    const progressTimer = setTimeout(() => {
      callbacks.onProgress(75);
    }, 350);

    const res = await fetch('/api/convert', {
      method: 'POST',
      body: formData,
    });

    clearTimeout(progressTimer);

    if (!res.ok) {
      const errJson = await res.json().catch(() => ({}));
      throw new Error(errJson.error || 'Conversion failed. Please try another format.');
    }

    const blob = await res.blob();
    const resultUrl = URL.createObjectURL(blob);
    callbacks.onSuccess(resultUrl, blob.size, false);
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
