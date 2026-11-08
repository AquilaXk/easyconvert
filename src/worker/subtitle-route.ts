import fs from 'node:fs';
import path from 'node:path';
import { stageTimeoutMs } from '../lib/conversions/job-time';
import { withConversionWarnings } from '../lib/conversions/conversion-warnings';
import { openMediaInput, mediaInputArgs, runFfmpeg } from '../lib/conversions/media-process';
import { MAX_SUBTITLE_BYTES, isSubtitlePair, prepareSubtitleInput, repairSubtitleOutput, subtitleFfmpegArguments } from '../lib/conversions/subtitle';

import { countSubtitleCues, isSubtitleFormat } from '../lib/subtitle-structure';
import { EngineUnavailableError, InvalidConversionOutputError, InvalidSubtitleInputError, PayloadLimitError } from '../lib/types';
import { rethrowSandboxUnavailable, SandboxedProcessError } from './sandbox';
import { createConversionResult, handOffOutput, readRawInputBuffer, withSandboxDir } from './worker-output';
import type { WorkerConversionResult, WorkerEngineOptions, WorkerVfsPayload } from './worker-types';

export { isSubtitlePair };

/**
 * The subtitle conversions (docs/policy-decisions.md, entry 188): SubRip, WebVTT, ASS, SSA and MicroDVD read by FFmpeg, and
 * SubRip, WebVTT and ASS written by it, in the sandbox of the media path (no network, the demuxer of the format fixed with
 * `-f`, only local files). The file is checked and turned into UTF-8 first (`prepareSubtitleInput`), so FFmpeg never meets a
 * binary file, a legacy code page or a file of another subtitle format. A worker without FFmpeg answers with an unavailable
 * engine: there is no other writer of these formats.
 */

const TEMP_PREFIX = 'easyconvert-subtitle-';
/** A subtitle file of the largest size takes FFmpeg well under a second; the limit only stops a runaway process. */
const DEFAULT_TIMEOUT_MS = 60_000;
/** FFmpeg prints a line per problem at the `error` level; the output is a file. */
const MAX_STDERR_BYTES = 1024 * 1024;
const MAX_STDERR_CHARS = 300;

export interface SubtitleRequest {
  input: Buffer | WorkerVfsPayload;
  src: string;
  tgt: string;
  options: WorkerEngineOptions;
  originalFilename: string;
}

/** The size of the input on disk, so that a file over the limit is refused before it is read. */
function assertInputSizeWithinLimit(input: Buffer | WorkerVfsPayload, src: string): void {
  if (Buffer.isBuffer(input) || input.inputPath === undefined || !fs.existsSync(input.inputPath)) return;
  const size = fs.statSync(input.inputPath).size;
  if (size > MAX_SUBTITLE_BYTES) throw new PayloadLimitError(`A .${src} subtitle file is at most ${MAX_SUBTITLE_BYTES} bytes; this one has ${size}.`);
}

/** FFmpeg's complaint about a file it could not read, in one line. */
function readerFailure(error: SandboxedProcessError, src: string): InvalidSubtitleInputError {
  const detail = error.stderr.trim().split('\n').find((line) => line.trim() !== '') ?? 'it could not be read';
  return new InvalidSubtitleInputError('wrong-structure', `The .${src} subtitle file could not be read: ${detail.slice(0, MAX_STDERR_CHARS)}`);
}

async function runSubtitleFfmpeg(ffmpegBin: string, args: string[], tempDir: string, request: SubtitleRequest): Promise<void> {
  try {
    await runFfmpeg(ffmpegBin, args, {
      cwd: tempDir,
      timeoutMs: stageTimeoutMs(request.options, DEFAULT_TIMEOUT_MS),
      maxBuffer: MAX_STDERR_BYTES,
      signal: request.options.signal,
    });
  } catch (error) {
    rethrowSandboxUnavailable(error);
    if (error instanceof SandboxedProcessError && error.exitCode !== null && error.signal === null) throw readerFailure(error, request.src);
    throw error;
  }
}

/** Repairs the file FFmpeg wrote (see `repairSubtitleOutput`) and throws unless it holds at least one cue of the target format. */
function finishSubtitleOutput(outputPath: string, request: SubtitleRequest): void {
  if (!isSubtitleFormat(request.tgt)) throw new InvalidConversionOutputError(request.src, request.tgt);
  const written = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '';
  if (countSubtitleCues(request.tgt, written) === 0) throw new InvalidConversionOutputError(request.src, request.tgt);
  const repaired = repairSubtitleOutput(written, request.tgt, request.src);
  if (repaired !== written) fs.writeFileSync(outputPath, repaired);
}

/**
 * Converts one subtitle file. The pairs are those of `isSubtitlePair`. The first bytes must open like the declared source
 * (`assertNotSpoofed`, the worker's upload guard), and the whole file is checked here before FFmpeg reads it.
 */
export async function convertSubtitle(
  request: SubtitleRequest,
  ffmpegBin: string | null,
  assertNotSpoofed: (input: Buffer | WorkerVfsPayload, declaredFormat: string, filename: string) => void
): Promise<WorkerConversionResult> {
  if (ffmpegBin === null) {
    throw new EngineUnavailableError('ffmpeg', `Converting .${request.src} subtitles to .${request.tgt} needs FFmpeg, which is not installed or not in PATH`);
  }
  const { input, src, tgt, options, originalFilename } = request;
  const startTime = Date.now();
  const baseName = originalFilename ? originalFilename.replace(/\.[^/.]+$/, '') : 'converted';
  assertNotSpoofed(input, src, originalFilename);
  assertInputSizeWithinLimit(input, src);
  return await withConversionWarnings(() =>
    withSandboxDir(TEMP_PREFIX, async (tempDir) => {
      if (!isSubtitleFormat(src)) throw new InvalidSubtitleInputError('wrong-structure', `.${src} is not a subtitle format.`);
      const prepared = prepareSubtitleInput(readRawInputBuffer(input), src);
      const inputPath = path.join(tempDir, `input.${src}`);
      fs.writeFileSync(inputPath, prepared.utf8);
      const outputPath = path.join(tempDir, `output.${tgt}`);
      options.signal?.throwIfAborted();
      await runSubtitleFfmpeg(ffmpegBin, subtitleFfmpegArguments(mediaInputArgs(openMediaInput(inputPath, src)), outputPath, tgt), tempDir, request);
      finishSubtitleOutput(outputPath, request);
      const vfsPayload = Buffer.isBuffer(input) ? undefined : input;
      const persistedPath = await handOffOutput(outputPath, tgt, options, vfsPayload);
      return createConversionResult(persistedPath, tgt, baseName, 'native-ffmpeg', Date.now() - startTime);
    })
  );
}
