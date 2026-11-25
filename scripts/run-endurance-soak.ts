/**
 * EasyConvert 2GB Endurance Soak Test Runner
 *
 * Drives high-throughput streaming workloads (up to 2GB+ payload cycles) together with
 * real in-process, archive, and native worker conversion engine cycles over extended
 * timeframes (up to 24 hours), verifying output integrity, zero temp residue, memory
 * stability, and zero file descriptor leakage.
 *
 * Usage:
 *   npx tsx scripts/run-endurance-soak.ts [--duration <hours|minutes|seconds>] [--target-gb <number>] [--quiet]
 *
 * Examples:
 *   npx tsx scripts/run-endurance-soak.ts --duration 24h
 *   npx tsx scripts/run-endurance-soak.ts --duration 12s --target-gb 0.05
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { nativeEngine, tsEngine } from '../src/lib/queue/node-processor';
import {
  createDeterministicSyntheticStream,
  getOpenFileDescriptorCount,
  streamProcessLargePayload,
  type SoakIterationStats,
  type SoakSessionReport,
} from '../src/lib/streaming/large-payload-streamer';

interface CliOptions {
  durationMs: number;
  targetBytes: number;
  chunkSizeBytes: number;
  maxDriftMb: number;
  snapshotIntervalMs: number;
  quiet: boolean;
  streamOnly: boolean;
  outputPath: string;
}

export interface EngineSoakTelemetry {
  enabled: boolean;
  cyclesCompleted: number;
  conversionCounts: {
    image: number;
    document: number;
    pdfText: number;
    archive: number;
    nativePoppler: number;
    nativeFfmpeg: number;
    nativeSoffice: number;
  };
  lastCycleMs: number;
  leftoverTempEntries: number;
}

export interface SoakTelemetryReport extends SoakSessionReport {
  engineSoak: EngineSoakTelemetry;
}

const DEFAULT_SNAPSHOT_INTERVAL_MS = 60_000;
const MIN_SNAPSHOT_INTERVAL_MS = 100;
const WARMUP_ITERATIONS = 3;
const HEAP_STABILITY_LIMIT_MB = 35;
const FD_STABILITY_LIMIT = 3;
const PDF_SOAK_TEXT = 'EasyConvert Soak PDF 123';
const SOAK_ZIP_ENTRY_NAME = 'soak.txt';
const SOAK_ZIP_ENTRY_BODY = 'EasyConvert endurance soak archive entry.\n'.repeat(16);
const POOL_TEMP_DIR_PATTERN = /^(?:libreoffice_(?:probe_)?(?:profile|work)_|tsx-\d+$)/;

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
  --chunk-mb <num>              Transfer chunk size in megabytes.
  --max-drift-mb <num>          Maximum allowed post-warmup heap growth in MB. Default: 35
  --snapshot-interval-ms <ms>   Interval for periodic atomic telemetry snapshots. Default: 60000
  --output <path>               Output path for telemetry JSON report.
  --stream-only                 Run only the synthetic stream pipeline (skip conversion engines)
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
  let durationMs = 30_000;
  let targetBytes = 100 * 1024 * 1024;
  let chunkSizeBytes = 128 * 1024;
  let maxDriftMb = HEAP_STABILITY_LIMIT_MB;
  let snapshotIntervalMs = DEFAULT_SNAPSHOT_INTERVAL_MS;
  let quiet = false;
  let streamOnly = false;
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
    } else if (arg === '--chunk-mb' && i + 1 < args.length) {
      chunkSizeBytes = Math.floor(parsePositiveNumber(args[++i], '--chunk-mb') * 1024 * 1024);
    } else if (arg === '--max-drift-mb' && i + 1 < args.length) {
      maxDriftMb = parsePositiveNumber(args[++i], '--max-drift-mb');
    } else if (arg === '--snapshot-interval-ms' && i + 1 < args.length) {
      snapshotIntervalMs = Math.max(MIN_SNAPSHOT_INTERVAL_MS, Math.floor(parsePositiveNumber(args[++i], '--snapshot-interval-ms')));
    } else if (arg === '--output' && i + 1 < args.length) {
      outputPath = path.resolve(args[++i]);
    } else if (arg === '--stream-only') {
      streamOnly = true;
    } else if (arg === '--quiet') {
      quiet = true;
    }
  }

  if (process.env.SOAK_DURATION_HOURS) {
    durationMs = parsePositiveNumber(process.env.SOAK_DURATION_HOURS, 'SOAK_DURATION_HOURS') * 3600 * 1000;
  }
  if (process.env.SOAK_TARGET_GB) {
    targetBytes = Math.floor(parsePositiveNumber(process.env.SOAK_TARGET_GB, 'SOAK_TARGET_GB') * 1024 * 1024 * 1024);
  }
  if (process.env.SOAK_SNAPSHOT_INTERVAL_MS) {
    snapshotIntervalMs = Math.max(MIN_SNAPSHOT_INTERVAL_MS, Math.floor(parsePositiveNumber(process.env.SOAK_SNAPSHOT_INTERVAL_MS, 'SOAK_SNAPSHOT_INTERVAL_MS')));
  }

  return { durationMs, targetBytes, chunkSizeBytes, maxDriftMb, snapshotIntervalMs, quiet, streamOnly, outputPath };
}

function writeTelemetryAtomic(outputPath: string, report: SoakTelemetryReport): void {
  const outputDir = path.dirname(outputPath);
  fs.mkdirSync(outputDir, { recursive: true });
  const tempPath = `${outputPath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(report, null, 2), 'utf-8');
  fs.renameSync(tempPath, outputPath);
}

function isBinaryAvailable(cmd: string, envOverride?: string): boolean {
  if (envOverride && fs.existsSync(envOverride)) return true;
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore', timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
}

interface SoakFixtures {
  png: Buffer;
  html: Buffer;
  docx: Buffer;
  pdf: Buffer;
  zip: Buffer;
  wav: Buffer;
  native: {
    soffice: boolean;
    pdftoppm: boolean;
    ffmpeg: boolean;
  };
}

function buildMinimalWavBuffer(): Buffer {
  const sampleRate = 8_000;
  const samples = 800;
  const pcmBytes = samples * 2;
  const wav = Buffer.alloc(44 + pcmBytes);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + pcmBytes, 4);
  wav.write('WAVEfmt ', 8, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(pcmBytes, 40);
  return wav;
}

async function buildSoakFixtures(): Promise<SoakFixtures> {
  const png = await sharp({
    create: { width: 32, height: 32, channels: 3, background: { r: 64, g: 128, b: 192 } },
  })
    .png()
    .toBuffer();

  const html = Buffer.from('<html><body><h1>EasyConvert Soak</h1><p>Endurance verification paragraph.</p></body></html>', 'utf-8');
  const docx = (await tsEngine.convert(html, 'html', 'docx', {}, 'soak.html')).buffer;

  const pdfDoc = await PDFDocument.create();
  pdfDoc.addPage([240, 180]).drawText(PDF_SOAK_TEXT, { x: 20, y: 90, size: 12 });
  const pdf = Buffer.from(await pdfDoc.save());

  const zipArchive = new JSZip();
  zipArchive.file(SOAK_ZIP_ENTRY_NAME, SOAK_ZIP_ENTRY_BODY);
  const zip = await zipArchive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

  return {
    png,
    html,
    docx,
    pdf,
    zip,
    wav: buildMinimalWavBuffer(),
    native: {
      soffice: isBinaryAvailable('soffice', process.env.SOFFICE_PATH),
      pdftoppm: isBinaryAvailable('pdftoppm', process.env.PDFTOPPM_PATH),
      ffmpeg: isBinaryAvailable('ffmpeg', process.env.FFMPEG_PATH),
    },
  };
}

function assertStartsWith(buf: Buffer, expected: number[] | string, label: string): void {
  if (buf.length === 0) {
    throw new Error(`${label} produced empty output`);
  }
  if (typeof expected === 'string') {
    const actual = buf.subarray(0, expected.length).toString('latin1');
    if (actual !== expected) {
      throw new Error(`${label} produced invalid magic "${actual}", expected "${expected}"`);
    }
    return;
  }
  for (let i = 0; i < expected.length; i++) {
    if (buf[i] !== expected[i]) {
      throw new Error(`${label} produced unexpected header byte at offset ${i}`);
    }
  }
}

function removeIfPresent(filePath: string | undefined): void {
  if (filePath && fs.existsSync(filePath)) {
    fs.rmSync(filePath, { force: true });
  }
}

async function runRealEngineCycle(
  fixtures: SoakFixtures,
  signal: AbortSignal,
  telemetry: EngineSoakTelemetry
): Promise<void> {
  const started = Date.now();
  const opts = { signal };

  // 1. Sharp image transcoding (PNG -> WebP, PNG -> JPG)
  const webp = await tsEngine.convert(fixtures.png, 'png', 'webp', opts, 'soak.png');
  removeIfPresent(webp.filePath);
  assertStartsWith(webp.buffer, 'RIFF', 'png->webp');
  if (webp.buffer.subarray(8, 12).toString('ascii') !== 'WEBP') {
    throw new Error('png->webp output missing WEBP signature');
  }
  telemetry.conversionCounts.image++;

  const jpg = await tsEngine.convert(fixtures.png, 'png', 'jpg', opts, 'soak.png');
  removeIfPresent(jpg.filePath);
  assertStartsWith(jpg.buffer, [0xff, 0xd8, 0xff], 'png->jpg');
  telemetry.conversionCounts.image++;

  // 2. In-process HTML/DOCX -> PDF
  const htmlPdf = await tsEngine.convert(fixtures.html, 'html', 'pdf', opts, 'soak.html');
  removeIfPresent(htmlPdf.filePath);
  assertStartsWith(htmlPdf.buffer, '%PDF-', 'html->pdf');
  telemetry.conversionCounts.document++;

  const docxPdf = await tsEngine.convert(fixtures.docx, 'docx', 'pdf', opts, 'soak.docx');
  removeIfPresent(docxPdf.filePath);
  assertStartsWith(docxPdf.buffer, '%PDF-', 'docx->pdf');
  telemetry.conversionCounts.document++;

  // 3. PDF text & layout extraction
  const pdfTxt = await tsEngine.convert(fixtures.pdf, 'pdf', 'txt', opts, 'soak.pdf');
  removeIfPresent(pdfTxt.filePath);
  if (!pdfTxt.buffer.toString('utf-8').includes(PDF_SOAK_TEXT)) {
    throw new Error('pdf->txt output lost expected PDF text');
  }
  telemetry.conversionCounts.pdfText++;

  // 4. ZIP <-> TAR.ZST archive round-trip & independent JSZip extraction verification
  const tarZst = await tsEngine.convert(fixtures.zip, 'zip', 'tar.zst', opts, 'soak.zip');
  removeIfPresent(tarZst.filePath);
  assertStartsWith(tarZst.buffer, [0x28, 0xb5, 0x2f, 0xfd], 'zip->tar.zst');
  telemetry.conversionCounts.archive++;

  const zipBack = await tsEngine.convert(tarZst.buffer, 'tar.zst', 'zip', opts, 'soak.tar.zst');
  removeIfPresent(zipBack.filePath);
  assertStartsWith(zipBack.buffer, [0x50, 0x4b, 0x03, 0x04], 'tar.zst->zip');
  const extracted = await JSZip.loadAsync(zipBack.buffer);
  const restoredText = await extracted.file(SOAK_ZIP_ENTRY_NAME)?.async('string');
  if (restoredText !== SOAK_ZIP_ENTRY_BODY) {
    throw new Error('tar.zst->zip round-trip altered archive entry payload');
  }
  telemetry.conversionCounts.archive++;

  // 5. Native worker conversions when local binaries are installed
  if (fixtures.native.pdftoppm) {
    const renderedPng = await nativeEngine.convert(fixtures.pdf, 'pdf', 'png', opts, 'soak.pdf');
    removeIfPresent(renderedPng.filePath);
    assertStartsWith(renderedPng.buffer, [0x89, 0x50, 0x4e, 0x47], 'native pdftoppm pdf->png');
    telemetry.conversionCounts.nativePoppler++;
  }

  if (fixtures.native.ffmpeg) {
    const mp3 = await nativeEngine.convert(fixtures.wav, 'wav', 'mp3', opts, 'soak.wav');
    removeIfPresent(mp3.filePath);
    if (mp3.buffer.length === 0) {
      throw new Error('native ffmpeg wav->mp3 produced empty output');
    }
    telemetry.conversionCounts.nativeFfmpeg++;
  }

  if (fixtures.native.soffice) {
    const loPdf = await nativeEngine.convert(fixtures.docx, 'docx', 'pdf', opts, 'soak.docx');
    removeIfPresent(loPdf.filePath);
    assertStartsWith(loPdf.buffer, '%PDF-', 'native soffice docx->pdf');
    telemetry.conversionCounts.nativeSoffice++;
  }

  telemetry.cyclesCompleted++;
  telemetry.lastCycleMs = Math.max(1, Date.now() - started);
}

interface SnapshotTracker {
  maxDriftMb: number;
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
  lastIterationDigest: string;
  startedAt: number;
  history: SoakIterationStats[];
  engineSoak: EngineSoakTelemetry;
}

function buildSnapshotReport(tracker: SnapshotTracker): SoakTelemetryReport {
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
    isMemoryStable: heapGrowthPostWarmupMb < tracker.maxDriftMb && fdDelta <= FD_STABILITY_LIMIT,
    lastIterationDigest: tracker.lastIterationDigest,
    history: tracker.history,
    engineSoak: { ...tracker.engineSoak, conversionCounts: { ...tracker.engineSoak.conversionCounts } },
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
    console.log(`  Max Heap Drift:     ${options.maxDriftMb} MB`);
    console.log(`  Engine Cycles:      ${options.streamOnly ? 'DISABLED (--stream-only)' : 'ENABLED'}`);
    console.log(`  Snapshot Interval:  ${options.snapshotIntervalMs} ms`);
    console.log(`  Output Path:        ${options.outputPath}`);
    console.log('----------------------------------------------------------------');
  }

  const prevTmpDir = process.env.TMPDIR;
  const soakTmpRoot = options.streamOnly ? undefined : fs.mkdtempSync(path.join(os.tmpdir(), 'easyconvert-soak-'));
  if (soakTmpRoot) {
    process.env.TMPDIR = soakTmpRoot;
  }

  const fixtures = options.streamOnly ? null : await buildSoakFixtures();
  // Drain one event-loop turn and collect startup/module-load FDs before sampling baseline metrics.
  await new Promise<void>((resolve) => setImmediate(resolve));
  if (typeof global.gc === 'function') {
    global.gc();
  }

  const initMem = process.memoryUsage();
  const initialHeapMb = initMem.heapUsed / (1024 * 1024);
  const initialRssMb = initMem.rss / (1024 * 1024);
  const initialExternalMb = (initMem.external || 0) / (1024 * 1024);
  const initialArrayBuffersMb = (initMem.arrayBuffers || 0) / (1024 * 1024);
  const initialFds = getOpenFileDescriptorCount();

  const tracker: SnapshotTracker = {
    maxDriftMb: options.maxDriftMb,
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
    lastIterationDigest: '',
    startedAt: Date.now(),
    history: [],
    engineSoak: {
      enabled: !options.streamOnly,
      cyclesCompleted: 0,
      conversionCounts: {
        image: 0,
        document: 0,
        pdfText: 0,
        archive: 0,
        nativePoppler: 0,
        nativeFfmpeg: 0,
        nativeSoffice: 0,
      },
      lastCycleMs: 0,
      leftoverTempEntries: 0,
    },
  };

  const abortController = new AbortController();
  let lastSnapshotAt = tracker.startedAt;
  let finalWritten = false;
  let signalHandled = false;

  const flushSnapshot = (): void => {
    if (finalWritten) return;
    writeTelemetryAtomic(options.outputPath, buildSnapshotReport(tracker));
    lastSnapshotAt = Date.now();
  };

  const onTerminationSignal = (sig: NodeJS.Signals): void => {
    if (signalHandled) return;
    signalHandled = true;
    console.log(`\nReceived ${sig}. Flushing telemetry snapshot and terminating soak session...`);
    try {
      flushSnapshot();
    } catch (err) {
      console.error('Failed to flush emergency soak snapshot:', err);
    }
    abortController.abort(new Error(`Soak aborted by ${sig}`));
  };

  process.on('SIGINT', () => onTerminationSignal('SIGINT'));
  process.on('SIGTERM', () => onTerminationSignal('SIGTERM'));

  try {
    let iteration = 0;
    while (!abortController.signal.aborted && Date.now() - tracker.startedAt < options.durationMs) {
      const nextIteration = iteration + 1;
      const iterStream = createDeterministicSyntheticStream(options.targetBytes, options.chunkSizeBytes);
      let streamResult;
      try {
        streamResult = await streamProcessLargePayload(iterStream, {
          chunkSizeBytes: options.chunkSizeBytes,
          signal: abortController.signal,
        });
        if (fixtures) {
          await runRealEngineCycle(fixtures, abortController.signal, tracker.engineSoak);
        }
      } catch (err: unknown) {
        if (abortController.signal.aborted) {
          break;
        }
        throw err;
      }

      iteration = nextIteration;
      tracker.totalBytesProcessed += streamResult.totalBytesProcessed;
      tracker.lastIterationDigest = streamResult.sha256Digest;

      const currentMem = process.memoryUsage();
      const currentHeapMb = currentMem.heapUsed / (1024 * 1024);
      const currentRssMb = currentMem.rss / (1024 * 1024);
      const currentExternalMb = (currentMem.external || 0) / (1024 * 1024);
      const currentArrayBuffersMb = (currentMem.arrayBuffers || 0) / (1024 * 1024);
      const currentActiveResources = typeof process.getActiveResourcesInfo === 'function'
        ? process.getActiveResourcesInfo().length
        : 0;
      const currentFds = getOpenFileDescriptorCount();

      tracker.peakHeapMb = Math.max(tracker.peakHeapMb, currentHeapMb);
      tracker.peakRssMb = Math.max(tracker.peakRssMb, currentRssMb);

      if (iteration === 1) {
        // Anchor persistent worker/pool FDs initialized on the first real engine cycle so
        // early SIGTERM exits do not misclassify one-time threadpool/worker pipes as leaks.
        tracker.postWarmupFds = currentFds;
        tracker.postWarmupHeapMb = Math.max(tracker.initialHeapMb, currentHeapMb);
      }

      if (iteration === WARMUP_ITERATIONS) {
        if (typeof global.gc === 'function') {
          global.gc();
        }
        const warmupMem = process.memoryUsage();
        tracker.postWarmupHeapMb = warmupMem.heapUsed / (1024 * 1024);
        tracker.postWarmupRssMb = warmupMem.rss / (1024 * 1024);
        tracker.postWarmupExternalMb = (warmupMem.external || 0) / (1024 * 1024);
        tracker.postWarmupArrayBuffersMb = (warmupMem.arrayBuffers || 0) / (1024 * 1024);
        tracker.postWarmupFds = getOpenFileDescriptorCount();
      }

      const stats: SoakIterationStats = {
        iteration,
        bytesProcessed: streamResult.totalBytesProcessed,
        elapsedMs: streamResult.elapsedMs,
        throughputMbPerSec: streamResult.throughputMbPerSec,
        heapUsedMb: currentHeapMb,
        rssMb: currentRssMb,
        externalMb: currentExternalMb,
        arrayBuffersMb: currentArrayBuffersMb,
        activeResourcesCount: currentActiveResources,
        openFds: currentFds,
      };
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
          `FDs: ${stats.openFds}` +
          (fixtures ? ` | EngineCycle: ${tracker.engineSoak.lastCycleMs}ms` : '')
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  } finally {
    if (prevTmpDir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = prevTmpDir;
    if (soakTmpRoot && fs.existsSync(soakTmpRoot)) {
      const entries = fs.readdirSync(soakTmpRoot);
      const nonPoolResidue = entries.filter((entry) => !POOL_TEMP_DIR_PATTERN.test(entry));
      tracker.engineSoak.leftoverTempEntries = nonPoolResidue.length;
      if (nonPoolResidue.length > 0) {
        console.error(`Leftover temp entries (${nonPoolResidue.length}): ${nonPoolResidue.join(', ')}`);
      }
      fs.rmSync(soakTmpRoot, { recursive: true, force: true });
      if (fs.existsSync(soakTmpRoot)) {
        tracker.engineSoak.leftoverTempEntries += 1;
      }
    }
  }

  if (typeof global.gc === 'function') {
    global.gc();
  }

  finalWritten = true;
  const report = buildSnapshotReport(tracker);
  writeTelemetryAtomic(options.outputPath, report);

  if (!options.quiet) {
    console.log('----------------------------------------------------------------');
    console.log(`  Total Iterations:   ${report.totalIterations}`);
    console.log(`  Total Processed:    ${(report.totalBytesProcessed / (1024 * 1024)).toFixed(2)} MB`);
    console.log(`  Avg Throughput:     ${report.averageThroughputMbPerSec.toFixed(2)} MB/s`);
    console.log(`  Peak Heap Used:     ${report.peakHeapMb.toFixed(2)} MB`);
    console.log(`  Initial -> Final:   ${report.initialHeapMb.toFixed(2)} MB -> ${report.finalHeapMb.toFixed(2)} MB`);
    console.log(`  FD Delta:           ${report.fdDelta}`);
    console.log(`  Engine Cycles:      ${report.engineSoak.cyclesCompleted}`);
    console.log(`  Temp Residue:       ${report.engineSoak.leftoverTempEntries}`);
    console.log(`  Memory Stable:      ${report.isMemoryStable ? 'PASSED (Zero Leaks)' : 'FAILED (Unbounded Growth)'}`);
    console.log('================================================================');
  }

  if (!report.isMemoryStable || report.engineSoak.leftoverTempEntries > 0) {
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
