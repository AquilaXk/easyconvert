import { describe, it, expect, beforeEach } from 'vitest';
import {
  createBoundedWasmMemory,
  applyRgbaGrayscale,
  applyRgbaInvert,
  applyRgbaBrightness,
  WasmEngine,
} from '../src/lib/edge/workers/wasm-engine.worker';
import {
  detectWasmExecutionMode,
  WasmModuleCache,
  WasmWorkerManager,
  executeWasmTask,
} from '../src/lib/edge/pipelines/wasm-simd-pipeline';
import { resolveConversionTier, checkWasmSimdSupport } from '../src/lib/edge/tier-router';

describe('Phase 3: Zero-COOP Single-Threaded SIMD Wasm & Module Caching (L2)', () => {
  beforeEach(async () => {
    await WasmModuleCache.clearCache();
    WasmWorkerManager.recycleWorker();
  });

  describe('1. Dual-Mode Runtime Detection & SIMD Validation', () => {
    it('detects runtime execution mode and SIMD bytecode validation capability', () => {
      const modeInfo = detectWasmExecutionMode();
      expect(modeInfo).toBeDefined();
      expect(['isolated-threads', 'zero-coop-transferable']).toContain(modeInfo.mode);
      expect(typeof modeInfo.hasSimd).toBe('boolean');
    });

    it('validates SIMD-128 opcode execution support without throwing', () => {
      const simdSupported = checkWasmSimdSupport();
      expect(typeof simdSupported).toBe('boolean');
    });

    it('creates bounded WebAssembly.Memory with initial and maximum page limits', () => {
      const memory = createBoundedWasmMemory(16, 64);
      expect(memory).toBeInstanceOf(WebAssembly.Memory);
      // 16 pages * 64KB = 1,048,576 bytes
      expect(memory.buffer.byteLength).toBe(16 * 65536);
    });
  });

  describe('2. 2-Tier WebAssembly Module Caching', () => {
    // Minimal valid Wasm module bytes: magic '\0asm' (0x00 0x61 0x73 0x6d) + version 1 (0x01 0x00 0x00 0x00)
    const minimalWasm = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

    it('compiles and caches Wasm module in Tier 1 memory on first call', async () => {
      const module1 = await WasmModuleCache.compileAndCache('test-module-1', minimalWasm.buffer);
      expect(module1).toBeInstanceOf(WebAssembly.Module);

      const moduleCached = await WasmModuleCache.getModule('test-module-1');
      expect(moduleCached).toBe(module1);
    });

    it('returns null on cache miss', async () => {
      const missing = await WasmModuleCache.getModule('non-existent-module-id');
      expect(missing).toBeNull();
    });

    it('flushes memory and persistent caches on clearCache()', async () => {
      await WasmModuleCache.compileAndCache('test-module-flush', minimalWasm.buffer);
      await WasmModuleCache.clearCache();
      const afterClear = await WasmModuleCache.getModule('test-module-flush');
      expect(afterClear).toBeNull();
    });
  });

  describe('3. SIMD Vector Transformations & Fixed-Point Mathematics', () => {
    it('accurately computes grayscale luminance using fixed-point integer math', () => {
      // 3 pixels: Pure Red, Pure Green, Pure Blue
      const input = new Uint8Array([
        255, 0, 0, 255,
        0, 255, 0, 255,
        0, 0, 255, 255,
      ]);

      const output = applyRgbaGrayscale(input);
      expect(output).toHaveLength(12);

      // Red: (77 * 255) >> 8 = 76
      expect(output[0]).toBe(76);
      expect(output[1]).toBe(76);
      expect(output[2]).toBe(76);
      expect(output[3]).toBe(255); // Alpha preserved

      // Green: (150 * 255) >> 8 = 149
      expect(output[4]).toBe(149);
      expect(output[5]).toBe(149);
      expect(output[6]).toBe(149);
      expect(output[7]).toBe(255);

      // Blue: (29 * 255) >> 8 = 28
      expect(output[8]).toBe(28);
      expect(output[9]).toBe(28);
      expect(output[10]).toBe(28);
      expect(output[11]).toBe(255);
    });

    it('inverts RGBA channels while preserving alpha transparency', () => {
      const input = new Uint8Array([10, 50, 200, 128]);
      const output = applyRgbaInvert(input);

      expect(output[0]).toBe(245);
      expect(output[1]).toBe(205);
      expect(output[2]).toBe(55);
      expect(output[3]).toBe(128);
    });

    it('adjusts brightness with positive and negative deltas with clamping', () => {
      const input = new Uint8Array([10, 240, 100, 255]);

      // Brighten +30
      const bright = applyRgbaBrightness(input, 30);
      expect(bright[0]).toBe(40);
      expect(bright[1]).toBe(255); // Clamped at 255
      expect(bright[2]).toBe(130);
      expect(bright[3]).toBe(255);

      // Darken -30
      const dark = applyRgbaBrightness(input, -30);
      expect(dark[0]).toBe(0); // Clamped at 0
      expect(dark[1]).toBe(210);
      expect(dark[2]).toBe(70);
      expect(dark[3]).toBe(255);
    });
  });

  describe('4. WasmEngine Lifecycle, IPC & Statistics', () => {
    it('executes tasks and updates memory and task counters', async () => {
      const engine = new WasmEngine();
      const initialStats = engine.getStats();
      expect(initialStats.cumulativeBytes).toBe(0);
      expect(initialStats.tasksCompleted).toBe(0);

      const buffer = new Uint8Array([100, 100, 100, 255, 200, 200, 200, 255]).buffer;
      const result = await engine.executeTask({
        jobId: 'wasm-test-1',
        task: 'rgba-invert',
        buffer,
      });

      expect(result.jobId).toBe('wasm-test-1');
      expect(result.bytesProcessed).toBe(8);

      const updatedStats = engine.getStats();
      expect(updatedStats.cumulativeBytes).toBe(8);
      expect(updatedStats.tasksCompleted).toBe(1);
    });

    it('fails closed on unknown task type', async () => {
      const engine = new WasmEngine();
      const buffer = new ArrayBuffer(16);

      await expect(
        engine.executeTask({
          jobId: 'bad-task',
          task: 'non-existent-task' as any,
          buffer,
        })
      ).rejects.toThrow(/Unknown Wasm task/);
    });
  });

  describe('5. Worker Manager & Automatic Recycling', () => {
    it('tracks processed bytes and completed tasks across multiple executions', async () => {
      expect(WasmWorkerManager.processedBytesCount).toBe(0);
      expect(WasmWorkerManager.completedTaskCount).toBe(0);

      const buf1 = new Uint8Array([50, 100, 150, 255]).buffer;
      await executeWasmTask('rgba-grayscale', buf1);

      expect(WasmWorkerManager.processedBytesCount).toBe(4);
      expect(WasmWorkerManager.completedTaskCount).toBe(1);

      const buf2 = new Uint8Array([10, 20, 30, 255, 40, 50, 60, 255]).buffer;
      await executeWasmTask('rgba-invert', buf2);

      expect(WasmWorkerManager.processedBytesCount).toBe(12);
      expect(WasmWorkerManager.completedTaskCount).toBe(2);
    });

    it('recycles worker and resets metrics when recycleWorker() is invoked', async () => {
      const buf = new Uint8Array([1, 2, 3, 4]).buffer;
      await executeWasmTask('rgba-grayscale', buf);
      expect(WasmWorkerManager.completedTaskCount).toBe(1);

      WasmWorkerManager.recycleWorker();
      expect(WasmWorkerManager.completedTaskCount).toBe(0);
      expect(WasmWorkerManager.processedBytesCount).toBe(0);
    });

    it('delivers progress updates during execution from 5% to 100%', async () => {
      const progressList: number[] = [];
      const buf = new Uint8Array([10, 20, 30, 255]).buffer;

      await executeWasmTask('rgba-brightness', buf, { brightnessDelta: 15 }, (p) => {
        progressList.push(p);
      });

      expect(progressList.length).toBeGreaterThanOrEqual(3);
      expect(progressList[0]).toBe(5);
      expect(progressList[progressList.length - 1]).toBe(100);
    });
  });

  describe('6. Tier Router Level 2 Routing', () => {
    it('routes OCR-enabled tasks to Level 2 (Edge L2 SIMD Wasm)', () => {
      const res = resolveConversionTier('png', 'txt', 500_000, { ocrEnabled: true });
      expect(res.tier).toBe('L2');
      expect(res.tierName).toBe('Edge L2 (SIMD Wasm)');
      expect(res.isClientEdge).toBe(true);
    });

    it('routes PDF source processing to Level 2', () => {
      const res = resolveConversionTier('pdf', 'docx', 1_000_000, {});
      expect(res.tier).toBe('L2');
      expect(res.tierName).toBe('Edge L2 (SIMD Wasm)');
      expect(res.isClientEdge).toBe(true);
    });
  });
});
