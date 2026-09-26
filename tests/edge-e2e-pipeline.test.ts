import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  resolveConversionTier,
} from '../src/lib/edge/tier-router';
import {
  validateExecutionPolicy,
  EdgeConversionRefusalError,
  isCloudFallbackPermitted,
} from '../src/lib/edge/pipelines/fallback-pipeline';
import {
  tryProcessClientEdge,
  executeItemConversion,
} from '../src/lib/client-converter';
import { ConversionQueueItem } from '../src/lib/types';

describe('Phase 5: Serverless Fail-Closed Bridge & 5-Tier E2E Integration Gates', () => {
  let originalWindow: any;
  let originalCreateObjectURL: any;

  beforeEach(() => {
    vi.restoreAllMocks();
    originalWindow = (globalThis as any).window;
    originalCreateObjectURL = URL.createObjectURL;
    (globalThis as any).window = globalThis;
    URL.createObjectURL = vi.fn((blob: any) => `blob:mock-url-${blob?.size || 100}`);
  });

  afterEach(() => {
    if (originalWindow === undefined) {
      delete (globalThis as any).window;
    } else {
      (globalThis as any).window = originalWindow;
    }
    URL.createObjectURL = originalCreateObjectURL;
  });

  describe('1. Universal 5-Tier Adaptive Resolution Matrix', () => {
    it('resolves Tier L0 for pure isomorphic structured data', () => {
      const res = resolveConversionTier('csv', 'json', 1024);
      expect(res.tier).toBe('L0');
      expect(res.tierName).toBe('Edge L0 (Instant)');
      expect(res.isClientEdge).toBe(true);
    });

    it('resolves Tier L0 for pure mathematical CAD B-spline tessellation', () => {
      const res = resolveConversionTier('step', 'stl', 50_000);
      expect(res.tier).toBe('L0');
      expect(res.tierName).toBe('Edge L0 (Instant)');
      expect(res.isClientEdge).toBe(true);
    });

    it('resolves Tier L0 for pure TypedArray WAV/MP3 audio', () => {
      const res = resolveConversionTier('wav', 'mp3', 200_000);
      expect(res.tier).toBe('L0');
      expect(res.tierName).toBe('Edge L0 (Instant)');
      expect(res.isClientEdge).toBe(true);
    });

    it('resolves Tier L0 for pure Canvas 2D image rasterization', () => {
      const res = resolveConversionTier('png', 'webp', 100_000, {}, { hasCanvas: true });
      expect(res.tier).toBe('L0');
      expect(res.tierName).toBe('Edge L0 (Instant)');
      expect(res.isClientEdge).toBe(true);
    });

    it('resolves Tier L1 for WebCodecs hardware accelerated media transcoding', () => {
      const res = resolveConversionTier(
        'mp4',
        'webm',
        10_000_000,
        {},
        { hasWebCodecsVideo: true }
      );
      expect(res.tier).toBe('L1');
      expect(res.tierName).toBe('Edge L1 (Hardware VPU)');
      expect(res.isClientEdge).toBe(true);
    });

    it('resolves Tier L2 for SIMD Wasm OCR & PDF processing', () => {
      const res = resolveConversionTier('png', 'txt', 500_000, { ocrEnabled: true });
      expect(res.tier).toBe('L2');
      expect(res.tierName).toBe('Edge L2 (SIMD Wasm)');
      expect(res.isClientEdge).toBe(true);
    });

    it('resolves Tier L3 for OPFS large-file streaming VFS (> 100MB)', () => {
      const res = resolveConversionTier(
        'mp4',
        'webm',
        150 * 1024 * 1024,
        {},
        { hasOpfsSyncAccess: true }
      );
      expect(res.tier).toBe('L3');
      expect(res.tierName).toBe('Edge L3 (OPFS Stream)');
      expect(res.isClientEdge).toBe(true);
    });

    it('resolves Tier L4 for Cloud serverless conversion when format is unsupported locally', () => {
      const res = resolveConversionTier(
        'mkv',
        'avi',
        5_000_000,
        {},
        { hasWebCodecsVideo: false, hasWebCodecsAudio: false }
      );
      expect(res.tier).toBe('L4');
      expect(res.tierName).toBe('Cloud (Zero-Retention)');
      expect(res.isClientEdge).toBe(false);
    });

    it('resolves Tier L4 when user explicitly opts out of client edge execution', () => {
      const res = resolveConversionTier('csv', 'json', 1024, { clientEdgeMode: false });
      expect(res.tier).toBe('L4');
      expect(res.tierName).toBe('Cloud (Zero-Retention)');
      expect(res.isClientEdge).toBe(false);
    });
  });

  describe('2. Fail-Closed Privacy & Refusal Policy Enforcement', () => {
    it('throws EdgeConversionRefusalError when clientEdgeMode === true but requires cloud L4', () => {
      expect(() => {
        validateExecutionPolicy('mkv', 'flv', 10_000_000, { clientEdgeMode: true }, {
          hasWebCodecsVideo: false,
          hasWebCodecsAudio: false,
        });
      }).toThrow(EdgeConversionRefusalError);
    });

    it('disallows cloud fallback when clientEdgeMode is true', () => {
      const item: ConversionQueueItem = {
        id: 'item-strict-edge',
        file: new File([new Uint8Array(100)], 'sample.mkv'),
        name: 'sample.mkv',
        size: 100,
        sourceFormat: 'mkv',
        targetFormat: 'flv',
        status: 'ready',
        progress: 0,
        options: { clientEdgeMode: true },
      };

      expect(isCloudFallbackPermitted(item)).toBe(false);
    });

    it('blocks network upload completely when client-only edge mode is enforced', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const onErrorSpy = vi.fn();
      const onSuccessSpy = vi.fn();

      const item: ConversionQueueItem = {
        id: 'item-blocked',
        file: new File([new Uint8Array(100)], 'test.mkv'),
        name: 'test.mkv',
        size: 100,
        sourceFormat: 'mkv',
        targetFormat: 'flv',
        status: 'ready',
        progress: 0,
        options: { clientEdgeMode: true },
      };

      await executeItemConversion(item, {
        onProgress: () => {},
        onSuccess: onSuccessSpy,
        onError: onErrorSpy,
      });

      // Assert no HTTP request was made to /api/convert
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(onSuccessSpy).not.toHaveBeenCalled();
      expect(onErrorSpy).toHaveBeenCalledTimes(1);
      expect(onErrorSpy.mock.calls[0][0]).toMatch(/requires cloud serverless processing/);
    });
  });

  describe('3. Cloud Serverless Fallback with Zero-Data Retention Header', () => {
    it('attaches X-Zero-Retention header and returns Cloud tier telemetry when cloud is permitted', async () => {
      const mockBlob = new Blob(['mock-result'], { type: 'video/mp4' });
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        blob: async () => mockBlob,
      } as any);

      const onSuccessSpy = vi.fn();
      const onErrorSpy = vi.fn();

      const item: ConversionQueueItem = {
        id: 'item-cloud-permitted',
        file: new File([new Uint8Array(500)], 'movie.mkv'),
        name: 'movie.mkv',
        size: 500,
        sourceFormat: 'mkv',
        targetFormat: 'mp4',
        status: 'ready',
        progress: 0,
        options: { clientEdgeMode: false },
      };

      await executeItemConversion(item, {
        onProgress: () => {},
        onSuccess: onSuccessSpy,
        onError: onErrorSpy,
      });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const callArgs = fetchSpy.mock.calls[0];
      expect(callArgs[0]).toBe('/api/convert');
      expect((callArgs[1]?.headers as any)['X-Zero-Retention']).toBe('true');

      expect(onErrorSpy).not.toHaveBeenCalled();
      expect(onSuccessSpy).toHaveBeenCalledTimes(1);
      expect(onSuccessSpy.mock.calls[0][2]).toBe(false); // edgeProcessed = false
      expect(onSuccessSpy.mock.calls[0][3]).toBe('Cloud (Zero-Retention)');
    });
  });

  describe('4. End-to-End Client Edge Processing Verification', () => {
    it('executes Level 0 data conversion directly in memory with Edge L0 telemetry', async () => {
      const csvData = 'id,name\n1,Alice\n2,Bob';
      const file = new File([new TextEncoder().encode(csvData)], 'users.csv', { type: 'text/csv' });

      const item: ConversionQueueItem = {
        id: 'csv-item',
        file,
        name: 'users.csv',
        size: file.size,
        sourceFormat: 'csv',
        targetFormat: 'json',
        status: 'ready',
        progress: 0,
        options: {},
      };

      const result = await tryProcessClientEdge(item);
      expect(result).not.toBeNull();
      expect(result?.tier).toBe('L0');
      expect(result?.tierName).toBe('Edge L0 (Instant)');
      expect(result?.resultSize).toBeGreaterThan(0);
    });

    it('executes Level 0 CAD tessellation directly in memory', async () => {
      const stepData = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('EasyConvert Test Surface'),'2;1');
FILE_NAME('bracket.step','2026-09-26T00:00:00','','','EasyConvert','','');
FILE_SCHEMA(('CONFIG_CONTROL_DESIGN'));
ENDSEC;
DATA;
#10 = CARTESIAN_POINT('', (0.0, 0.0, 0.0));
#11 = CARTESIAN_POINT('', (0.0, 10.0, 2.0));
#12 = CARTESIAN_POINT('', (10.0, 0.0, 2.0));
#13 = CARTESIAN_POINT('', (10.0, 10.0, 5.0));
#20 = B_SPLINE_SURFACE_WITH_KNOTS('surface1', 1, 1, ((#10, #11), (#12, #13)), .UNSPECIFIED., .F., .F., .F., (2, 2), (2, 2), (0.0, 1.0), (0.0, 1.0), .PIECEWISE_BEZIER_KNOTS.);
#30 = ADVANCED_FACE('face1', (), #20, .T.);
ENDSEC;
END-ISO-10303-21;
`;
      const file = new File([new TextEncoder().encode(stepData)], 'bracket.step', { type: 'text/plain' });

      const item: ConversionQueueItem = {
        id: 'cad-item',
        file,
        name: 'bracket.step',
        size: file.size,
        sourceFormat: 'step',
        targetFormat: 'stl',
        status: 'ready',
        progress: 0,
        options: {},
      };

      const result = await tryProcessClientEdge(item);
      expect(result).not.toBeNull();
      expect(result?.tier).toBe('L0');
      expect(result?.resultSize).toBeGreaterThan(0);
    });

    it('executes Level 0 pure audio conversion directly in memory', async () => {
      // 44-byte minimal WAV header + 8 bytes PCM
      const wavHeader = new Uint8Array([
        0x52, 0x49, 0x46, 0x46, 0x2c, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
        0x66, 0x6d, 0x74, 0x20, 0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
        0x44, 0xac, 0x00, 0x00, 0x88, 0x58, 0x01, 0x00, 0x02, 0x00, 0x10, 0x00,
        0x64, 0x61, 0x74, 0x61, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
      ]);
      const file = new File([wavHeader], 'audio.wav', { type: 'audio/wav' });

      const item: ConversionQueueItem = {
        id: 'audio-item',
        file,
        name: 'audio.wav',
        size: file.size,
        sourceFormat: 'wav',
        targetFormat: 'mp3',
        status: 'ready',
        progress: 0,
        options: {},
      };

      const result = await tryProcessClientEdge(item);
      expect(result).not.toBeNull();
      expect(result?.tier).toBe('L0');
      expect(result?.resultSize).toBeGreaterThan(0);
    });
  });
});
