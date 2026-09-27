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
import {
  EnduranceSoakController,
  SoakIterationStats,
} from '../src/lib/streaming/large-payload-streamer';

interface CliOptions {
  durationMs: number;
  targetBytes: number;
  chunkSizeBytes: number;
  quiet: boolean;
  outputPath: string;
}

function parseCliArgs(): CliOptions {
  const args = process.argv.slice(2);
  let durationMs = 30_000; // Default 30 seconds for quick local/CI runs
  let targetBytes = 100 * 1024 * 1024; // Default 100MB per iteration
  let chunkSizeBytes = 128 * 1024; // 128KB chunks
  let quiet = false;
  let outputPath = path.resolve('tests/fixtures/soak-telemetry.json');

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--duration' && i + 1 < args.length) {
      const val = args[++i];
      if (val.endsWith('h')) {
        durationMs = parseFloat(val) * 3600 * 1000;
      } else if (val.endsWith('m')) {
        durationMs = parseFloat(val) * 60 * 1000;
      } else if (val.endsWith('s')) {
        durationMs = parseFloat(val) * 1000;
      } else {
        durationMs = parseFloat(val) * 1000;
      }
    } else if (arg === '--target-gb' && i + 1 < args.length) {
      targetBytes = Math.floor(parseFloat(args[++i]) * 1024 * 1024 * 1024);
    } else if (arg === '--chunk-kb' && i + 1 < args.length) {
      chunkSizeBytes = Math.floor(parseFloat(args[++i]) * 1024);
    } else if (arg === '--output' && i + 1 < args.length) {
      outputPath = path.resolve(args[++i]);
    } else if (arg === '--quiet') {
      quiet = true;
    }
  }

  // Support environment variable overrides
  if (process.env.SOAK_DURATION_HOURS) {
    durationMs = parseFloat(process.env.SOAK_DURATION_HOURS) * 3600 * 1000;
  }
  if (process.env.SOAK_TARGET_GB) {
    targetBytes = Math.floor(parseFloat(process.env.SOAK_TARGET_GB) * 1024 * 1024 * 1024);
  }

  return { durationMs, targetBytes, chunkSizeBytes, quiet, outputPath };
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
    console.log(`  Output Path:        ${options.outputPath}`);
    console.log('----------------------------------------------------------------');
  }

  const controller = new EnduranceSoakController();

  process.on('SIGINT', () => {
    console.log('\nReceived SIGINT. Gracefully terminating soak session...');
    controller.abort();
  });

  const report = await controller.runSoakSession({
    durationMs: options.durationMs,
    bytesPerIteration: options.targetBytes,
    chunkSizeBytes: options.chunkSizeBytes,
    onProgress: (stats: SoakIterationStats) => {
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

  const outputDir = path.dirname(options.outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  fs.writeFileSync(options.outputPath, JSON.stringify(report, null, 2), 'utf-8');

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

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('Fatal error during soak execution:', err);
    process.exit(1);
  });
}
