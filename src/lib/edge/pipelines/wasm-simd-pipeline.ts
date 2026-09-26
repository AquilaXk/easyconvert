/**
 * SIMD WebAssembly Pipeline Controller & 2-Tier Module Caching (Level 2 - L2)
 *
 * Implements:
 * 1. 2-Tier module caching (Tier 1: In-Memory Map, Tier 2: IndexedDB Bytecode Cache).
 * 2. Dual-mode detection: Zero-COOP Transferable Objects vs isolated SharedArrayBuffer.
 * 3. Dynamic Worker pooling with automatic recycling to prevent V8 heap fragmentation.
 * 4. High-performance Transferable Objects IPC.
 */

import { checkWasmSimdSupport } from '../tier-router';
import {
  isCrossOriginIsolated,
  WasmEngine,
  WasmTaskResult,
} from '../workers/wasm-engine.worker';

export interface WasmExecutionInfo {
  mode: 'isolated-threads' | 'zero-coop-transferable';
  hasSimd: boolean;
  isCrossOriginIsolated: boolean;
}

export interface WasmPipelineOptions {
  brightnessDelta?: number;
  width?: number;
  height?: number;
  customWasmBytes?: ArrayBuffer;
}

export interface WasmPipelineResult {
  buffer: ArrayBuffer;
  bytesProcessed: number;
  executionMode: 'isolated-threads' | 'zero-coop-transferable';
  simdUsed: boolean;
}

/**
 * 2-Tier WebAssembly Module Cache.
 * Tier 1: In-memory Map cache.
 * Tier 2: IndexedDB persistent key-value storage.
 */
export class WasmModuleCache {
  private static memoryCache = new Map<string, WebAssembly.Module>();
  private static readonly DB_NAME = 'easyconvert_wasm_cache';
  private static readonly STORE_NAME = 'wasm_modules';

  /**
   * Retrieves compiled WebAssembly.Module from Tier 1 (Memory) or Tier 2 (IndexedDB).
   */
  public static async getModule(id: string): Promise<WebAssembly.Module | null> {
    // 1. Check Tier 1 memory cache
    const memCached = this.memoryCache.get(id);
    if (memCached) {
      return memCached;
    }

    // 2. Check Tier 2 IndexedDB cache
    if (typeof indexedDB === 'undefined') {
      return null;
    }

    try {
      const wasmModule = await this.getFromIndexedDb(id);
      if (wasmModule) {
        this.memoryCache.set(id, wasmModule);
        return wasmModule;
      }
    } catch {
      // IndexedDB failure gracefully ignored
    }

    return null;
  }

  /**
   * Caches compiled WebAssembly.Module into Tier 1 and Tier 2.
   */
  public static async setModule(id: string, wasmModule: WebAssembly.Module): Promise<void> {
    this.memoryCache.set(id, wasmModule);

    if (typeof indexedDB === 'undefined') {
      return;
    }

    try {
      await this.saveToIndexedDb(id, wasmModule);
    } catch {
      // Graceful fallback if IndexedDB is unavailable or storage quota exceeded
    }
  }

  /**
   * Compiles Wasm bytecode and caches it in both tiers.
   */
  public static async compileAndCache(id: string, wasmBytes: ArrayBuffer): Promise<WebAssembly.Module> {
    const existing = await this.getModule(id);
    if (existing) {
      return existing;
    }

    const wasmModule = await WebAssembly.compile(wasmBytes);
    await this.setModule(id, wasmModule);
    return wasmModule;
  }

  /**
   * Clears both memory and IndexedDB caches.
   */
  public static async clearCache(): Promise<void> {
    this.memoryCache.clear();

    if (typeof indexedDB === 'undefined') {
      return;
    }

    await new Promise<void>((resolve) => {
      try {
        const req = indexedDB.deleteDatabase(this.DB_NAME);
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
        req.onblocked = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  private static openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(this.STORE_NAME)) {
          db.createObjectStore(this.STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  private static async getFromIndexedDb(id: string): Promise<WebAssembly.Module | null> {
    const db = await this.openDb();
    return new Promise((resolve) => {
      const tx = db.transaction(this.STORE_NAME, 'readonly');
      const store = tx.objectStore(this.STORE_NAME);
      const req = store.get(id);
      req.onsuccess = () => {
        resolve(req.result instanceof WebAssembly.Module ? req.result : null);
      };
      req.onerror = () => resolve(null);
    });
  }

  private static async saveToIndexedDb(id: string, module: WebAssembly.Module): Promise<void> {
    const db = await this.openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.STORE_NAME, 'readwrite');
      const store = tx.objectStore(this.STORE_NAME);
      const req = store.put(module, id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }
}

/**
 * Detects the runtime execution mode for WebAssembly tasks.
 */
export function detectWasmExecutionMode(): WasmExecutionInfo {
  const hasSimd = checkWasmSimdSupport();
  const isolated = isCrossOriginIsolated();

  return {
    mode: isolated ? 'isolated-threads' : 'zero-coop-transferable',
    hasSimd,
    isCrossOriginIsolated: isolated,
  };
}

/**
 * Managed Worker Pool for SIMD Wasm Execution with Automatic Recycling.
 */
export class WasmWorkerManager {
  private static activeWorker: Worker | null = null;
  private static processedBytes: number = 0;
  private static taskCount: number = 0;
  private static readonly RECYCLE_BYTE_THRESHOLD = 256 * 1024 * 1024; // 256 MB
  private static readonly RECYCLE_TASK_THRESHOLD = 50;
  private static inProcessEngine = new WasmEngine();

  public static get processedBytesCount(): number {
    return this.processedBytes;
  }

  public static get completedTaskCount(): number {
    return this.taskCount;
  }

  /**
   * Recycles the active worker to release V8 heap memory.
   */
  public static recycleWorker(): void {
    if (this.activeWorker) {
      this.activeWorker.terminate();
      this.activeWorker = null;
    }
    this.processedBytes = 0;
    this.taskCount = 0;
    this.inProcessEngine = new WasmEngine();
  }

  /**
   * Executes a Wasm task either via dedicated worker or in-process engine.
   */
  public static async execute(
    task: 'rgba-grayscale' | 'rgba-invert' | 'rgba-brightness' | 'custom-module',
    buffer: ArrayBuffer,
    options?: WasmPipelineOptions,
    onProgress?: (progress: number) => void
  ): Promise<WasmPipelineResult> {
    const jobId =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? `wasm-${crypto.randomUUID()}`
        : `wasm-${Date.now()}`;

    // Check recycling thresholds
    if (
      this.processedBytes >= this.RECYCLE_BYTE_THRESHOLD ||
      this.taskCount >= this.RECYCLE_TASK_THRESHOLD
    ) {
      this.recycleWorker();
    }

    onProgress?.(5);

    // Browser environment with Worker support
    if (typeof window !== 'undefined' && typeof Worker !== 'undefined') {
      try {
        if (!this.activeWorker) {
          this.activeWorker = new Worker(
            new URL('../workers/wasm-engine.worker.ts', import.meta.url),
            { type: 'module' }
          );
        }

        const result = await this.sendToWorker(this.activeWorker, jobId, task, buffer, options, onProgress);
        this.processedBytes += result.bytesProcessed;
        this.taskCount += 1;
        return result;
      } catch {
        // Fallback to in-process execution on worker fault
      }
    }

    // In-process fallback (Node.js or test environment)
    const result: WasmTaskResult = await this.inProcessEngine.executeTask(
      { jobId, task, buffer, options },
      onProgress
    );
    this.processedBytes += result.bytesProcessed;
    this.taskCount += 1;

    return {
      buffer: result.buffer,
      bytesProcessed: result.bytesProcessed,
      executionMode: result.executionMode,
      simdUsed: result.simdUsed,
    };
  }

  private static sendToWorker(
    worker: Worker,
    jobId: string,
    task: string,
    buffer: ArrayBuffer,
    options?: WasmPipelineOptions,
    onProgress?: (p: number) => void
  ): Promise<WasmPipelineResult> {
    return new Promise((resolve, reject) => {
      let isSettled = false;

      const messageHandler = (e: MessageEvent) => {
        const data = e.data;
        if (data?.jobId !== jobId) return;

        if (data.type === 'PROGRESS') {
          onProgress?.(data.progress);
        } else if (data.type === 'COMPLETED') {
          if (isSettled) return;
          isSettled = true;
          worker.removeEventListener('message', messageHandler);
          resolve({
            buffer: data.buffer,
            bytesProcessed: data.bytesProcessed,
            executionMode: data.executionMode,
            simdUsed: data.simdUsed,
          });
        } else if (data.type === 'ERROR') {
          if (isSettled) return;
          isSettled = true;
          worker.removeEventListener('message', messageHandler);
          reject(new Error(data.message || 'Wasm Worker execution error'));
        }
      };

      worker.addEventListener('message', messageHandler);

      // Transfer buffer to worker
      worker.postMessage(
        {
          type: 'EXECUTE',
          jobId,
          task,
          buffer,
          options,
        },
        [buffer]
      );
    });
  }
}

/**
 * Public execution helper for SIMD Wasm operations.
 */
export async function executeWasmTask(
  task: 'rgba-grayscale' | 'rgba-invert' | 'rgba-brightness' | 'custom-module',
  buffer: ArrayBuffer,
  options?: WasmPipelineOptions,
  onProgress?: (progress: number) => void
): Promise<WasmPipelineResult> {
  return WasmWorkerManager.execute(task, buffer, options, onProgress);
}
