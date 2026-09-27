import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

export interface SandboxEnvironment {
  isContainer: boolean;
  isGVisor: boolean;
  hasRunsc: boolean;
  sandboxType: 'gvisor' | 'container' | 'host';
  platform: string;
}

export interface SandboxedExecutionOptions {
  timeoutMs?: number;
  maxBuffer?: number;
  env?: Record<string, string>;
  cwd?: string;
  networkIsolated?: boolean;
  memoryLimitMb?: number;
}

export interface SandboxedExecutionResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
  durationMs: number;
  sandboxed: boolean;
  sandboxType: 'gvisor' | 'container' | 'host';
}

export class SandboxedProcessError extends Error {
  public exitCode: number;
  public stderr: string;

  constructor(message: string, exitCode: number, stderr: string) {
    super(message);
    this.name = 'SandboxedProcessError';
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export class SandboxedTimeoutError extends Error {
  public timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Process execution timed out after ${timeoutMs}ms`);
    this.name = 'SandboxedTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

export class SandboxedBufferLimitError extends Error {
  public limitBytes: number;

  constructor(limitBytes: number) {
    super(`Process output exceeded maximum buffer limit of ${limitBytes} bytes`);
    this.name = 'SandboxedBufferLimitError';
    this.limitBytes = limitBytes;
  }
}

let cachedEnv: SandboxEnvironment | null = null;

/**
 * Probes the runtime environment to detect container or gVisor (runsc) virtualization boundaries.
 */
export function detectSandboxEnvironment(): SandboxEnvironment {
  if (cachedEnv) return cachedEnv;

  const platform = os.platform();
  let isContainer = false;
  let isGVisor = false;
  let hasRunsc = false;

  // 1. Container detection via standard container indicators
  try {
    if (fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv')) {
      isContainer = true;
    }
  } catch {}

  if (!isContainer && platform === 'linux') {
    try {
      if (fs.existsSync('/proc/1/cgroup')) {
        const cgroups = fs.readFileSync('/proc/1/cgroup', 'utf-8');
        if (
          cgroups.includes('docker') ||
          cgroups.includes('kubepods') ||
          cgroups.includes('containerd') ||
          cgroups.includes('lxc')
        ) {
          isContainer = true;
        }
      }
    } catch {}
  }

  // 2. gVisor probe
  try {
    if (fs.existsSync('/dev/gvisor')) {
      isGVisor = true;
    } else if (platform === 'linux' && fs.existsSync('/proc/version')) {
      const ver = fs.readFileSync('/proc/version', 'utf-8');
      if (ver.toLowerCase().includes('gvisor')) {
        isGVisor = true;
      }
    }
  } catch {}

  // 3. runsc capability probe
  const knownRunscPaths = ['/usr/bin/runsc', '/usr/local/bin/runsc'];
  for (const p of knownRunscPaths) {
    try {
      if (fs.existsSync(p)) {
        hasRunsc = true;
        break;
      }
    } catch {}
  }

  const sandboxType: 'gvisor' | 'container' | 'host' = isGVisor
    ? 'gvisor'
    : isContainer
    ? 'container'
    : 'host';

  cachedEnv = {
    isContainer,
    isGVisor,
    hasRunsc,
    sandboxType,
    platform,
  };

  return cachedEnv;
}

/**
 * Sanitizes the process environment variables, stripping credentials, API keys, and sensitive tokens.
 */
export function getSanitizedEnvironment(customEnv: Record<string, string> = {}, networkIsolated = true): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {
    NODE_ENV: (process.env.NODE_ENV as 'development' | 'production' | 'test') || 'production',
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin',
    TMPDIR: os.tmpdir(),
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TZ: 'UTC',
    HOME: os.tmpdir(),
  };

  if (networkIsolated) {
    // Poison proxy variables to prevent network egress from standard tools
    sanitized.HTTP_PROXY = 'http://127.0.0.1:0';
    sanitized.HTTPS_PROXY = 'http://127.0.0.1:0';
    sanitized.ALL_PROXY = 'http://127.0.0.1:0';
    sanitized.NO_PROXY = '';
  }

  // Strip sensitive environment patterns
  const sensitiveRegex = /(TOKEN|SECRET|KEY|PASSWORD|AUTH|CREDENTIAL|PRIVATE|DATABASE_URL|REDIS_URL|AWS_)/i;

  for (const [k, v] of Object.entries(customEnv)) {
    if (!sensitiveRegex.test(k) && typeof v === 'string') {
      sanitized[k] = v;
    }
  }

  return sanitized;
}

/**
 * Executes a binary under defensive process guards:
 * - Environment sanitization (credential purging)
 * - Strict stdio buffer threshold (default 50MB)
 * - Execution timeout enforcement (default 30s)
 * - Network isolation guard
 * - Non-zero exit code error handling
 */
export async function executeSandboxedBinary(
  binaryPath: string,
  args: string[],
  options: SandboxedExecutionOptions = {}
): Promise<SandboxedExecutionResult> {
  const {
    timeoutMs = 30000,
    maxBuffer = 50 * 1024 * 1024, // 50MB
    env: customEnv = {},
    cwd = os.tmpdir(),
    networkIsolated = true,
  } = options;

  if (!binaryPath || typeof binaryPath !== 'string') {
    throw new Error('Sandboxed execution error: invalid binary path provided.');
  }

  const sandboxEnv = detectSandboxEnvironment();
  const sanitizedEnv = getSanitizedEnvironment(customEnv, networkIsolated);
  const startTime = Date.now();

  return new Promise((resolve, reject) => {
    let stdoutChunks: Buffer[] = [];
    let stderrChunks: Buffer[] = [];
    let currentBufferSize = 0;
    let timedOut = false;
    let bufferExceeded = false;

    // Spawn directly without shell to prevent shell injection vulnerabilities
    const child = spawn(binaryPath, args, {
      cwd,
      env: sanitizedEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {}
      reject(new SandboxedTimeoutError(timeoutMs));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      currentBufferSize += chunk.length;
      if (currentBufferSize > maxBuffer) {
        bufferExceeded = true;
        clearTimeout(timer);
        try {
          child.kill('SIGKILL');
        } catch {}
        reject(new SandboxedBufferLimitError(maxBuffer));
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      currentBufferSize += chunk.length;
      if (currentBufferSize > maxBuffer) {
        bufferExceeded = true;
        clearTimeout(timer);
        try {
          child.kill('SIGKILL');
        } catch {}
        reject(new SandboxedBufferLimitError(maxBuffer));
        return;
      }
      stderrChunks.push(chunk);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      if (!timedOut && !bufferExceeded) {
        reject(err);
      }
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut || bufferExceeded) return;

      const durationMs = Date.now() - startTime;
      const stdout = Buffer.concat(stdoutChunks);
      const stderr = Buffer.concat(stderrChunks);

      if (code !== 0 && code !== null) {
        const errorSummary = stderr.toString('utf-8').trim() || `Process exited with code ${code}`;
        reject(new SandboxedProcessError(errorSummary, code, stderr.toString('utf-8')));
        return;
      }

      resolve({
        stdout,
        stderr,
        exitCode: code ?? 0,
        durationMs,
        sandboxed: sandboxEnv.sandboxType !== 'host',
        sandboxType: sandboxEnv.sandboxType,
      });
    });
  });
}
