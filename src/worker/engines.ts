import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import {
  ConversionOptions,
  ConversionResult,
  ArchiveEncryptionUnavailableError,
  UnsupportedOptionError,
  EngineUnavailableError,
  InvalidPageRangeError,
  ComplexScriptRequiresNativeEngineError,
  MediaPackagingOptions,
  UnsupportedTargetError,
} from '../lib/types';
import { PayloadTooLargeForMemoryError, getMaxInMemoryBytes } from '../lib/storage/errors';
import { convertFile } from '../lib/conversions';
import { hasComplexTextScript } from '../lib/conversions/ctl';
import { getFormatByExtension, assertNotSpoofedFile } from '../lib/registry';
import { assertNotSpoofedFilePath } from '../lib/security/file-guard';
import { parsePageRanges, groupConsecutiveRanges, PageInterval } from '../lib/conversions/page-range';
import {
  buildFfmpegArguments,
  buildHlsDashArguments,
  probeHardwareAcceleration,
  HardwareAccelerationCapabilities,
} from '../lib/conversions/media-ffmpeg-args';
import { probeMediaDuration, computeMediaTimeoutMs } from '../lib/conversions/media';
import { executeSandboxedBinary, SandboxedMemoryLimitError } from './sandbox';
import { extractWithSpannedStream7z } from '../lib/conversions/archive';
import { LibreOfficePoolManager, LibreOfficePoolTimeoutError, resolveLibreOfficeFilter } from './libreoffice-pool';

export { EngineUnavailableError, InvalidPageRangeError, ComplexScriptRequiresNativeEngineError };

export interface WorkerVfsPayload {
  inputPath?: string;
  outputPath?: string;
  inputBuffer?: Buffer;
}


export interface WorkerEngineOptions extends ConversionOptions {
  timeoutMs?: number;
  maxBufferBytes?: number;
  page?: number;
  dpi?: number;
  zeroHeap?: boolean;
  signal?: AbortSignal;
  throwOnUnavailable?: boolean;
  /**
   * When false, a pair that no available native engine converted fails instead of falling back
   * to the in-process engine: the last EngineUnavailableError is rethrown, or an
   * UnsupportedTargetError when no native route handles the pair at all.
   */
  inProcessFallback?: boolean;
}

export interface WorkerConversionResult extends ConversionResult {
  engineUsed: 'native-soffice' | 'native-soffice-pool' | 'native-ffmpeg' | 'native-7z' | 'native-poppler' | 'internal-fallback';
  executionTimeMs: number;
  filePath?: string;
  metadata?: Record<string, unknown>;
  fallbackReason?: string;
  fallbackChain?: string[];
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
  pdfinfo: [
    ...(process.env.PDFINFO_PATH ? [process.env.PDFINFO_PATH] : []),
    '/usr/bin/pdfinfo',
    '/usr/local/bin/pdfinfo',
    '/opt/homebrew/bin/pdfinfo',
  ],
  pdftoppm: [
    ...(process.env.PDFTOPPM_PATH ? [process.env.PDFTOPPM_PATH] : []),
    '/usr/bin/pdftoppm',
    '/usr/local/bin/pdftoppm',
    '/opt/homebrew/bin/pdftoppm',
  ],
  pdftocairo: [
    ...(process.env.PDFTOCAIRO_PATH ? [process.env.PDFTOCAIRO_PATH] : []),
    '/usr/bin/pdftocairo',
    '/usr/local/bin/pdftocairo',
    '/opt/homebrew/bin/pdftocairo',
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
  if (envOverride !== undefined && envOverride !== '' && envOverride !== 'undefined') {
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
    } catch (poolErr) {
      if (options.signal?.aborted || poolErr instanceof SandboxedMemoryLimitError) {
        throw poolErr;
      }
      if (options.throwOnUnavailable && !(poolErr instanceof LibreOfficePoolTimeoutError)) {
        throw poolErr;
      }
      // Fall through cleanly to standalone sandbox execution if pool acquire timed out
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

      const durationSeconds = probeMediaDuration(inputPath, options);
      const timeout = computeMediaTimeoutMs(durationSeconds, options.timeoutMs || 180000);
      const maxBuffer = Math.min(options.maxBufferBytes || 200 * 1024 * 1024, 500 * 1024 * 1024);
      if (options.thumbnail?.at && options.thumbnail.at.length > 1) {
        const parts: { filename: string; buffer: Buffer }[] = [];
        for (let i = 0; i < options.thumbnail.at.length; i++) {
          const ts = options.thumbnail.at[i];
          const partOut = path.join(tempDir, `output_${i}.${tgt}`);
          const partArgs = buildFfmpegArguments(inputPath, partOut, src, tgt, options, ffmpegBin, ts);
          await executeSandboxedBinary(ffmpegBin, partArgs, {
            cwd: tempDir,
            timeoutMs: timeout,
            maxBuffer,
            networkIsolated: true,
            signal: options.signal,
          });
          if (fs.existsSync(partOut)) {
            parts.push({
              filename: `${baseName}_thumb_${i + 1}.${tgt}`,
              buffer: fs.readFileSync(partOut),
            });
          }
        }
        if (parts.length > 0) {
          const vfsPayload = Buffer.isBuffer(input) ? undefined : input;
          const firstPersisted = preserveOutput(path.join(tempDir, `output_0.${tgt}`), tgt, options, vfsPayload);
          const res = createConversionResult(
            firstPersisted,
            tgt,
            baseName,
            'native-ffmpeg',
            Date.now() - startTime
          );
          res.parts = parts;
          return res;
        }
      }

      const isPackaging = Boolean(options.packaging) || tgt === 'hls' || tgt === 'dash';
      if (isPackaging) {
        const packaging: MediaPackagingOptions = options.packaging || {
          format: (tgt === 'dash' ? 'dash' : 'hls'),
        };
        const outputDir = path.join(tempDir, 'packaged');
        fs.mkdirSync(outputDir, { recursive: true });

        const args = buildHlsDashArguments(inputPath, outputDir, packaging, ffmpegBin);
        await executeSandboxedBinary(ffmpegBin, args, {
          cwd: outputDir,
          timeoutMs: timeout,
          maxBuffer,
          networkIsolated: true,
          signal: options.signal,
        });

        const outputFiles = fs.readdirSync(outputDir);
        if (outputFiles.length === 0) {
          throw new Error(`FFmpeg packaging failed: no files produced in ${outputDir}`);
        }

        const zip = new JSZip();
        const parts: { filename: string; buffer: Buffer }[] = [];
        for (const f of outputFiles) {
          const p = path.join(outputDir, f);
          if (fs.statSync(p).isFile()) {
            const buf = fs.readFileSync(p);
            zip.file(f, buf);
            parts.push({ filename: f, buffer: buf });
          }
        }

        const zipBuffer = await zip.generateAsync({
          type: 'nodebuffer',
          compression: 'DEFLATE',
          compressionOptions: { level: 6 },
        });

        const tempZipPath = path.join(tempDir, `${baseName}-${packaging.format}.zip`);
        fs.writeFileSync(tempZipPath, zipBuffer);

        const vfsPayload = Buffer.isBuffer(input) ? undefined : input;
        const persistedPath = preserveOutput(tempZipPath, 'zip', options, vfsPayload);

        const res = createConversionResult(
          persistedPath,
          'zip',
          `${baseName}-${packaging.format}`,
          'native-ffmpeg',
          Date.now() - startTime
        );
        res.parts = parts;
        return res;
      }

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
  if (options?.password && tgt !== 'zip' && tgt !== '7z') {
    throw new UnsupportedOptionError(`Target archive format '${tgt}' does not support password encryption.`);
  }

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

  const pwArgs: string[] = [];
  if (options?.password) {
    if (tgt === '7z') {
      pwArgs.push('-mhe=on', '-p');
    } else if (tgt === 'zip') {
      pwArgs.push('-mem=AES256', '-p');
    }
  }
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
    const includeArgs = (options?.entries && options.entries.length > 0)
      ? options.entries.map((p) => `-i!${p}`)
      : [];
    await executeSandboxedBinary(
      p7zBin,
      ['x', '-y', ...pwArgs, `-o${extractDir}`, inputPath, ...includeArgs],
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

  const isTarGz = tgt === 'tar.gz' || tgt === 'tgz';
  const isTarBz2 = tgt === 'tar.bz2' || tgt === 'tbz2' || tgt === 'tbz';
  const isTarXz = tgt === 'tar.xz' || tgt === 'txz';
  if (options.password && tgt !== 'zip' && tgt !== '7z') {
    throw new UnsupportedOptionError(`Target archive format '${tgt}' does not support password encryption.`);
  }

  const p7zBin = resolveBinary(BINARY_PATHS.p7zip, process.env.P7ZIP_PATH);
  if (!p7zBin) {
    if (options.password) {
      throw new ArchiveEncryptionUnavailableError(
        'Archive encryption is unavailable: native 7z binary is required for encrypted archives.'
      );
    }
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

export async function getPdfPageCount(
  inputPath: string,
  tempDir: string,
  timeoutMs: number,
  signal?: AbortSignal,
  inputBuffer?: Buffer,
  password?: string
): Promise<number> {
  const pdfinfoBin = resolveBinary(BINARY_PATHS.pdfinfo, process.env.PDFINFO_PATH);
  if (pdfinfoBin) {
    try {
      const pwArgs = password ? ['-upw', password] : [];
      const res = await executeSandboxedBinary(pdfinfoBin, [...pwArgs, inputPath], {
        cwd: tempDir,
        timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        networkIsolated: true,
        signal,
      });
      const match = res.stdout.toString('utf-8').match(/Pages:\s+(\d+)/i);
      if (match) {
        const pages = Number.parseInt(match[1], 10);
        if (pages > 0) return pages;
      }
    } catch {
      // Fall back to pdf-lib parsing if pdfinfo fails
    }
  }

  // Fallback via pdf-lib
  const buf = inputBuffer ?? fs.readFileSync(inputPath);
  try {
    const pdfDoc = await PDFDocument.load(buf, { ignoreEncryption: true });
    const count = pdfDoc.getPageCount();
    if (count > 0) return count;
  } catch {
    // Fall-through to error
  }
  throw new Error('Unable to determine PDF page count: invalid or corrupted PDF structure.');
}

function buildPdftoppmArgs(
  tgt: string,
  options: WorkerEngineOptions,
  startPage: number,
  endPage: number,
  inputPath: string,
  prefix: string
): string[] {
  const dpi = options.dpi && options.dpi >= 72 && options.dpi <= 600 ? options.dpi : 150;
  const args: string[] = ['-r', String(dpi)];

  if (tgt === 'png') {
    args.push('-png');
  } else if (tgt === 'jpg' || tgt === 'jpeg') {
    args.push('-jpeg');
  } else if (tgt === 'tiff' || tgt === 'tif') {
    args.push('-tiff');
  }

  if (options.password) {
    args.push('-upw', options.password);
  }

  args.push('-f', String(startPage), '-l', String(endPage), inputPath, prefix);
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

function resolveRequestedPages(options: WorkerEngineOptions, pageCount: number): number[] {
  let requestedPages: number[];
  if (options.pages) {
    requestedPages = parsePageRanges(options.pages, pageCount);
  } else if (typeof options.page === 'number') {
    if (!Number.isInteger(options.page) || options.page < 1 || options.page > pageCount) {
      throw new InvalidPageRangeError(
        `Page number ${options.page} is out of bounds (1-${pageCount})`
      );
    }
    requestedPages = [options.page];
  } else {
    requestedPages = Array.from({ length: pageCount }, (_, i) => i + 1);
  }

  if (requestedPages.length === 0) {
    throw new InvalidPageRangeError('No pages selected for rendering');
  }

  return requestedPages;
}

function matchOutputPageFiles(
  files: string[],
  requestedPages: number[]
): Array<{ file: string; pageNum: number }> {
  const pageRegex = /-(\d+)\.[^.]+$/;
  const parsedFiles = files
    .map((f) => {
      const m = pageRegex.exec(f);
      let pageNum = 0;
      if (m) {
        pageNum = Number.parseInt(m[1], 10);
      } else if (files.length === 1 && requestedPages.length === 1) {
        pageNum = requestedPages[0];
      }
      return { file: f, pageNum };
    })
    .filter((item) => requestedPages.includes(item.pageNum))
    .sort((a, b) => a.pageNum - b.pageNum);

  return parsedFiles.length > 0
    ? parsedFiles
    : [...files]
        .sort((a, b) => a.localeCompare(b))
        .map((f, i) => ({ file: f, pageNum: requestedPages[i] ?? i + 1 }));
}

interface FinalizeMultiPageParams {
  tempDir: string;
  resolvedFiles: Array<{ file: string; pageNum: number }>;
  requestedPages: number[];
  tgt: string;
  baseName: string;
  options: WorkerEngineOptions;
  input: Buffer | WorkerVfsPayload;
  startTime: number;
}

async function finalizeMultiPageOutput(params: FinalizeMultiPageParams): Promise<WorkerConversionResult> {
  const {
    tempDir,
    resolvedFiles,
    requestedPages,
    tgt,
    baseName,
    options,
    input,
    startTime,
  } = params;

  const isSingleOutput = requestedPages.length === 1 || options.multiPageOutput === 'first';
  const vfsPayload = Buffer.isBuffer(input) ? undefined : input;

  if (isSingleOutput) {
    const selected = resolvedFiles[0];
    const tempOutputPath = path.join(tempDir, selected.file);
    const persistedPath = preserveOutput(tempOutputPath, tgt, options, vfsPayload);

    return createConversionResult(
      persistedPath,
      tgt,
      baseName,
      'native-poppler',
      Date.now() - startTime
    );
  }

  // Multi-page bundle: package into ZIP with standard formatted names: <baseName>-p001.<tgt>
  const zip = new JSZip();
  const maxPage = requestedPages.at(-1) ?? 1;
  const padLen = Math.max(3, String(maxPage).length);

  for (const item of resolvedFiles) {
    const entryName = `${baseName}-p${String(item.pageNum).padStart(padLen, '0')}.${tgt}`;
    const fileBytes = fs.readFileSync(path.join(tempDir, item.file));
    zip.file(entryName, fileBytes);
  }

  const zipBuffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  const zipOutputPath = path.join(tempDir, `${baseName}.zip`);
  fs.writeFileSync(zipOutputPath, zipBuffer);

  const persistedPath = preserveOutput(zipOutputPath, 'zip', options, vfsPayload);

  return createConversionResult(
    persistedPath,
    'zip',
    baseName,
    'native-poppler',
    Date.now() - startTime
  );
}

interface PopplerRenderParams {
  sandboxPrefix: string;
  tgt: string;
  input: Buffer | WorkerVfsPayload;
  options: WorkerEngineOptions;
  originalFilename: string;
  startTime: number;
  timeout: number;
  filterOutputFile: (fileName: string) => boolean;
  missingOutputError: string;
  renderPages: (tempDir: string, inputPath: string, requestedPages: number[]) => Promise<void>;
}

async function executePopplerRender(params: PopplerRenderParams): Promise<WorkerConversionResult | null> {
  const {
    sandboxPrefix,
    tgt,
    input,
    options,
    originalFilename,
    startTime,
    timeout,
    filterOutputFile,
    missingOutputError,
    renderPages,
  } = params;

  const baseName = originalFilename ? originalFilename.replace(/\.[^/.]+$/, '') : 'converted';
  try {
    return await withSandboxDir(sandboxPrefix, async (tempDir) => {
      const { inputPath } = resolveInputContext(input, 'pdf', tempDir);
      const inputBuffer = Buffer.isBuffer(input)
        ? input
        : (input.inputBuffer ?? (input.inputPath ? fs.readFileSync(input.inputPath) : undefined));
      const pageCount = await getPdfPageCount(
        inputPath,
        tempDir,
        timeout,
        options.signal,
        inputBuffer,
        options.password
      );

      const requestedPages = resolveRequestedPages(options, pageCount);
      await renderPages(tempDir, inputPath, requestedPages);

      const files = fs.readdirSync(tempDir).filter(filterOutputFile);
      if (files.length === 0) {
        throw new Error(missingOutputError);
      }

      const resolvedFiles = matchOutputPageFiles(files, requestedPages);
      return finalizeMultiPageOutput({
        tempDir,
        resolvedFiles,
        requestedPages,
        tgt,
        baseName,
        options,
        input,
        startTime,
      });
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

  return executePopplerRender({
    sandboxPrefix: 'easyconvert-poppler-img-',
    tgt,
    input,
    options,
    originalFilename,
    startTime,
    timeout,
    filterOutputFile: (f) => f.startsWith('page') && !f.endsWith('.pdf'),
    missingOutputError: 'pdftoppm execution completed without producing any output images',
    renderPages: async (tempDir, inputPath, requestedPages) => {
      const intervals = groupConsecutiveRanges(requestedPages);
      const prefix = path.join(tempDir, 'page');
      let step: Promise<any> = Promise.resolve();
      for (const interval of intervals) {
        step = step.then(() => {
          const args = buildPdftoppmArgs(tgt, options, interval.start, interval.end, inputPath, prefix);
          return executeSandboxedBinary(pdftoppmBin, args, {
            cwd: tempDir,
            timeoutMs: timeout,
            maxBuffer,
            networkIsolated: true,
            signal: options.signal,
          });
        });
      }
      await step;
    },
  });
}

async function renderPdfToSvgWithPoppler(
  input: Buffer | WorkerVfsPayload,
  options: WorkerEngineOptions,
  originalFilename: string,
  startTime: number,
  timeout: number,
  maxBuffer: number
): Promise<WorkerConversionResult | null> {
  const pdftocairoBin = resolveBinary(BINARY_PATHS.pdftocairo, process.env.PDFTOCAIRO_PATH);
  if (!pdftocairoBin) {
    if (options.throwOnUnavailable) {
      throw new EngineUnavailableError('pdftocairo', 'pdftocairo binary is not installed or not in PATH');
    }
    return null;
  }

  return executePopplerRender({
    sandboxPrefix: 'easyconvert-poppler-svg-',
    tgt: 'svg',
    input,
    options,
    originalFilename,
    startTime,
    timeout,
    filterOutputFile: (f) => f.endsWith('.svg'),
    missingOutputError: 'pdftocairo execution completed without producing any output SVG files',
    renderPages: async (tempDir, inputPath, requestedPages) => {
      let step: Promise<any> = Promise.resolve();
      for (const p of requestedPages) {
        step = step.then(() => {
          const pageSvgPath = path.join(tempDir, `page-${p}.svg`);
          const args = ['-svg', '-f', String(p), '-l', String(p)];
          if (options.password) {
            args.push('-upw', options.password);
          }
          args.push(inputPath, pageSvgPath);
          return executeSandboxedBinary(pdftocairoBin, args, {
            cwd: tempDir,
            timeoutMs: timeout,
            maxBuffer,
            networkIsolated: true,
            signal: options.signal,
          });
        });
      }
      await step;
    },
  });
}

/**
 * Converts PDF documents using native Poppler utilities (pdftoppm, pdftocairo, and pdftotext).
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

  // 3. Vector SVG rendering via pdftocairo
  if (tgt === 'svg') {
    return renderPdfToSvgWithPoppler(input, options, originalFilename, startTime, timeout, maxBuffer);
  }

  return null;
}

/**
 * Universal Worker Conversion Orchestrator.
 * Dispatches to native container engines first, with fail-closed security and pure TS fallback.
 */
const OFFICE_FORMATS = new Set(['docx', 'doc', 'pptx', 'ppt', 'xlsx', 'xls', 'odt', 'ods', 'odp', 'rtf']);
const MEDIA_FORMATS = new Set(['mp4', 'mkv', 'avi', 'mov', 'webm', 'mp3', 'wav', 'aac', 'ogg', 'opus', 'flac', 'm4a', 'wma']);
const COMPLEX_TEXT_FORMATS = new Set(['txt', 'html', 'htm', 'md']);

function checkInputContainsComplexScript(input: Buffer | WorkerVfsPayload, src: string): boolean {
  if (!COMPLEX_TEXT_FORMATS.has(src)) return false;
  try {
    let buf: Buffer | undefined;
    if (Buffer.isBuffer(input)) {
      buf = input;
    } else if (input.inputBuffer) {
      buf = input.inputBuffer;
    } else if (input.inputPath && fs.existsSync(input.inputPath)) {
      const fd = fs.openSync(input.inputPath, 'r');
      const stat = fs.fstatSync(fd);
      const readLen = Math.min(512 * 1024, stat.size);
      const readBuf = Buffer.alloc(readLen);
      fs.readSync(fd, readBuf, 0, readLen, 0);
      fs.closeSync(fd);
      buf = readBuf;
    }
    if (buf) {
      return hasComplexTextScript(buf.toString('utf-8'));
    }
  } catch {
    // Ignore read errors
  }
  return false;
}

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
  let lastUnavailable: EngineUnavailableError | undefined;
  const fallbackChain: string[] = [];
  const nativeOptions: WorkerEngineOptions = { ...options, throwOnUnavailable: true };
  const isComplexText = tgt === 'pdf' && checkInputContainsComplexScript(input, src);
  const isRecalculate = Boolean(options.recalculate) && (src === 'xlsx' || src === 'xls' || src === 'ods');

  // 1. Native Headless Office
  if (isComplexText || isRecalculate || (OFFICE_FORMATS.has(src) && (tgt === 'pdf' || OFFICE_FORMATS.has(tgt)))) {
    try {
      const officeRes = await convertWithHeadlessOffice(input, src, tgt, nativeOptions, originalFilename);
      if (officeRes) {
        return {
          ...officeRes,
          fallbackChain: fallbackChain.length > 0 ? fallbackChain : undefined,
        };
      }
    } catch (err) {
      if (err instanceof EngineUnavailableError) {
        if (isComplexText) {
          throw new ComplexScriptRequiresNativeEngineError(
            `Rendering complex text script (${src} to pdf) requires the native LibreOffice engine: ${err.message}`
          );
        }
        if (isRecalculate) {
          throw new EngineUnavailableError(
            'soffice',
            `Spreadsheet formula recalculation requires native LibreOffice engine: ${err.message}`
          );
        }
        if (options.pdfStandard) {
          throw new Error(
            `Native LibreOffice engine is required for pdfStandard '${options.pdfStandard}', but engine is unavailable: ${err.reason}`
          );
        }
        fallbackChain.push(`native-soffice: ${err.message}`);
        fallbackReason = err.message;
        lastUnavailable = err;
      } else {
        throw err;
      }
    }
  }

  // 1b. Office Documents -> Raster / Vector Image Chaining via LibreOffice + Poppler
  if (OFFICE_FORMATS.has(src) && (POPPLER_IMAGE_FORMATS.has(tgt) || tgt === 'svg')) {
    try {
      const intermediatePdf = await convertWithHeadlessOffice(input, src, 'pdf', nativeOptions, originalFilename);
      if (intermediatePdf) {
        const popplerInput = intermediatePdf.filePath
          ? { inputPath: intermediatePdf.filePath }
          : intermediatePdf.buffer;
        const popplerRes = await convertWithNativePoppler(
          popplerInput,
          'pdf',
          tgt,
          nativeOptions,
          originalFilename
        );
        if (popplerRes) {
          return {
            ...popplerRes,
            fallbackChain: fallbackChain.length > 0 ? fallbackChain : undefined,
          };
        }
      }
    } catch (err) {
      if (err instanceof EngineUnavailableError) {
        fallbackChain.push(`office-poppler-chain: ${err.message}`);
        fallbackReason = err.message;
        lastUnavailable = err;
      } else {
        throw err;
      }
    }
  }

  // 2. Native FFmpeg
  const isThumbnailTarget = (tgt === 'jpg' || tgt === 'jpeg' || tgt === 'png') && Boolean(nativeOptions.thumbnail);
  const isSubtitleExtractTarget = (tgt === 'srt' || tgt === 'vtt' || tgt === 'ass') && nativeOptions.subtitles?.mode === 'extract';
  const isPackagingTarget = Boolean(nativeOptions.packaging) || tgt === 'hls' || tgt === 'dash';
  if (
    (MEDIA_FORMATS.has(src) && MEDIA_FORMATS.has(tgt)) ||
    (MEDIA_FORMATS.has(src) && (isThumbnailTarget || isSubtitleExtractTarget || isPackagingTarget))
  ) {
    try {
      const ffmpegRes = await convertWithNativeFfmpeg(input, src, tgt, nativeOptions, originalFilename);
      if (ffmpegRes) {
        return {
          ...ffmpegRes,
          fallbackChain: fallbackChain.length > 0 ? fallbackChain : undefined,
        };
      }
    } catch (err) {
      if (err instanceof EngineUnavailableError) {
        fallbackChain.push(`native-ffmpeg: ${err.message}`);
        fallbackReason = err.message;
        lastUnavailable = err;
      } else {
        throw err;
      }
    }
  }

  // 3. Native Poppler (PDF -> Image, SVG, or Text)
  if (src === 'pdf' && (POPPLER_IMAGE_FORMATS.has(tgt) || tgt === 'svg' || tgt === 'txt' || tgt === 'text')) {
    try {
      const popplerRes = await convertWithNativePoppler(input, src, tgt, nativeOptions, originalFilename);
      if (popplerRes) {
        return {
          ...popplerRes,
          fallbackChain: fallbackChain.length > 0 ? fallbackChain : undefined,
        };
      }
    } catch (err) {
      if (err instanceof EngineUnavailableError) {
        fallbackChain.push(`native-poppler: ${err.message}`);
        fallbackReason = err.message;
        lastUnavailable = err;
      } else {
        throw err;
      }
    }
  }

  // 4. Native 7-Zip (Archive handling)
  if (ARCHIVE_EXTRACT_FORMATS.has(src) && ARCHIVE_TARGET_FORMATS.has(tgt)) {
    try {
      const p7zRes = await convertWithNative7z(input, src, tgt, nativeOptions, originalFilename);
      if (p7zRes) {
        return {
          ...p7zRes,
          fallbackChain: fallbackChain.length > 0 ? fallbackChain : undefined,
        };
      }
    } catch (err) {
      if (err instanceof EngineUnavailableError) {
        fallbackChain.push(`native-7z: ${err.message}`);
        fallbackReason = err.message;
        lastUnavailable = err;
      } else {
        throw err;
      }
    }
  }

  // 5. In-Repo Pure TS Fallback
  if (options.inProcessFallback === false) {
    if (lastUnavailable) {
      throw lastUnavailable;
    }
    throw new UnsupportedTargetError(`No native engine route converts ${src} to ${tgt}`);
  }
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
    const stat = fs.statSync(input.inputPath);
    if (stat.size > getMaxInMemoryBytes()) {
      throw new PayloadTooLargeForMemoryError(
        `Payload size (${stat.size} bytes) exceeds in-memory buffer limit of ${getMaxInMemoryBytes()} bytes. Native worker required.`,
        { size: stat.size, limit: getMaxInMemoryBytes() }
      );
    }
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
      fallbackChain: fallbackChain.length > 0 ? fallbackChain : undefined,
    };
  }
  return {
    ...internalRes,
    engineUsed: 'internal-fallback',
    executionTimeMs: Date.now() - startTime,
    metadata: fallbackMetadata,
    fallbackReason,
    fallbackChain: fallbackChain.length > 0 ? fallbackChain : undefined,
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
    svg: 'image/svg+xml',
    txt: 'text/plain',
  };
  return map[cleanFormat] || 'application/octet-stream';
}
