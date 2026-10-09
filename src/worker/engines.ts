import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import {
  ConversionOptions,
  ConversionResult,
  ConversionFailedError,
  ArchiveEncryptionUnavailableError,
  ArchiveNotEncryptedError,
  UnsupportedOptionError,
  EngineUnavailableError,
  InvalidPageRangeError,
  ComplexScriptRequiresNativeEngineError,
  MediaPackagingOptions,
  UnsupportedTargetError,
  RawDecodeError,
  UnsupportedRawCompressionError,
  InvalidRawSensorError,
  RawEngineRequiredError,
  PayloadLimitError,
} from '../lib/types';
import { PayloadTooLargeForMemoryError, getMaxInMemoryBytes } from '../lib/storage/errors';
import { convertFile, convertImage } from '../lib/conversions';
import { assertOpenDocumentGraphic } from '../lib/conversions/office';
import { RAW_CAMERA_FORMATS } from '../lib/conversions/raw-formats';
import { findBrcmTrailer } from '../lib/conversions/raw-brcm';
import { isX3f } from '../lib/conversions/raw-x3f';
import { decodeRawInThread } from './raw-decode-host';
import { encode16BitTiff } from '../lib/conversions/raw-hdr';
import { hasCjkScript, hasComplexTextScript } from '../lib/conversions/ctl';
import { encodeSvgPageToDxf } from '../lib/conversions/vector-dxf';
import { assertFontCoverage, findUncoveredCodePoint, loadFontCoverageIndex } from '../lib/conversions/pdf-fonts';
import { createTextInputDecoder, decodeTextInput } from '../lib/conversions/text-input';
import { markdownToSafeHtml } from '../lib/conversions/markdown-pdf';
import { stageHtmlForNativeEngine } from '../lib/conversions/html-native-staging';
import { parseHwpDocument } from '../lib/conversions/hwp';
import { assertConversionOptionsObject } from '../lib/conversions/options-guard';
import { readPersistedOutput } from './persisted-output';
import { getFormatByExtension, assertNotSpoofedFile } from '../lib/registry';
import { assertNotSpoofedFilePath } from '../lib/security/file-guard';
import { parsePageRanges, groupConsecutiveRanges, pageEntryName, resolvePageSelection, PageInterval } from '../lib/conversions/page-range';
import {
  buildFfmpegArguments,
  buildHlsDashArguments,
  buildTwoPassArguments,
  isTwoPassRequested,
  probePackagingSource,
  probeHardwareAcceleration,
  usesHardwareVideoEncoder,
  HardwareAccelerationCapabilities,
} from '../lib/conversions/media-ffmpeg-args';
import {
  probeMediaDuration,
  computeMediaTimeoutMs,
  computePackagingTimeoutMs,
  plannedRungCount,
  DEFAULT_MEDIA_TIER_MAX_MS,
} from '../lib/conversions/media';
import { describeAudioProcessing, measureLoudnessStage } from '../lib/conversions/media-audio-run';
import { describeDroppedStreams } from '../lib/conversions/media-dropped-streams';
import { runTwoPass, TWO_PASS_LOG_PREFIX, twoPassBudgetMs } from '../lib/conversions/media-two-pass';
import {
  executeSandboxedBinary,
  rethrowSandboxUnavailable,
  SandboxedMemoryLimitError,
  SandboxedProcessError,
  SandboxedBufferLimitError,
} from './sandbox';
import { isPasswordHandlingUnavailable, toPopplerPasswordError, withDecryptedPdf } from './pdf-decrypt';
import {
  RAW_DECODE_MAX_OUTPUT_BYTES,
  assertCompleteDecodedImage,
  assertWithinPixelCap,
  hasRepeatedTail,
  readDecodedTiffLayout,
} from './raw-decoded-tiff';
import { ARCHIVE_SECURITY_LIMITS, SEVEN_ZIP_BINARY_CANDIDATES, extractWithSpannedStream7z } from '../lib/conversions/archive';
import {
  cleanupDirectoryTree,
  extractArchiveContained,
  sanitizeLeafFilename,
} from '../lib/conversions/archive-extraction-safety';
import { planNativeArchiveRoute, type NativeArchiveRoute } from '../lib/conversions/archive-stream-route';
import {
  sevenZipToTar,
  stageTarForSevenZip,
  streamToTar,
  type ArchiveSource,
  type StagedTar,
  type StreamedArchive,
} from '../lib/conversions/archive-stream';
import {
  SEVEN_ZIP_ASK_PASSWORD_SWITCH,
  archivePasswordError,
  MAX_ENCRYPTION_LISTING_BYTES,
  archiveFailureStderr,
  assertArchivePasswordSafe,
  assertListingShowsEncryption,
  assertEncryptedArchiveInputWithinLimits,
  assertZipPasswordSupported,
  isArchivePasswordError,
  sevenZipCreatePasswordInput,
  sevenZipEncryptionCheckInput,
  sevenZipReadPasswordInput,
  walkArchiveTreePaths,
} from '../lib/conversions/archive-password';
import { resolveArchiveCompressionLevel } from '../lib/conversions/archive-compression-level';
import {
  LibreOfficePoolManager,
  LibreOfficePoolTimeoutError,
  resolveLibreOfficeFilter,
} from './libreoffice-pool';

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
  engineUsed: 'native-soffice' | 'native-soffice-pool' | 'native-ffmpeg' | 'native-7z' | 'native-poppler' | 'native-postscript' | 'native-raw' | 'in-process-raw' | 'internal-fallback';
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
  // Same names and order as the library (7zz first, then the p7zip names). 7zr reads 7z only, and
  // the worker also needs zip, tar and rar, so it is not a candidate here.
  p7zip: [
    ...(process.env.P7ZIP_PATH ? [process.env.P7ZIP_PATH] : []),
    ...SEVEN_ZIP_BINARY_CANDIDATES.filter((candidate) => !candidate.endsWith('/7zr')),
  ],
  ffprobe: [
    ...(process.env.FFPROBE_PATH ? [process.env.FFPROBE_PATH] : []),
    '/usr/bin/ffprobe',
    '/usr/local/bin/ffprobe',
    '/opt/homebrew/bin/ffprobe',
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
  pdftops: [
    ...(process.env.PDFTOPS_PATH ? [process.env.PDFTOPS_PATH] : []),
    '/usr/bin/pdftops',
    '/usr/local/bin/pdftops',
    '/opt/homebrew/bin/pdftops',
  ],
  dcrawEmu: [
    ...(process.env.DCRAW_EMU_PATH ? [process.env.DCRAW_EMU_PATH] : []),
    '/usr/bin/dcraw_emu',
    '/usr/local/bin/dcraw_emu',
    '/opt/homebrew/bin/dcraw_emu',
  ],
  ps2pdf: [
    ...(process.env.PS2PDF_PATH ? [process.env.PS2PDF_PATH] : []),
    '/usr/bin/ps2pdf',
    '/usr/local/bin/ps2pdf',
    '/opt/homebrew/bin/ps2pdf',
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

/** Native CLIs a health check can ask about, keyed as in BINARY_PATHS. */
export type NativeBinaryName =
  | 'soffice'
  | 'ffmpeg'
  | 'ffprobe'
  | 'p7zip'
  | 'pdftoppm'
  | 'pdftotext'
  | 'tesseract'
  | 'ps2pdf'
  | 'dcrawEmu';

/** The environment variable that overrides each native CLI's location. */
const NATIVE_BINARY_ENV_VARS: Readonly<Record<NativeBinaryName, string>> = {
  soffice: 'SOFFICE_PATH',
  ffmpeg: 'FFMPEG_PATH',
  ffprobe: 'FFPROBE_PATH',
  p7zip: 'P7ZIP_PATH',
  pdftoppm: 'PDFTOPPM_PATH',
  pdftotext: 'PDFTOTEXT_PATH',
  tesseract: 'TESSERACT_PATH',
  ps2pdf: 'PS2PDF_PATH',
  dcrawEmu: 'DCRAW_EMU_PATH',
};

/**
 * Where the worker finds a native CLI: the environment override when one is set, otherwise the
 * fixed install locations, or null. Reads the environment on every call and runs nothing.
 */
export function resolveNativeBinary(name: NativeBinaryName): string | null {
  return resolveBinary(BINARY_PATHS[name], process.env[NATIVE_BINARY_ENV_VARS[name]]);
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
  dcrawEmu: boolean;
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
    dcrawEmu: resolveBinary(BINARY_PATHS.dcrawEmu, process.env.DCRAW_EMU_PATH) !== null,
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
    cleanupDirectoryTree(tempDir);
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
function resolveOutputPath(targetFormat: string, options?: WorkerEngineOptions, vfsPayload?: WorkerVfsPayload): string {
  const desiredOutput = vfsPayload?.outputPath || (options as any)?.outputPath;
  if (desiredOutput) return desiredOutput;
  const vfsDir = path.join(os.tmpdir(), 'easyconvert-vfs');
  if (!fs.existsSync(vfsDir)) {
    try {
      fs.mkdirSync(vfsDir, { recursive: true, mode: 0o700 });
    } catch {}
  }
  return path.join(vfsDir, `easyconvert-out-${crypto.randomUUID()}.${targetFormat}`);
}

export function preserveOutput(
  tempOutputPath: string,
  targetFormat: string,
  options?: WorkerEngineOptions,
  vfsPayload?: WorkerVfsPayload
): string {
  const finalPath = resolveOutputPath(targetFormat, options, vfsPayload);
  fs.copyFileSync(tempOutputPath, finalPath);
  return finalPath;
}

/** Writes an output that is already in memory as byte ranges straight to its destination, without a temporary copy. */
function writeOutputSegments(
  segments: readonly Uint8Array[],
  targetFormat: string,
  options?: WorkerEngineOptions,
  vfsPayload?: WorkerVfsPayload
): string {
  const finalPath = resolveOutputPath(targetFormat, options, vfsPayload);
  const fd = fs.openSync(finalPath, 'w');
  try {
    for (const segment of segments) {
      let written = 0;
      while (written < segment.length) {
        written += fs.writeSync(fd, segment, written, segment.length - written);
      }
    }
  } finally {
    fs.closeSync(fd);
  }
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
      cachedBuffer ??= readPersistedOutput(persistedFilePath, stat.size);
      return cachedBuffer;
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
      // The standalone run below needs the same sandbox the pool just failed to get.
      rethrowSandboxUnavailable(poolErr);
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
    // A missing sandbox is not a missing tool: it is never reported as "nothing converted".
    rethrowSandboxUnavailable(err);
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

      const durationSeconds = probeMediaDuration(inputPath, options, ffmpegBin);
      const timeout = computeMediaTimeoutMs(durationSeconds, options.timeoutMs || DEFAULT_MEDIA_TIER_MAX_MS);
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

        const source = probePackagingSource(inputPath, ffmpegBin);
        const args = buildHlsDashArguments(inputPath, outputDir, packaging, ffmpegBin, source);
        await executeSandboxedBinary(ffmpegBin, args, {
          cwd: outputDir,
          timeoutMs: computePackagingTimeoutMs(
            source.geometry.durationSec,
            plannedRungCount(packaging, source),
            options.timeoutMs || DEFAULT_MEDIA_TIER_MAX_MS
          ),
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

      const runFfmpegWith = (ffmpegArgs: string[], limitMs: number) =>
        executeSandboxedBinary(ffmpegBin, ffmpegArgs, {
          cwd: tempDir,
          timeoutMs: limitMs,
          maxBuffer,
          networkIsolated: true,
          signal: options.signal,
        });
      const runFfmpeg = (ffmpegArgs: string[]) => runFfmpegWith(ffmpegArgs, timeout);
      // A loudness request measures first (cheap: audio only), so the encode applies real numbers.
      const loudnessStage = await measureLoudnessStage({ inputPath, src, tgt, options, ffmpegBin, run: runFfmpeg });

      if (isTwoPassRequested(options)) {
        // The pass logs go to the job's sandbox directory (the working directory), which is removed with it.
        const passes = buildTwoPassArguments(inputPath, tempOutputPath, src, tgt, options, ffmpegBin, TWO_PASS_LOG_PREFIX, loudnessStage);
        await runTwoPass(passes, twoPassBudgetMs(timeout), runFfmpegWith);
      } else {
        const args = buildFfmpegArguments(inputPath, tempOutputPath, src, tgt, options, ffmpegBin, undefined, loudnessStage);
        try {
          await runFfmpeg(args);
        } catch (err) {
          // A hardware encoder that passed the capability probe can still fail at runtime (device lost,
          // driver error). Retry exactly once in software; a failed retry reports the original error,
          // and a cancelled job is never retried.
          const hardwareEncoderFailed = err instanceof SandboxedProcessError && usesHardwareVideoEncoder(args);
          if (!hardwareEncoderFailed || options.signal?.aborted) {
            throw err;
          }
          const softwareArgs = buildFfmpegArguments(
            inputPath, tempOutputPath, src, tgt, { ...options, disableHwaccel: true }, ffmpegBin, undefined, loudnessStage
          );
          try {
            await runFfmpeg(softwareArgs);
          } catch {
            throw err;
          }
        }
      }

      if (!fs.existsSync(tempOutputPath)) {
        throw new Error(`FFmpeg execution completed without producing expected output file "${tempOutputPath}"`);
      }

      const vfsPayload = Buffer.isBuffer(input) ? undefined : input;
      const persistedPath = preserveOutput(tempOutputPath, tgt, options, vfsPayload);

      const transcoded = createConversionResult(
        persistedPath,
        tgt,
        baseName,
        'native-ffmpeg',
        Date.now() - startTime
      );
      transcoded.metadata = {
        ...describeAudioProcessing(options, ffmpegBin, loudnessStage),
        ...describeDroppedStreams(inputPath, tgt, options, ffmpegBin),
      };
      return transcoded;
    });
  } catch (err) {
    if (options.throwOnUnavailable) {
      throw err;
    }
    // A missing sandbox is not a missing tool: it is never reported as "nothing converted".
    rethrowSandboxUnavailable(err);
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
  // Sources the in-process archive engine leaves to this engine (NATIVE_SEVEN_ZIP_SOURCES in archive.ts).
  'dmg', 'img', 'lha', 'lzma', 'z', 'tar.z', 'tz',
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
  /** Validated level, passed to 7-Zip as `-mx`. */
  compressionLevel: number;
}

/**
 * Lists the password-protected archive just written, without its password, and throws
 * ArchiveNotEncryptedError unless it is encrypted: a 7-Zip that ignores its prompt exits 0 with
 * a plaintext archive.
 */
async function assertCreatedArchiveEncrypted(
  p7zBin: string,
  archivePath: string,
  format: 'zip' | '7z',
  limits: { cwd: string; timeoutMs: number; signal?: AbortSignal }
): Promise<void> {
  let outcome: { listing?: string; failureOutput?: string };
  try {
    const result = await executeSandboxedBinary(p7zBin, ['l', '-slt', archivePath], {
      cwd: limits.cwd,
      timeoutMs: limits.timeoutMs,
      maxBuffer: MAX_ENCRYPTION_LISTING_BYTES,
      networkIsolated: true,
      stdin: sevenZipEncryptionCheckInput(),
      signal: limits.signal,
    });
    outcome = { listing: result.stdout.toString('utf-8') };
  } catch (err) {
    rethrowSandboxUnavailable(err);
    outcome = { failureOutput: archiveFailureStderr(err) };
  }
  assertListingShowsEncryption(format, outcome);
}

async function package7zArchive(params: Package7zArchiveParams): Promise<boolean> {
  const { p7zBin, tgt, extractDir, tempDir, tempOutputPath, timeout, maxBuffer, options, compressionLevel } = params;
  const levelArgs = [`-mx=${compressionLevel}`];
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
    await executeSandboxedBinary(p7zBin, ['a', '-y', subType, ...levelArgs, tempOutputPath, tarPath], {
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

  if (options?.password && (tgt === 'zip' || tgt === '7z')) {
    assertEncryptedArchiveInputWithinLimits(walkArchiveTreePaths(extractDir));
  }
  const pwArgs: string[] = [];
  if (options?.password) {
    if (tgt === '7z') {
      pwArgs.push('-mhe=on', SEVEN_ZIP_ASK_PASSWORD_SWITCH);
    } else if (tgt === 'zip') {
      pwArgs.push('-mem=AES256', SEVEN_ZIP_ASK_PASSWORD_SWITCH);
    }
  }
  const pwInput =
    options?.password && (tgt === 'zip' || tgt === '7z')
      ? sevenZipCreatePasswordInput(options.password)
      : undefined;

  await executeSandboxedBinary(p7zBin, ['a', '-y', `-t${archiveType}`, ...(tgt === 'tar' ? [] : levelArgs), ...pwArgs, tempOutputPath, '.'], {
    cwd: extractDir,
    timeoutMs: timeout,
    maxBuffer,
    networkIsolated: true,
    stdin: pwInput,
    signal: options?.signal,
  });
  if (options?.password && (tgt === 'zip' || tgt === '7z')) {
    await assertCreatedArchiveEncrypted(p7zBin, tempOutputPath, tgt, {
      cwd: tempDir,
      timeoutMs: timeout,
      signal: options.signal,
    });
  }
  return true;
}

/** Turns a failed `7z a` run into a typed error; other failures (timeouts, aborts) keep their own type. */
function toPackagingFailure(err: unknown, targetFormat: string): unknown {
  if (err instanceof SandboxedProcessError) {
    return new ConversionFailedError(
      `7-Zip failed to create the ${targetFormat} archive (exit code ${err.exitCode ?? 'unknown'}).`
    );
  }
  return err;
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

/** 7-Zip opens a Z stream by its `.z` name; it does not know `.tz`, the registry name of a tar compressed with compress. */
const SEVEN_ZIP_INPUT_EXTENSION: ReadonlyMap<string, string> = new Map([['tz', 'z']]);

/** Compression wrappers that unpack to a single tar, which is repackaged without being extracted. */
const COMPRESSED_STREAM_FORMATS = new Set([
  'gz', 'gzip', 'tgz', 'tar.gz',
  'bz2', 'bzip2', 'tbz2', 'tar.bz2',
  'xz', 'txz', 'tar.xz',
  'lzma', 'z', 'tar.z', 'tz',
]);

interface SourceExtraction {
  entryCount: number;
  skippedLinks: string[];
}

/**
 * Extracts the source archive into `extractDir` through the contained 7z pipeline (list, vet,
 * extract, re-verify). Throws a typed error for any unsafe, oversized or unreadable archive; it
 * never returns a partial result.
 */
async function extractSourceArchive(params: ExtractArchiveParams, src: string): Promise<SourceExtraction> {
  const { p7zBin, inputPath, extractDir, tempDir, timeout, maxBuffer, options } = params;

  if (options?.archiveParts && options.archiveParts.length > 0) {
    // Multi-volume input is stitched to one seekable file so it is listed like any other archive.
    const spanned = await extractWithSpannedStream7z(options.archiveParts, extractDir, {
      timeoutMs: timeout,
      maxBuffer,
      password: options.password,
      skipLinks: options.skipLinks,
      collisionPolicy: options.collisionPolicy,
      signal: options.signal,
    });
    return { entryCount: spanned.entryCount, skippedLinks: spanned.skippedLinks };
  }

  const includePatterns = options?.entries && options.entries.length > 0 ? options.entries : undefined;
  const tree = await extractArchiveContained({
    p7zBin,
    archivePath: inputPath,
    extractDir,
    cwd: tempDir,
    timeoutMs: timeout,
    maxBuffer,
    limits: ARCHIVE_SECURITY_LIMITS,
    label: 'archive',
    password: options?.password,
    includePatterns,
    skipLinks: options?.skipLinks,
    collisionPolicy: options?.collisionPolicy,
    validateNestedTar: COMPRESSED_STREAM_FORMATS.has(src),
    signal: options?.signal,
  });
  return { entryCount: tree.entryCount, skippedLinks: tree.skippedLinks };
}

/**
 * The result of a streamed conversion. The dispatcher keeps an output on disk only for a payload that already lives on
 * disk, a zero-heap request or a requested output path; any other caller gets the bytes back in memory, so a Buffer
 * conversion writes no output file only to read it back and delete it.
 */
function streamedArchiveResult(
  streamed: StreamedArchive,
  context: { tgt: string; baseName: string; options: WorkerEngineOptions; vfsPayload?: WorkerVfsPayload; startTime: number }
): WorkerConversionResult {
  const { tgt, baseName, options, vfsPayload, startTime } = context;
  const wantsFile = vfsPayload !== undefined || Boolean(options.zeroHeap) || Boolean((options as { outputPath?: string }).outputPath);
  if (wantsFile) {
    const persistedPath = writeOutputSegments(streamed.segments, tgt, options, vfsPayload);
    return createConversionResult(persistedPath, tgt, baseName, 'native-7z', Date.now() - startTime);
  }
  const buffer = streamed.segments.length === 1 ? Buffer.from(streamed.segments[0].buffer, streamed.segments[0].byteOffset, streamed.segments[0].byteLength) : Buffer.concat(streamed.segments);
  return {
    mimeType: getMimeType(tgt),
    filename: `${baseName}.${tgt}`,
    size: buffer.length,
    buffer,
    engineUsed: 'native-7z',
    executionTimeMs: Date.now() - startTime,
  };
}

/** The archive a conversion reads, as the streaming routes take it: in memory, or a file left where it is. */
function archiveSourceOf(input: Buffer | WorkerVfsPayload): ArchiveSource {
  if (Buffer.isBuffer(input)) return { buffer: input };
  if (input.inputBuffer) return { buffer: input.inputBuffer };
  if (input.inputPath && fs.existsSync(input.inputPath)) return { filePath: input.inputPath };
  throw new Error('Worker conversion received invalid input payload: neither inputPath nor inputBuffer provided');
}

/** Runs a streaming route; null hands the request to the general pipeline (see archive-stream.ts). */
async function runStreamingRoute(
  route: Extract<NativeArchiveRoute, { kind: 'stream-to-tar' | 'seven-zip-to-tar' }>,
  params: {
    p7zBin: string;
    input: Buffer | WorkerVfsPayload;
    originalFilename: string;
    timeout: number;
    options: WorkerEngineOptions;
  }
): Promise<StreamedArchive | null> {
  const common = {
    p7zBin: params.p7zBin,
    source: archiveSourceOf(params.input),
    originalFilename: params.originalFilename,
    timeoutMs: params.timeout,
    skipLinks: params.options.skipLinks,
    collisionPolicy: params.options.collisionPolicy,
    signal: params.options.signal,
  };
  if (route.kind === 'stream-to-tar') return streamToTar({ ...common, compressor: route.source.compressor });
  return sevenZipToTar(common);
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
  assertArchivePasswordSafe(options.password);
  // Refused before any tool runs; the pack steps read the same validated value.
  const compressionLevel = resolveArchiveCompressionLevel(options.compressionLevel);

  const isTarGz = tgt === 'tar.gz' || tgt === 'tgz';
  const isTarBz2 = tgt === 'tar.bz2' || tgt === 'tbz2' || tgt === 'tbz';
  const isTarXz = tgt === 'tar.xz' || tgt === 'txz';
  assertArchivePasswordSafe(options.password);
  if (options.password && tgt !== 'zip' && tgt !== '7z') {
    throw new UnsupportedOptionError(`Target archive format '${tgt}' does not support password encryption.`);
  }
  if (tgt === 'zip') assertZipPasswordSupported(options.password);

  // Stock 7-Zip builds cannot open or create Zstandard streams; the in-process zstd engine owns them.
  if (src.includes('zst') || tgt.includes('zst')) {
    return null;
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
  const timeout = Math.min(options.timeoutMs || 60000, 180000);
  const maxBuffer = Math.min(options.maxBufferBytes || 200 * 1024 * 1024, 500 * 1024 * 1024);
  const vfsPayload = Buffer.isBuffer(input) ? undefined : input;

  // The routing decision lives in planNativeArchiveRoute; a null plan is the general extract-then-pack pipeline.
  const route = planNativeArchiveRoute(src, tgt, options);
  if (route?.kind === 'stream-to-tar' || route?.kind === 'seven-zip-to-tar') {
    const streamed = await runStreamingRoute(route, { p7zBin, input, originalFilename, timeout, options });
    if (streamed) {
      const result = streamedArchiveResult(streamed, { tgt, baseName, options, vfsPayload, startTime });
      if (streamed.skippedLinks.length > 0) {
        result.skippedLinks = streamed.skippedLinks;
      }
      return result;
    }
  }

  // Failures are typed errors that propagate: a bad archive must never become a null that lets a
  // caller drop to another engine.
  return withSandboxDir('easyconvert-7z-', async (tempDir) => {
    // A tar headed for 7z is read and vetted in process and written once into the tree 7-Zip packs.
    const staged: StagedTar | null =
      route?.kind === 'tar-to-seven-zip'
        ? stageTarForSevenZip({
            source: archiveSourceOf(input),
            workDir: tempDir,
            skipLinks: options.skipLinks,
            collisionPolicy: options.collisionPolicy,
          })
        : null;

    let extractDir = path.join(tempDir, 'extracted');
    let entryCount: number;
    let skippedLinks: string[] = [];
    if (staged) {
      extractDir = staged.stagingDir;
      entryCount = staged.entryCount;
      skippedLinks = staged.skippedLinks;
    } else {
      const inputExt = SEVEN_ZIP_INPUT_EXTENSION.get(src) ?? (src.includes('.') ? src.split('.').pop()! : src);
      const { inputPath } = resolveInputContext(input, inputExt, tempDir);
      fs.mkdirSync(extractDir, { recursive: true });

      // Step 1: Extract if source is an archive container, otherwise copy/place single file into extract directory
      if (ARCHIVE_EXTRACT_FORMATS.has(src)) {
        const extraction = await extractSourceArchive(
          {
            p7zBin,
            inputPath,
            extractDir,
            tempDir,
            timeout,
            maxBuffer,
            options,
          },
          src
        );
        entryCount = extraction.entryCount;
        skippedLinks = extraction.skippedLinks;
      } else {
        // The caller-supplied name becomes a single path component inside the extraction root.
        const destPath = path.join(extractDir, sanitizeLeafFilename(originalFilename || `file.${src}`));
        fs.copyFileSync(inputPath, destPath);
        entryCount = 1;
      }
    }

    if (entryCount === 0) {
      throw new ConversionFailedError('The archive contains no files to convert.');
    }

    const tempOutputPath = path.join(tempDir, `output.${tgt}`);
    let packaged: boolean;
    try {
      packaged = await package7zArchive({
        p7zBin,
        tgt,
        extractDir,
        tempDir,
        tempOutputPath,
        timeout,
        maxBuffer,
        options,
        compressionLevel,
      });
    } catch (err) {
      throw toPackagingFailure(err, tgt);
    } finally {
      // The staged directories keep the tar's modes while 7-Zip packs them; the sandbox removes them afterwards.
      staged?.release();
    }
    if (!packaged || !fs.existsSync(tempOutputPath)) {
      throw new ConversionFailedError('7-Zip packaging failed to produce output archive');
    }

    const persistedPath = preserveOutput(tempOutputPath, tgt, options, vfsPayload);

    const result = createConversionResult(persistedPath, tgt, baseName, 'native-7z', Date.now() - startTime);
    if (skippedLinks.length > 0) {
      result.skippedLinks = skippedLinks;
    }
    return result;
  });
}

/**
 * Image formats supported by Poppler pdftoppm.
 */
const POPPLER_IMAGE_FORMATS = new Set(['png', 'jpg', 'jpeg', 'tiff', 'tif', 'ppm']);

/**
 * Counts the pages of a PDF. A password never reaches the pdfinfo command line: the document is
 * decrypted into a private copy under `tempDir` first (see `withDecryptedPdf`).
 */
export async function getPdfPageCount(
  inputPath: string,
  tempDir: string,
  timeoutMs: number,
  signal?: AbortSignal,
  inputBuffer?: Buffer,
  password?: string
): Promise<number> {
  return withDecryptedPdf({ inputPath, tempDir, password, timeoutMs, signal }, (readablePath) =>
    countPagesOfReadablePdf(readablePath, tempDir, timeoutMs, signal, password ? undefined : inputBuffer)
  );
}

/** Page count of a PDF that Poppler can open without a password. */
async function countPagesOfReadablePdf(
  inputPath: string,
  tempDir: string,
  timeoutMs: number,
  signal?: AbortSignal,
  inputBuffer?: Buffer
): Promise<number> {
  const pdfinfoBin = resolveBinary(BINARY_PATHS.pdfinfo, process.env.PDFINFO_PATH);
  if (pdfinfoBin) {
    try {
      const res = await executeSandboxedBinary(pdfinfoBin, [inputPath], {
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
    } catch (err) {
      rethrowSandboxUnavailable(err);
      const passwordError = toPopplerPasswordError(err);
      if (passwordError) {
        throw passwordError;
      }
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

/** Raster density of a PDF page image: the default and the range the API accepts. */
const PDF_RASTER_DEFAULT_DPI = 150;
const PDF_RASTER_MIN_DPI = 72;
const PDF_RASTER_MAX_DPI = 600;

function buildPdftoppmArgs(
  tgt: string,
  options: WorkerEngineOptions,
  startPage: number,
  endPage: number,
  inputPath: string,
  prefix: string
): string[] {
  const dpi = options.dpi ?? PDF_RASTER_DEFAULT_DPI;
  if (!Number.isFinite(dpi) || dpi < PDF_RASTER_MIN_DPI || dpi > PDF_RASTER_MAX_DPI) {
    throw new UnsupportedOptionError(`The dpi option ${options.dpi} is outside the supported range of ${PDF_RASTER_MIN_DPI} to ${PDF_RASTER_MAX_DPI}.`);
  }
  const args: string[] = ['-r', String(dpi)];

  if (tgt === 'png') {
    args.push('-png');
  } else if (tgt === 'jpg' || tgt === 'jpeg') {
    args.push('-jpeg');
  } else if (tgt === 'tiff' || tgt === 'tif') {
    args.push('-tiff');
  }

  args.push('-f', String(startPage), '-l', String(endPage), inputPath, prefix);
  return args;
}

/**
 * pdftotext flags for a text export. The default is poppler's reading-order mode, which follows
 * the page's own text flow and reads columns one after another. `layout: true` keeps physical
 * layout (`-layout`) so table rows stay on one line. Any other `layout` value is a client error.
 */
function buildPdftotextArgs(options: WorkerEngineOptions): string[] {
  if (options.layout === undefined || options.layout === false) return [];
  if (options.layout === true) return ['-layout'];
  throw new UnsupportedOptionError('The layout option must be a boolean.');
}

async function convertPdfToTextWithPoppler(
  input: Buffer | WorkerVfsPayload,
  options: WorkerEngineOptions,
  originalFilename: string,
  startTime: number,
  timeout: number,
  maxBuffer: number
): Promise<WorkerConversionResult | null> {
  const pdftotextArgs = buildPdftotextArgs(options);
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

      await withDecryptedPdf(
        { inputPath, tempDir, password: options.password, timeoutMs: timeout, signal: options.signal },
        async (readablePath) => {
          try {
            await executeSandboxedBinary(pdftotextBin, [...pdftotextArgs, readablePath, tempOutputPath], {
              cwd: tempDir,
              timeoutMs: timeout,
              maxBuffer,
              networkIsolated: true,
              signal: options.signal,
            });
          } catch (err) {
            throw toPopplerPasswordError(err) ?? err;
          }
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
    // A missing sandbox is not a missing tool: it is never reported as "nothing converted".
    rethrowSandboxUnavailable(err);
    return null;
  }
}

function resolveRequestedPages(options: WorkerEngineOptions, pageCount: number): number[] {
  const requestedPages =
    resolvePageSelection(
      options.page,
      options.pages,
      pageCount,
      (page, count) => new InvalidPageRangeError(`Page number ${page} is out of bounds (1-${count})`)
    ) ?? Array.from({ length: pageCount }, (_, i) => i + 1);

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
  singleFile?: boolean;
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
    singleFile,
    tempDir,
    resolvedFiles,
    requestedPages,
    tgt,
    baseName,
    options,
    input,
    startTime,
  } = params;

  const isSingleOutput = singleFile || requestedPages.length === 1 || options.multiPageOutput === 'first';
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

  for (const item of resolvedFiles) {
    const entryName = pageEntryName(baseName, item.pageNum, maxPage, tgt);
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
  /** The one output file covers every selected page (a multi-page PostScript file), so it is never zipped. */
  singleFile?: boolean;
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

function loadPdfInputBuffer(input: Buffer | WorkerVfsPayload): Buffer | undefined {
  if (Buffer.isBuffer(input)) {
    return input;
  }
  if (input.inputBuffer) {
    return input.inputBuffer;
  }
  return input.inputPath ? fs.readFileSync(input.inputPath) : undefined;
}

async function executePopplerRender(params: PopplerRenderParams): Promise<WorkerConversionResult | null> {
  const {
    sandboxPrefix,
    singleFile,
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
      // Poppler only ever sees a PDF it can open without a password; the credential stays in qpdf's private file.
      return withDecryptedPdf(
        { inputPath, tempDir, password: options.password, timeoutMs: timeout, signal: options.signal },
        async (readablePath) => {
          // With a password the fallback parser must read the decrypted copy, not the encrypted input.
          const inputBuffer = options.password ? undefined : loadPdfInputBuffer(input);
          const pageCount = await countPagesOfReadablePdf(readablePath, tempDir, timeout, options.signal, inputBuffer);

          const requestedPages = resolveRequestedPages(options, pageCount);
          await renderPages(tempDir, readablePath, requestedPages);

          const files = fs.readdirSync(tempDir).filter(filterOutputFile);
          if (files.length === 0) {
            throw new Error(missingOutputError);
          }

          const resolvedFiles = matchOutputPageFiles(files, requestedPages);
          return finalizeMultiPageOutput({
            singleFile,
            tempDir,
            resolvedFiles,
            requestedPages,
            tgt,
            baseName,
            options,
            input,
            startTime,
          });
        }
      );
    });
  } catch (err) {
    if (options.throwOnUnavailable) {
      throw err;
    }
    // A missing sandbox is not a missing tool: it is never reported as "nothing converted".
    rethrowSandboxUnavailable(err);
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
          const args = ['-svg', '-f', String(p), '-l', String(p), inputPath, pageSvgPath];
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
 * Raster targets written by the in-process image encoders: Poppler renders each page to PNG and the encoder
 * takes the picture from there, the way the camera RAW route hands its decoded image to the same encoders.
 */
const ENCODED_RASTER_TARGETS: ReadonlySet<string> = new Set(['avif', 'bmp', 'gif', 'ico', 'psd', 'webp']);
/** PostScript targets: Poppler's pdftops writes them from the PDF. */
const POSTSCRIPT_TARGETS: ReadonlySet<string> = new Set(['eps', 'ps']);
const EPS_TARGET = 'eps';
const DXF_TARGET = 'dxf';
const PNG_FORMAT = 'png';
const SVG_FORMAT = 'svg';
/** Poppler tools: default and ceiling for the run time, and for the bytes read from a tool's output pipes. */
const POPPLER_DEFAULT_TIMEOUT_MS = 45_000;
const POPPLER_MAX_TIMEOUT_MS = 120_000;
const POPPLER_DEFAULT_MAX_BUFFER_BYTES = 100 * 1024 * 1024;
const POPPLER_MAX_BUFFER_BYTES = 500 * 1024 * 1024;
/** Pages one request may re-encode: the page images are already rendered, the encoders then run once per page. */
const CHAINED_PAGE_ENCODE_MAX_PAGES = 500;

/** Every target a PDF turns into with native tools: Poppler images and SVG, the encoded rasters, PostScript and DXF. */
function isPdfChainTarget(tgt: string): boolean {
  return (
    POPPLER_IMAGE_FORMATS.has(tgt) ||
    tgt === SVG_FORMAT ||
    ENCODED_RASTER_TARGETS.has(tgt) ||
    POSTSCRIPT_TARGETS.has(tgt) ||
    tgt === DXF_TARGET
  );
}

interface ChainOutputContext {
  /** The engine reported for the result: the one that did the page rendering. */
  engine: WorkerConversionResult['engineUsed'];
  baseName: string;
  options: WorkerEngineOptions;
  input: Buffer | WorkerVfsPayload;
  startTime: number;
}

/** Writes a chain's final bytes where the request asked for them, like every other engine does. */
async function persistChainOutput(buffer: Buffer, extension: string, context: ChainOutputContext): Promise<WorkerConversionResult> {
  return withSandboxDir('easyconvert-chain-', async (tempDir) => {
    const outputPath = path.join(tempDir, `output.${extension}`);
    fs.writeFileSync(outputPath, buffer);
    const vfsPayload = Buffer.isBuffer(context.input) ? undefined : context.input;
    const persistedPath = preserveOutput(outputPath, extension, context.options, vfsPayload);
    return createConversionResult(persistedPath, extension, context.baseName, context.engine, Date.now() - context.startTime);
  });
}

/**
 * Re-encodes every page Poppler rendered. A single page is one file; several pages arrive as the ZIP of per-page
 * files every Poppler route returns, and leave as a ZIP with the same entry names and the new extension.
 */
async function reencodeRenderedPages(
  rendered: WorkerConversionResult,
  renderedExtension: string,
  targetExtension: string,
  encode: (page: Buffer, entryName: string) => Promise<Buffer>,
  context: ChainOutputContext
): Promise<WorkerConversionResult> {
  try {
    if (!rendered.filename.endsWith('.zip')) {
      return await persistChainOutput(await encode(rendered.buffer, rendered.filename), targetExtension, context);
    }
    const pages = await JSZip.loadAsync(rendered.buffer);
    const entryNames = Object.keys(pages.files)
      .filter((name) => !pages.files[name].dir)
      .sort((a, b) => a.localeCompare(b));
    if (entryNames.length > CHAINED_PAGE_ENCODE_MAX_PAGES) {
      throw new PayloadLimitError(
        `The document has ${entryNames.length} pages; at most ${CHAINED_PAGE_ENCODE_MAX_PAGES} can be converted to .${targetExtension} in one request. Select a page range.`
      );
    }
    const encoded = new JSZip();
    const renderedSuffix = `.${renderedExtension}`;
    for (const entryName of entryNames) {
      const stem = entryName.endsWith(renderedSuffix) ? entryName.slice(0, -renderedSuffix.length) : entryName;
      const page = await pages.files[entryName].async('nodebuffer');
      encoded.file(`${stem}.${targetExtension}`, await encode(page, entryName));
    }
    const zipBuffer = await encoded.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    return await persistChainOutput(zipBuffer, 'zip', context);
  } finally {
    // The intermediate pages are an implementation detail of this chain: never leave them on disk.
    discardPersistedOutput(rendered.filePath, context.input, context.options);
  }
}

/** The page images written by an encoder from PNG renders: page selection already happened in Poppler. */
function encoderOptions(options: WorkerEngineOptions): ConversionOptions {
  return { ...options, page: undefined, pages: undefined, multiPageOutput: undefined, password: undefined };
}

/** Options for a chain's first step: its output is an intermediate, so it is never written to the requested path. */
function intermediateOptions(options: WorkerEngineOptions): WorkerEngineOptions {
  return { ...options, outputPath: undefined } as WorkerEngineOptions;
}

/** PDF pages to avif, bmp, gif, ico, psd or webp: pdftoppm renders PNG pages, then the image encoder writes the target. */
async function convertPdfToEncodedRaster(
  input: Buffer | WorkerVfsPayload,
  tgt: string,
  options: WorkerEngineOptions,
  originalFilename: string,
  context: ChainOutputContext
): Promise<WorkerConversionResult | null> {
  const rendered = await convertWithNativePoppler(input, 'pdf', PNG_FORMAT, intermediateOptions(options), originalFilename);
  if (!rendered) return null;
  const pageOptions = encoderOptions(options);
  return reencodeRenderedPages(
    rendered,
    PNG_FORMAT,
    tgt,
    async (page, entryName) => (await convertImage(page, tgt, pageOptions, entryName, PNG_FORMAT)).buffer,
    context
  );
}

/** PDF pages to DXF: pdftocairo draws each page as SVG geometry and the DXF writer turns the geometry into entities. */
async function convertPdfToDxf(
  input: Buffer | WorkerVfsPayload,
  options: WorkerEngineOptions,
  originalFilename: string,
  context: ChainOutputContext
): Promise<WorkerConversionResult | null> {
  const rendered = await convertWithNativePoppler(input, 'pdf', SVG_FORMAT, intermediateOptions(options), originalFilename);
  if (!rendered) return null;
  return reencodeRenderedPages(rendered, SVG_FORMAT, DXF_TARGET, async (page) => encodeSvgPageToDxf(page), context);
}

/** True when the pages are consecutive, in order: the only selection one PostScript file can hold. */
function isConsecutivePageRun(pages: readonly number[]): boolean {
  return pages.every((page, index) => index === 0 || page === pages[index - 1] + 1);
}

/**
 * PDF pages to PostScript with pdftops. PostScript holds many pages: one file covers the selected pages, which
 * must be consecutive. EPS holds one picture, so each page becomes its own EPS file and several pages come back
 * as the ZIP of per-page files every Poppler route returns (`multiPageOutput: 'first'` keeps page one).
 */
async function convertPdfToPostScript(
  input: Buffer | WorkerVfsPayload,
  tgt: string,
  options: WorkerEngineOptions,
  originalFilename: string,
  startTime: number
): Promise<WorkerConversionResult | null> {
  const pdftopsBin = resolveBinary(BINARY_PATHS.pdftops, process.env.PDFTOPS_PATH);
  if (!pdftopsBin) {
    if (options.throwOnUnavailable) {
      throw new EngineUnavailableError('pdftops', 'pdftops binary is not installed or not in PATH');
    }
    return null;
  }
  const timeout = Math.min(options.timeoutMs || POPPLER_DEFAULT_TIMEOUT_MS, POPPLER_MAX_TIMEOUT_MS);
  const maxBuffer = Math.min(options.maxBufferBytes || POPPLER_DEFAULT_MAX_BUFFER_BYTES, POPPLER_MAX_BUFFER_BYTES);
  const isEps = tgt === EPS_TARGET;
  const run = (tempDir: string, args: string[]) =>
    executeSandboxedBinary(pdftopsBin, args, { cwd: tempDir, timeoutMs: timeout, maxBuffer, networkIsolated: true, signal: options.signal });

  return executePopplerRender({
    sandboxPrefix: 'easyconvert-poppler-ps-',
    singleFile: !isEps,
    tgt,
    input,
    options,
    originalFilename,
    startTime,
    timeout,
    filterOutputFile: (f) => f.endsWith(`.${tgt}`),
    missingOutputError: `pdftops execution completed without producing any .${tgt} output`,
    renderPages: async (tempDir, inputPath, requestedPages) => {
      if (isEps) {
        for (const page of requestedPages) {
          await run(tempDir, ['-eps', '-f', String(page), '-l', String(page), inputPath, path.join(tempDir, `page-${page}.eps`)]);
        }
        return;
      }
      if (!isConsecutivePageRun(requestedPages)) {
        throw new InvalidPageRangeError('PostScript output holds one run of consecutive pages: select a single range such as 2-4.');
      }
      const pages = options.multiPageOutput === 'first' ? requestedPages.slice(0, 1) : requestedPages;
      const first = pages[0];
      const last = pages[pages.length - 1];
      await run(tempDir, ['-f', String(first), '-l', String(last), inputPath, path.join(tempDir, `output.${tgt}`)]);
    },
  });
}

/**
 * A rendered PDF as HTML: the document text, page by page, from the in-process PDF reader. It fails with a typed
 * error when the pages hold no text, so a presentation of pictures never becomes an empty page.
 */
async function convertPdfToHtml(
  pdf: Buffer,
  options: WorkerEngineOptions,
  originalFilename: string,
  input: Buffer | WorkerVfsPayload,
  engine: WorkerConversionResult['engineUsed']
): Promise<WorkerConversionResult> {
  const startTime = Date.now();
  const baseName = originalFilename ? originalFilename.replace(/\.[^/.]+$/, '') : 'converted';
  const html = await convertFile(pdf, 'pdf', HTML_TARGET, encoderOptions(options), `${baseName}.pdf`);
  const body = HTML_BODY_PATTERN.exec(html.buffer.toString('utf-8'))?.[1] ?? '';
  if (body.replace(HTML_TAG_PATTERN, '').trim() === '') {
    throw new ConversionFailedError('The rendered pages hold no text, so there is nothing to write as HTML.');
  }
  return persistChainOutput(html.buffer, HTML_TARGET, { engine, baseName, options, input, startTime });
}

/**
 * Turns a PDF into any target a native tool chain writes from PDF pages: Poppler images and SVG, the encoded
 * rasters (pdftoppm, then the image encoder), PostScript and EPS (pdftops) and DXF (pdftocairo, then the DXF
 * writer). Returns null for any other target, and for a missing tool unless the caller asked for an error.
 */
export async function convertPdfPagesWithNativeTools(
  input: Buffer | WorkerVfsPayload,
  targetFormat: string,
  options: WorkerEngineOptions = {},
  originalFilename = 'file'
): Promise<WorkerConversionResult | null> {
  const tgt = validateFormat(targetFormat);
  if (!isPdfChainTarget(tgt)) return null;
  const startTime = Date.now();
  const baseName = originalFilename ? originalFilename.replace(/\.[^/.]+$/, '') : 'converted';
  const context: ChainOutputContext = { engine: 'native-poppler', baseName, options, input, startTime };
  if (ENCODED_RASTER_TARGETS.has(tgt)) return convertPdfToEncodedRaster(input, tgt, options, originalFilename, context);
  if (tgt === DXF_TARGET) return convertPdfToDxf(input, options, originalFilename, context);
  if (POSTSCRIPT_TARGETS.has(tgt)) return convertPdfToPostScript(input, tgt, options, originalFilename, startTime);
  return convertWithNativePoppler(input, 'pdf', tgt, options, originalFilename);
}

/** Targets that package the original camera file instead of rendering its pixels. */
const RAW_PACKAGING_TARGETS: ReadonlySet<string> = new Set(['zip']);
const RAW_DECODE_DEFAULT_TIMEOUT_MS = 120_000;
const RAW_DECODE_MAX_TIMEOUT_MS = 600_000;
const RAW_DECODE_MAX_STDERR_CHARS = 300;
/** Address-space ceiling for the decoder: room for the largest sensor plus LibRaw's working buffers. */
const RAW_DECODE_MEMORY_LIMIT_MB = 4096;
const RAW_DECODE_UNRECOGNIZED_PATTERN = /unsupported file format|not raw file/i;
/** dcraw_emu: write a TIFF (-T) with 16-bit samples (-6), camera white balance (-w) in sRGB (-o 1). */
const RAW_DECODE_FLAGS: readonly string[] = ['-T', '-6', '-w', '-o', '1'];

/**
 * Decodes camera RAW sensor data natively with LibRaw (`dcraw_emu`) into a 16-bit sRGB TIFF, then
 * encodes the requested target from it with the in-process image pipeline.
 */
export async function convertWithNativeRaw(
  input: Buffer | WorkerVfsPayload,
  sourceFormat: string,
  targetFormat: string,
  options: WorkerEngineOptions = {},
  originalFilename = 'file'
): Promise<WorkerConversionResult | null> {
  const src = validateFormat(sourceFormat);
  const tgt = validateFormat(targetFormat);
  if (!RAW_CAMERA_FORMATS.has(src) || RAW_PACKAGING_TARGETS.has(tgt)) return null;
  const dcrawBin = resolveBinary(BINARY_PATHS.dcrawEmu, process.env.DCRAW_EMU_PATH);
  if (!dcrawBin) {
    if (options.throwOnUnavailable) {
      throw new EngineUnavailableError('dcraw_emu', 'dcraw_emu (libraw-bin) is not installed or not in PATH');
    }
    return null;
  }

  const baseName = originalFilename ? originalFilename.replace(/\.[^/.]+$/, '') : 'converted';
  const startTime = Date.now();
  const timeout = Math.min(options.timeoutMs || RAW_DECODE_DEFAULT_TIMEOUT_MS, RAW_DECODE_MAX_TIMEOUT_MS);

  return withSandboxDir('easyconvert-raw-', async (tempDir) => {
    const { inputPath } = resolveInputContext(input, src, tempDir);
    const decodedPath = path.join(tempDir, 'decoded.tiff');
    let decoderStderr = '';
    try {
      const run = await executeSandboxedBinary(dcrawBin, [...RAW_DECODE_FLAGS, '-Z', decodedPath, inputPath], {
        cwd: tempDir,
        timeoutMs: timeout,
        maxBuffer: options.maxBufferBytes || 100 * 1024 * 1024,
        maxFileSize: RAW_DECODE_MAX_OUTPUT_BYTES,
        memoryLimitMb: RAW_DECODE_MEMORY_LIMIT_MB,
        networkIsolated: true,
        signal: options.signal,
      });
      decoderStderr = run.stderr.toString('utf-8').trim();
    } catch (err) {
      if (err instanceof SandboxedBufferLimitError || err instanceof SandboxedMemoryLimitError) {
        // The decoder hit its output-size or memory ceiling: the input demands more than the limits allow.
        throw new RawDecodeError(`Native RAW decoder exceeded its output limit or memory limit on the .${src} file`);
      }
      if (err instanceof SandboxedProcessError) {
        const detail = err.stderr.trim().slice(0, RAW_DECODE_MAX_STDERR_CHARS).replaceAll(tempDir, '<tmp>');
        throw new RawDecodeError(
          `Native RAW decoder rejected the .${src} file${detail ? `: ${detail}` : ''}`,
          RAW_DECODE_UNRECOGNIZED_PATTERN.test(err.stderr)
        );
      }
      throw err;
    }
    if (!fs.existsSync(decodedPath) || fs.statSync(decodedPath).size === 0) {
      throw new RawDecodeError(`Native RAW decoder produced no image for the .${src} file`);
    }

    // LibRaw reports damaged input on stderr and may still exit 0 with a partly filled image.
    if (decoderStderr) {
      throw new RawDecodeError(
        `Native RAW decoder reported a problem with the .${src} file: ${decoderStderr.slice(0, RAW_DECODE_MAX_STDERR_CHARS).replaceAll(tempDir, '<tmp>')}`
      );
    }
    const layout = readDecodedTiffLayout(decodedPath);
    assertWithinPixelCap(layout);
    assertCompleteDecodedImage(decodedPath, layout);
    if (hasRepeatedTail(decodedPath, layout)) {
      throw new RawDecodeError(`The .${src} file is truncated: the decoded image ends in repeated filler rows`);
    }

    const converted = await convertImage(fs.readFileSync(decodedPath), tgt, options, originalFilename, 'tiff');
    const tempOutputPath = path.join(tempDir, `output.${tgt}`);
    fs.writeFileSync(tempOutputPath, converted.buffer);
    const persistedPath = preserveOutput(tempOutputPath, tgt, options, Buffer.isBuffer(input) ? undefined : input);
    return createConversionResult(persistedPath, tgt, baseName, 'native-raw', Date.now() - startTime);
  });
}

/** PostScript sources: only an interpreter can draw them, so the worker runs ps2pdf and then Poppler. */
const POSTSCRIPT_SOURCES: ReadonlySet<string> = new Set(['eps', 'ps']);
const POSTSCRIPT_DEFAULT_TIMEOUT_MS = 120_000;
const POSTSCRIPT_MAX_TIMEOUT_MS = 600_000;
const POSTSCRIPT_MEMORY_LIMIT_MB = 2048;
const POSTSCRIPT_MAX_OUTPUT_BYTES = 512 * 1024 * 1024;
const POSTSCRIPT_MAX_STDERR_CHARS = 300;
/** The interpreter runs in its safe mode: the file cannot read or write other files or start programs. */
const POSTSCRIPT_INTERPRETER_FLAGS: readonly string[] = ['-dSAFER'];
/** An EPS is a figure, not a page: the PDF page is cropped to its %%BoundingBox instead of the default paper size. */
const EPS_SOURCE = 'eps';
const EPS_CROP_FLAG = '-dEPSCrop';

/**
 * Renders PostScript (EPS, PS) with `ps2pdf` and, for targets other than PDF, hands the PDF to the native tools
 * every PDF source uses (Poppler images and SVG, the encoded rasters, pdftops and the DXF writer). Returns null when `ps2pdf` is missing and the caller did not
 * ask for an error; with `throwOnUnavailable` a missing interpreter is an EngineUnavailableError.
 */
export async function convertWithNativePostScript(
  input: Buffer | WorkerVfsPayload,
  sourceFormat: string,
  targetFormat: string,
  options: WorkerEngineOptions = {},
  originalFilename = 'file'
): Promise<WorkerConversionResult | null> {
  const src = validateFormat(sourceFormat);
  const tgt = validateFormat(targetFormat);
  if (!POSTSCRIPT_SOURCES.has(src)) return null;
  const interpreter = resolveBinary(BINARY_PATHS.ps2pdf, process.env.PS2PDF_PATH);
  if (!interpreter) {
    if (options.throwOnUnavailable) {
      throw new EngineUnavailableError('ps2pdf', 'ps2pdf (Ghostscript) is not installed or not in PATH');
    }
    return null;
  }
  const baseName = originalFilename ? originalFilename.replace(/\.[^/.]+$/, '') : 'converted';
  const startTime = Date.now();
  const timeout = Math.min(options.timeoutMs || POSTSCRIPT_DEFAULT_TIMEOUT_MS, POSTSCRIPT_MAX_TIMEOUT_MS);

  const pdf = await withSandboxDir('easyconvert-postscript-', async (tempDir) => {
    const { inputPath } = resolveInputContext(input, src, tempDir);
    const pdfPath = path.join(tempDir, 'rendered.pdf');
    try {
      const flags = src === EPS_SOURCE ? [...POSTSCRIPT_INTERPRETER_FLAGS, EPS_CROP_FLAG] : POSTSCRIPT_INTERPRETER_FLAGS;
      await executeSandboxedBinary(interpreter, [...flags, inputPath, pdfPath], {
        cwd: tempDir,
        timeoutMs: timeout,
        maxBuffer: options.maxBufferBytes || 100 * 1024 * 1024,
        maxFileSize: POSTSCRIPT_MAX_OUTPUT_BYTES,
        memoryLimitMb: POSTSCRIPT_MEMORY_LIMIT_MB,
        networkIsolated: true,
        signal: options.signal,
      });
    } catch (err) {
      if (err instanceof SandboxedBufferLimitError || err instanceof SandboxedMemoryLimitError) {
        throw new ConversionFailedError(`The PostScript interpreter exceeded its output or memory limit on the .${src} file.`);
      }
      if (err instanceof SandboxedProcessError) {
        const detail = err.stderr.trim().slice(0, POSTSCRIPT_MAX_STDERR_CHARS).replaceAll(tempDir, '<tmp>');
        throw new ConversionFailedError(`The PostScript interpreter rejected the .${src} file${detail ? `: ${detail}` : ''}`);
      }
      throw err;
    }
    if (!fs.existsSync(pdfPath) || fs.statSync(pdfPath).size === 0) {
      throw new ConversionFailedError(`The PostScript interpreter drew no page from the .${src} file.`);
    }
    return fs.readFileSync(pdfPath);
  });

  if (tgt === 'pdf') {
    return withSandboxDir('easyconvert-postscript-out-', async (tempDir) => {
      const outputPath = path.join(tempDir, 'output.pdf');
      fs.writeFileSync(outputPath, pdf);
      const persistedPath = preserveOutput(outputPath, 'pdf', options, Buffer.isBuffer(input) ? undefined : input);
      return createConversionResult(persistedPath, 'pdf', baseName, 'native-postscript', Date.now() - startTime);
    });
  }
  return convertPdfPagesWithNativeTools(pdf, tgt, options, originalFilename);
}

/**
 * Camera RAW formats LibRaw's distribution build cannot open and that are decoded in-process from the
 * real sensor data instead: Sigma X3F (Foveon) and Raspberry Pi frames (a JPEG followed by a "BRCM" Bayer dump).
 */
const IN_PROCESS_RAW_SENSOR_FORMATS: ReadonlySet<string> = new Set(['x3f', 'raw']);

/** Reads the whole input into memory, within the in-memory payload limit. */
function readRawInputBuffer(input: Buffer | WorkerVfsPayload): Buffer {
  if (Buffer.isBuffer(input)) return input;
  if (input.inputBuffer) return input.inputBuffer;
  if (input.inputPath && fs.existsSync(input.inputPath)) {
    const size = fs.statSync(input.inputPath).size;
    if (size > getMaxInMemoryBytes()) {
      throw new PayloadTooLargeForMemoryError(
        `Payload size (${size} bytes) exceeds in-memory buffer limit of ${getMaxInMemoryBytes()} bytes. Native worker required.`,
        { size, limit: getMaxInMemoryBytes() }
      );
    }
    return fs.readFileSync(input.inputPath);
  }
  throw new Error('Worker conversion received invalid input payload: neither inputPath nor inputBuffer provided');
}

/**
 * Decodes Sigma X3F and Raspberry Pi RAW frames in-process into 16-bit sRGB and encodes the requested
 * target from it. Returns null when the file is not one of those layouts (a `.raw` file without a
 * "BRCM" block belongs to the LibRaw engine), so the caller can route it elsewhere.
 */
export async function convertWithInProcessRawSensor(
  input: Buffer | WorkerVfsPayload,
  sourceFormat: string,
  targetFormat: string,
  options: WorkerEngineOptions = {},
  originalFilename = 'file'
): Promise<WorkerConversionResult | null> {
  const src = validateFormat(sourceFormat);
  const tgt = validateFormat(targetFormat);
  if (!IN_PROCESS_RAW_SENSOR_FORMATS.has(src) || RAW_PACKAGING_TARGETS.has(tgt)) return null;
  const file = readRawInputBuffer(input);
  const recognized = src === 'x3f' ? isX3f(file) : findBrcmTrailer(file) >= 0;
  if (!recognized) return null;

  const startTime = Date.now();
  const timeout = Math.min(options.timeoutMs || RAW_DECODE_DEFAULT_TIMEOUT_MS, RAW_DECODE_MAX_TIMEOUT_MS);
  const decoded = await decodeRawInThread(src as 'x3f' | 'raw', file, timeout, options.signal);
  const intermediate = encode16BitTiff(decoded.width, decoded.height, decoded.rgb16);
  const converted = await convertImage(intermediate, tgt, options, originalFilename, 'tiff');
  const baseName = originalFilename ? originalFilename.replace(/\.[^/.]+$/, '') : 'converted';
  return withSandboxDir('easyconvert-raw-', async (tempDir) => {
    const tempOutputPath = path.join(tempDir, `output.${tgt}`);
    fs.writeFileSync(tempOutputPath, converted.buffer);
    const persistedPath = preserveOutput(tempOutputPath, tgt, options, Buffer.isBuffer(input) ? undefined : input);
    return createConversionResult(persistedPath, tgt, baseName, 'in-process-raw', Date.now() - startTime);
  });
}

/**
 * Universal Worker Conversion Orchestrator.
 * Dispatches to native container engines first, with fail-closed security and pure TS fallback.
 */
const OFFICE_FORMATS = new Set(['docx', 'doc', 'pptx', 'ppt', 'xlsx', 'xls', 'odt', 'ods', 'odp', 'rtf']);
/**
 * Sources LibreOffice reads and renders: the Office formats plus PowerPoint templates, Keynote
 * presentations and OpenDocument drawings, none of which the in-process engine can render. Targets
 * are still limited to OFFICE_FORMATS, because LibreOffice cannot write the other formats.
 */
const OFFICE_NATIVE_SOURCES: ReadonlySet<string> = new Set([...OFFICE_FORMATS, 'potx', 'key', 'odg', 'odd']);
/** Formats LibreOffice also writes back out: a drawing template is saved again as a normalised template (.otg). */
const OFFICE_NATIVE_RESAVE_FORMATS: ReadonlySet<string> = new Set(['odd']);
/** A presentation LibreOffice can only read: its HTML is the text of the PDF it renders. */
const PRESENTATION_HTML_SOURCES: ReadonlySet<string> = new Set(['key']);
/** Sources only LibreOffice renders: an unreadable file is the client's, so it answers a typed 400 instead of an untyped failure. */
const DRAWING_SOURCES: ReadonlySet<string> = new Set(['odg', 'odd']);
const LIBREOFFICE_ONLY_SOURCES: ReadonlySet<string> = new Set(['odg', 'odd', 'key']);
const LIBREOFFICE_NO_OUTPUT_PATTERN = /^LibreOffice execution completed without producing expected output file/;
/** Sources whose load failure LibreOffice reports on stderr (an encrypted or damaged workbook) instead of writing nothing. */
const LIBREOFFICE_LOAD_FAILURE_SOURCES: ReadonlySet<string> = new Set(['xls']);
const LIBREOFFICE_LOAD_FAILURE_PATTERN = /source file could not be loaded/;

/** Proves, before LibreOffice starts, that a drawing is an OpenDocument drawing package (files too big to hold in memory go straight to LibreOffice). */
async function assertDrawingPackage(input: Buffer | WorkerVfsPayload, src: string): Promise<void> {
  if (!DRAWING_SOURCES.has(src)) return;
  let buffer: Buffer | undefined;
  if (Buffer.isBuffer(input)) buffer = input;
  else if (input.inputBuffer) buffer = input.inputBuffer;
  else if (input.inputPath && fs.existsSync(input.inputPath) && fs.statSync(input.inputPath).size <= getMaxInMemoryBytes()) {
    buffer = fs.readFileSync(input.inputPath);
  }
  if (buffer) await assertOpenDocumentGraphic(buffer, src);
}

/** LibreOffice ran and wrote nothing for a drawing or Keynote file: the file is damaged or not that kind of document (typed 400). */
function asUnreadableDocument(err: unknown, src: string): unknown {
  if (LIBREOFFICE_ONLY_SOURCES.has(src) && err instanceof Error && !(err instanceof ConversionFailedError) && LIBREOFFICE_NO_OUTPUT_PATTERN.test(err.message)) {
    return new ConversionFailedError(`LibreOffice could not read the .${src} file: it is damaged or not a valid ${src.toUpperCase()} document.`);
  }
  if (LIBREOFFICE_LOAD_FAILURE_SOURCES.has(src) && err instanceof SandboxedProcessError && LIBREOFFICE_LOAD_FAILURE_PATTERN.test(err.message)) {
    return new ConversionFailedError(`LibreOffice could not read the .${src} file: it is damaged, encrypted or not a valid ${src.toUpperCase()} document.`);
  }
  return err;
}
const HTML_TARGET = 'html';
const HTML_BODY_PATTERN = /<body[^>]*>([\s\S]*)<\/body>/i;
const HTML_TAG_PATTERN = /<[^>]*>/g;
const MEDIA_FORMATS = new Set(['mp4', 'mkv', 'avi', 'mov', 'webm', 'mp3', 'wav', 'aac', 'ogg', 'opus', 'flac', 'm4a', 'wma']);
/** Text sources rendered to PDF; CJK or complex-script text and all HTML prefer LibreOffice. */
const TEXT_PDF_SOURCES: ReadonlySet<string> = new Set(['txt', 'md', 'html', 'htm', 'hwp']);
/** Sources LibreOffice reads directly; their text is scanned in chunks, whatever the size. */
const STREAMED_TEXT_SOURCES: ReadonlySet<string> = new Set(['txt', 'html', 'htm']);
/** HTML always prefers LibreOffice, which keeps its full structure. */
const HTML_SOURCES: ReadonlySet<string> = new Set(['html', 'htm']);
const HTML_FORMAT = 'html';
const PLAIN_TEXT_SOURCE = 'txt';
const MARKDOWN_SOURCE = 'md';
const TEXT_SCAN_CHUNK_BYTES = 1024 * 1024;

/** CSS page sizes LibreOffice applies to staged HTML (the last @page rule wins). */
const PAGE_SIZE_CSS: Readonly<Record<'portrait' | 'landscape', string>> = {
  portrait: '210mm 297mm',
  landscape: '297mm 210mm',
};

type PageOrientation = 'portrait' | 'landscape';

interface TextPdfRoute {
  /** Text has Arabic, Hebrew, Indic or another complex script: LibreOffice lays it out first, the in-process shaper is the fallback. */
  readonly complexScript: boolean;
  /** LibreOffice renders this input first when installed. */
  readonly preferNative: boolean;
  /** Page orientation LibreOffice must apply, when one was requested. */
  readonly orientation?: PageOrientation;
  /** The checked HTML LibreOffice renders, rebuilt from the parsed input (absent when it reads the text file itself). */
  readonly stagedHtml?: Buffer;
}

/** Every distinct character of a text file, read and strictly decoded in chunks, whatever the size. */
function distinctCharactersOfFile(filePath: string): string {
  const seen = new Set<number>();
  const chunk = Buffer.alloc(TEXT_SCAN_CHUNK_BYTES);
  const fd = fs.openSync(filePath, 'r');
  try {
    let bytesRead = fs.readSync(fd, chunk, 0, chunk.length, null);
    const decode = createTextInputDecoder(chunk.subarray(0, bytesRead));
    while (bytesRead > 0) {
      for (const ch of decode(chunk.subarray(0, bytesRead))) seen.add(ch.codePointAt(0) as number);
      bytesRead = fs.readSync(fd, chunk, 0, chunk.length, null);
    }
    for (const ch of decode()) seen.add(ch.codePointAt(0) as number);
  } finally {
    fs.closeSync(fd);
  }
  let text = '';
  for (const codePoint of seen) text += String.fromCodePoint(codePoint);
  return text;
}

/** The text whose scripts decide the PDF route: the file's characters, or the HWP document text. */
function textForPdfRouting(input: Buffer | WorkerVfsPayload, src: string): string {
  if (src === 'hwp') {
    const hwp = parseHwpDocument(readRawInputBuffer(input));
    return [...hwp.paragraphs.map((p) => p.text), ...hwp.tables.flatMap((t) => t.rows.flat())].join('\n');
  }
  const filePath = !Buffer.isBuffer(input) && !input.inputBuffer ? input.inputPath : undefined;
  if (STREAMED_TEXT_SOURCES.has(src) && filePath && fs.existsSync(filePath)) {
    return distinctCharactersOfFile(filePath);
  }
  const raw = readRawInputBuffer(input);
  return decodeTextInput(raw);
}

/**
 * Decides how text and HTML go to PDF. Complex-script text prefers LibreOffice and is shaped in-process without it. HTML prefers it for
 * its full structure, and so do CJK Markdown and HWP; plain CJK text stays in-process when the
 * installed fonts cover it. With an explicit orientation, everything but complex-script text stays
 * in-process, which applies the orientation itself. Both engines draw with the installed fonts, so
 * CJK or complex-script letters no installed font covers fail first with EngineUnavailableError.
 */
async function planTextPdfRoute(
  input: Buffer | WorkerVfsPayload,
  src: string,
  tgt: string,
  originalFilename: string,
  orientation?: PageOrientation
): Promise<TextPdfRoute | null> {
  if (tgt !== 'pdf' || !TEXT_PDF_SOURCES.has(src)) return null;
  await loadFontCoverageIndex();
  const text = textForPdfRouting(input, src);
  const complexScript = hasComplexTextScript(text);
  const cjk = hasCjkScript(text);
  if (complexScript || cjk) {
    const scriptLetters = new Set<string>();
    for (const ch of text) {
      if (hasCjkScript(ch) || hasComplexTextScript(ch)) scriptLetters.add(ch);
    }
    assertFontCoverage(Array.from(scriptLetters).join(''));
  }
  const route = planTextPdfEngine(src, text, complexScript, cjk, orientation);
  if (!route.preferNative || (src === PLAIN_TEXT_SOURCE && !route.orientation)) return route;
  // Staged here, before LibreOffice is tried, so a refused reference is a 400 and never a fallback.
  return { ...route, stagedHtml: await stageTextPdfHtml(input, src, originalFilename, route.orientation) };
}

/**
 * The HTML LibreOffice renders for a text source, rebuilt from the parsed document so it reads
 * only what was checked: HTML as given, Markdown and HWP converted in-process (LibreOffice cannot
 * open them), and text as one paragraph per line. A requested orientation is a CSS page size.
 */
async function stageTextPdfHtml(
  input: Buffer | WorkerVfsPayload,
  src: string,
  originalFilename: string,
  orientation?: PageOrientation
): Promise<Buffer> {
  const raw = readRawInputBuffer(input);
  let html: string;
  if (HTML_SOURCES.has(src)) {
    html = decodeTextInput(raw);
  } else if (src === PLAIN_TEXT_SOURCE) {
    html = plainTextToHtml(decodeTextInput(raw));
  } else if (src === MARKDOWN_SOURCE) {
    html = markdownToSafeHtml(decodeTextInput(raw), originalFilename.replace(/\.[^/.]+$/, ''));
  } else {
    html = (await convertFile(raw, src, HTML_FORMAT, {}, originalFilename)).buffer.toString('utf-8');
  }
  // Appended last so it overrides any @page rule of the document.
  const pageSize = orientation ? `\n<style>@page { size: ${PAGE_SIZE_CSS[orientation]}; }</style>\n` : '';
  return Buffer.from((await stageHtmlForNativeEngine(html)) + pageSize, 'utf-8');
}

function planTextPdfEngine(
  src: string,
  text: string,
  complexScript: boolean,
  cjk: boolean,
  orientation?: PageOrientation
): TextPdfRoute {
  if (complexScript) return { complexScript, preferNative: true, orientation };
  if (orientation) return { complexScript, preferNative: false };
  if (HTML_SOURCES.has(src)) return { complexScript, preferNative: true };
  if (src === PLAIN_TEXT_SOURCE) return { complexScript, preferNative: cjk && findUncoveredCodePoint(text) !== null };
  return { complexScript, preferNative: cjk };
}

function escapeHtmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Plain text as an HTML document, one paragraph per line. */
function plainTextToHtml(text: string): string {
  const paragraphs = text.split(/\r\n?|\n/).map((line) => (line.trim() ? `<p>${escapeHtmlText(line)}</p>` : '<p><br></p>'));
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>\n${paragraphs.join('\n')}\n</body></html>\n`;
}

/**
 * Renders text or HTML to PDF with LibreOffice: the staged HTML when the route has one (HTML,
 * Markdown, HWP, or text with an orientation), otherwise the text file itself.
 */
async function convertTextPdfWithHeadlessOffice(
  input: Buffer | WorkerVfsPayload,
  src: string,
  options: WorkerEngineOptions,
  originalFilename: string,
  stagedHtml?: Buffer
): Promise<WorkerConversionResult | null> {
  if (!stagedHtml) {
    return convertWithHeadlessOffice(input, src, 'pdf', options, originalFilename);
  }
  if (!resolveBinary(BINARY_PATHS.soffice, process.env.SOFFICE_PATH)) {
    throw new EngineUnavailableError('soffice', 'LibreOffice binary is not installed or not in PATH');
  }
  const stagedInput: Buffer | WorkerVfsPayload = Buffer.isBuffer(input) ? stagedHtml : { inputBuffer: stagedHtml, outputPath: input.outputPath };
  return convertWithHeadlessOffice(stagedInput, HTML_FORMAT, 'pdf', options, originalFilename);
}

/** Whether text output holds any character other than whitespace (form feeds from empty pages count as blank). */
function hasNonWhitespaceText(buffer: Buffer): boolean {
  return buffer.toString('utf-8').trim().length > 0;
}

/** Deletes an engine's temporary output file unless it is the destination the caller asked for. */
function discardPersistedOutput(filePath: string | undefined, input: Buffer | WorkerVfsPayload, options: WorkerEngineOptions): void {
  if (!filePath) return;
  const requestedOutput = (Buffer.isBuffer(input) ? undefined : input.outputPath) || (options as { outputPath?: string }).outputPath;
  if (filePath === requestedOutput) return;
  fs.rmSync(filePath, { force: true });
}

export async function executeWorkerConversion(
  input: Buffer | WorkerVfsPayload,
  sourceFormat: string,
  targetFormat: string,
  options: WorkerEngineOptions = {},
  originalFilename = 'file'
): Promise<WorkerConversionResult> {
  assertConversionOptionsObject(options);
  const src = validateFormat(sourceFormat);
  const tgt = validateFormat(targetFormat);
  const startTime = Date.now();

  // Fail-closed verification against spoofed file extensions before any native engine execution
  assertNotSpoofedFileVfs(input, src, originalFilename);

  let fallbackReason: string | undefined;
  let lastUnavailable: EngineUnavailableError | undefined;
  const fallbackChain: string[] = [];
  const nativeOptions: WorkerEngineOptions = { ...options, throwOnUnavailable: true };
  const textPdfRoute = await planTextPdfRoute(input, src, tgt, originalFilename, options.orientation);
  const isNativeTextPdf = Boolean(textPdfRoute?.preferNative);
  const isRecalculate = Boolean(options.recalculate) && (src === 'xlsx' || src === 'xls' || src === 'ods');

  // 1. Native Headless Office
  await assertDrawingPackage(input, src);
  const isOfficeResave = src === tgt && OFFICE_NATIVE_RESAVE_FORMATS.has(src);
  if (isNativeTextPdf || isRecalculate || isOfficeResave || (OFFICE_NATIVE_SOURCES.has(src) && (tgt === 'pdf' || OFFICE_FORMATS.has(tgt)))) {
    try {
      const officeRes = isNativeTextPdf
        ? await convertTextPdfWithHeadlessOffice(input, src, nativeOptions, originalFilename, textPdfRoute?.stagedHtml)
        : await convertWithHeadlessOffice(input, src, tgt, nativeOptions, originalFilename);
      if (officeRes) {
        return {
          ...officeRes,
          fallbackChain: fallbackChain.length > 0 ? fallbackChain : undefined,
        };
      }
    } catch (err) {
      rethrowSandboxUnavailable(err);
      if (isNativeTextPdf && !options.signal?.aborted) {
        // Text and HTML: a LibreOffice that is missing, fails or times out never surfaces as an untyped error.
        const message = err instanceof Error ? err.message : String(err);
        if (options.pdfStandard) {
          throw new EngineUnavailableError('soffice', `Native LibreOffice engine is required for pdfStandard '${options.pdfStandard}': ${message}`);
        }
        fallbackChain.push(`native-soffice: ${message}`);
        fallbackReason = message;
        if (err instanceof EngineUnavailableError) lastUnavailable = err;
      } else if (err instanceof EngineUnavailableError) {
        if (isRecalculate) {
          throw new EngineUnavailableError(
            'soffice',
            `Spreadsheet formula recalculation requires native LibreOffice engine: ${err.message}`
          );
        }
        if (options.pdfStandard) {
          throw new EngineUnavailableError(
            'soffice',
            `Native LibreOffice engine is required for pdfStandard '${options.pdfStandard}': ${err.reason}`
          );
        }
        fallbackChain.push(`native-soffice: ${err.message}`);
        fallbackReason = err.message;
        lastUnavailable = err;
      } else {
        throw asUnreadableDocument(err, src);
      }
    }
  }

  // 1b. Office Documents -> pages via LibreOffice + native PDF tools: Poppler images and SVG, the encoded
  // rasters, PostScript and EPS, DXF; a presentation LibreOffice only reads also becomes HTML.
  const isPresentationHtml = PRESENTATION_HTML_SOURCES.has(src) && tgt === HTML_TARGET;
  if (OFFICE_NATIVE_SOURCES.has(src) && (isPdfChainTarget(tgt) || isPresentationHtml)) {
    let intermediatePdf: WorkerConversionResult | null = null;
    try {
      intermediatePdf = await convertWithHeadlessOffice(input, src, 'pdf', nativeOptions, originalFilename);
      if (intermediatePdf) {
        const popplerInput = intermediatePdf.filePath
          ? { inputPath: intermediatePdf.filePath }
          : intermediatePdf.buffer;
        const popplerRes = isPresentationHtml
          ? await convertPdfToHtml(intermediatePdf.buffer, nativeOptions, originalFilename, input, intermediatePdf.engineUsed)
          : await convertPdfPagesWithNativeTools(popplerInput, tgt, nativeOptions, originalFilename);
        if (popplerRes) {
          return {
            ...popplerRes,
            fallbackChain: fallbackChain.length > 0 ? fallbackChain : undefined,
          };
        }
      }
    } catch (err) {
      rethrowSandboxUnavailable(err);
      if (isPasswordHandlingUnavailable(err, options.password)) {
        throw err;
      }
      if (err instanceof EngineUnavailableError) {
        fallbackChain.push(`office-poppler-chain: ${err.message}`);
        fallbackReason = err.message;
        lastUnavailable = err;
      } else {
        throw asUnreadableDocument(err, src);
      }
    } finally {
      // The intermediate PDF is an implementation detail of this chain: never leave it on disk.
      discardPersistedOutput(intermediatePdf?.filePath, input, options);
    }
  }

  // 1c. In-process sensor decode for the camera files LibRaw cannot open (Sigma X3F, Raspberry Pi frames).
  if (IN_PROCESS_RAW_SENSOR_FORMATS.has(src) && !RAW_PACKAGING_TARGETS.has(tgt)) {
    try {
      const sensorRes = await convertWithInProcessRawSensor(input, src, tgt, nativeOptions, originalFilename);
      if (sensorRes) {
        return {
          ...sensorRes,
          fallbackChain: fallbackChain.length > 0 ? fallbackChain : undefined,
        };
      }
    } catch (err) {
      if (err instanceof RawDecodeError && err.unrecognized && options.allowEmbeddedPreview) {
        fallbackChain.push(`native-raw: ${err.message}`);
        fallbackReason = err.message;
      } else {
        throw err;
      }
    }
  }

  // 1c'. PostScript sources: ps2pdf, then the native PDF tools for every page target.
  if (POSTSCRIPT_SOURCES.has(src) && (tgt === 'pdf' || isPdfChainTarget(tgt))) {
    try {
      const psRes = await convertWithNativePostScript(input, src, tgt, nativeOptions, originalFilename);
      if (psRes) {
        return {
          ...psRes,
          fallbackChain: fallbackChain.length > 0 ? fallbackChain : undefined,
        };
      }
    } catch (err) {
      rethrowSandboxUnavailable(err);
      if (err instanceof EngineUnavailableError) {
        fallbackChain.push(`native-postscript: ${err.message}`);
        fallbackReason = err.message;
        lastUnavailable = err;
      } else {
        throw err;
      }
    }
  }

  // 1d. Native RAW sensor decode (LibRaw). Formats LibRaw does not recognize may still yield an
  // embedded preview in-process, but only when the request opted in.
  if (RAW_CAMERA_FORMATS.has(src) && !RAW_PACKAGING_TARGETS.has(tgt)) {
    try {
      const rawRes = await convertWithNativeRaw(input, src, tgt, nativeOptions, originalFilename);
      if (rawRes) {
        return {
          ...rawRes,
          fallbackChain: fallbackChain.length > 0 ? fallbackChain : undefined,
        };
      }
    } catch (err) {
      rethrowSandboxUnavailable(err);
      if (err instanceof EngineUnavailableError) {
        fallbackChain.push(`native-raw: ${err.message}`);
        fallbackReason = err.message;
        lastUnavailable = err;
      } else if (err instanceof RawDecodeError && err.unrecognized && options.allowEmbeddedPreview) {
        fallbackChain.push(`native-raw: ${err.message}`);
        fallbackReason = err.message;
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
      rethrowSandboxUnavailable(err);
      if (err instanceof EngineUnavailableError) {
        fallbackChain.push(`native-ffmpeg: ${err.message}`);
        fallbackReason = err.message;
        lastUnavailable = err;
      } else {
        throw err;
      }
    }
  }

  // 3. Native Poppler (PDF -> Image, SVG, or Text). OCR requests skip the text-layer route.
  const isPdfTextTarget = tgt === 'txt' || tgt === 'text';
  const skipPopplerForOcr = isPdfTextTarget && Boolean(options.ocrEnabled);
  if (src === 'pdf' && !skipPopplerForOcr && (POPPLER_IMAGE_FORMATS.has(tgt) || tgt === 'svg' || isPdfTextTarget)) {
    try {
      const popplerRes = await convertWithNativePoppler(input, src, tgt, nativeOptions, originalFilename);
      if (popplerRes && isPdfTextTarget && options.inProcessFallback !== false && !hasNonWhitespaceText(popplerRes.buffer)) {
        // No text layer: scanned pages need the in-process engine's OCR. Drop the empty output first.
        discardPersistedOutput(popplerRes.filePath, input, options);
        if (options.password) {
          // The in-process engine would receive the still-encrypted original and cannot honour the password.
          throw new UnsupportedOptionError(
            'OCR of a password-protected PDF is not supported: the PDF has no text layer and the in-process OCR engine cannot decrypt it.'
          );
        }
        fallbackChain.push('native-poppler: pdftotext found no text layer');
      } else if (popplerRes) {
        return {
          ...popplerRes,
          fallbackChain: fallbackChain.length > 0 ? fallbackChain : undefined,
        };
      }
    } catch (err) {
      rethrowSandboxUnavailable(err);
      if (isPasswordHandlingUnavailable(err, options.password)) {
        // Only qpdf can open the document; falling back would convert an unreadable file.
        throw err;
      }
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
      rethrowSandboxUnavailable(err);
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
  if (src === 'pdf' && options.password && lastUnavailable) {
    // The in-process engine ignores PDF passwords, so it must not run for a request a native engine could not serve.
    throw lastUnavailable;
  }
  if (options.pdfStandard) {
    throw new UnsupportedOptionError(
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
  let internalRes: ConversionResult;
  try {
    internalRes = await convertFile(inputBuffer, src, tgt, options, originalFilename);
  } catch (err) {
    // The in-process engine cannot decode this camera data, yet the native RAW engine could have.
    const nativeCouldDecode =
      err instanceof UnsupportedRawCompressionError ||
      err instanceof InvalidRawSensorError ||
      err instanceof RawEngineRequiredError;
    if (lastUnavailable && RAW_CAMERA_FORMATS.has(src) && nativeCouldDecode) {
      throw new EngineUnavailableError(lastUnavailable.engineName, `${lastUnavailable.reason} (${err.message})`);
    }
    throw err;
  }
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
      metadata: { ...internalRes.metadata, ...fallbackMetadata },
      fallbackReason,
      fallbackChain: fallbackChain.length > 0 ? fallbackChain : undefined,
    };
  }
  return {
    ...internalRes,
    engineUsed: 'internal-fallback',
    executionTimeMs: Date.now() - startTime,
    metadata: { ...internalRes.metadata, ...fallbackMetadata },
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
