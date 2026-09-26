import { ConversionQueueItem } from './types';
import { tryProcessClientEdgeOcr } from './edge-ocr';

export interface ConvertItemCallbacks {
  onProgress: (progress: number) => void;
  onSuccess: (resultUrl: string, resultSize: number, edgeProcessed?: boolean) => void;
  onError: (errorMessage: string) => void;
}

/**
 * Universal client conversion executor.
 * Handles client-side Edge OCR (Zero-Data Retention) with automatic fallback
 * to server-side conversion pipeline.
 */
export async function executeItemConversion(
  item: ConversionQueueItem,
  callbacks: ConvertItemCallbacks
): Promise<void> {
  // 1. Check for client-side Edge OCR mode (100% in-browser memory execution)
  const edgeRes = await tryProcessClientEdgeOcr(item, callbacks.onProgress);
  if (edgeRes) {
    callbacks.onSuccess(edgeRes.resultUrl, edgeRes.resultSize, true);
    return;
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
