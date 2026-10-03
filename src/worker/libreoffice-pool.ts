import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createWorkerSandboxDir } from './sandbox';
import { executeSandboxedBinary, SandboxedExecutionOptions, SandboxedExecutionResult } from '../lib/security/process-sandbox';
import type { WorkerEngineOptions, WorkerConversionResult } from './engines';

export type WorkerLifecycleState = 'INITIALIZING' | 'READY' | 'BUSY' | 'RECYCLING' | 'DEAD';

export type SandboxedProcessRunner = (
  binaryPath: string,
  args: string[],
  options?: SandboxedExecutionOptions
) => Promise<SandboxedExecutionResult>;

export interface LibreOfficeWorker {
  id: string;
  state: WorkerLifecycleState;
  userProfileDir: string;
  workDir: string;
  jobCount: number;
  createdAt: number;
  lastUsedAt: number;
  port: number;
  unoAccept?: string;
}

export interface LibreOfficePoolOptions {
  maxWorkers?: number;
  minWorkers?: number;
  maxJobsPerWorker?: number;
  acquireTimeoutMs?: number;
  sofficePath?: string | null;
  enabled?: boolean;
  executor?: SandboxedProcessRunner;
  daemonMode?: boolean;
  unoAcceptHost?: string;
}

export interface LibreOfficePoolStats {
  totalWorkers: number;
  readyWorkers: number;
  busyWorkers: number;
  recyclingWorkers: number;
  deadWorkers: number;
  queueLength: number;
  totalJobsProcessed: number;
  maxJobsPerWorker?: number;
  daemonMode?: boolean;
}

export class LibreOfficePoolTimeoutError extends Error {
  constructor(message = 'Timed out waiting for an available LibreOffice worker in the pool.') {
    super(message);
    this.name = 'LibreOfficePoolTimeoutError';
  }
}

const SAFE_ALPHANUMERIC_REGEX = /^[a-zA-Z0-9.-]{1,16}$/;

function validateFormat(format: string): string {
  const sanitized = format.trim().toLowerCase();
  if (!SAFE_ALPHANUMERIC_REGEX.test(sanitized)) {
    throw new Error(`Invalid format identifier: "${format}"`);
  }
  return sanitized;
}

const MIME_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  html: 'text/html',
  txt: 'text/plain',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  csv: 'text/csv',
};

/**
 * Resolves compliant LibreOffice --convert-to filter specification according to
 * source document domain and output parameters (PDF/A profiles, lossless compression).
 */
export function resolveLibreOfficeFilter(
  targetFormat: string,
  sourceFormat: string,
  options: WorkerEngineOptions = {}
): string {
  const tgt = targetFormat.toLowerCase();
  const src = sourceFormat.toLowerCase();

  if (options.libreOfficeFilter) {
    return `${tgt}:${options.libreOfficeFilter}`;
  }

  if (tgt === 'pdf') {
    const isSpreadsheet = ['xlsx', 'xls', 'ods', 'csv', 'tsv'].includes(src);
    const isPresentation = ['pptx', 'ppt', 'odp', 'potx', 'key'].includes(src);
    const filterName = isSpreadsheet
      ? 'calc_pdf_Export'
      : isPresentation
      ? 'impress_pdf_Export'
      : 'writer_pdf_Export';

    const pdfVersion = (options.pdfVersion || options.pdfStandard || '').toLowerCase();
    if (pdfVersion === 'pdfa' || pdfVersion === 'pdfa-1b' || pdfVersion === 'pdf/a-1b') {
      return `${tgt}:${filterName}:{"SelectPdfVersion":{"type":"long","value":"1"}}`;
    }
    if (pdfVersion === 'pdfa-2b' || pdfVersion === 'pdf/a-2b') {
      return `${tgt}:${filterName}:{"SelectPdfVersion":{"type":"long","value":"2"}}`;
    }
    if (pdfVersion === 'pdfa-3b' || pdfVersion === 'pdf/a-3b') {
      return `${tgt}:${filterName}:{"SelectPdfVersion":{"type":"long","value":"3"}}`;
    }

    if (options.losslessImageCompression) {
      return `${tgt}:${filterName}:{"UseLosslessCompression":{"type":"boolean","value":"true"}}`;
    }
  }

  return tgt;
}

/**
 * Pre-warmed LibreOffice Daemon Worker Pool Manager.
 * Maintains isolated background worker environments with dedicated user profiles,
 * FIFO queueing, auto-recycling (every N jobs) to prevent memory leaks,
 * and seamless fail-closed fallback.
 */
export class LibreOfficePoolManager {
  private workers: LibreOfficeWorker[] = [];
  private queue: Array<{
    resolve: (worker: LibreOfficeWorker) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  private maxWorkers: number;
  private minWorkers: number;
  private maxJobsPerWorker: number;
  private acquireTimeoutMs: number;
  private sofficePath: string | null;
  private enabled: boolean;
  private executor: SandboxedProcessRunner;
  private daemonMode: boolean;
  private unoAcceptHost: string;

  private isShuttingDown = false;
  private totalJobsProcessed = 0;
  private basePort = 2002;
  private portCounter = 0;

  constructor(options: LibreOfficePoolOptions = {}) {
    const cpus = os.cpus()?.length || 2;
    this.maxWorkers = options.maxWorkers ?? Math.max(1, Math.min(4, cpus));
    this.minWorkers = options.minWorkers ?? Math.min(1, this.maxWorkers);
    this.maxJobsPerWorker = options.maxJobsPerWorker ?? 150;
    this.acquireTimeoutMs = options.acquireTimeoutMs ?? 30000;
    this.sofficePath = options.sofficePath ?? null;
    this.enabled = options.enabled ?? (this.sofficePath !== null);
    this.executor = options.executor ?? executeSandboxedBinary;
    this.daemonMode = options.daemonMode ?? true;
    this.unoAcceptHost = options.unoAcceptHost ?? '127.0.0.1';
  }

  public isEnabled(): boolean {
    return this.enabled && !this.isShuttingDown;
  }

  public enable(): void {
    if (this.sofficePath) {
      this.enabled = true;
    }
  }

  public disable(): void {
    this.enabled = false;
  }

  public setSofficePath(path: string | null): void {
    this.sofficePath = path;
    this.enabled = path !== null;
  }

  /**
   * Initializes pool by pre-warming minimum worker daemons.
   */
  public async init(): Promise<void> {
    if (!this.enabled || this.isShuttingDown) return;

    const toWarm = Math.max(0, this.minWorkers - this.workers.length);
    for (let i = 0; i < toWarm; i++) {
      try {
        const worker = await this.createWorker();
        this.workers.push(worker);
      } catch (err) {
        console.warn('[LibreOfficePoolManager] Warning: failed to pre-warm initial daemon worker:', err);
        break;
      }
    }
  }

  /**
   * Creates an isolated worker environment with pre-warmed user profile.
   */
  public async createWorker(): Promise<LibreOfficeWorker> {
    const id = `worker-${crypto.randomUUID().slice(0, 8)}`;
    const port = this.basePort + (this.portCounter++ % 1000);
    const userProfileDir = createWorkerSandboxDir(`libreoffice_profile_${id}_`);
    const workDir = createWorkerSandboxDir(`libreoffice_work_${id}_`);
    const unoAccept = `socket,host=${this.unoAcceptHost},port=${port};urp;`;

    const worker: LibreOfficeWorker = {
      id,
      state: 'INITIALIZING',
      userProfileDir,
      workDir,
      jobCount: 0,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      port,
      unoAccept,
    };

    // Pre-warm user profile if binary is configured and exists or custom executor is set
    if (this.sofficePath && (fs.existsSync(this.sofficePath) || this.executor !== executeSandboxedBinary)) {
      try {
        const warmArgs = [
          '--headless',
          '--norestore',
          '--nofirststartwizard',
          '--nologo',
          `-env:UserInstallation=file://${userProfileDir}`,
        ];
        if (this.daemonMode) {
          warmArgs.push(`--accept=${unoAccept}`);
        }
        warmArgs.push('--help');

        await this.executor(
          this.sofficePath,
          warmArgs,
          {
            cwd: workDir,
            timeoutMs: 15000,
            env: { HOME: workDir, SAL_USE_VCLPLUGIN: 'svp' },
            networkIsolated: true,
          }
        );
      } catch {
        // Fall through; profile directory was created
      }
    }

    worker.state = 'READY';
    return worker;
  }

  /**
   * Acquires a ready worker from the pool or enqueues FIFO request.
   */
  public async acquireWorker(timeoutMs = this.acquireTimeoutMs, signal?: AbortSignal): Promise<LibreOfficeWorker> {
    if (this.isShuttingDown) {
      throw new Error('LibreOfficePoolManager is shutting down.');
    }
    if (signal?.aborted) {
      throw signal.reason || new Error('The operation was aborted');
    }

    // 1. Look for already READY worker
    const readyWorker = this.workers.find((w) => w.state === 'READY');
    if (readyWorker) {
      readyWorker.state = 'BUSY';
      readyWorker.lastUsedAt = Date.now();
      return readyWorker;
    }

    // 2. Spawn a new worker if under maxWorkers limit
    if (this.workers.length < this.maxWorkers) {
      const newWorker = await this.createWorker();
      newWorker.state = 'BUSY';
      this.workers.push(newWorker);
      return newWorker;
    }

    // 3. Enqueue FIFO request
    return new Promise<LibreOfficeWorker>((resolve, reject) => {
      let onAbort: (() => void) | undefined;
      const cleanup = () => {
        if (signal && onAbort) {
          signal.removeEventListener('abort', onAbort);
        }
      };

      const timer = setTimeout(() => {
        cleanup();
        const idx = this.queue.findIndex((q) => q.resolve === resolve);
        if (idx !== -1) {
          this.queue.splice(idx, 1);
        }
        reject(new LibreOfficePoolTimeoutError());
      }, timeoutMs);

      if (signal) {
        onAbort = () => {
          clearTimeout(timer);
          cleanup();
          const idx = this.queue.findIndex((q) => q.resolve === resolve);
          if (idx !== -1) {
            this.queue.splice(idx, 1);
          }
          reject(signal.reason || new Error('The operation was aborted'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }

      this.queue.push({
        resolve: (w) => {
          cleanup();
          resolve(w);
        },
        reject: (err) => {
          cleanup();
          reject(err);
        },
        timer,
      });
    });
  }

  /**
   * Releases worker back to pool or recycles if limit reached / error occurred.
   */
  public async releaseWorker(worker: LibreOfficeWorker, hasError = false): Promise<void> {
    if (this.isShuttingDown) {
      await this.destroyWorker(worker);
      return;
    }

    worker.jobCount++;
    this.totalJobsProcessed++;

    const needsRecycle = hasError || worker.jobCount >= this.maxJobsPerWorker;
    if (needsRecycle) {
      await this.recycleWorker(worker);
      return;
    }

    worker.state = 'READY';
    worker.lastUsedAt = Date.now();

    // Dispatch next queued job if available
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      clearTimeout(next.timer);
      worker.state = 'BUSY';
      next.resolve(worker);
    }
  }

  /**
   * Recycles a worker by safely cleaning up its resources and replacing it.
   */
  public async recycleWorker(worker: LibreOfficeWorker): Promise<void> {
    worker.state = 'RECYCLING';
    await this.destroyWorker(worker);

    // Remove from workers array
    const idx = this.workers.findIndex((w) => w.id === worker.id);
    if (idx !== -1) {
      this.workers.splice(idx, 1);
    }

    if (this.isShuttingDown) return;

    // Spawn a fresh replacement worker
    try {
      const replacement = await this.createWorker();
      this.workers.push(replacement);

      if (this.queue.length > 0) {
        const next = this.queue.shift()!;
        clearTimeout(next.timer);
        replacement.state = 'BUSY';
        next.resolve(replacement);
      }
    } catch (err) {
      console.warn('[LibreOfficePoolManager] Warning: failed to spawn replacement worker:', err);
    }
  }

  /**
   * Cleans up directories and marks worker DEAD.
   */
  private async destroyWorker(worker: LibreOfficeWorker): Promise<void> {
    worker.state = 'DEAD';
    try {
      if (fs.existsSync(worker.userProfileDir)) {
        fs.rmSync(worker.userProfileDir, { recursive: true, force: true });
      }
    } catch {}
    try {
      if (fs.existsSync(worker.workDir)) {
        fs.rmSync(worker.workDir, { recursive: true, force: true });
      }
    } catch {}
  }

  private prepareInputPath(
    jobSubdir: string,
    src: string,
    input: Buffer | { inputPath?: string; outputPath?: string; inputBuffer?: Buffer }
  ): string {
    if (Buffer.isBuffer(input)) {
      const inputPath = path.join(jobSubdir, `input.${src}`);
      fs.writeFileSync(inputPath, input);
      return inputPath;
    }
    if (input.inputPath && fs.existsSync(input.inputPath)) {
      return input.inputPath;
    }
    if (input.inputBuffer) {
      const inputPath = path.join(jobSubdir, `input.${src}`);
      fs.writeFileSync(inputPath, input.inputBuffer);
      return inputPath;
    }
    throw new Error('LibreOffice pool conversion received invalid input payload');
  }

  private buildPersistedResult(
    tempOutputPath: string,
    targetFormat: string,
    baseName: string,
    startTime: number,
    input: any,
    options: WorkerEngineOptions
  ): WorkerConversionResult {
    let persistedPath = input?.outputPath || (options as any)?.outputPath;
    if (!persistedPath) {
      const vfsDir = path.join(os.tmpdir(), 'easyconvert-vfs');
      if (!fs.existsSync(vfsDir)) {
        try {
          fs.mkdirSync(vfsDir, { recursive: true, mode: 0o700 });
        } catch {}
      }
      persistedPath = path.join(vfsDir, `easyconvert-out-${crypto.randomUUID()}.${targetFormat}`);
    }
    fs.copyFileSync(tempOutputPath, persistedPath);

    const stat = fs.statSync(persistedPath);
    let cachedBuffer: Buffer | null = null;
    return {
      filePath: persistedPath,
      mimeType: MIME_TYPES[targetFormat] || 'application/octet-stream',
      filename: `${baseName}.${targetFormat}`,
      size: stat.size,
      engineUsed: 'native-soffice-pool',
      executionTimeMs: Date.now() - startTime,
      get buffer(): Buffer {
        if (cachedBuffer) return cachedBuffer;
        if (stat.size > 2 * 1024 * 1024 * 1024 - 1) {
          throw new RangeError(
            `Cannot read file (${stat.size} bytes) into single Node.js Buffer because it exceeds 2GB V8 buffer limit. Use filePath streaming instead.`
          );
        }
        if (fs.existsSync(persistedPath)) {
          cachedBuffer = fs.readFileSync(persistedPath);
          return cachedBuffer;
        }
        return Buffer.alloc(0);
      },
      set buffer(b: Buffer) {
        cachedBuffer = b;
      },
    };
  }

  /**
   * Executes a document conversion job using a pre-warmed worker daemon from the pool.
   */
  public async convert(
    input: Buffer | { inputPath?: string; outputPath?: string; inputBuffer?: Buffer },
    sourceFormat: string,
    targetFormat: string,
    options: WorkerEngineOptions = {},
    originalFilename = 'file'
  ): Promise<WorkerConversionResult | null> {
    const src = validateFormat(sourceFormat);
    const tgt = validateFormat(targetFormat);

    if (options.signal?.aborted) {
      throw options.signal.reason || new Error('The operation was aborted');
    }

    if (!this.sofficePath || (!fs.existsSync(this.sofficePath) && this.executor === executeSandboxedBinary)) {
      return null;
    }

    const worker = await this.acquireWorker(options.timeoutMs, options.signal);
    let hasError = false;
    const startTime = Date.now();
    const baseName = originalFilename ? originalFilename.replace(/\.[^/.]+$/, '') : 'converted';
    const jobSubdir = path.join(worker.workDir, `job_${crypto.randomUUID().slice(0, 8)}`);

    try {
      fs.mkdirSync(jobSubdir, { recursive: true, mode: 0o700 });
      const inputPath = this.prepareInputPath(jobSubdir, src, input);

      const timeout = Math.min(options.timeoutMs || 45000, 120000);
      const maxBuffer = Math.min(options.maxBufferBytes || 100 * 1024 * 1024, 500 * 1024 * 1024);

      const convertArgs = [
        '--headless',
        '--norestore',
        '--nofirststartwizard',
        '--nologo',
        `-env:UserInstallation=file://${worker.userProfileDir}`,
      ];
      if (this.daemonMode && worker.unoAccept) {
        convertArgs.push(`--accept=${worker.unoAccept}`);
      }
      convertArgs.push(
        '--convert-to',
        resolveLibreOfficeFilter(tgt, src, options),
        '--outdir',
        jobSubdir,
        inputPath
      );

      await this.executor(
        this.sofficePath,
        convertArgs,
        {
          cwd: jobSubdir,
          timeoutMs: timeout,
          maxBuffer,
          env: { HOME: jobSubdir, SAL_USE_VCLPLUGIN: 'svp' },
          networkIsolated: true,
          signal: options.signal,
        }
      );

      const matches = fs
        .readdirSync(jobSubdir)
        .filter((f) => f.startsWith('input.') && !f.endsWith(`.${src}`));
      if (matches.length === 0) {
        hasError = true;
        throw new Error(
          `LibreOffice execution completed without producing expected output file for target format "${tgt}"`
        );
      }

      return this.buildPersistedResult(
        path.join(jobSubdir, matches[0]),
        tgt,
        baseName,
        startTime,
        input,
        options
      );
    } catch (err) {
      hasError = true;
      throw err;
    } finally {
      try {
        if (fs.existsSync(jobSubdir)) {
          fs.rmSync(jobSubdir, { recursive: true, force: true });
        }
      } catch {}
      await this.releaseWorker(worker, hasError);
    }
  }

  /**
   * Shuts down pool, cleans up all worker sandboxes, and rejects pending requests.
   */
  public async shutdown(): Promise<void> {
    this.isShuttingDown = true;

    // Reject queued jobs
    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      clearTimeout(item.timer);
      item.reject(new Error('LibreOfficePoolManager has been shut down.'));
    }

    // Destroy all workers
    const destroyPromises = this.workers.map((w) => this.destroyWorker(w));
    await Promise.all(destroyPromises);
    this.workers = [];
  }

  /**
   * Introspects pool statistics for monitoring and health checking.
   */
  public getStats(): LibreOfficePoolStats {
    let ready = 0;
    let busy = 0;
    let recycling = 0;
    let dead = 0;

    for (const w of this.workers) {
      switch (w.state) {
        case 'READY':
          ready++;
          break;
        case 'BUSY':
          busy++;
          break;
        case 'RECYCLING':
          recycling++;
          break;
        case 'DEAD':
          dead++;
          break;
        default:
          break;
      }
    }

    return {
      totalWorkers: this.workers.length,
      readyWorkers: ready,
      busyWorkers: busy,
      recyclingWorkers: recycling,
      deadWorkers: dead,
      queueLength: this.queue.length,
      totalJobsProcessed: this.totalJobsProcessed,
      maxJobsPerWorker: this.maxJobsPerWorker,
      daemonMode: this.daemonMode,
    };
  }
}
