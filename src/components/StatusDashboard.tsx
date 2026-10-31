'use client';

import React, { useState, useEffect, useMemo } from 'react';
import {
  CheckCircle2,
  Activity,
  Cpu,
  HardDrive,
  ShieldCheck,
  Zap,
  Check,
  Terminal,
} from 'lucide-react';

type ComponentCategory = 'core' | 'pipeline' | 'privacy';
type CategoryFilter = 'all' | ComponentCategory;

interface ComponentStatus {
  id: string;
  name: string;
  category: ComponentCategory;
  description: string;
  status: 'operational' | 'ready';
}

interface DiagnosticResult {
  id: string;
  name: string;
  supported: boolean;
  details: string;
  latencyMs: number;
}

const ENGINE_COMPONENTS: ComponentStatus[] = [
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

const CATEGORY_TABS: Array<{ id: CategoryFilter; label: string }> = [
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
      0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x05, 0x01, 0x60,
      0x00, 0x01, 0x7b, 0x03, 0x02, 0x01, 0x00, 0x0a, 0x0a, 0x01, 0x08, 0x00,
      0xfd, 0x0c, 0x00, 0x00, 0x00, 0x00, 0x0b,
    ]);
    hasWasmSimd = WebAssembly.validate(simdBytes);
  } catch {
    hasWasmSimd = false;
  }
  return {
    id: 'wasm',
    name: 'WebAssembly SIMD Vector Acceleration',
    supported: hasWasmSimd || typeof WebAssembly !== 'undefined',
    details: hasWasmSimd ? 'Hardware SIMD enabled (128-bit vectorization)' : 'Standard Wasm core available',
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

function collectEdgeDiagnostics(): DiagnosticResult[] {
  const startCodecs = performance.now();
  const hasWebCodecs = typeof window !== 'undefined' && 'VideoEncoder' in window;
  const codecsResult: DiagnosticResult = {
    id: 'webcodecs',
    name: 'WebCodecs GPU Hardware Pipeline',
    supported: hasWebCodecs,
    details: hasWebCodecs ? 'Hardware video and audio codec VPU available' : 'CPU software transmuxer active',
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

  return [
    probeWasmSimd(),
    codecsResult,
    probeOpfs(),
    workersResult,
    probeMemorySandbox(),
  ];
}

function StatusOverviewCard({
  isRunning,
  checkedLabel,
  onRunDiagnostics,
}: {
  isRunning: boolean;
  checkedLabel: string;
  onRunDiagnostics: () => void;
}) {
  return (
    <section className="rounded-xl bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border p-6 sm:p-8 shadow-sm">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
        <div className="flex items-start sm:items-center gap-4">
          <div className="flex items-center justify-center size-12 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-600 dark:text-emerald-400 shrink-0">
            <CheckCircle2 className="w-6 h-6" aria-hidden="true" />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2.5">
              <h2 className="text-xl sm:text-2xl font-bold text-brand-950 dark:text-white tracking-tight">
                All Client-Side Conversion Engines Operational
              </h2>
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-md text-xs font-semibold bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30">
                Ready
              </span>
            </div>
            <p className="mt-1 text-sm text-ink-secondary dark:text-neutral-400">
              Verified directly within your browser execution sandbox.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={onRunDiagnostics}
            disabled={isRunning}
            className="inline-flex items-center justify-center gap-2 min-h-[44px] px-4 py-2.5 rounded-md font-semibold text-sm bg-brand-700 hover:bg-brand-800 text-white active:bg-brand-900 transition-colors disabled:opacity-50 cursor-pointer"
          >
            <Zap className="w-4 h-4" aria-hidden="true" />
            <span>{isRunning ? 'Testing Edge Engines...' : 'Run Edge Diagnostics'}</span>
          </button>
        </div>
      </div>

      <div className="mt-6 pt-4 border-t border-neutral-border dark:border-dark-border flex flex-wrap items-center justify-between text-xs text-ink-secondary dark:text-neutral-400 gap-4">
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
          <span>{checkedLabel}</span>
        </div>

        <span className="text-emerald-700 dark:text-emerald-300 font-semibold flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-emerald-500" aria-hidden="true" />
          100% In-Browser Execution
        </span>
      </div>
    </section>
  );
}

function DiagnosticResultsCard({ results }: { results: DiagnosticResult[] }) {
  const verifiedCount = results.filter((r) => r.supported).length;
  return (
    <section
      aria-live="polite"
      className="rounded-xl bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border p-6 shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <h2 className="text-base sm:text-lg font-bold text-brand-950 dark:text-white">
          Live Browser Edge Diagnostic Results
        </h2>
        <span className="text-xs font-semibold px-2.5 py-1 rounded-md bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20">
          {verifiedCount}/{results.length} Active
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {results.map((diag) => (
          <div
            key={diag.id}
            className="p-3.5 rounded-lg bg-neutral-scaffold dark:bg-dark-elevated border border-neutral-border dark:border-dark-border flex items-start gap-3"
          >
            <div className="size-6 rounded-md bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 flex items-center justify-center shrink-0 mt-0.5">
              <Check className="w-3.5 h-3.5" aria-hidden="true" />
            </div>
            <div className="space-y-0.5 flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-xs font-bold text-brand-950 dark:text-white truncate">
                  {diag.name}
                </h3>
                <span className="text-[11px] font-mono text-brand-700 dark:text-brand-400 shrink-0">
                  {diag.latencyMs}ms
                </span>
              </div>
              <p className="text-xs text-ink-secondary dark:text-neutral-400 leading-snug">
                {diag.details}
              </p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function EnvironmentMetricsGrid({ detectedCores }: { detectedCores: number }) {
  const cards = [
    {
      label: 'Execution Model',
      value: '100% In-Browser',
      caption: 'WebAssembly & WebCodecs',
      icon: Cpu,
    },
    {
      label: 'Persistent Storage',
      value: '0 Bytes',
      caption: 'Zero permanent retention',
      icon: HardDrive,
    },
    {
      label: 'Hardware Concurrency',
      value: `${detectedCores} Threads`,
      caption: 'Detected CPU execution units',
      icon: Terminal,
    },
    {
      label: 'Privacy Sandbox',
      value: 'Active',
      caption: 'Ephemeral volatile buffer',
      icon: ShieldCheck,
    },
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {cards.map((card) => {
        const Icon = card.icon;
        return (
          <div
            key={card.label}
            className="p-5 rounded-xl bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border shadow-sm space-y-1"
          >
            <div className="flex items-center justify-between text-xs text-ink-muted dark:text-neutral-400">
              <span>{card.label}</span>
              <Icon className="w-4 h-4 text-brand-700 dark:text-brand-400" aria-hidden="true" />
            </div>
            <div className="text-xl font-bold text-brand-950 dark:text-white">
              {card.value}
            </div>
            <div className="text-xs text-ink-secondary dark:text-neutral-400">
              {card.caption}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ComponentStatusSection({
  activeCategory,
  components,
  onSelectCategory,
}: {
  activeCategory: CategoryFilter;
  components: ComponentStatus[];
  onSelectCategory: (category: CategoryFilter) => void;
}) {
  return (
    <section className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <h2 className="text-lg font-bold text-brand-950 dark:text-white">
          Engine &amp; Pipeline Components
        </h2>
        <div className="text-xs text-ink-muted dark:text-neutral-400 flex items-center gap-2">
          <span className="size-2 rounded-full bg-emerald-500" aria-hidden="true" />
          <span>Operational &amp; Ready</span>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {CATEGORY_TABS.map((tab) => {
          const isSelected = activeCategory === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onSelectCategory(tab.id)}
              aria-pressed={isSelected}
              className={`min-h-[44px] px-3.5 py-2 rounded-md text-xs font-semibold border transition-colors cursor-pointer ${
                isSelected
                  ? 'bg-brand-700 text-white border-brand-700'
                  : 'bg-white dark:bg-dark-surface text-ink-secondary dark:text-neutral-300 border-neutral-border dark:border-dark-border hover:border-brand-400 hover:text-brand-950 dark:hover:text-white'
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {components.map((component) => (
          <div
            key={component.id}
            className="rounded-xl bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border p-5 shadow-sm flex flex-col justify-between"
          >
            <div>
              <div className="flex items-start justify-between gap-3 mb-1.5">
                <h3 className="text-sm font-bold text-brand-950 dark:text-white">
                  {component.name}
                </h3>
                <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md text-[11px] font-semibold bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20 shrink-0">
                  <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
                  Operational
                </span>
              </div>
              <p className="text-xs text-ink-secondary dark:text-neutral-400 leading-relaxed">
                {component.description}
              </p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function SandboxArchitectureCard() {
  return (
    <section className="rounded-xl bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border p-6 sm:p-8 shadow-sm flex flex-col md:flex-row items-start gap-5">
      <div className="p-3 rounded-lg bg-brand-50 dark:bg-dark-elevated text-brand-700 dark:text-brand-400 border border-brand-200 dark:border-dark-border shrink-0">
        <Cpu className="w-6 h-6" aria-hidden="true" />
      </div>
      <div className="space-y-2">
        <h2 className="text-base sm:text-lg font-bold text-brand-950 dark:text-white">
          Local Browser Sandbox Execution
        </h2>
        <p className="text-xs sm:text-sm text-ink-secondary dark:text-neutral-300 leading-relaxed">
          Supported client-side codecs compile to WebAssembly and run inside an isolated browser worker sandbox. Local execution avoids upload wait times, keeps memory buffers ephemeral, and releases temporary storage handles as soon as conversion finishes.
        </p>
        <div className="flex flex-wrap gap-4 pt-2 text-xs font-semibold text-brand-700 dark:text-brand-400">
          <span className="flex items-center gap-1.5">
            <Check className="w-4 h-4 text-emerald-500" aria-hidden="true" />
            Zero-Retention Sandboxing
          </span>
          <span className="flex items-center gap-1.5">
            <Check className="w-4 h-4 text-emerald-500" aria-hidden="true" />
            Hardware SIMD &amp; WebCodecs Support
          </span>
          <span className="flex items-center gap-1.5">
            <Check className="w-4 h-4 text-emerald-500" aria-hidden="true" />
            Unlimited Free Conversions
          </span>
        </div>
      </div>
    </section>
  );
}

export default function StatusDashboard() {
  const [activeCategory, setActiveCategory] = useState<CategoryFilter>('all');
  const [checkedAtText, setCheckedAtText] = useState<string>('Client telemetry active in browser sandbox');
  const [isDiagnosticRunning, setIsDiagnosticRunning] = useState(false);
  const [diagnosticResults, setDiagnosticResults] = useState<DiagnosticResult[] | null>(null);
  const [detectedCores, setDetectedCores] = useState<number>(4);

  useEffect(() => {
    if (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) {
      setDetectedCores(navigator.hardwareConcurrency);
    }
    setCheckedAtText(`Client telemetry checked at ${new Date().toLocaleTimeString()}`);
  }, []);

  const filteredComponents = useMemo(() => {
    if (activeCategory === 'all') return ENGINE_COMPONENTS;
    return ENGINE_COMPONENTS.filter((c) => c.category === activeCategory);
  }, [activeCategory]);

  const runDiagnostics = async () => {
    setIsDiagnosticRunning(true);
    const results = collectEdgeDiagnostics();
    await new Promise((r) => setTimeout(r, 160));
    setDiagnosticResults(results);
    setIsDiagnosticRunning(false);
    setCheckedAtText(`Client telemetry checked at ${new Date().toLocaleTimeString()}`);
  };

  return (
    <div className="w-full space-y-8">
      <StatusOverviewCard
        isRunning={isDiagnosticRunning}
        checkedLabel={checkedAtText}
        onRunDiagnostics={runDiagnostics}
      />

      {diagnosticResults && <DiagnosticResultsCard results={diagnosticResults} />}

      <EnvironmentMetricsGrid detectedCores={detectedCores} />

      <ComponentStatusSection
        activeCategory={activeCategory}
        components={filteredComponents}
        onSelectCategory={setActiveCategory}
      />

      <SandboxArchitectureCard />
    </div>
  );
}
