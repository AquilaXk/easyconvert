import { checkOpfsSupport, checkWasmSimdSupport } from '@/lib/edge/tier-router';

export type ComponentCategory = 'core' | 'pipeline' | 'privacy';
export type CategoryFilter = 'all' | ComponentCategory;

/** An engine component; its name and description are `status.components.<id>` in the messages. */
export interface ComponentStatus {
  id: ComponentId;
  category: ComponentCategory;
  status: 'operational' | 'ready';
}

export type ComponentId =
  | 'wasm-simd' | 'webcodecs-vpu' | 'opfs-storage' | 'workers-pool'
  | 'pipeline-document' | 'pipeline-imaging' | 'pipeline-audio' | 'pipeline-video' | 'pipeline-ocr' | 'pipeline-archive' | 'pipeline-cad'
  | 'privacy-in-browser' | 'privacy-scrubbing' | 'privacy-crypto';

export type DiagnosticId = 'wasm' | 'webcodecs' | 'opfs' | 'workers' | 'memory-sandbox';

/** A capability probe; its name and the sentence for each outcome are `status.diagnostics.<id>` in the messages. */
export interface DiagnosticResult {
  id: DiagnosticId;
  supported: boolean;
  latencyMs: number;
  /** Logical threads the browser reports, for the worker probe. */
  cores?: number;
}

export const ENGINE_COMPONENTS: ComponentStatus[] = [
  {
    id: 'wasm-simd',
    category: 'core',
    status: 'operational',
  },
  {
    id: 'webcodecs-vpu',
    category: 'core',
    status: 'operational',
  },
  {
    id: 'opfs-storage',
    category: 'core',
    status: 'operational',
  },
  {
    id: 'workers-pool',
    category: 'core',
    status: 'operational',
  },
  {
    id: 'pipeline-document',
    category: 'pipeline',
    status: 'operational',
  },
  {
    id: 'pipeline-imaging',
    category: 'pipeline',
    status: 'operational',
  },
  {
    id: 'pipeline-audio',
    category: 'pipeline',
    status: 'operational',
  },
  {
    id: 'pipeline-video',
    category: 'pipeline',
    status: 'operational',
  },
  {
    id: 'pipeline-ocr',
    category: 'pipeline',
    status: 'operational',
  },
  {
    id: 'pipeline-archive',
    category: 'pipeline',
    status: 'operational',
  },
  {
    id: 'pipeline-cad',
    category: 'pipeline',
    status: 'operational',
  },
  {
    id: 'privacy-in-browser',
    category: 'privacy',
    status: 'operational',
  },
  {
    id: 'privacy-scrubbing',
    category: 'privacy',
    status: 'operational',
  },
  {
    id: 'privacy-crypto',
    category: 'privacy',
    status: 'operational',
  },
];

/** The category filters, each with how many components it shows; the label is `status.categories.<id>`. */
export const CATEGORY_TABS: ReadonlyArray<{ id: CategoryFilter; count: number }> = [
  { id: 'all', count: ENGINE_COMPONENTS.length },
  { id: 'core', count: 4 },
  { id: 'pipeline', count: 7 },
  { id: 'privacy', count: 3 },
];

export function probeWasmSimd(): DiagnosticResult {
  const start = performance.now();
  const hasWasmSimd = checkWasmSimdSupport();
  return {
    id: 'wasm',
    supported: hasWasmSimd,
    latencyMs: Math.round(performance.now() - start),
  };
}

function probeOpfs(): DiagnosticResult {
  const start = performance.now();
  let hasOpfs = false;
  try {
    hasOpfs = checkOpfsSupport();
  } catch {
    hasOpfs = false;
  }
  return {
    id: 'opfs',
    supported: hasOpfs,
    latencyMs: Math.round(performance.now() - start),
  };
}

function probeMemorySandbox(): DiagnosticResult {
  const start = performance.now();
  let memValid = true;
  try {
    const buf = new Uint8Array(1024 * 1024 * 2);
    buf.fill(0x5c);
    buf.fill(0);
  } catch {
    memValid = false;
  }
  return {
    id: 'memory-sandbox',
    supported: memValid,
    latencyMs: Math.round(performance.now() - start),
  };
}

export function collectEdgeDiagnostics(): DiagnosticResult[] {
  const startCodecs = performance.now();
  const hasWebCodecs = typeof window !== 'undefined' && 'VideoEncoder' in window;
  const codecsResult: DiagnosticResult = {
    id: 'webcodecs',
    supported: hasWebCodecs,
    latencyMs: Math.round(performance.now() - startCodecs),
  };

  const startWorkers = performance.now();
  const hasWorkers = typeof window !== 'undefined' && 'Worker' in window;
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
  const workersResult: DiagnosticResult = {
    id: 'workers',
    supported: hasWorkers,
    cores,
    latencyMs: Math.round(performance.now() - startWorkers),
  };

  return [probeWasmSimd(), codecsResult, probeOpfs(), workersResult, probeMemorySandbox()];
}
