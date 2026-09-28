import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export {
  executeSandboxedBinary,
  detectSandboxEnvironment,
  getSanitizedEnvironment,
  SandboxedProcessError,
  SandboxedTimeoutError,
  SandboxedBufferLimitError,
} from '../lib/security/process-sandbox';

export type {
  SandboxedExecutionOptions,
  SandboxedExecutionResult,
  SandboxEnvironment,
} from '../lib/security/process-sandbox';

import {
  executeSandboxedBinary,
  getSanitizedEnvironment,
  SandboxedExecutionOptions,
  SandboxedExecutionResult,
} from '../lib/security/process-sandbox';

export interface WorkerSandboxContext {
  sandboxDir: string;
  env: NodeJS.ProcessEnv;
  execute: (
    binaryPath: string,
    args: string[],
    options?: Omit<SandboxedExecutionOptions, 'cwd'>
  ) => Promise<SandboxedExecutionResult>;
}

export interface WorkerSandboxOptions {
  networkIsolated?: boolean;
  timeoutMs?: number;
  maxBuffer?: number;
  memoryLimitMb?: number;
  env?: Record<string, string>;
}

/**
 * Creates a dedicated ephemeral sandbox directory isolated with strict 0o700 permission mask.
 */
export function createWorkerSandboxDir(prefix: string = 'easyconvert_worker_sandbox_'): string {
  const dirName = `${prefix}${crypto.randomUUID()}`;
  const sandboxDir = path.join(os.tmpdir(), dirName);
  try {
    fs.mkdirSync(sandboxDir, { recursive: true, mode: 0o700 });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to create worker sandbox directory '${sandboxDir}': ${msg}`);
  }
  try {
    fs.chmodSync(sandboxDir, 0o700);
  } catch {
    // Filesystem may not support chmod (e.g. FAT/exFAT); mkdirSync mode already applied
  }
  return sandboxDir;
}

/**
 * Teardown helper for cleaning up the ephemeral worker sandbox directory.
 */
export function cleanupWorkerSandboxDir(sandboxDir: string): void {
  if (!sandboxDir || typeof sandboxDir !== 'string') return;
  try {
    if (fs.existsSync(sandboxDir)) {
      fs.rmSync(sandboxDir, { recursive: true, force: true });
    }
  } catch {
    // Ignore cleanup error defensively
  }
}

/**
 * Sanitizes and filters environment variables for worker execution.
 * Strips sensitive tokens/keys and overrides temporary directory paths to the ephemeral sandbox directory.
 */
export function sanitizeWorkerEnvironment(
  customEnv: Record<string, string> = {},
  sandboxDir?: string,
  networkIsolated: boolean = true
): NodeJS.ProcessEnv {
  const targetDir = sandboxDir || os.tmpdir();
  const base = getSanitizedEnvironment(customEnv, networkIsolated);

  base.TMPDIR = targetDir;
  base.TEMP = targetDir;
  base.TMP = targetDir;
  base.HOME = targetDir;

  return base;
}

/**
 * Executes a callback within a managed ephemeral sandbox with guaranteed teardown cleanup.
 */
export async function withWorkerSandbox<T>(
  callback: (context: WorkerSandboxContext) => Promise<T>,
  options: WorkerSandboxOptions = {}
): Promise<T> {
  const sandboxDir = createWorkerSandboxDir();
  const sanitizedEnv = sanitizeWorkerEnvironment(options.env, sandboxDir, options.networkIsolated ?? true);

  const context: WorkerSandboxContext = {
    sandboxDir,
    env: sanitizedEnv,
    execute: (binaryPath, args, execOpts = {}) => {
      return executeSandboxedBinary(binaryPath, args, {
        ...execOpts,
        cwd: sandboxDir,
        env: {
          TMPDIR: sandboxDir,
          TEMP: sandboxDir,
          TMP: sandboxDir,
          HOME: sandboxDir,
          ...options.env,
          ...execOpts.env,
        },
        networkIsolated: options.networkIsolated ?? true,
        timeoutMs: execOpts.timeoutMs ?? options.timeoutMs,
        maxBuffer: execOpts.maxBuffer ?? options.maxBuffer,
        memoryLimitMb: execOpts.memoryLimitMb ?? options.memoryLimitMb,
      });
    },
  };

  try {
    return await callback(context);
  } finally {
    cleanupWorkerSandboxDir(sandboxDir);
  }
}

/**
 * Worker-specific security sandbox orchestrator.
 * Enforces process-level containment, sanitized credentials, ephemeral 0o700 directory isolation,
 * and guaranteed teardown cleanup for native CLI execution.
 */
export async function runInWorkerSandbox(
  binaryPath: string,
  args: string[],
  options: SandboxedExecutionOptions & { isolateEphemeralDir?: boolean } = {}
): Promise<SandboxedExecutionResult> {
  const shouldIsolate = options.isolateEphemeralDir ?? true;

  if (shouldIsolate && !options.cwd) {
    return withWorkerSandbox(async (ctx) => {
      return ctx.execute(binaryPath, args, options);
    }, {
      networkIsolated: options.networkIsolated,
      timeoutMs: options.timeoutMs,
      maxBuffer: options.maxBuffer,
      memoryLimitMb: options.memoryLimitMb,
      env: options.env,
    });
  }

  return executeSandboxedBinary(binaryPath, args, {
    ...options,
    networkIsolated: options.networkIsolated ?? true,
    cwd: options.cwd,
  });
}

