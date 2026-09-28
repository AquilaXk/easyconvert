import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ConversionOptions, ConversionResult } from '../lib/types';
import { convertFile } from '../lib/conversions';
import { getFormatByExtension } from '../lib/registry';
import {
  buildFfmpegArguments,
  probeHardwareAcceleration,
  HardwareAccelerationCapabilities,
} from '../lib/conversions/media-ffmpeg-args';
import { executeSandboxedBinary } from './sandbox';
import { extractWithSpannedStream7z } from '../lib/conversions/archive';
import { LibreOfficePoolManager } from './libreoffice-pool';

export interface WorkerEngineOptions extends ConversionOptions {
  timeoutMs?: number;
  maxBufferBytes?: number;
  page?: number;
  dpi?: number;
}

export interface WorkerConversionResult extends ConversionResult {
  engineUsed: 'native-soffice' | 'native-soffice-pool' | 'native-ffmpeg' | 'native-7z' | 'native-poppler' | 'internal-fallback';
  executionTimeMs: number;
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

function resolveBinary(candidates: string[]): string | null {
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
  const ffmpegPath = resolveBinary(BINARY_PATHS.ffmpeg);
  return {
    soffice: resolveBinary(BINARY_PATHS.soffice) !== null,
    ffmpeg: ffmpegPath !== null,
    p7zip: resolveBinary(BINARY_PATHS.p7zip) !== null,
    pdftoppm: resolveBinary(BINARY_PATHS.pdftoppm) !== null,
    pdftotext: resolveBinary(BINARY_PATHS.pdftotext) !== null,
    tesseract: resolveBinary(BINARY_PATHS.tesseract) !== null,
    hardwareAcceleration: probeHardwareAcceleration(ffmpegPath),
  };
}

/**
 * Pre-warmed LibreOffice Daemon Worker Pool Instance.
 */
const sofficeResolvedPath = resolveBinary(BINARY_PATHS.soffice);
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
  operation: (tempDir: string) => Promise<T | null>
): Promise<T | null> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return await operation(tempDir);
  } catch {
    return null;
  } finally {
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {}
  }
}

/**
 * Converts an Office document using headless LibreOffice in an isolated sandbox.
 * Leverages the pre-warmed daemon pool with sub-200ms dispatch, auto-recycling,
 * and seamless fail-closed fallback to standalone sandbox execution.
 */
export async function convertWithHeadlessOffice(
  inputBuffer: Buffer,
  sourceFormat: string,
  targetFormat: string,
  options: WorkerEngineOptions = {},
  originalFilename = 'file'
): Promise<WorkerConversionResult | null> {
  const src = validateFormat(sourceFormat);
  const tgt = validateFormat(targetFormat);
  const sofficeBin = resolveBinary(BINARY_PATHS.soffice);
  if (!sofficeBin) return null;

  libreOfficePool.setSofficePath(sofficeBin);

  if (libreOfficePool.isEnabled()) {
    try {
      const poolResult = await libreOfficePool.convert(
        inputBuffer,
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

  return withSandboxDir('easyconvert-office-', async (tempDir) => {
    const inputPath = path.join(tempDir, `input.${src}`);
    fs.writeFileSync(inputPath, inputBuffer);

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
        tgt,
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
      }
    );

    const matches = fs.readdirSync(tempDir).filter((f) => f.startsWith('input.') && !f.endsWith(`.${src}`));
    if (matches.length === 0) return null;

    const outputPath = path.join(tempDir, matches[0]);
    const outputBuffer = fs.readFileSync(outputPath);

    return {
      buffer: outputBuffer,
      mimeType: getMimeType(tgt),
      filename: `${baseName}.${tgt}`,
      size: outputBuffer.length,
      engineUsed: 'native-soffice',
      executionTimeMs: Date.now() - startTime,
    };
  });
}

/**
 * Transcodes media using native FFmpeg with strict argument boundaries.
 */
export async function convertWithNativeFfmpeg(
  inputBuffer: Buffer,
  sourceFormat: string,
  targetFormat: string,
  options: WorkerEngineOptions = {},
  originalFilename = 'file'
): Promise<WorkerConversionResult | null> {
  const src = validateFormat(sourceFormat);
  const tgt = validateFormat(targetFormat);
  const ffmpegBin = resolveBinary(BINARY_PATHS.ffmpeg);
  if (!ffmpegBin) return null;

  const baseName = originalFilename ? originalFilename.replace(/\.[^/.]+$/, '') : 'converted';
  const startTime = Date.now();

  return withSandboxDir('easyconvert-ffmpeg-', async (tempDir) => {
    const inputPath = path.join(tempDir, `input.${src}`);
    const outputPath = path.join(tempDir, `output.${tgt}`);
    fs.writeFileSync(inputPath, inputBuffer);

    const timeout = Math.min(options.timeoutMs || 60000, 180000);
    const maxBuffer = Math.min(options.maxBufferBytes || 200 * 1024 * 1024, 500 * 1024 * 1024);
    const args = buildFfmpegArguments(inputPath, outputPath, src, tgt, options, ffmpegBin);

    await executeSandboxedBinary(ffmpegBin, args, {
      cwd: tempDir,
      timeoutMs: timeout,
      maxBuffer,
      networkIsolated: true,
    });

    if (!fs.existsSync(outputPath)) return null;

    const outputBuffer = fs.readFileSync(outputPath);
    return {
      buffer: outputBuffer,
      mimeType: getMimeType(tgt),
      filename: `${baseName}.${tgt}`,
      size: outputBuffer.length,
      engineUsed: 'native-ffmpeg',
      executionTimeMs: Date.now() - startTime,
    };
  });
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

/**
 * Converts or extracts archives using the native 7-Zip CLI engine.
 */
export async function convertWithNative7z(
  inputBuffer: Buffer,
  sourceFormat: string,
  targetFormat: string,
  options: WorkerEngineOptions = {},
  originalFilename = 'file'
): Promise<WorkerConversionResult | null> {
  const src = validateFormat(sourceFormat);
  const tgt = validateFormat(targetFormat);
  const p7zBin = resolveBinary(BINARY_PATHS.p7zip);
  if (!p7zBin) return null;

  const baseName = originalFilename ? originalFilename.replace(/\.[^/.]+$/, '') : 'converted';
  const startTime = Date.now();

  return withSandboxDir('easyconvert-7z-', async (tempDir) => {
    const inputExt = src.includes('.') ? src.split('.').pop()! : src;
    const inputPath = path.join(tempDir, `input.${inputExt}`);
    fs.writeFileSync(inputPath, inputBuffer);

    const timeout = Math.min(options.timeoutMs || 60000, 180000);
    const maxBuffer = Math.min(options.maxBufferBytes || 200 * 1024 * 1024, 500 * 1024 * 1024);
    const extractDir = path.join(tempDir, 'extracted');
    fs.mkdirSync(extractDir, { recursive: true });

    // Step 1: Extract if source is an archive container, otherwise place single file into extract directory
    if (ARCHIVE_EXTRACT_FORMATS.has(src)) {
      if (options.archiveParts && options.archiveParts.length > 0) {
        // Multi-volume split archive extraction via Virtual Spanned Stream pipeline
        await extractWithSpannedStream7z(options.archiveParts as any, extractDir, {
          timeoutMs: timeout,
          maxBuffer,
          password: options.password,
        });
      } else {
        await executeSandboxedBinary(
          p7zBin,
          ['x', '-y', `-o${extractDir}`, inputPath],
          {
            cwd: tempDir,
            timeoutMs: timeout,
            maxBuffer,
            networkIsolated: true,
          }
        );
      }
    } else {
      const destPath = path.join(extractDir, originalFilename || `file.${src}`);
      fs.writeFileSync(destPath, inputBuffer);
    }

    const extractedFiles = fs.readdirSync(extractDir);
    if (extractedFiles.length === 0) {
      return null;
    }

    const outputPath = path.join(tempDir, `output.${tgt}`);

    // Step 2: Re-archive contents into requested target format
    if (tgt === 'tar.gz' || tgt === 'tgz') {
      const tarPath = path.join(tempDir, 'archive.tar');
      await executeSandboxedBinary(
        p7zBin,
        ['a', '-y', '-ttar', tarPath, '.'],
        {
          cwd: extractDir,
          timeoutMs: timeout,
          maxBuffer,
          networkIsolated: true,
        }
      );
      await executeSandboxedBinary(
        p7zBin,
        ['a', '-y', '-tgzip', outputPath, tarPath],
        {
          cwd: tempDir,
          timeoutMs: timeout,
          maxBuffer,
          networkIsolated: true,
        }
      );
    } else if (tgt === 'tar.bz2' || tgt === 'tbz2' || tgt === 'tbz') {
      const tarPath = path.join(tempDir, 'archive.tar');
      await executeSandboxedBinary(
        p7zBin,
        ['a', '-y', '-ttar', tarPath, '.'],
        {
          cwd: extractDir,
          timeoutMs: timeout,
          maxBuffer,
          networkIsolated: true,
        }
      );
      await executeSandboxedBinary(
        p7zBin,
        ['a', '-y', '-tbzip2', outputPath, tarPath],
        {
          cwd: tempDir,
          timeoutMs: timeout,
          maxBuffer,
          networkIsolated: true,
        }
      );
    } else if (tgt === 'tar.xz' || tgt === 'txz') {
      const tarPath = path.join(tempDir, 'archive.tar');
      await executeSandboxedBinary(
        p7zBin,
        ['a', '-y', '-ttar', tarPath, '.'],
        {
          cwd: extractDir,
          timeoutMs: timeout,
          maxBuffer,
          networkIsolated: true,
        }
      );
      await executeSandboxedBinary(
        p7zBin,
        ['a', '-y', '-txz', outputPath, tarPath],
        {
          cwd: tempDir,
          timeoutMs: timeout,
          maxBuffer,
          networkIsolated: true,
        }
      );
    } else {
      const archiveType = get7zArchiveType(tgt);
      if (!archiveType) return null;

      await executeSandboxedBinary(
        p7zBin,
        ['a', '-y', `-t${archiveType}`, outputPath, '.'],
        {
          cwd: extractDir,
          timeoutMs: timeout,
          maxBuffer,
          networkIsolated: true,
        }
      );
    }

    if (!fs.existsSync(outputPath)) return null;

    const outputBuffer = fs.readFileSync(outputPath);
    return {
      buffer: outputBuffer,
      mimeType: getMimeType(tgt),
      filename: `${baseName}.${tgt}`,
      size: outputBuffer.length,
      engineUsed: 'native-7z',
      executionTimeMs: Date.now() - startTime,
    };
  });
}

/**
 * Image formats supported by Poppler pdftoppm.
 */
const POPPLER_IMAGE_FORMATS = new Set(['png', 'jpg', 'jpeg', 'tiff', 'tif', 'ppm']);

/**
 * Converts PDF documents using native Poppler utilities (pdftoppm and pdftotext).
 */
export async function convertWithNativePoppler(
  inputBuffer: Buffer,
  sourceFormat: string,
  targetFormat: string,
  options: WorkerEngineOptions = {},
  originalFilename = 'file'
): Promise<WorkerConversionResult | null> {
  const src = validateFormat(sourceFormat);
  const tgt = validateFormat(targetFormat);
  if (src !== 'pdf') return null;

  const baseName = originalFilename ? originalFilename.replace(/\.[^/.]+$/, '') : 'converted';
  const startTime = Date.now();
  const timeout = Math.min(options.timeoutMs || 45000, 120000);
  const maxBuffer = Math.min(options.maxBufferBytes || 100 * 1024 * 1024, 500 * 1024 * 1024);

  // 1. Text extraction via pdftotext
  if (tgt === 'txt' || tgt === 'text') {
    const pdftotextBin = resolveBinary(BINARY_PATHS.pdftotext);
    if (!pdftotextBin) return null;

    return withSandboxDir('easyconvert-poppler-txt-', async (tempDir) => {
      const inputPath = path.join(tempDir, 'input.pdf');
      const outputPath = path.join(tempDir, 'output.txt');
      fs.writeFileSync(inputPath, inputBuffer);

      await executeSandboxedBinary(
        pdftotextBin,
        ['-layout', inputPath, outputPath],
        {
          cwd: tempDir,
          timeoutMs: timeout,
          maxBuffer,
          networkIsolated: true,
        }
      );

      if (!fs.existsSync(outputPath)) return null;

      const outputBuffer = fs.readFileSync(outputPath);
      return {
        buffer: outputBuffer,
        mimeType: 'text/plain; charset=utf-8',
        filename: `${baseName}.txt`,
        size: outputBuffer.length,
        engineUsed: 'native-poppler',
        executionTimeMs: Date.now() - startTime,
      };
    });
  }

  // 2. High-fidelity raster rendering via pdftoppm
  if (POPPLER_IMAGE_FORMATS.has(tgt)) {
    const pdftoppmBin = resolveBinary(BINARY_PATHS.pdftoppm);
    if (!pdftoppmBin) return null;

    return withSandboxDir('easyconvert-poppler-img-', async (tempDir) => {
      const inputPath = path.join(tempDir, 'input.pdf');
      fs.writeFileSync(inputPath, inputBuffer);

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

      const prefix = path.join(tempDir, 'page');
      args.push(inputPath, prefix);

      await executeSandboxedBinary(pdftoppmBin, args, {
        cwd: tempDir,
        timeoutMs: timeout,
        maxBuffer,
        networkIsolated: true,
      });

      const files = fs.readdirSync(tempDir).filter((f) => f.startsWith('page') && f !== 'input.pdf');
      if (files.length === 0) return null;

      const selectedFile = files.sort()[0];
      const outputPath = path.join(tempDir, selectedFile);
      const outputBuffer = fs.readFileSync(outputPath);

      return {
        buffer: outputBuffer,
        mimeType: getMimeType(tgt),
        filename: `${baseName}.${tgt}`,
        size: outputBuffer.length,
        engineUsed: 'native-poppler',
        executionTimeMs: Date.now() - startTime,
      };
    });
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
  inputBuffer: Buffer,
  sourceFormat: string,
  targetFormat: string,
  options: WorkerEngineOptions = {},
  originalFilename = 'file'
): Promise<WorkerConversionResult> {
  const src = validateFormat(sourceFormat);
  const tgt = validateFormat(targetFormat);
  const startTime = Date.now();

  // 1. Native Headless Office
  if (OFFICE_FORMATS.has(src) && (tgt === 'pdf' || OFFICE_FORMATS.has(tgt))) {
    const officeRes = await convertWithHeadlessOffice(inputBuffer, src, tgt, options, originalFilename);
    if (officeRes) return officeRes;
  }

  // 2. Native FFmpeg
  if (MEDIA_FORMATS.has(src) && MEDIA_FORMATS.has(tgt)) {
    const ffmpegRes = await convertWithNativeFfmpeg(inputBuffer, src, tgt, options, originalFilename);
    if (ffmpegRes) return ffmpegRes;
  }

  // 3. Native Poppler (PDF -> Image or Text)
  if (src === 'pdf' && (POPPLER_IMAGE_FORMATS.has(tgt) || tgt === 'txt' || tgt === 'text')) {
    const popplerRes = await convertWithNativePoppler(inputBuffer, src, tgt, options, originalFilename);
    if (popplerRes) return popplerRes;
  }

  // 4. Native 7-Zip (Archive handling)
  if (ARCHIVE_EXTRACT_FORMATS.has(src) && ARCHIVE_TARGET_FORMATS.has(tgt)) {
    const p7zRes = await convertWithNative7z(inputBuffer, src, tgt, options, originalFilename);
    if (p7zRes) return p7zRes;
  }

  // 5. In-Repo Pure TS Fallback
  const internalRes = await convertFile(inputBuffer, src, tgt, options, originalFilename);
  return {
    ...internalRes,
    engineUsed: 'internal-fallback',
    executionTimeMs: Date.now() - startTime,
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
