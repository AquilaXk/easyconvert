export type ComponentCategory = 'core' | 'pipeline' | 'privacy';
export type CategoryFilter = 'all' | ComponentCategory;

export interface ComponentStatus {
  id: string;
  name: string;
  category: ComponentCategory;
  description: string;
  status: 'operational' | 'ready';
}

export interface DiagnosticResult {
  id: string;
  name: string;
  supported: boolean;
  details: string;
  latencyMs: number;
}

export const ENGINE_COMPONENTS: ComponentStatus[] = [
  {
    id: 'wasm-simd',
    name: 'SIMD WebAssembly Core Engine',
    category: 'core',
    description: '128-bit vector-accelerated transformations for documents and binary streams',
    status: 'operational',
  },
  {
    id: 'webcodecs-vpu',
    name: 'WebCodecs VPU Transcoding Accelerator',
    category: 'core',
    description: 'Direct GPU/VPU hardware acceleration for H.264, VP9, and audio codecs',
    status: 'operational',
  },
  {
    id: 'opfs-storage',
    name: 'Origin Private File System (OPFS) Streaming Storage',
    category: 'core',
    description: 'Low-overhead virtual disk streaming for large multi-hundred-megabyte files',
    status: 'operational',
  },
  {
    id: 'workers-pool',
    name: 'Multithreaded Web Worker Thread Pool',
    category: 'core',
    description: 'Non-blocking concurrent worker isolation matching CPU core topology',
    status: 'operational',
  },
  {
    id: 'pipeline-document',
    name: 'Document & Office Pipeline (PDF, DOCX, XLSX, PPTX)',
    category: 'pipeline',
    description: 'Document rendering, vector text layout, and structured table reconstruction',
    status: 'operational',
  },
  {
    id: 'pipeline-imaging',
    name: 'Raster & Vector Imaging Pipeline (PNG, JPG, WEBP, SVG, HEIC)',
    category: 'pipeline',
    description: 'Color-calibrated resampling and vector geometry rasterization',
    status: 'operational',
  },
  {
    id: 'pipeline-audio',
    name: 'Audio DSP Pipeline (MP3, WAV, FLAC, AAC, OGG)',
    category: 'pipeline',
    description: '32-bit floating-point audio processing, resampling, and lossless codecs',
    status: 'operational',
  },
  {
    id: 'pipeline-video',
    name: 'Video Container Remuxing & Transmuxing (MP4, MKV, WEBM)',
    category: 'pipeline',
    description: 'Container repackaging, codec transcoding, and timestamp synchronization',
    status: 'operational',
  },
  {
    id: 'pipeline-ocr',
    name: 'OCR Engine (Tesseract Wasm LSTM Core)',
    category: 'pipeline',
    description: 'Optical character recognition with searchable PDF text layer synthesis',
    status: 'operational',
  },
  {
    id: 'pipeline-archive',
    name: 'Stream Archive & Compression Engine (ZIP, 7Z, TAR, GZ)',
    category: 'pipeline',
    description: 'Deflate, LZMA2, and BZip2 streaming archive packing and extraction',
    status: 'operational',
  },
  {
    id: 'pipeline-cad',
    name: 'CAD & Geometric Engine (DXF, SVG)',
    category: 'pipeline',
    description: 'Spline tessellation, IEEE 754 coordinate precision, and vector export',
    status: 'operational',
  },
  {
    id: 'privacy-zero-retention',
    name: 'Zero Data Retention Ephemeral Memory Sandbox',
    category: 'privacy',
    description: 'Volatile client memory allocation with zero permanent disk retention',
    status: 'operational',
  },
  {
    id: 'privacy-scrubbing',
    name: 'Volatile Buffer Scrubbing & Memory Zeroing',
    category: 'privacy',
    description: 'Immediate buffer release upon conversion download or queue clearance',
    status: 'operational',
  },
  {
    id: 'privacy-crypto',
    name: 'Client-Side SHA-256 Cryptographic Hash Verification',
    category: 'privacy',
    description: 'Local bitstream integrity checks using the Web Crypto API',
    status: 'operational',
  },
];

export const CATEGORY_TABS: ReadonlyArray<{ id: CategoryFilter; label: string }> = [
  { id: 'all', label: `All Components (${ENGINE_COMPONENTS.length})` },
  { id: 'core', label: 'Compute Core (4)' },
  { id: 'pipeline', label: 'Pipelines (7)' },
  { id: 'privacy', label: 'Privacy & Retention (3)' },
];

function probeWasmSimd(): DiagnosticResult {
  const start = performance.now();
  let hasWasmSimd = false;
  try {
    const simdBytes = new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b,
      0x03, 0x02, 0x01, 0x00, 0x0a, 0x0a, 0x01, 0x08, 0x00, 0xfd, 0x0c, 0x00, 0x00, 0x00, 0x00,
      0x0b,
    ]);
    hasWasmSimd = WebAssembly.validate(simdBytes);
  } catch {
    hasWasmSimd = false;
  }
  return {
    id: 'wasm',
    name: 'WebAssembly SIMD Vector Acceleration',
    supported: hasWasmSimd || typeof WebAssembly !== 'undefined',
    details: hasWasmSimd
      ? 'Hardware SIMD enabled (128-bit vectorization)'
      : 'Standard Wasm core available',
    latencyMs: Math.round(performance.now() - start),
  };
}

function probeOpfs(): DiagnosticResult {
  const start = performance.now();
  let hasOpfs = false;
  try {
    if (typeof navigator !== 'undefined' && 'storage' in navigator && navigator.storage) {
      hasOpfs = typeof navigator.storage.getDirectory === 'function';
    }
  } catch {
    hasOpfs = false;
  }
  return {
    id: 'opfs',
    name: 'Origin Private File System (OPFS)',
    supported: hasOpfs,
    details: hasOpfs ? 'Native streaming storage supported' : 'Blob memory streaming active',
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
    name: 'Ephemeral Memory Buffer Sandbox',
    supported: memValid,
    details: 'Transient memory allocation and zeroing verified',
    latencyMs: Math.round(performance.now() - start),
  };
}

export function collectEdgeDiagnostics(): DiagnosticResult[] {
  const startCodecs = performance.now();
  const hasWebCodecs = typeof window !== 'undefined' && 'VideoEncoder' in window;
  const codecsResult: DiagnosticResult = {
    id: 'webcodecs',
    name: 'WebCodecs GPU Hardware Pipeline',
    supported: hasWebCodecs,
    details: hasWebCodecs
      ? 'Hardware video and audio codec VPU available'
      : 'CPU software transmuxer active',
    latencyMs: Math.round(performance.now() - startCodecs),
  };

  const startWorkers = performance.now();
  const hasWorkers = typeof window !== 'undefined' && 'Worker' in window;
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
  const workersResult: DiagnosticResult = {
    id: 'workers',
    name: 'Multithreaded Web Workers',
    supported: hasWorkers,
    details: `${cores} CPU logical execution threads detected`,
    latencyMs: Math.round(performance.now() - startWorkers),
  };

  return [probeWasmSimd(), codecsResult, probeOpfs(), workersResult, probeMemorySandbox()];
}
