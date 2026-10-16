import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  rethrowSandboxUnavailable,
  SandboxedBufferLimitError,
  SandboxedMemoryLimitError,
  SandboxedProcessError,
  SandboxedTimeoutError,
} from '../security/process-sandbox';
import { ConversionFailedError, EngineUnavailableError, PayloadLimitError } from '../types';

/**
 * Shared parts of the two command-line decoders that read the picture formats the image library has no loader for
 * (ImageMagick, OpenJPEG): finding the executable and turning a failed run into the typed error of the conversion.
 */

const STANDARD_TOOL_DIRECTORIES = ['/usr/bin', '/usr/local/bin', '/opt/homebrew/bin'] as const;
/** Exit statuses of a process that could not be started (not executable, not found). */
const NOT_EXECUTABLE_STATUS = 126;
const NOT_FOUND_STATUS = 127;
/** Characters of a tool's diagnostics written to the server log; they are never sent to clients. */
const LOGGED_DIAGNOSTIC_CHARS = 500;

/** True for the path of a regular file this process may execute. */
function isExecutableFile(candidate: string): boolean {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where the executable is installed, or null. A value of the environment variable `envName` is authoritative and must
 * be the absolute path of an executable file; otherwise the standard directories are searched for each name in turn.
 * The environment is read on every call.
 */
export function findDecoderTool(envName: string, names: readonly string[], env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  const override = env[envName];
  if (override !== undefined && override !== '') {
    return path.isAbsolute(override) && isExecutableFile(override) ? override : null;
  }
  for (const name of names) {
    const found = STANDARD_TOOL_DIRECTORIES.map((dir) => path.join(dir, name)).find(isExecutableFile);
    if (found !== undefined) return found;
  }
  return null;
}

/** The error of a conversion whose decoder is not installed (HTTP 503: another worker may have it). */
export function decoderUnavailable(tool: string, packageName: string): EngineUnavailableError {
  return new EngineUnavailableError(tool, `${tool} (${packageName}) is not installed or not in PATH`);
}

/** What the sandbox reports for a failed run, in the words of a conversion error; `label` names the format. */
export function describeDecoderFailure(err: unknown, tool: string, label: string, timeoutMs: number): Error {
  rethrowSandboxUnavailable(err);
  if (err instanceof SandboxedTimeoutError) {
    return new ConversionFailedError(`Cannot decode the ${label} picture (the decoder did not finish within ${timeoutMs} ms)`);
  }
  if (err instanceof SandboxedMemoryLimitError || err instanceof SandboxedBufferLimitError) {
    return new PayloadLimitError(`Cannot decode the ${label} picture: it needs more memory than decoding allows`);
  }
  if (err instanceof SandboxedProcessError) {
    if (err.exitCode === NOT_EXECUTABLE_STATUS || err.exitCode === NOT_FOUND_STATUS) {
      return new EngineUnavailableError(tool, 'the executable cannot be started');
    }
    console.warn(`[image-decode] ${tool} failed on a ${label} picture with status ${String(err.exitCode)}: ${err.stderr.replace(/\s+/g, ' ').trim().slice(0, LOGGED_DIAGNOSTIC_CHARS)}`);
    return new ConversionFailedError(`Invalid image: the ${label} picture could not be decoded`);
  }
  return err instanceof Error ? err : new Error(String(err));
}

/** Resident memory (MB) the sandbox allows one decoder run; it kills the process group above it. */
export const DECODER_MEMORY_LIMIT_MB = 3072;
/** A run that has not finished in this time is stuck, not slow. */
export const DECODER_TIMEOUT_MS = 120_000;
/** Diagnostics a decoder may print; more is runaway output. */
export const DECODER_MAX_DIAGNOSTIC_BYTES = 1024 * 1024;
/** Name of the file the picture is handed over as, and of the file the decoder writes, inside the private directory. */
export const DECODER_INPUT_NAME = 'in';
export const DECODER_OUTPUT_NAME = 'out';

const JOB_DIRECTORY_PREFIX = 'easyconvert-decode-';
const PRIVATE_FILE_MODE = 0o600;
const CLEANUP_RETRIES = 3;
const CLEANUP_RETRY_DELAY_MS = 50;

/**
 * Runs `task` with a private directory (mode 0700) that holds the picture as a file named `inputName`, and removes the
 * directory afterwards. A failure to remove it is logged and never replaces the result or the error of the run.
 */
export async function withDecoderJob<T>(input: Buffer, inputName: string, task: (jobDir: string) => Promise<T>): Promise<T> {
  let jobDir: string;
  try {
    jobDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), JOB_DIRECTORY_PREFIX));
  } catch {
    throw new ConversionFailedError('Cannot decode the picture (the decoder working directory could not be created)');
  }
  try {
    try {
      await fs.promises.writeFile(path.join(jobDir, inputName), input, { flag: 'wx', mode: PRIVATE_FILE_MODE });
    } catch {
      throw new ConversionFailedError('Cannot decode the picture (the picture could not be handed to the decoder)');
    }
    return await task(jobDir);
  } finally {
    await fs.promises.rm(jobDir, { recursive: true, force: true, maxRetries: CLEANUP_RETRIES, retryDelay: CLEANUP_RETRY_DELAY_MS }).catch((err: unknown) => {
      console.warn(`[image-decode] could not remove the decoder working directory ${jobDir}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}

/**
 * Reads the file a decoder wrote: a regular file (not a link) within `maxBytes`, opened without following a link. Where the
 * sandbox enforces its file-size limit a larger file was never written; where it does not (a developer's machine), this stops it.
 */
export async function readDecodedFile(filePath: string, maxBytes: number, label: string): Promise<Buffer> {
  const missing = new ConversionFailedError(`Invalid image: the ${label} picture could not be decoded`);
  const linkStat = await fs.promises.lstat(filePath).catch(() => null);
  if (linkStat === null || !linkStat.isFile()) throw missing;
  if (linkStat.size > maxBytes) throw new PayloadLimitError(`Cannot decode the ${label} picture: it needs more memory than decoding allows`);
  const handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW).catch(() => {
    throw missing;
  });
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
