import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { ConversionOptions, ConversionResult } from '../lib/types';
import { convertFile } from '../lib/conversions';
import { getFormatByExtension, assertNotSpoofedFile } from '../lib/registry';
import { assertNotSpoofedFilePath } from '../lib/security/file-guard';
import {
  buildFfmpegArguments,
  probeHardwareAcceleration,
  HardwareAccelerationCapabilities,
} from '../lib/conversions/media-ffmpeg-args';
import { executeSandboxedBinary } from './sandbox';
import { extractWithSpannedStream7z } from '../lib/conversions/archive';
import { LibreOfficePoolManager, resolveLibreOfficeFilter } from './libreoffice-pool';

export interface WorkerVfsPayload {
  inputPath?: string;
  outputPath?: string;
  inputBuffer?: Buffer;
}

export class EngineUnavailableError extends Error {
  public readonly engineName: string;
  public readonly reason: string;

  constructor(engineName: string, reason?: string) {
    const msg = reason ? `Engine '${engineName}' is unavailable: ${reason}` : `Engine '${engineName}' is unavailable`;
    super(msg);
    this.name = 'EngineUnavailableError';
    this.engineName = engineName;
    this.reason = reason || msg;
  }
}

export interface WorkerEngineOptions extends ConversionOptions {
  timeoutMs?: number;
  maxBufferBytes?: number;
  page?: number;
  dpi?: number;
  zeroHeap?: boolean;
  signal?: AbortSignal;
  throwOnUnavailable?: boolean;
}

export interface WorkerConversionResult extends ConversionResult {
  engineUsed: 'native-soffice' | 'native-soffice-pool' | 'native-ffmpeg' | 'native-7z' | 'native-poppler' | 'internal-fallback';
  executionTimeMs: number;
  filePath?: string;
  metadata?: Record<string, unknown>;
  fallbackReason?: string;
}

// Fixed standard locations for native CLI binaries (hardened against injection)
const BINARY_PATHS: Record<string, string[]> = {
  soffice: [
    ...(process.env.SOFFICE_PATH ? [process.env.SOFFICE_PATH] : []),
    '/usr/bin/soffice',
    '/usr/local/bin/soffice',
    '/opt/homebrew/bin/soffice',
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
  ],
  ffmpeg: [
    ...(process.env.FFMPEG_PATH ? [process.env.FFMPEG_PATH] : []),
    '/usr/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/opt/homebrew/bin/ffmpeg',
  ],
  p7zip: [
    ...(process.env.P7ZIP_PATH ? [process.env.P7ZIP_PATH] : []),
    '/usr/bin/7z',
    '/usr/bin/7za',
    '/usr/local/bin/7z',
    '/opt/homebrew/bin/7z',
  ],
  pdftoppm: [
    ...(process.env.PDFTOPPM_PATH ? [process.env.PDFTOPPM_PATH] : []),
    '/usr/bin/pdftoppm',
    '/usr/local/bin/pdftoppm',
    '/opt/homebrew/bin/pdftoppm',
  ],
  pdftotext: [
    ...(process.env.PDFTOTEXT_PATH ? [process.env.PDFTOTEXT_PATH] : []),
    '/usr/bin/pdftotext',
    '/usr/local/bin/pdftotext',
    '/opt/homebrew/bin/pdftotext',
  ],
  tesseract: [
    ...(process.env.TESSERACT_PATH ? [process.env.TESSERACT_PATH] : []),
    '/usr/bin/tesseract',
    '/usr/local/bin/tesseract',
    '/opt/homebrew/bin/tesseract',
  ],
};

const SAFE_ALPHANUMERIC_REGEX = /^[a-zA-Z0-9.-]{1,16}$/;

function validateFormat(format: string): string {
  const sanitized = format.trim().toLowerCase();
  if (!SAFE_ALPHANUMERIC_REGEX.test(sanitized)) {
    throw new Error(`Invalid format identifier: "${format}"`);
  }
  return sanitized;
}

function resolveBinary(candidates: string[], envOverride?: string): string | null {
  if (envOverride !== undefined) {
    if (path.isAbsolute(envOverride) && fs.existsSync(envOverride)) {
      return envOverride;
    }
    return null;
  }
  for (const candidate of candidates) {
    if (path.isAbsolute(candidate) && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Checks availability of native conversion engines in the execution environment.
 */
export function probeNativeEngines(): {
  soffice: boolean;
  ffmpeg: boolean;
  p7zip: boolean;
  pdftoppm: boolean;
  pdftotext: boolean;
  tesseract: boolean;
  hardwareAcceleration?: HardwareAccelerationCapabilities;
} {
  const ffmpegPath = resolveBinary(BINARY_PATHS.ffmpeg, process.env.FFMPEG_PATH);
  return {
    soffice: resolveBinary(BINARY_PATHS.soffice, process.env.SOFFICE_PATH) !== null,
    ffmpeg: ffmpegPath !== null,
    p7zip: resolveBinary(BINARY_PATHS.p7zip, process.env.P7ZIP_PATH) !== null,
    pdftoppm: resolveBinary(BINARY_PATHS.pdftoppm, process.env.PDFTOPPM_PATH) !== null,
    pdftotext: resolveBinary(BINARY_PATHS.pdftotext, process.env.PDFTOTEXT_PATH) !== null,
    tesseract: resolveBinary(BINARY_PATHS.tesseract, process.env.TESSERACT_PATH) !== null,
    hardwareAcceleration: probeHardwareAcceleration(ffmpegPath),
  };
}

/**
 * Pre-warmed LibreOffice Daemon Worker Pool Instance.
 */
const sofficeResolvedPath = resolveBinary(BINARY_PATHS.soffice, process.env.SOFFICE_PATH);
export const libreOfficePool = new LibreOfficePoolManager({
  sofficePath: sofficeResolvedPath,
  enabled: sofficeResolvedPath !== null,
});

export function getLibreOfficePool(): LibreOfficePoolManager {
  return libreOfficePool;
}

/**
 * Scoped sandbox directory runner with automated cleanup and error encapsulation.
 */
async function withSandboxDir<T>(
  prefix: string,
  operation: (tempDir: string) => Promise<T>
): Promise<T> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return await operation(tempDir);
  } finally {
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {}
  }
}

/**
 * Resolves disk input path and ownership from Buffer or WorkerVfsPayload.
 */
export function resolveInputContext(
  input: Buffer | WorkerVfsPayload,
  ext: string,
  tempDir: string
): { inputPath: string; isTemporary: boolean } {
  if (Buffer.isBuffer(input)) {
    const p = path.join(tempDir, `input.${ext}`);
    fs.writeFileSync(p, input);
    return { inputPath: p, isTemporary: true };
  }
  if (typeof input === 'object' && input !== null) {
    if (input.inputPath && fs.existsSync(input.inputPath)) {
      return { inputPath: input.inputPath, isTemporary: false };
    }
    if (input.inputBuffer) {
      const p = path.join(tempDir, `input.${ext}`);
      fs.writeFileSync(p, input.inputBuffer);
      return { inputPath: p, isTemporary: true };
    }
  }
  throw new Error('Worker conversion received invalid input payload: neither inputPath nor inputBuffer provided');
}

/**
 * Asserts fail-closed that magic bytes match declared format using zero-heap header sniffing.
 */
export function assertNotSpoofedFileVfs(
  input: Buffer | Uint8Array | WorkerVfsPayload,
  declaredExt: string,
  filename?: string
): void {
  if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
    assertNotSpoofedFile(input, declaredExt, filename);
    return;
  }
  if (typeof input === 'object' && input !== null) {
    if (input.inputBuffer !== undefined) {
      assertNotSpoofedFile(input.inputBuffer, declaredExt, filename);
      return;
    }
    if (input.inputPath) {
      assertNotSpoofedFilePath(input.inputPath, declaredExt, filename);
      return;
    }
  }
  throw new Error('VFS payload contains no valid inputBuffer or inputPath to verify. Operation failed closed.');
}

/**
 * Persists an output file to target VFS destination outside ephemeral sandbox before cleanup.
 */
export function preserveOutput(
  tempOutputPath: string,
  targetFormat: string,
  options?: WorkerEngineOptions,
  vfsPayload?: WorkerVfsPayload
): string {
  const desiredOutput = vfsPayload?.outputPath || (options as any)?.outputPath;
  let finalPath = desiredOutput;
  if (!finalPath) {
    const vfsDir = path.join(os.tmpdir(), 'easyconvert-vfs');
    if (!fs.existsSync(vfsDir)) {
      try {
        fs.mkdirSync(vfsDir, { recursive: true, mode: 0o700 });
      } catch {}
    }
    finalPath = path.join(vfsDir, `easyconvert-out-${crypto.randomUUID()}.${targetFormat}`);
  }
  fs.copyFileSync(tempOutputPath, finalPath);
  return finalPath;
}

/**
 * Creates lazy zero-heap WorkerConversionResult supporting 2GB+ payloads without heap overflow.
 */
export function createConversionResult(
  persistedFilePath: string,
  targetFormat: string,
  baseName: string,
  engineUsed: WorkerConversionResult['engineUsed'],
  executionTimeMs: number
): WorkerConversionResult {
  const stat = fs.statSync(persistedFilePath);
  let cachedBuffer: Buffer | null = null;
  return {
    filePath: persistedFilePath,
    mimeType: getMimeType(targetFormat),
    filename: `${baseName}.${targetFormat}`,
    size: stat.size,
    engineUsed,
    executionTimeMs,
    get buffer(): Buffer {
      if (cachedBuffer) return cachedBuffer;
      // V8 Buffer max size is 2GB - 1 byte (2147483647)
      if (stat.size > 2 * 1024 * 1024 * 1024 - 1) {
        throw new RangeError(
          `Cannot read file (${stat.size} bytes) into single Node.js Buffer because it exceeds 2GB V8 buffer limit. Use filePath streaming instead.`
        );
      }
      if (fs.existsSync(persistedFilePath)) {
        cachedBuffer = fs.readFileSync(persistedFilePath);
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
 * Converts an Office document using headless LibreOffice in an isolated sandbox.
 * Leverages the pre-warmed daemon pool with sub-200ms dispatch, auto-recycling,
 * and seamless fail-closed fallback to standalone sandbox execution.
 */
export async function convertWithHeadlessOffice(
  input: Buffer | WorkerVfsPayload,
  sourceFormat: string,
  targetFormat: string,
  options: WorkerEngineOptions = {},
  originalFilename = 'file'
): Promise<WorkerConversionResult | null> {
  const src = validateFormat(sourceFormat);
  const tgt = validateFormat(targetFormat);
  const sofficeBin = resolveBinary(BINARY_PATHS.soffice, process.env.SOFFICE_PATH);
  if (!sofficeBin) {
    libreOfficePool.setSofficePath(null);
    if (options.throwOnUnavailable) {
      throw new EngineUnavailableError('soffice', 'LibreOffice binary is not installed or not in PATH');
    }
    return null;
  }

  libreOfficePool.setSofficePath(sofficeBin);

  if (libreOfficePool.isEnabled()) {
    try {
      const poolResult = await libreOfficePool.convert(
        input as any,
        src,
        tgt,
        options,
        originalFilename
      );
      if (poolResult) {
        return poolResult;
      }
    } catch {
      // Fall through cleanly to standalone sandbox execution
    }
  }

  const baseName = originalFilename ? originalFilename.replace(/\.[^/.]+$/, '') : 'converted';
  const startTime = Date.now();

  try {
    return await withSandboxDir('easyconvert-office-', async (tempDir) => {
      const { inputPath } = resolveInputContext(input, src, tempDir);

      const timeout = Math.min(options.timeoutMs || 45000, 120000);
      const maxBuffer = Math.min(options.maxBufferBytes || 100 * 1024 * 1024, 500 * 1024 * 1024);

      await executeSandboxedBinary(
        sofficeBin,
        [
          '--headless',
          '--norestore',
          '--nofirststartwizard',
          '--nologo',
          `-env:UserInstallation=file://${tempDir}/user`,
          '--convert-to',
          resolveLibreOfficeFilter(tgt, src, options),
          '--outdir',
          tempDir,
          inputPath,
        ],
        {
          cwd: tempDir,
          timeoutMs: timeout,
          maxBuffer,
          env: { HOME: tempDir, SAL_USE_VCLPLUGIN: 'svp' },
          networkIsolated: true,
          signal: options.signal,
        }
      );

      const matches = fs.readdirSync(tempDir).filter((f) => f.startsWith('input.') && !f.endsWith(`.${src}`));
      if (matches.length === 0) {
        throw new Error(`LibreOffice execution completed without producing expected output file for target format "${tgt}"`);
      }

      const tempOutputPath = path.join(tempDir, matches[0]);
      const vfsPayload = Buffer.isBuffer(input) ? undefined : input;
      const persistedPath = preserveOutput(tempOutputPath, tgt, options, vfsPayload);

      return createConversionResult(
        persistedPath,
        tgt,
        baseName,
        'native-soffice',
        Date.now() - startTime
      );
    });
  } catch (err) {
    if (options.throwOnUnavailable) {
      throw err;
    }
    return null;
  }
}

/**
 * Transcodes media using native FFmpeg with strict argument boundaries.
 */
export async function convertWithNativeFfmpeg(
  input: Buffer | WorkerVfsPayload,
  sourceFormat: string,
  targetFormat: string,
  options: WorkerEngineOptions = {},
  originalFilename = 'file'
): Promise<WorkerConversionResult | null> {
  const src = validateFormat(sourceFormat);
  const tgt = validateFormat(targetFormat);
  const ffmpegBin = resolveBinary(BINARY_PATHS.ffmpeg, process.env.FFMPEG_PATH);
  if (!ffmpegBin) {
    if (options.throwOnUnavailable) {
      throw new EngineUnavailableError('ffmpeg', 'FFmpeg binary is not installed or not in PATH');
    }
    return null;
  }

  const baseName = originalFilename ? originalFilename.replace(/\.[^/.]+$/, '') : 'converted';
  const startTime = Date.now();

  try {
    return await withSandboxDir('easyconvert-ffmpeg-', async (tempDir) => {
      const { inputPath } = resolveInputContext(input, src, tempDir);
      const tempOutputPath = path.join(tempDir, `output.${tgt}`);

      const timeout = Math.min(options.timeoutMs || 60000, 180000);
      const maxBuffer = Math.min(options.maxBufferBytes || 200 * 1024 * 1024, 500 * 1024 * 1024);
      const args = buildFfmpegArguments(inputPath, tempOutputPath, src, tgt, options, ffmpegBin);

      await executeSandboxedBinary(ffmpegBin, args, {
        cwd: tempDir,
        timeoutMs: timeout,
        maxBuffer,
        networkIsolated: true,
        signal: options.signal,
      });

      if (!fs.existsSync(tempOutputPath)) {
        throw new Error(`FFmpeg execution completed without producing expected output file "${tempOutputPath}"`);
      }

      const vfsPayload = Buffer.isBuffer(input) ? undefined : input;
      const persistedPath = preserveOutput(tempOutputPath, tgt, options, vfsPayload);

      return createConversionResult(
        persistedPath,
        tgt,
        baseName,
        'native-ffmpeg',
        Date.now() - startTime
      );
    });
  } catch (err) {
    if (options.throwOnUnavailable) {
      throw err;
    }
    return null;
  }
}

/**
 * Archive extraction and re-packaging formats supported by 7-Zip CLI.
 */
const ARCHIVE_EXTRACT_FORMATS = new Set([
  'zip', '7z', 'rar', 'tar', 'gz', 'gzip', 'tgz', 'tar.gz',
  'bz2', 'bzip2', 'tbz2', 'tar.bz2', 'xz', 'txz', 'tar.xz',
  'iso', 'deb', 'rpm', 'cab', 'wim', 'arj', 'cpio', 'lzh', 'zstd', 'zst',
]);

const ARCHIVE_TARGET_FORMATS = new Set([
  'zip', '7z', 'tar', 'gz', 'gzip', 'tgz', 'tar.gz',
  'bz2', 'bzip2', 'tbz2', 'tar.bz2', 'xz', 'txz', 'tar.xz',
]);

function get7zArchiveType(format: string): string | null {
  switch (format.toLowerCase()) {
    case '7z':
      return '7z';
    case 'zip':
      return 'zip';
    case 'tar':
      return 'tar';
    case 'gz':
    case 'gzip':
    case 'tgz':
    case 'tar.gz':
      return 'gzip';
    case 'bz2':
    case 'bzip2':
    case 'tbz2':
    case 'tar.bz2':
      return 'bzip2';
    case 'xz':
    case 'txz':
    case 'tar.xz':
      return 'xz';
    default:
      return null;
  }
}

interface Package7zArchiveParams {
  p7zBin: string;
  tgt: string;
  extractDir: string;
  tempDir: string;
  tempOutputPath: string;
  timeout: number;
  maxBuffer: number;
  options?: WorkerEngineOptions;
}

async function package7zArchive(params: Package7zArchiveParams): Promise<boolean> {
  const { p7zBin, tgt, extractDir, tempDir, tempOutputPath, timeout, maxBuffer, options } = params;
  const isTarGz = tgt === 'tar.gz' || tgt === 'tgz';
  const isTarBz2 = tgt === 'tar.bz2' || tgt === 'tbz2' || tgt === 'tbz';
  const isTarXz = tgt === 'tar.xz' || tgt === 'txz';

    if (isTarGz || isTarBz2 || isTarXz) {
    const tarPath = path.join(tempDir, 'archive.tar');
    await executeSandboxedBinary(p7zBin, ['a', '-y', '-ttar', tarPath, '.'], {
      cwd: extractDir,
      timeoutMs: timeout,
      maxBuffer,
      networkIsolated: true,
      signal: options?.signal,
    });
    let subType = '-txz';
    if (isTarGz) {
      subType = '-tgzip';
    } else if (isTarBz2) {
      subType = '-tbzip2';
    }
    await executeSandboxedBinary(p7zBin, ['a', '-y', subType, tempOutputPath, tarPath], {
      cwd: tempDir,
      timeoutMs: timeout,
      maxBuffer,
      networkIsolated: true,
      signal: options?.signal,
    });
    return true;
  }

  const archiveType = get7zArchiveType(tgt);
  if (!archiveType) return false;

  const pwArgs = options?.password && (tgt === 'zip' || tgt === '7z') ? ['-p'] : [];
  const pwInput =
    options?.password && (tgt === 'zip' || tgt === '7z')
      ? Buffer.from(`${options.password}\n${options.password}\n`)
      : undefined;

  await executeSandboxedBinary(p7zBin, ['a', '-y', `-t${archiveType}`, ...pwArgs, tempOutputPath, '.'], {
    cwd: extractDir,
    timeoutMs: timeout,
    maxBuffer,
    networkIsolated: true,
    stdin: pwInput,
    signal: options?.signal,
  });
  return true;
}

interface ExtractArchiveParams {
  p7zBin: string;
  inputPath: string;
  extractDir: string;
  tempDir: string;
  timeout: number;
  maxBuffer: number;
  options?: WorkerEngineOptions;
}

async function extractSourceArchive(params: ExtractArchiveParams): Promise<void> {
  const { p7zBin, inputPath, extractDir, tempDir, timeout, maxBuffer, options } = params;
  if (options?.archiveParts && options.archiveParts.length > 0) {
    await extractWithSpannedStream7z(options.archiveParts as any, extractDir, {
      timeoutMs: timeout,
      maxBuffer,
      password: options.password,
    });
  } else {
    const pwArgs = options?.password ? ['-p'] : [];
    await executeSandboxedBinary(
      p7zBin,
      ['x', '-y', ...pwArgs, `-o${extractDir}`, inputPath],
      {
        cwd: tempDir,
        timeoutMs: timeout,
        maxBuffer,
        networkIsolated: true,
        stdin: options?.password ? Buffer.from(options.password + '\n') : undefined,
        signal: options?.signal,
      }
    );
  }
}

/**
 * Converts or extracts archives using the native 7-Zip CLI engine.
 */
export async function convertWithNative7z(
  input: Buffer | WorkerVfsPayload,
  sourceFormat: string,
  targetFormat: string,
  options: WorkerEngineOptions = {},
  originalFilename = 'file'
): Promise<WorkerConversionResult | null> {
  const src = validateFormat(sourceFormat);
  const tgt = validateFormat(targetFormat);
  const p7zBin = resolveBinary(BINARY_PATHS.p7zip, process.env.P7ZIP_PATH);
  if (!p7zBin) {
    if (options.throwOnUnavailable) {
      throw new EngineUnavailableError('7z', '7-Zip binary is not installed or not in PATH');
    }
    return null;
  }

  const baseName = originalFilename ? originalFilename.replace(/\.[^/.]+$/, '') : 'converted';
  const startTime = Date.now();

  try {
    return await withSandboxDir('easyconvert-7z-', async (tempDir) => {
      const inputExt = src.includes('.') ? src.split('.').pop()! : src;
      const { inputPath } = resolveInputContext(input, inputExt, tempDir);

      const timeout = Math.min(options.timeoutMs || 60000, 180000);
      const maxBuffer = Math.min(options.maxBufferBytes || 200 * 1024 * 1024, 500 * 1024 * 1024);
      const extractDir = path.join(tempDir, 'extracted');
      fs.mkdirSync(extractDir, { recursive: true });

      // Step 1: Extract if source is an archive container, otherwise copy/place single file into extract directory
      if (ARCHIVE_EXTRACT_FORMATS.has(src)) {
        await extractSourceArchive({
          p7zBin,
          inputPath,
          extractDir,
          tempDir,
          timeout,
          maxBuffer,
          options,
        });
      } else {
        const destPath = path.join(extractDir, originalFilename || `file.${src}`);
        fs.copyFileSync(inputPath, destPath);
      }

      const extractedFiles = fs.readdirSync(extractDir);
      if (extractedFiles.length === 0) {
        throw new Error('7-Zip extraction completed without producing any files');
      }

      const tempOutputPath = path.join(tempDir, `output.${tgt}`);
      const packaged = await package7zArchive({
        p7zBin,
        tgt,
        extractDir,
        tempDir,
        tempOutputPath,
        timeout,
        maxBuffer,
        options,
      });
      if (!packaged || !fs.existsSync(tempOutputPath)) {
        throw new Error('7-Zip packaging failed to produce output archive');
      }

      const vfsPayload = Buffer.isBuffer(input) ? undefined : input;
      const persistedPath = preserveOutput(tempOutputPath, tgt, options, vfsPayload);

      return createConversionResult(
        persistedPath,
        tgt,
        baseName,
        'native-7z',
        Date.now() - startTime
      );
    });
  } catch (err) {
    if (options.throwOnUnavailable) {
      throw err;
    }
    return null;
  }
}

/**
 * Image formats supported by Poppler pdftoppm.
 */
const POPPLER_IMAGE_FORMATS = new Set(['png', 'jpg', 'jpeg', 'tiff', 'tif', 'ppm']);

function buildPdftoppmArgs(tgt: string, options: WorkerEngineOptions, inputPath: string, prefix: string): string[] {
  const dpi = options.dpi && options.dpi >= 72 && options.dpi <= 600 ? options.dpi : 150;
  const args: string[] = ['-r', String(dpi)];

  if (tgt === 'png') {
    args.push('-png');
  } else if (tgt === 'jpg' || tgt === 'jpeg') {
    args.push('-jpeg');
  } else if (tgt === 'tiff' || tgt === 'tif') {
    args.push('-tiff');
  }

  if (options.page && Number.isInteger(options.page) && options.page > 0) {
    args.push('-f', String(options.page), '-l', String(options.page));
  } else {
    args.push('-f', '1', '-l', '1');
  }

  args.push(inputPath, prefix);
  return args;
}

async function convertPdfToTextWithPoppler(
  input: Buffer | WorkerVfsPayload,
  options: WorkerEngineOptions,
  originalFilename: string,
  startTime: number,
  timeout: number,
  maxBuffer: number
): Promise<WorkerConversionResult | null> {
  const pdftotextBin = resolveBinary(BINARY_PATHS.pdftotext, process.env.PDFTOTEXT_PATH);
  if (!pdftotextBin) {
    if (options.throwOnUnavailable) {
      throw new EngineUnavailableError('pdftotext', 'pdftotext binary is not installed or not in PATH');
    }
    return null;
  }

  const baseName = originalFilename ? originalFilename.replace(/\.[^/.]+$/, '') : 'converted';
  try {
    return await withSandboxDir('easyconvert-poppler-txt-', async (tempDir) => {
      const { inputPath } = resolveInputContext(input, 'pdf', tempDir);
      const tempOutputPath = path.join(tempDir, 'output.txt');

      await executeSandboxedBinary(
        pdftotextBin,
        ['-layout', inputPath, tempOutputPath],
        {
          cwd: tempDir,
          timeoutMs: timeout,
          maxBuffer,
          networkIsolated: true,
          signal: options.signal,
        }
      );

      if (!fs.existsSync(tempOutputPath)) {
        throw new Error(`pdftotext execution completed without producing expected output file "${tempOutputPath}"`);
      }

      const vfsPayload = Buffer.isBuffer(input) ? undefined : input;
      const persistedPath = preserveOutput(tempOutputPath, 'txt', options, vfsPayload);

      return createConversionResult(
        persistedPath,
        'txt',
        baseName,
        'native-poppler',
        Date.now() - startTime
      );
    });
  } catch (err) {
    if (options.throwOnUnavailable) {
      throw err;
    }
    return null;
  }
}

async function renderPdfToImageWithPoppler(
  input: Buffer | WorkerVfsPayload,
  tgt: string,
  options: WorkerEngineOptions,
  originalFilename: string,
  startTime: number,
  timeout: number,
  maxBuffer: number
): Promise<WorkerConversionResult | null> {
  const pdftoppmBin = resolveBinary(BINARY_PATHS.pdftoppm, process.env.PDFTOPPM_PATH);
  if (!pdftoppmBin) {
    if (options.throwOnUnavailable) {
      throw new EngineUnavailableError('pdftoppm', 'pdftoppm binary is not installed or not in PATH');
    }
    return null;
  }

  const baseName = originalFilename ? originalFilename.replace(/\.[^/.]+$/, '') : 'converted';
  try {
    return await withSandboxDir('easyconvert-poppler-img-', async (tempDir) => {
      const { inputPath } = resolveInputContext(input, 'pdf', tempDir);
      const prefix = path.join(tempDir, 'page');
      const args = buildPdftoppmArgs(tgt, options, inputPath, prefix);

      await executeSandboxedBinary(pdftoppmBin, args, {
        cwd: tempDir,
        timeoutMs: timeout,
        maxBuffer,
        networkIsolated: true,
        signal: options.signal,
      });

      const files = fs.readdirSync(tempDir).filter((f) => f.startsWith('page') && !f.endsWith('.pdf'));
      if (files.length === 0) {
        throw new Error('pdftoppm execution completed without producing any output images');
      }

      const selectedFile = files.sort()[0];
      const tempOutputPath = path.join(tempDir, selectedFile);

      const vfsPayload = Buffer.isBuffer(input) ? undefined : input;
      const persistedPath = preserveOutput(tempOutputPath, tgt, options, vfsPayload);

      return createConversionResult(
        persistedPath,
        tgt,
        baseName,
        'native-poppler',
        Date.now() - startTime
      );
    });
  } catch (err) {
    if (options.throwOnUnavailable) {
      throw err;
    }
    return null;
  }
}

/**
 * Converts PDF documents using native Poppler utilities (pdftoppm and pdftotext).
 */
export async function convertWithNativePoppler(
  input: Buffer | WorkerVfsPayload,
  sourceFormat: string,
  targetFormat: string,
  options: WorkerEngineOptions = {},
  originalFilename = 'file'
): Promise<WorkerConversionResult | null> {
  const src = validateFormat(sourceFormat);
  const tgt = validateFormat(targetFormat);
  if (src !== 'pdf') return null;

  const startTime = Date.now();
  const timeout = Math.min(options.timeoutMs || 45000, 120000);
  const maxBuffer = Math.min(options.maxBufferBytes || 100 * 1024 * 1024, 500 * 1024 * 1024);

  // 1. Text extraction via pdftotext
  if (tgt === 'txt' || tgt === 'text') {
    return convertPdfToTextWithPoppler(input, options, originalFilename, startTime, timeout, maxBuffer);
  }

  // 2. High-fidelity raster rendering via pdftoppm
  if (POPPLER_IMAGE_FORMATS.has(tgt)) {
    return renderPdfToImageWithPoppler(input, tgt, options, originalFilename, startTime, timeout, maxBuffer);
  }

  return null;
}

/**
 * Universal Worker Conversion Orchestrator.
 * Dispatches to native container engines first, with fail-closed security and pure TS fallback.
 */
const OFFICE_FORMATS = new Set(['docx', 'doc', 'pptx', 'ppt', 'xlsx', 'xls', 'odt', 'ods', 'odp', 'rtf']);
const MEDIA_FORMATS = new Set(['mp4', 'mkv', 'avi', 'mov', 'webm', 'mp3', 'wav', 'aac', 'ogg', 'opus', 'flac', 'm4a', 'wma']);

export async function executeWorkerConversion(
  input: Buffer | WorkerVfsPayload,
  sourceFormat: string,
  targetFormat: string,
  options: WorkerEngineOptions = {},
  originalFilename = 'file'
): Promise<WorkerConversionResult> {
  const src = validateFormat(sourceFormat);
  const tgt = validateFormat(targetFormat);
  const startTime = Date.now();

  // Fail-closed verification against spoofed file extensions before any native engine execution
  assertNotSpoofedFileVfs(input, src, originalFilename);

  let fallbackReason: string | undefined;
  const nativeOptions: WorkerEngineOptions = { ...options, throwOnUnavailable: true };

  // 1. Native Headless Office
  if (OFFICE_FORMATS.has(src) && (tgt === 'pdf' || OFFICE_FORMATS.has(tgt))) {
    try {
      const officeRes = await convertWithHeadlessOffice(input, src, tgt, nativeOptions, originalFilename);
      if (officeRes) return officeRes;
    } catch (err) {
      if (err instanceof EngineUnavailableError) {
        if (options.pdfStandard) {
          throw new Error(
            `Native LibreOffice engine is required for pdfStandard '${options.pdfStandard}', but engine is unavailable: ${err.reason}`
          );
        }
        fallbackReason = err.message;
      } else {
        throw err;
      }
    }
  }

  // 2. Native FFmpeg
  if (MEDIA_FORMATS.has(src) && MEDIA_FORMATS.has(tgt)) {
    try {
      const ffmpegRes = await convertWithNativeFfmpeg(input, src, tgt, nativeOptions, originalFilename);
      if (ffmpegRes) return ffmpegRes;
    } catch (err) {
      if (err instanceof EngineUnavailableError) {
        fallbackReason = err.message;
      } else {
        throw err;
      }
    }
  }

  // 3. Native Poppler (PDF -> Image or Text)
  if (src === 'pdf' && (POPPLER_IMAGE_FORMATS.has(tgt) || tgt === 'txt' || tgt === 'text')) {
    try {
      const popplerRes = await convertWithNativePoppler(input, src, tgt, nativeOptions, originalFilename);
      if (popplerRes) return popplerRes;
    } catch (err) {
      if (err instanceof EngineUnavailableError) {
        fallbackReason = err.message;
      } else {
        throw err;
      }
    }
  }

  // 4. Native 7-Zip (Archive handling)
  if (ARCHIVE_EXTRACT_FORMATS.has(src) && ARCHIVE_TARGET_FORMATS.has(tgt)) {
    try {
      const p7zRes = await convertWithNative7z(input, src, tgt, nativeOptions, originalFilename);
      if (p7zRes) return p7zRes;
    } catch (err) {
      if (err instanceof EngineUnavailableError) {
        fallbackReason = err.message;
      } else {
        throw err;
      }
    }
  }

  // 5. In-Repo Pure TS Fallback
  if (options.pdfStandard) {
    throw new Error(
      `Fallback to pure TypeScript engine is forbidden when pdfStandard ('${options.pdfStandard}') is specified`
    );
  }

  let inputBuffer: Buffer;
  if (Buffer.isBuffer(input)) {
    inputBuffer = input;
  } else if (input.inputBuffer) {
    inputBuffer = input.inputBuffer;
  } else if (input.inputPath && fs.existsSync(input.inputPath)) {
    inputBuffer = fs.readFileSync(input.inputPath);
  } else {
    throw new Error('Worker conversion received invalid input payload: neither inputPath nor inputBuffer provided');
  }
  const internalRes = await convertFile(inputBuffer, src, tgt, options, originalFilename);
  const vfsPayload = Buffer.isBuffer(input) ? undefined : input;
  const desiredOutput = vfsPayload?.outputPath || (options as any)?.outputPath;
  let finalPath = desiredOutput;
  if (!finalPath && options.zeroHeap) {
    const vfsDir = path.join(os.tmpdir(), 'easyconvert-vfs');
    if (!fs.existsSync(vfsDir)) {
      try {
        fs.mkdirSync(vfsDir, { recursive: true, mode: 0o700 });
      } catch {}
    }
    finalPath = path.join(vfsDir, `easyconvert-out-${crypto.randomUUID()}.${tgt}`);
  }
  const fallbackMetadata: Record<string, unknown> = fallbackReason ? { fallbackReason } : {};
  if (finalPath) {
    fs.writeFileSync(finalPath, internalRes.buffer);
    return {
      ...internalRes,
      filePath: finalPath,
      engineUsed: 'internal-fallback',
      executionTimeMs: Date.now() - startTime,
      metadata: fallbackMetadata,
      fallbackReason,
    };
  }
  return {
    ...internalRes,
    engineUsed: 'internal-fallback',
    executionTimeMs: Date.now() - startTime,
    metadata: fallbackMetadata,
    fallbackReason,
  };
}

function getMimeType(format: string): string {
  const cleanFormat = format.toLowerCase().trim();
  const regDef = getFormatByExtension(cleanFormat);
  if (regDef?.mimeType) {
    return regDef.mimeType;
  }

  const map: Record<string, string> = {
    pdf: 'application/pdf',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    zip: 'application/zip',
    '7z': 'application/x-7z-compressed',
    tar: 'application/x-tar',
    gz: 'application/gzip',
    tgz: 'application/gzip',
    bz2: 'application/x-bzip2',
    tbz2: 'application/x-bzip-compressed-tar',
    xz: 'application/x-xz',
    txz: 'application/x-xz',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    tiff: 'image/tiff',
    ppm: 'image/x-portable-pixmap',
    txt: 'text/plain',
  };
  return map[cleanFormat] || 'application/octet-stream';
}
