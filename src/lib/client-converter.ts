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

/**
 * Factory creating the stateful single-item converter callback for React queue components.
 */
export function createItemConverter(
  setQueue: (action: (prev: ConversionQueueItem[]) => ConversionQueueItem[]) => void,
  maxFileSize: number = 100 * 1024 * 1024
) {
  return async (item: ConversionQueueItem): Promise<void> => {
    if (item.file.size > maxFileSize) {
      setQueue((prev) =>
        prev.map((i) =>
          i.id === item.id ? { ...i, status: 'error', error: 'File size exceeds 100 MB limit.' } : i
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
      onSuccess: (resultUrl, resultSize, edgeProcessed) => {
        setQueue((prev) =>
          prev.map((i) =>
            i.id === item.id
              ? { ...i, status: 'completed', progress: 100, resultUrl, resultSize, edgeProcessed }
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
