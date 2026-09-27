import fs from 'fs';
import path from 'path';
import os from 'os';
import { ConversionOptions, ConversionResult } from '../lib/types';
import { convertFile } from '../lib/conversions';
import { executeSandboxedBinary } from '../lib/security/process-sandbox';

export interface WorkerEngineOptions extends ConversionOptions {
  timeoutMs?: number;
  maxBufferBytes?: number;
}

export interface WorkerConversionResult extends ConversionResult {
  engineUsed: 'native-soffice' | 'native-ffmpeg' | 'native-7z' | 'native-poppler' | 'internal-fallback';
  executionTimeMs: number;
}

// Fixed standard locations for native CLI binaries (hardened against injection)
const BINARY_PATHS: Record<string, string[]> = {
  soffice: ['/usr/bin/soffice', '/usr/local/bin/soffice', '/opt/homebrew/bin/soffice'],
  ffmpeg: ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg'],
  p7zip: ['/usr/bin/7z', '/usr/bin/7za', '/usr/local/bin/7z', '/opt/homebrew/bin/7z'],
  pdftoppm: ['/usr/bin/pdftoppm', '/usr/local/bin/pdftoppm', '/opt/homebrew/bin/pdftoppm'],
};

const SAFE_ALPHANUMERIC_REGEX = /^[a-zA-Z0-9]{1,16}$/;

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
} {
  return {
    soffice: resolveBinary(BINARY_PATHS.soffice) !== null,
    ffmpeg: resolveBinary(BINARY_PATHS.ffmpeg) !== null,
    p7zip: resolveBinary(BINARY_PATHS.p7zip) !== null,
    pdftoppm: resolveBinary(BINARY_PATHS.pdftoppm) !== null,
  };
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
 */
export async function convertWithHeadlessOffice(
  inputBuffer: Buffer,
  sourceFormat: string,
  targetFormat: string,
  options: WorkerEngineOptions = {}
): Promise<WorkerConversionResult | null> {
  const sofficeBin = resolveBinary(BINARY_PATHS.soffice);
  if (!sofficeBin) return null;

  const src = validateFormat(sourceFormat);
  const tgt = validateFormat(targetFormat);
  const startTime = Date.now();

  return withSandboxDir('easyconvert-office-', async (tempDir) => {
    const inputPath = path.join(tempDir, `input.${src}`);
    fs.writeFileSync(inputPath, inputBuffer);

    const timeout = Math.min(options.timeoutMs || 45000, 120000);
    const maxBuffer = Math.min(options.maxBufferBytes || 100 * 1024 * 1024, 500 * 1024 * 1024);

    await executeSandboxedBinary(
      sofficeBin,
      ['--headless', '--convert-to', tgt, '--outdir', tempDir, inputPath],
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
      filename: `converted.${tgt}`,
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
  options: WorkerEngineOptions = {}
): Promise<WorkerConversionResult | null> {
  const ffmpegBin = resolveBinary(BINARY_PATHS.ffmpeg);
  if (!ffmpegBin) return null;

  const src = validateFormat(sourceFormat);
  const tgt = validateFormat(targetFormat);
  const startTime = Date.now();

  return withSandboxDir('easyconvert-ffmpeg-', async (tempDir) => {
    const inputPath = path.join(tempDir, `input.${src}`);
    const outputPath = path.join(tempDir, `output.${tgt}`);
    fs.writeFileSync(inputPath, inputBuffer);

    const timeout = Math.min(options.timeoutMs || 60000, 180000);
    const maxBuffer = Math.min(options.maxBufferBytes || 200 * 1024 * 1024, 500 * 1024 * 1024);
    const args: string[] = ['-y', '-i', inputPath];

    if (options.audioBitrate && /^\d+k$/.test(options.audioBitrate)) {
      args.push('-b:a', options.audioBitrate);
    }
    if (typeof options.videoBitrate === 'number' && Number.isFinite(options.videoBitrate)) {
      args.push('-b:v', `${Math.floor(options.videoBitrate)}k`);
    }
    if (typeof options.audioSampleRate === 'number' && [8000, 11025, 16000, 22050, 32000, 44100, 48000, 96000].includes(options.audioSampleRate)) {
      args.push('-ar', String(options.audioSampleRate));
    }
    if (options.audioChannels) {
      const channelCount = options.audioChannels === 'mono' ? '1' : options.audioChannels === 'stereo' ? '2' : '6';
      args.push('-ac', channelCount);
    }

    args.push(outputPath);

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
      filename: `converted.${tgt}`,
      size: outputBuffer.length,
      engineUsed: 'native-ffmpeg',
      executionTimeMs: Date.now() - startTime,
    };
  });
}

/**
 * Universal Worker Conversion Orchestrator.
 * Dispatches to native container engines first, with fail-closed security and pure TS fallback.
 */
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

  const officeFormats = ['docx', 'doc', 'pptx', 'ppt', 'xlsx', 'xls', 'odt', 'ods', 'odp', 'rtf'];
  const mediaFormats = ['mp4', 'mkv', 'avi', 'mov', 'webm', 'mp3', 'wav', 'aac', 'ogg', 'opus', 'flac', 'm4a', 'wma'];

  // 1. Native Headless Office
  if (officeFormats.includes(src) && (tgt === 'pdf' || officeFormats.includes(tgt))) {
    const officeRes = await convertWithHeadlessOffice(inputBuffer, src, tgt, options);
    if (officeRes) return officeRes;
  }

  // 2. Native FFmpeg
  if (mediaFormats.includes(src) && mediaFormats.includes(tgt)) {
    const ffmpegRes = await convertWithNativeFfmpeg(inputBuffer, src, tgt, options);
    if (ffmpegRes) return ffmpegRes;
  }

  // 3. In-Repo Pure TS Fallback
  const internalRes = await convertFile(inputBuffer, src, tgt, options, originalFilename);
  return {
    ...internalRes,
    engineUsed: 'internal-fallback',
    executionTimeMs: Date.now() - startTime,
  };
}

function getMimeType(format: string): string {
  const map: Record<string, string> = {
    pdf: 'application/pdf',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    zip: 'application/zip',
    '7z': 'application/x-7z-compressed',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
  };
  return map[format.toLowerCase()] || 'application/octet-stream';
}
