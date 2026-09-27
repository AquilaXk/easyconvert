import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  shouldOffloadToMicroVM,
  evaluateMicroVMOffload,
  checkWebGpuSupport,
  probeWebGpuCapabilities,
  probeEdgeCapabilities,
  resolveConversionTier,
  MICROVM_PAYLOAD_BUDGETS,
  parsePageRangeCount,
} from '../src/lib/edge/tier-router';
import {
  validateExecutionPolicy,
  EdgeConversionRefusalError,
} from '../src/lib/edge/pipelines/fallback-pipeline';

describe('Phase 5: Tier Router Budgets & WebGPU Compute Probing', () => {
  // ==========================================================================
  // 1. MicroVM Payload Budgets & Offload Evaluator
  // ==========================================================================
  describe('MicroVM Payload Offload Budgets (Section 7)', () => {
    it('verifies resolved payload budget constants', () => {
      expect(MICROVM_PAYLOAD_BUDGETS.OFFICE_MAX_BYTES).toBe(30 * 1024 * 1024);
      expect(MICROVM_PAYLOAD_BUDGETS.OCR_MAX_PAGES).toBe(50);
      expect(MICROVM_PAYLOAD_BUDGETS.RAW_MAX_BYTES).toBe(35 * 1024 * 1024);
      expect(MICROVM_PAYLOAD_BUDGETS.CAD_MAX_BYTES).toBe(15 * 1024 * 1024);
      expect(MICROVM_PAYLOAD_BUDGETS.VIDEO_MAX_BYTES).toBe(100 * 1024 * 1024);
      expect(MICROVM_PAYLOAD_BUDGETS.LOW_SPEC_CONCURRENCY_THRESHOLD).toBe(2);
      expect(MICROVM_PAYLOAD_BUDGETS.LOW_SPEC_MEMORY_GB_THRESHOLD).toBe(4);
      expect(MICROVM_PAYLOAD_BUDGETS.LOW_SPEC_PAYLOAD_MAX_BYTES).toBe(5 * 1024 * 1024);
    });

    it('enforces Office payload budget (> 30MB offload)', () => {
      // Below or at budget (<= 30MB)
      expect(shouldOffloadToMicroVM('docx', 25 * 1024 * 1024)).toBe(false);
      expect(shouldOffloadToMicroVM('xlsx', 30 * 1024 * 1024)).toBe(false);
      expect(shouldOffloadToMicroVM('pptx', 10 * 1024 * 1024)).toBe(false);
      expect(shouldOffloadToMicroVM('pdf', 28 * 1024 * 1024)).toBe(false);

      // Above budget (> 30MB)
      const docxExceeded = evaluateMicroVMOffload('docx', 31 * 1024 * 1024);
      expect(docxExceeded.shouldOffload).toBe(true);
      expect(docxExceeded.category).toBe('office');
      expect(docxExceeded.reason).toContain('30MB');

      expect(shouldOffloadToMicroVM('xlsx', 35 * 1024 * 1024)).toBe(true);
      expect(shouldOffloadToMicroVM('pptx', 40 * 1024 * 1024)).toBe(true);
      expect(shouldOffloadToMicroVM('odt', 32 * 1024 * 1024)).toBe(true);
      expect(shouldOffloadToMicroVM('pdf', 50 * 1024 * 1024)).toBe(true);
    });

    it('accurately parses page ranges and merged intervals with parsePageRangeCount', () => {
      expect(parsePageRangeCount('5')).toBe(1);
      expect(parsePageRangeCount('100')).toBe(1);
      expect(parsePageRangeCount('55-60')).toBe(6);
      expect(parsePageRangeCount('1, 3, 5')).toBe(3);
      expect(parsePageRangeCount('1-10, 45, 52-60')).toBe(20);
      expect(parsePageRangeCount('1-30, 20-55')).toBe(55);
      expect(parsePageRangeCount('1-10, 11-20, 21-30, 31-40, 41-50, 51-55')).toBe(55);
      expect(parsePageRangeCount('')).toBeUndefined();
      expect(parsePageRangeCount('invalid')).toBeUndefined();
    });

    it('enforces OCR document page count budget (> 50 pages offload)', () => {
      // Below budget (<= 50 pages)
      expect(
        shouldOffloadToMicroVM('pdf', 5 * 1024 * 1024, {
          ocrEnabled: true,
          pageCount: 30,
        })
      ).toBe(false);

      expect(
        shouldOffloadToMicroVM('pdf', 5 * 1024 * 1024, {
          ocrEnabled: true,
          pages: '1-50',
        })
      ).toBe(false);

      // Non-contiguous and offset page ranges within budget
      expect(
        shouldOffloadToMicroVM('pdf', 5 * 1024 * 1024, {
          ocrEnabled: true,
          pages: '55-60',
        })
      ).toBe(false);

      expect(
        shouldOffloadToMicroVM('pdf', 5 * 1024 * 1024, {
          ocrEnabled: true,
          pages: '100',
        })
      ).toBe(false);

      expect(
        shouldOffloadToMicroVM('pdf', 5 * 1024 * 1024, {
          ocrEnabled: true,
          pages: '1-10, 45, 52-60',
        })
      ).toBe(false);

      // Above budget (> 50 pages)
      const ocrExceeded = evaluateMicroVMOffload('pdf', 5 * 1024 * 1024, {
        ocrEnabled: true,
        pageCount: 65,
      });
      expect(ocrExceeded.shouldOffload).toBe(true);
      expect(ocrExceeded.category).toBe('ocr');
      expect(ocrExceeded.reason).toContain('50 pages');

      expect(
        shouldOffloadToMicroVM('pdf', 5 * 1024 * 1024, {
          ocrEnabled: true,
          pages: '1-75',
        })
      ).toBe(true);

      // Disjoint ranges totaling > 50 pages offload
      expect(
        shouldOffloadToMicroVM('pdf', 5 * 1024 * 1024, {
          ocrEnabled: true,
          pages: '1-20, 25-45, 50-70',
        })
      ).toBe(true);
    });

    it('enforces RAW camera image budget (> 35MB offload)', () => {
      // Below or at budget (<= 35MB)
      expect(shouldOffloadToMicroVM('cr2', 30 * 1024 * 1024)).toBe(false);
      expect(shouldOffloadToMicroVM('nef', 35 * 1024 * 1024)).toBe(false);
      expect(shouldOffloadToMicroVM('arw', 25 * 1024 * 1024)).toBe(false);
      expect(shouldOffloadToMicroVM('dng', 20 * 1024 * 1024)).toBe(false);

      // Above budget (> 35MB)
      const rawExceeded = evaluateMicroVMOffload('cr2', 36 * 1024 * 1024);
      expect(rawExceeded.shouldOffload).toBe(true);
      expect(rawExceeded.category).toBe('raw');
      expect(rawExceeded.reason).toContain('35MB');

      expect(shouldOffloadToMicroVM('nef', 40 * 1024 * 1024)).toBe(true);
      expect(shouldOffloadToMicroVM('arw', 45 * 1024 * 1024)).toBe(true);
      expect(shouldOffloadToMicroVM('dng', 50 * 1024 * 1024)).toBe(true);
    });

    it('enforces CAD geometry model budget (> 15MB offload)', () => {
      // Below or at budget (<= 15MB)
      expect(shouldOffloadToMicroVM('step', 10 * 1024 * 1024)).toBe(false);
      expect(shouldOffloadToMicroVM('iges', 15 * 1024 * 1024)).toBe(false);
      expect(shouldOffloadToMicroVM('dxf', 5 * 1024 * 1024)).toBe(false);

      // Above budget (> 15MB)
      const cadExceeded = evaluateMicroVMOffload('step', 16 * 1024 * 1024);
      expect(cadExceeded.shouldOffload).toBe(true);
      expect(cadExceeded.category).toBe('cad');
      expect(cadExceeded.reason).toContain('15MB');

      expect(shouldOffloadToMicroVM('iges', 25 * 1024 * 1024)).toBe(true);
      expect(shouldOffloadToMicroVM('stp', 18 * 1024 * 1024)).toBe(true);
      expect(shouldOffloadToMicroVM('brep', 20 * 1024 * 1024)).toBe(true);
    });

    it('enforces Video payload budget (> 100MB offload)', () => {
      // Below or at budget (<= 100MB)
      expect(shouldOffloadToMicroVM('mp4', 80 * 1024 * 1024)).toBe(false);
      expect(shouldOffloadToMicroVM('mov', 100 * 1024 * 1024)).toBe(false);

      // Above budget (> 100MB)
      const videoExceeded = evaluateMicroVMOffload('mp4', 105 * 1024 * 1024);
      expect(videoExceeded.shouldOffload).toBe(true);
      expect(videoExceeded.category).toBe('video');
      expect(videoExceeded.reason).toContain('100MB');

      expect(shouldOffloadToMicroVM('mkv', 150 * 1024 * 1024)).toBe(true);
      expect(shouldOffloadToMicroVM('webm', 120 * 1024 * 1024)).toBe(true);
    });

    it('enforces low-spec device heuristics to avoid tab OOM crash', () => {
      // High-spec client (8 cores, 16GB) handles 10MB docx locally
      expect(
        shouldOffloadToMicroVM('docx', 10 * 1024 * 1024, {}, {
          hardwareConcurrency: 8,
          deviceMemory: 16,
        })
      ).toBe(false);

      // Low-spec client (2 cores) offloads 10MB docx
      const lowCores = evaluateMicroVMOffload('docx', 10 * 1024 * 1024, {}, {
        hardwareConcurrency: 2,
        deviceMemory: 8,
      });
      expect(lowCores.shouldOffload).toBe(true);
      expect(lowCores.category).toBe('low-spec');

      // Low-spec client (2GB RAM) offloads 10MB docx
      const lowRam = evaluateMicroVMOffload('docx', 10 * 1024 * 1024, {}, {
        hardwareConcurrency: 4,
        deviceMemory: 2,
      });
      expect(lowRam.shouldOffload).toBe(true);
      expect(lowRam.category).toBe('low-spec');

      // Small file (< 5MB) on low-spec client does not trigger premature offload
      expect(
        shouldOffloadToMicroVM('docx', 2 * 1024 * 1024, {}, {
          hardwareConcurrency: 2,
          deviceMemory: 2,
        })
      ).toBe(false);
    });
  });

  // ==========================================================================
  // 2. WebGPU Capability Probing Engine
  // ==========================================================================
  describe('WebGPU Capability Probing Engine', () => {
    const originalNavigator = globalThis.navigator;

    afterEach(() => {
      Object.defineProperty(globalThis, 'navigator', {
        value: originalNavigator,
        configurable: true,
        writable: true,
      });
    });

    it('returns false when navigator.gpu is absent (Node / unsupported browser)', async () => {
      expect(checkWebGpuSupport()).toBe(false);
      const caps = await probeWebGpuCapabilities();
      expect(caps.hasWebGpu).toBe(false);
    });

    it('probes adapter limits, features, and compute shader info when WebGPU is available', async () => {
      const mockGpu = {
        requestAdapter: vi.fn().mockResolvedValue({
          limits: {
            maxComputeWorkgroupSizeX: 256,
            maxComputeWorkgroupSizeY: 256,
            maxComputeWorkgroupSizeZ: 64,
            maxComputeInvocationsPerWorkgroup: 256,
            maxBufferSize: 1073741824,
            maxStorageBufferBindingSize: 1073741824,
          },
          features: new Set(['shader-f16', 'timestamp-query']),
          requestAdapterInfo: vi.fn().mockResolvedValue({
            vendor: 'Apple',
            architecture: 'Apple Silicon',
            device: 'Apple M3 Pro',
            description: 'Apple M3 Pro GPU',
          }),
        }),
      };

      Object.defineProperty(globalThis, 'navigator', {
        value: {
          gpu: mockGpu,
          hardwareConcurrency: 12,
        },
        configurable: true,
        writable: true,
      });

      expect(checkWebGpuSupport()).toBe(true);
      const caps = await probeWebGpuCapabilities();

      expect(caps.hasWebGpu).toBe(true);
      expect(caps.adapterInfo?.vendor).toBe('Apple');
      expect(caps.adapterInfo?.architecture).toBe('Apple Silicon');
      expect(caps.limits?.maxComputeWorkgroupSizeX).toBe(256);
      expect(caps.features).toContain('shader-f16');
      expect(caps.supportedShaderFormats).toContain('wgsl');
    });

    it('handles WebGPU requestAdapter returning null gracefully', async () => {
      const mockGpu = {
        requestAdapter: vi.fn().mockResolvedValue(null),
      };

      Object.defineProperty(globalThis, 'navigator', {
        value: { gpu: mockGpu },
        configurable: true,
        writable: true,
      });

      const caps = await probeWebGpuCapabilities();
      expect(caps.hasWebGpu).toBe(false);
    });

    it('integrates WebGPU capabilities into probeEdgeCapabilities', async () => {
      const edgeCaps = await probeEdgeCapabilities();
      expect(typeof edgeCaps.hasWasmSimd).toBe('boolean');
      expect(typeof edgeCaps.hardwareConcurrency).toBe('number');
      expect(edgeCaps.webGpu).toBeDefined();
    });
  });

  // ==========================================================================
  // 3. Level 1A WebGPU Compute Routing & Fallback Cascade
  // ==========================================================================
  describe('L1A WebGPU Compute Routing & Fallback Cascade', () => {
    it('routes to L1A when WebGPU is requested and adapter is available', () => {
      const res = resolveConversionTier('png', 'png', 500_000, {
        useWebGpu: true,
        quantizer: 'oklab',
      }, {
        hasWebGpu: true,
      });

      expect(res.tier).toBe('L1A');
      expect(res.tierName).toBe('Edge L1A (WebGPU Compute)');
      expect(res.isClientEdge).toBe(true);
      expect(res.reason).toContain('WebGPU');
    });

    it('cascades down to L2 Wasm when WebGPU is requested but unavailable', () => {
      const res = resolveConversionTier('png', 'png', 500_000, {
        useWebGpu: true,
        quantizer: 'oklab',
      }, {
        hasWebGpu: false,
      });

      expect(res.tier).toBe('L2');
      expect(res.tierName).toBe('Edge L2 (SIMD Wasm)');
      expect(res.isClientEdge).toBe(true);
    });

    it('routes OKLab heavy image filtering to L1A when WebGPU is available', () => {
      const res = resolveConversionTier('png', 'png', 500_000, {
        palette: true,
        quantizer: 'oklab',
      }, {
        hasWebGpu: true,
      });

      expect(res.tier).toBe('L1A');
      expect(res.tierName).toBe('Edge L1A (WebGPU Compute)');
    });

    it('routes OKLab heavy image filtering to L2 when WebGPU is not available', () => {
      const res = resolveConversionTier('png', 'png', 500_000, {
        palette: true,
        quantizer: 'oklab',
      }, {
        hasWebGpu: false,
      });

      expect(res.tier).toBe('L2');
      expect(res.tierName).toBe('Edge L2 (SIMD Wasm)');
    });

    it('routes basic image transcoding to L0 Canvas when canvas is available and no filters requested', () => {
      const res = resolveConversionTier('png', 'jpg', 500_000, {}, {
        hasCanvas: true,
      });
      expect(res.tier).toBe('L0');
      expect(res.tierName).toBe('Edge L0 (Instant)');
    });

    it('ensures L1A WebGPU takes precedence over L0 Canvas when WebGPU compute is requested', () => {
      const res = resolveConversionTier('png', 'png', 500_000, {
        useWebGpu: true,
        quantizer: 'oklab',
      }, {
        hasCanvas: true,
        hasWebGpu: true,
      });
      expect(res.tier).toBe('L1A');
      expect(res.tierName).toBe('Edge L1A (WebGPU Compute)');
    });

    it('ensures L2 Wasm cascade takes precedence over L0 Canvas when WebGPU is unavailable but filters are requested', () => {
      const res = resolveConversionTier('png', 'png', 500_000, {
        useWebGpu: true,
        quantizer: 'oklab',
      }, {
        hasCanvas: true,
        hasWebGpu: false,
      });
      expect(res.tier).toBe('L2');
      expect(res.tierName).toBe('Edge L2 (SIMD Wasm)');
    });

    it('ensures blue-noise dither method routes to L2 Wasm rather than being intercepted by L0 Canvas', () => {
      const res = resolveConversionTier('png', 'png', 500_000, {
        ditherMethod: 'blue-noise',
      }, {
        hasCanvas: true,
      });
      expect(res.tier).toBe('L2');
      expect(res.tierName).toBe('Edge L2 (SIMD Wasm)');
    });

    it('resolves L1A by probing checkWebGpuSupport when capabilities argument is omitted', () => {
      const originalGpu = (globalThis as any).navigator?.gpu;
      try {
        (globalThis as any).navigator = {
          ...((globalThis as any).navigator || {}),
          gpu: { requestAdapter: () => Promise.resolve(null) },
        };
        const res = resolveConversionTier('png', 'png', 500_000, {
          useWebGpu: true,
        });
        expect(res.tier).toBe('L1A');
      } finally {
        if (originalGpu !== undefined) {
          (globalThis as any).navigator.gpu = originalGpu;
        } else if ((globalThis as any).navigator) {
          delete (globalThis as any).navigator.gpu;
        }
      }
    });
  });

  // ==========================================================================
  // 4. End-to-End Tier Router Budget Integration & Fail-Closed Protection
  // ==========================================================================
  describe('Budget Offloading & Fail-Closed Validation', () => {
    it('routes payload exceeding Section 7 budget to L4 Cloud MicroVM', () => {
      // 35MB Office docx exceeds 30MB budget
      const res = resolveConversionTier('docx', 'pdf', 35 * 1024 * 1024);
      expect(res.tier).toBe('L4');
      expect(res.tierName).toBe('Cloud (Zero-Retention)');
      expect(res.isClientEdge).toBe(false);
      expect(res.reason).toContain('30MB');
    });

    it('routes payload within budget to local client edge tier', () => {
      // 10MB PDF document stays within budget -> L2 SIMD Wasm
      const res = resolveConversionTier('pdf', 'docx', 10 * 1024 * 1024);
      expect(res.tier).toBe('L2');
      expect(res.tierName).toBe('Edge L2 (SIMD Wasm)');
      expect(res.isClientEdge).toBe(true);
    });

    it('enforces fail-closed refusal when clientEdgeMode === true and payload exceeds budget', () => {
      expect(() => {
        validateExecutionPolicy('docx', 'pdf', 35 * 1024 * 1024, {
          clientEdgeMode: true,
        });
      }).toThrow(EdgeConversionRefusalError);
    });
  });
});
