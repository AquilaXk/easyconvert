import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ConversionQueueItem } from '../src/lib/types';

// The routing decision and the browser-only tier engines are replaced so this suite can drive
// each fallback path in Node. The module under test (client-converter) is not mocked.
vi.mock('../src/lib/edge/tier-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/edge/tier-router')>();
  return { ...actual, resolveConversionTier: vi.fn() };
});
vi.mock('../src/lib/edge-ocr', () => ({ tryProcessClientEdgeOcr: vi.fn() }));
vi.mock('../src/lib/edge/pipelines/webgpu-compute-pipeline', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/edge/pipelines/webgpu-compute-pipeline')>();
  return { ...actual, isWebGpuComputeSupported: vi.fn() };
});
vi.mock('../src/lib/edge/pipelines/opfs-streaming-pipeline', () => ({ streamConvertWithOpfs: vi.fn() }));

import {
  tryProcessClientEdge,
  executeItemConversion,
  ClientEdgeEscalationError,
} from '../src/lib/client-converter';
import { resolveConversionTier, type ConversionTier } from '../src/lib/edge/tier-router';
import { tryProcessClientEdgeOcr } from '../src/lib/edge-ocr';
import { isWebGpuComputeSupported } from '../src/lib/edge/pipelines/webgpu-compute-pipeline';
import { streamConvertWithOpfs } from '../src/lib/edge/pipelines/opfs-streaming-pipeline';

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CLOUD_TIER_NAME = 'Cloud (Zero-Retention)';

function routeTo(tier: ConversionTier, tierName: string): void {
  vi.mocked(resolveConversionTier).mockReturnValue({
    tier,
    tierName,
    isClientEdge: true,
    reason: 'routed by test',
  });
}

function scanItem(overrides: Partial<ConversionQueueItem['options']> = {}): ConversionQueueItem {
  const file = new File([PNG_SIGNATURE], 'scan.png', { type: 'image/png' });
  return {
    id: 'tier-attribution-scan',
    file,
    name: 'scan.png',
    size: file.size,
    sourceFormat: 'png',
    targetFormat: 'pdf',
    status: 'ready',
    progress: 0,
    options: { ocrEnabled: true, ...overrides },
  };
}

/** A PNG with a pixel task and an image target, so L1A decodes it (and meets the failing GPU upload of the tests). */
function gpuScanItem(): ConversionQueueItem {
  return { ...scanItem({ invert: true } as Partial<ConversionQueueItem['options']>), targetFormat: 'png' };
}

function largeCsvItem(overrides: Partial<ConversionQueueItem['options']> = {}): ConversionQueueItem {
  const file = new File(['id,name\n1,Alice\n'], 'export.csv', { type: 'text/csv' });
  return {
    id: 'tier-attribution-stream',
    file,
    name: 'export.csv',
    size: file.size,
    sourceFormat: 'csv',
    targetFormat: 'tsv',
    status: 'ready',
    progress: 0,
    options: { ...overrides },
  };
}

describe('Client edge tier attribution and escalation reasons', () => {
  beforeEach(() => {
    vi.stubGlobal('window', globalThis);
    vi.mocked(tryProcessClientEdgeOcr).mockResolvedValue({ resultUrl: 'blob:edge-ocr-result', resultSize: 2048 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('L1A (WebGPU) falling back to L2 (Wasm)', () => {
    it('reports L2 as the tier that ran, with L1A and its error as the fallback source', async () => {
      routeTo('L1A', 'Edge L1A (WebGPU Compute)');
      vi.mocked(isWebGpuComputeSupported).mockReturnValue(true);
      vi.stubGlobal('OffscreenCanvas', class {});
      vi.stubGlobal(
        'createImageBitmap',
        vi.fn(async () => {
          throw new Error('GPU adapter lost during upload');
        })
      );

      // A pixel task is requested, so L1A decodes the image and meets the failing GPU upload.
      const result = await tryProcessClientEdge(gpuScanItem());

      expect(result).toEqual({
        resultUrl: 'blob:edge-ocr-result',
        resultSize: 2048,
        tier: 'L2',
        tierName: 'Edge L2 (SIMD Wasm)',
        fallbackFrom: 'L1A',
        escalationReason: 'GPU adapter lost during upload',
      });
    });

    it('records that L1A produced no result when WebGPU is unavailable', async () => {
      routeTo('L1A', 'Edge L1A (WebGPU Compute)');
      vi.mocked(isWebGpuComputeSupported).mockReturnValue(false);

      const result = await tryProcessClientEdge(scanItem());

      expect(result?.tier).toBe('L2');
      expect(result?.tierName).toBe('Edge L2 (SIMD Wasm)');
      expect(result?.fallbackFrom).toBe('L1A');
      expect(result?.escalationReason).toBe('L1A returned no result');
    });

    it('passes the real tier name and fallback details to onSuccess', async () => {
      routeTo('L1A', 'Edge L1A (WebGPU Compute)');
      vi.mocked(isWebGpuComputeSupported).mockReturnValue(false);
      const onSuccess = vi.fn();
      const onError = vi.fn();

      await executeItemConversion(scanItem(), { onProgress: () => undefined, onSuccess, onError });

      expect(onError).not.toHaveBeenCalled();
      expect(onSuccess).toHaveBeenCalledTimes(1);
      expect(onSuccess).toHaveBeenCalledWith('blob:edge-ocr-result', 2048, true, 'Edge L2 (SIMD Wasm)', {
        fallbackFrom: 'L1A',
        escalationReason: 'L1A returned no result',
      });
    });
  });

  describe('L1A (WebGPU) and then L2 (edge OCR) both failing', () => {
    // The fallback names the tier immediately before the cloud tier (L2). Its reason keeps every
    // failed tier in order, "L1A: <reason>; L2: <reason>", so the L1A failure is not lost.
    const CHAINED_REASON = 'L1A: GPU adapter lost during upload; L2: Edge OCR engine failed: worker crashed';

    function failBothEdgeTiers(): void {
      routeTo('L1A', 'Edge L1A (WebGPU Compute)');
      vi.mocked(isWebGpuComputeSupported).mockReturnValue(true);
      vi.stubGlobal('OffscreenCanvas', class {});
      vi.stubGlobal(
        'createImageBitmap',
        vi.fn(async () => {
          throw new Error('GPU adapter lost during upload');
        })
      );
      vi.mocked(tryProcessClientEdgeOcr).mockRejectedValue(new Error('Edge OCR engine failed: worker crashed'));
    }

    it('escalates from L2 with both tier failures in the reason', async () => {
      failBothEdgeTiers();

      const attempt = tryProcessClientEdge(gpuScanItem());

      await expect(attempt).rejects.toBeInstanceOf(ClientEdgeEscalationError);
      await expect(attempt).rejects.toMatchObject({ fallbackFrom: 'L2', message: CHAINED_REASON });
    });

    it('carries both tier failures into the cloud result', async () => {
      failBothEdgeTiers();
      const cloudBody = new Blob(['%PDF-1.7 cloud'], { type: 'application/pdf' });
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        blob: async () => cloudBody,
      } as Response);
      const onSuccess = vi.fn();
      const onError = vi.fn();

      await executeItemConversion(gpuScanItem(), { onProgress: () => undefined, onSuccess, onError });

      expect(onError).not.toHaveBeenCalled();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [, size, edgeProcessed, tierName, fallback] = onSuccess.mock.calls[0];
      expect(size).toBe(cloudBody.size);
      expect(edgeProcessed).toBe(false);
      expect(tierName).toBe(CLOUD_TIER_NAME);
      expect(fallback).toEqual({ fallbackFrom: 'L2', escalationReason: CHAINED_REASON });
    });
  });

  describe('L3 (OPFS stream) failing over to L4 (cloud)', () => {
    it('surfaces the L3 failure as a typed escalation instead of discarding it', async () => {
      routeTo('L3', 'Edge L3 (OPFS Stream)');
      vi.mocked(streamConvertWithOpfs).mockRejectedValue(new Error('OPFS quota exceeded'));

      const attempt = tryProcessClientEdge(largeCsvItem());

      await expect(attempt).rejects.toBeInstanceOf(ClientEdgeEscalationError);
      await expect(attempt).rejects.toMatchObject({
        fallbackFrom: 'L3',
        message: 'OPFS quota exceeded',
      });
    });

    it('carries the L3 source tier and reason into the cloud result', async () => {
      routeTo('L3', 'Edge L3 (OPFS Stream)');
      vi.mocked(streamConvertWithOpfs).mockRejectedValue(new Error('OPFS quota exceeded'));
      const cloudBody = new Blob(['id\tname\n1\tAlice\n'], { type: 'text/tab-separated-values' });
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        blob: async () => cloudBody,
      } as Response);
      const onSuccess = vi.fn();
      const onError = vi.fn();

      await executeItemConversion(largeCsvItem(), { onProgress: () => undefined, onSuccess, onError });

      expect(onError).not.toHaveBeenCalled();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0][0]).toBe('/api/convert');
      expect(onSuccess).toHaveBeenCalledTimes(1);
      const [url, size, edgeProcessed, tierName, fallback] = onSuccess.mock.calls[0];
      expect(String(url).startsWith('blob:')).toBe(true);
      expect(size).toBe(cloudBody.size);
      expect(edgeProcessed).toBe(false);
      expect(tierName).toBe(CLOUD_TIER_NAME);
      expect(fallback).toEqual({ fallbackFrom: 'L3', escalationReason: 'OPFS quota exceeded' });
    });

    it('keeps blocking the cloud upload in client-only edge mode', async () => {
      routeTo('L3', 'Edge L3 (OPFS Stream)');
      vi.mocked(streamConvertWithOpfs).mockRejectedValue(new Error('OPFS quota exceeded'));
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const onSuccess = vi.fn();
      const onError = vi.fn();

      await executeItemConversion(largeCsvItem({ clientEdgeMode: true }), {
        onProgress: () => undefined,
        onSuccess,
        onError,
      });

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(onSuccess).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledWith(
        'Conversion from CSV to TSV requires cloud serverless processing, but client-only edge mode is strictly enabled without cloud fallback consent. Edge tier L3 failed: OPFS quota exceeded'
      );
    });
  });
});
