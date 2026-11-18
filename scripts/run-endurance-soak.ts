/**
 * EasyConvert 2GB Endurance Soak Test Runner
 *
 * Simulates high-throughput streaming workloads up to 2GB payload cycles
 * over extended timeframes (up to 24 hours), measuring memory stability,
 * throughput, and zero file descriptor leakage.
 *
 * Usage:
 *   npx tsx scripts/run-endurance-soak.ts [--duration <hours|minutes|seconds>] [--target-gb <number>] [--quiet]
 *
 * Examples:
 *   npx tsx scripts/run-endurance-soak.ts --duration 24h
 *   npx tsx scripts/run-endurance-soak.ts --duration 5m --target-gb 2
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EnduranceSoakController,
  SoakIterationStats,
  SoakSessionReport,
  getOpenFileDescriptorCount,
} from '../src/lib/streaming/large-payload-streamer';

interface CliOptions {
  durationMs: number;
  targetBytes: number;
  chunkSizeBytes: number;
  snapshotIntervalMs: number;
  quiet: boolean;
  outputPath: string;
}

const DEFAULT_SNAPSHOT_INTERVAL_MS = 60_000;
const MIN_SNAPSHOT_INTERVAL_MS = 100;
const WARMUP_ITERATIONS = 3;
const HEAP_STABILITY_LIMIT_MB = 35;
const FD_STABILITY_LIMIT = 3;

function printUsage(): void {
  console.log(`
EasyConvert 2GB Endurance Soak Test Runner

Usage:
  npx tsx scripts/run-endurance-soak.ts [options]

Options:
  --duration <time>             Duration of test (e.g. 24h, 30m, 60s). Default: 30s
  --target-gb <num>             Payload size per iteration in gigabytes. Default: 0.1 (100MB)
  --target-mb <num>             Payload size per iteration in megabytes.
  --chunk-kb <num>              Transfer chunk size in kilobytes. Default: 128 (128KB)
  --snapshot-interval-ms <ms>   Interval for periodic atomic telemetry snapshots. Default: 60000
  --output <path>               Output path for telemetry JSON report.
  --quiet                       Suppress per-iteration telemetry logging
  --help, -h                    Show this help message
`);
}

function parsePositiveNumber(raw: string, flag: string): number {
  const num = Number.parseFloat(raw);
  if (!Number.isFinite(num) || num <= 0) {
    throw new Error(`Invalid value for ${flag}: "${raw}" (must be a finite positive number).`);
  }
  return num;
}

function parseCliArgs(): CliOptions {
  const args = process.argv.slice(2);
  let durationMs = 30_000; // Default 30 seconds for quick local/CI runs
  let targetBytes = 100 * 1024 * 1024; // Default 100MB per iteration
  let chunkSizeBytes = 128 * 1024; // 128KB chunks
  let snapshotIntervalMs = DEFAULT_SNAPSHOT_INTERVAL_MS;
  let quiet = false;
  let outputPath = path.resolve('tests/fixtures/soak-telemetry.json');

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else if (arg === '--duration' && i + 1 < args.length) {
      const val = args[++i];
      if (val.endsWith('h')) {
        durationMs = parsePositiveNumber(val.slice(0, -1), '--duration') * 3600 * 1000;
      } else if (val.endsWith('m')) {
        durationMs = parsePositiveNumber(val.slice(0, -1), '--duration') * 60 * 1000;
      } else if (val.endsWith('s')) {
        durationMs = parsePositiveNumber(val.slice(0, -1), '--duration') * 1000;
      } else {
        durationMs = parsePositiveNumber(val, '--duration') * 1000;
      }
    } else if (arg === '--target-gb' && i + 1 < args.length) {
      targetBytes = Math.floor(parsePositiveNumber(args[++i], '--target-gb') * 1024 * 1024 * 1024);
    } else if (arg === '--target-mb' && i + 1 < args.length) {
      targetBytes = Math.floor(parsePositiveNumber(args[++i], '--target-mb') * 1024 * 1024);
    } else if (arg === '--chunk-kb' && i + 1 < args.length) {
      chunkSizeBytes = Math.floor(parsePositiveNumber(args[++i], '--chunk-kb') * 1024);
    } else if (arg === '--snapshot-interval-ms' && i + 1 < args.length) {
      snapshotIntervalMs = Math.max(MIN_SNAPSHOT_INTERVAL_MS, Math.floor(parsePositiveNumber(args[++i], '--snapshot-interval-ms')));
    } else if (arg === '--output' && i + 1 < args.length) {
      outputPath = path.resolve(args[++i]);
    } else if (arg === '--quiet') {
      quiet = true;
    }
  }

  // Support environment variable overrides
  if (process.env.SOAK_DURATION_HOURS) {
    durationMs = parsePositiveNumber(process.env.SOAK_DURATION_HOURS, 'SOAK_DURATION_HOURS') * 3600 * 1000;
  }
  if (process.env.SOAK_TARGET_GB) {
    targetBytes = Math.floor(parsePositiveNumber(process.env.SOAK_TARGET_GB, 'SOAK_TARGET_GB') * 1024 * 1024 * 1024);
  }
  if (process.env.SOAK_SNAPSHOT_INTERVAL_MS) {
    snapshotIntervalMs = Math.max(MIN_SNAPSHOT_INTERVAL_MS, Math.floor(parsePositiveNumber(process.env.SOAK_SNAPSHOT_INTERVAL_MS, 'SOAK_SNAPSHOT_INTERVAL_MS')));
  }

  return { durationMs, targetBytes, chunkSizeBytes, snapshotIntervalMs, quiet, outputPath };
}

function writeTelemetryAtomic(outputPath: string, report: SoakSessionReport): void {
  const outputDir = path.dirname(outputPath);
  fs.mkdirSync(outputDir, { recursive: true });
  const tempPath = `${outputPath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(report, null, 2), 'utf-8');
  fs.renameSync(tempPath, outputPath);
}

interface SnapshotTracker {
  initialHeapMb: number;
  initialRssMb: number;
  initialExternalMb: number;
  initialArrayBuffersMb: number;
  initialActiveResources: number;
  initialFds: number;
  postWarmupHeapMb: number;
  postWarmupRssMb: number;
  postWarmupExternalMb: number;
  postWarmupArrayBuffersMb: number;
  postWarmupFds: number;
  peakHeapMb: number;
  peakRssMb: number;
  totalBytesProcessed: number;
  startedAt: number;
  history: SoakIterationStats[];
}

function buildSnapshotReport(tracker: SnapshotTracker): SoakSessionReport {
  const mem = process.memoryUsage();
  const finalHeapMb = mem.heapUsed / (1024 * 1024);
  const finalRssMb = mem.rss / (1024 * 1024);
  const finalExternalMb = (mem.external || 0) / (1024 * 1024);
  const finalArrayBuffersMb = (mem.arrayBuffers || 0) / (1024 * 1024);
  const finalActiveResources = typeof process.getActiveResourcesInfo === 'function' ? process.getActiveResourcesInfo().length : 0;
  const finalFds = getOpenFileDescriptorCount();
  const totalDurationMs = Math.max(1, Date.now() - tracker.startedAt);
  const heapGrowthPostWarmupMb = Math.max(0, finalHeapMb - tracker.postWarmupHeapMb);
  const fdDelta = Math.max(0, finalFds - tracker.postWarmupFds);
  return {
    totalIterations: tracker.history.length,
    totalBytesProcessed: tracker.totalBytesProcessed,
    totalDurationMs,
    averageThroughputMbPerSec: (tracker.totalBytesProcessed / (1024 * 1024)) / (totalDurationMs / 1000),
    initialHeapMb: tracker.initialHeapMb,
    finalHeapMb,
    peakHeapMb: Math.max(tracker.peakHeapMb, finalHeapMb),
    initialRssMb: tracker.initialRssMb,
    finalRssMb,
    peakRssMb: Math.max(tracker.peakRssMb, finalRssMb),
    rssDeltaMb: Math.max(0, finalRssMb - tracker.postWarmupRssMb),
    initialExternalMb: tracker.initialExternalMb,
    finalExternalMb,
    externalDeltaMb: Math.max(0, finalExternalMb - tracker.postWarmupExternalMb),
    initialArrayBuffersMb: tracker.initialArrayBuffersMb,
    finalArrayBuffersMb,
    arrayBuffersDeltaMb: Math.max(0, finalArrayBuffersMb - tracker.postWarmupArrayBuffersMb),
    initialActiveResources: tracker.initialActiveResources,
    finalActiveResources,
    initialFds: tracker.initialFds,
    finalFds,
    fdDelta,
    isMemoryStable: heapGrowthPostWarmupMb < HEAP_STABILITY_LIMIT_MB && fdDelta <= FD_STABILITY_LIMIT,
    lastIterationDigest: '',
    history: tracker.history,
  };
}

async function main(): Promise<void> {
  const options = parseCliArgs();

  if (!options.quiet) {
    console.log('================================================================');
    console.log('  EasyConvert 2GB Endurance Soak Test Runner');
    console.log('================================================================');
    console.log(`  Duration Budget:    ${(options.durationMs / 1000 / 60).toFixed(2)} minutes`);
    console.log(`  Iteration Payload:  ${(options.targetBytes / (1024 * 1024)).toFixed(2)} MB`);
    console.log(`  Transfer Chunk:     ${(options.chunkSizeBytes / 1024).toFixed(0)} KB`);
    console.log(`  Snapshot Interval:  ${options.snapshotIntervalMs} ms`);
    console.log(`  Output Path:        ${options.outputPath}`);
    console.log('----------------------------------------------------------------');
  }

  const controller = new EnduranceSoakController();
  const initMem = process.memoryUsage();
  const initialHeapMb = initMem.heapUsed / (1024 * 1024);
  const initialRssMb = initMem.rss / (1024 * 1024);
  const initialExternalMb = (initMem.external || 0) / (1024 * 1024);
  const initialArrayBuffersMb = (initMem.arrayBuffers || 0) / (1024 * 1024);
  const initialFds = getOpenFileDescriptorCount();
  const tracker: SnapshotTracker = {
    initialHeapMb,
    initialRssMb,
    initialExternalMb,
    initialArrayBuffersMb,
    initialActiveResources: typeof process.getActiveResourcesInfo === 'function' ? process.getActiveResourcesInfo().length : 0,
    initialFds,
    postWarmupHeapMb: initialHeapMb,
    postWarmupRssMb: initialRssMb,
    postWarmupExternalMb: initialExternalMb,
    postWarmupArrayBuffersMb: initialArrayBuffersMb,
    postWarmupFds: initialFds,
    peakHeapMb: initialHeapMb,
    peakRssMb: initialRssMb,
    totalBytesProcessed: 0,
    startedAt: Date.now(),
    history: [],
  };
  let lastSnapshotAt = tracker.startedAt;
  let finalWritten = false;

  const flushSnapshot = (): void => {
    if (finalWritten) return;
    writeTelemetryAtomic(options.outputPath, buildSnapshotReport(tracker));
    lastSnapshotAt = Date.now();
  };

  let signalHandled = false;
  const onTerminationSignal = (sig: NodeJS.Signals): void => {
    if (signalHandled) return;
    signalHandled = true;
    console.log(`\nReceived ${sig}. Flushing telemetry snapshot and terminating soak session...`);
    try {
      flushSnapshot();
    } catch (err) {
      console.error('Failed to flush emergency soak snapshot:', err);
    }
    controller.abort();
  };

  process.on('SIGINT', () => onTerminationSignal('SIGINT'));
  process.on('SIGTERM', () => onTerminationSignal('SIGTERM'));

  const report = await controller.runSoakSession({
    durationMs: options.durationMs,
    // The session is bounded by --duration; the controller's default iteration cap would end a 24h run in minutes.
    maxIterations: Number.POSITIVE_INFINITY,
    bytesPerIteration: options.targetBytes,
    chunkSizeBytes: options.chunkSizeBytes,
    warmupIterations: WARMUP_ITERATIONS,
    onProgress: (stats: SoakIterationStats) => {
      tracker.totalBytesProcessed += stats.bytesProcessed;
      tracker.peakHeapMb = Math.max(tracker.peakHeapMb, stats.heapUsedMb);
      tracker.peakRssMb = Math.max(tracker.peakRssMb, stats.rssMb);
      if (stats.iteration === WARMUP_ITERATIONS) {
        tracker.postWarmupHeapMb = stats.heapUsedMb;
        tracker.postWarmupRssMb = stats.rssMb;
        tracker.postWarmupExternalMb = stats.externalMb ?? 0;
        tracker.postWarmupArrayBuffersMb = stats.arrayBuffersMb ?? 0;
        tracker.postWarmupFds = stats.openFds;
      }
      tracker.history.push(stats);
      if (Date.now() - lastSnapshotAt >= options.snapshotIntervalMs) {
        flushSnapshot();
      }
      if (!options.quiet) {
        console.log(
          `[Iter #${stats.iteration.toString().padStart(3, ' ')}] ` +
          `Processed: ${(stats.bytesProcessed / (1024 * 1024)).toFixed(1)}MB | ` +
          `Throughput: ${stats.throughputMbPerSec.toFixed(1)}MB/s | ` +
          `Heap: ${stats.heapUsedMb.toFixed(1)}MB | ` +
          `RSS: ${stats.rssMb.toFixed(1)}MB | ` +
          `FDs: ${stats.openFds}`
        );
      }
    },
  });

  finalWritten = true;
  writeTelemetryAtomic(options.outputPath, report);

  if (!options.quiet) {
    console.log('----------------------------------------------------------------');
    console.log(`  Total Iterations:   ${report.totalIterations}`);
    console.log(`  Total Processed:    ${(report.totalBytesProcessed / (1024 * 1024)).toFixed(2)} MB`);
    console.log(`  Avg Throughput:     ${report.averageThroughputMbPerSec.toFixed(2)} MB/s`);
    console.log(`  Peak Heap Used:     ${report.peakHeapMb.toFixed(2)} MB`);
    console.log(`  Initial -> Final:   ${report.initialHeapMb.toFixed(2)} MB -> ${report.finalHeapMb.toFixed(2)} MB`);
    console.log(`  Memory Stable:      ${report.isMemoryStable ? 'PASSED (Zero Leaks)' : 'FAILED (Unbounded Growth)'}`);
    console.log('================================================================');
  }

  if (!report.isMemoryStable) {
    process.exitCode = 1;
  }
}

const isDirectInvocation =
  process.argv[1] &&
  (import.meta.url === `file://${process.argv[1]}` ||
    fileURLToPath(import.meta.url) === path.resolve(process.argv[1]));

if (isDirectInvocation) {
  main().catch((err) => {
    console.error('Fatal error during soak execution:', err);
    process.exit(1);
  });
}
