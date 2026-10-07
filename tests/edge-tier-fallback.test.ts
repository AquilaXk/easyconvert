import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversionQueueItem } from '../src/lib/types';

// The routing decision is replaced so the suite can send a file to L1 in Node (the real router needs probed
// browser capabilities); its server-fallback decision is the real one. The module under test (client-converter),
// the WebCodecs pipeline and the worker logic are not mocked; only the network upload is.
vi.mock('../src/lib/edge/tier-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/edge/tier-router')>();
  return { ...actual, resolveConversionTier: vi.fn() };
});
vi.mock('../src/lib/edge/pipelines/fallback-pipeline', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/edge/pipelines/fallback-pipeline')>();
  return { ...actual, executeServerlessCloudFallback: vi.fn() };
});

import { executeItemConversion, tryProcessClientEdge } from '../src/lib/client-converter';
import { executeServerlessCloudFallback } from '../src/lib/edge/pipelines/fallback-pipeline';
import {
  resolveConversionTier,
  resolveTierAfterEdgeFailure,
  type EdgeCapabilities,
} from '../src/lib/edge/tier-router';
import { EdgeUnsupportedError } from '../src/lib/edge/workers/worker-errors';
import { installFakeWebCodecs, type FakePlatform } from './helpers/webcodecs-platform-fakes';

const { resolveConversionTier: realResolveConversionTier } = await vi.importActual<
  typeof import('../src/lib/edge/tier-router')
>('../src/lib/edge/tier-router');

const SERVER_TIER_NAME = 'Cloud (Zero-Retention)';
const KIB = 1024;
const WEBCODECS_CAPABLE: Partial<EdgeCapabilities> = {
  hasWebCodecsVideo: true,
  hasWebCodecsAudio: true,
  supportedAudioEncoders: ['opus', 'mp4a.40.2'],
};

/** MKV (EBML) bytes: a container the edge worker has no demuxer for, handed in under an mp4 file name. */
function mkvBytes(): Uint8Array {
  const out = new Uint8Array(4 * KIB).fill(0xa3);
  out.set([0x1a, 0x45, 0xdf, 0xa3, 0x93, 0x42, 0x82, 0x88, ...new TextEncoder().encode('matroska')], 0);
  return out;
}

function videoItem(overrides: Partial<ConversionQueueItem['options']> = {}): ConversionQueueItem {
  const file = new File([mkvBytes().buffer as ArrayBuffer], 'holiday.mp4', { type: 'video/mp4' });
  return {
    id: 'edge-fallback-video',
    file,
    name: 'holiday.mp4',
    size: file.size,
    sourceFormat: 'mp4',
    targetFormat: 'webm',
    status: 'ready',
    progress: 0,
    options: { ...overrides },
  };
}

describe('router fallback to the server tier for what the edge cannot convert (issue #479)', () => {
  describe('static routing', () => {
    it.each(['avi', 'mkv', 'wmv', 'flv', 'webm', '3gp'])('sends %s input to the server tier even with WebCodecs present', (src) => {
      const resolution = realResolveConversionTier(src, 'mp4', 5 * KIB * KIB, {}, WEBCODECS_CAPABLE);

      expect(resolution.tier).toBe('L4');
      expect(resolution.isClientEdge).toBe(false);
      expect(resolution.reason).toContain(src.toUpperCase());
    });

    it.each(['mp4', 'm4v', 'mov'])('keeps %s to webm on the edge when WebCodecs is present', (src) => {
      expect(realResolveConversionTier(src, 'webm', 5 * KIB * KIB, {}, WEBCODECS_CAPABLE).tier).toBe('L1');
    });

    it('sends a mov target to the server tier, since the worker writes no QuickTime container', () => {
      expect(realResolveConversionTier('mp4', 'mov', 5 * KIB * KIB, {}, WEBCODECS_CAPABLE).tier).toBe('L4');
    });

    it('sends an audio target from an unreadable source to the server tier', () => {
      expect(realResolveConversionTier('flac', 'aac', 5 * KIB, {}, WEBCODECS_CAPABLE).tier).toBe('L4');
      expect(realResolveConversionTier('wav', 'aac', 5 * KIB, {}, WEBCODECS_CAPABLE).tier).toBe('L1');
    });
  });

  describe('resolveTierAfterEdgeFailure', () => {
    it('answers an EdgeUnsupportedError with the server tier and keeps the reason', () => {
      const resolution = resolveTierAfterEdgeFailure('L1', new EdgeUnsupportedError('no demuxer for MKV'));

      expect(resolution).toMatchObject({ tier: 'L4', tierName: SERVER_TIER_NAME, isClientEdge: false });
      expect(resolution?.reason).toContain('no demuxer for MKV');
    });

    it('leaves every other failure to the caller', () => {
      expect(resolveTierAfterEdgeFailure('L1', new Error('GPU lost'))).toBeNull();
      expect(resolveTierAfterEdgeFailure('L1', 'EdgeUnsupportedError')).toBeNull();
    });
  });

  describe('a conversion routed to L1 that the worker cannot read', () => {
    let platform: FakePlatform;

    beforeEach(() => {
      platform = installFakeWebCodecs();
      vi.stubGlobal('window', globalThis);
      vi.mocked(resolveConversionTier).mockReturnValue({
        tier: 'L1',
        tierName: 'Edge L1 (Hardware VPU)',
        isClientEdge: true,
        reason: 'routed by test',
      });
      vi.mocked(executeServerlessCloudFallback).mockClear();
      vi.mocked(executeServerlessCloudFallback).mockImplementation(async (file) => ({
        blob: new Blob([file]),
        url: 'blob:server-engine-output',
        size: 4242,
      }));
    });

    afterEach(() => {
      platform.restore();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    it('runs the server tier on the original file and reports the edge reason', async () => {
      const item = videoItem();
      const onSuccess = vi.fn();
      const onError = vi.fn();

      await executeItemConversion(item, { onProgress: () => undefined, onSuccess, onError });

      expect(onError).not.toHaveBeenCalled();
      expect(platform.encodedFrames).toHaveLength(0);
      expect(executeServerlessCloudFallback).toHaveBeenCalledTimes(1);
      expect(vi.mocked(executeServerlessCloudFallback).mock.calls[0][0]).toBe(item.file);
      expect(onSuccess).toHaveBeenCalledTimes(1);
      const [url, size, edgeProcessed, tierName, fallback] = onSuccess.mock.calls[0];
      expect(url).toBe('blob:server-engine-output');
      expect(size).toBe(4242);
      expect(edgeProcessed).toBe(false);
      expect(tierName).toBe(SERVER_TIER_NAME);
      expect(fallback.fallbackFrom).toBe('L1');
      expect(fallback.escalationReason).toContain('could not read any media samples');
    });

    it('does not hand the input back or invent a result URL when no server tier may run', async () => {
      const item = videoItem({ clientEdgeMode: true });
      const onSuccess = vi.fn();
      const onError = vi.fn();

      await executeItemConversion(item, { onProgress: () => undefined, onSuccess, onError });

      expect(onSuccess).not.toHaveBeenCalled();
      expect(executeServerlessCloudFallback).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0][0]).toContain('Edge tier L1 failed');
      expect(onError.mock.calls[0][0]).toContain('could not read any media samples');
    });

    it('raises no result from tryProcessClientEdge for the unreadable file', async () => {
      await expect(tryProcessClientEdge(videoItem())).rejects.toMatchObject({
        name: 'ClientEdgeEscalationError',
        fallbackFrom: 'L1',
      });
    });
  });
});
