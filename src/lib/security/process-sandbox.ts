import { spawn, execFileSync } from 'child_process';
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

export class SandboxedMemoryLimitError extends Error {
  public limitMb: number;

  constructor(limitMb: number) {
    super(`Process memory exceeded limit of ${limitMb}MB`);
    this.name = 'SandboxedMemoryLimitError';
    this.limitMb = limitMb;
  }
}

let cachedEnv: SandboxEnvironment | null = null;

export function resetSandboxEnvironmentCache(): void {
  cachedEnv = null;
}

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
    // Poison proxy variables to prevent network egress from standard tools (both uppercase and lowercase)
    sanitized.HTTP_PROXY = 'http://127.0.0.1:0';
    sanitized.HTTPS_PROXY = 'http://127.0.0.1:0';
    sanitized.ALL_PROXY = 'socks5://127.0.0.1:0';
    sanitized.http_proxy = 'http://127.0.0.1:0';
    sanitized.https_proxy = 'http://127.0.0.1:0';
    sanitized.all_proxy = 'socks5://127.0.0.1:0';
    sanitized.NO_PROXY = '';
    sanitized.no_proxy = '';
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
 * Reads resident set size (RSS) memory of a process in MB.
 */
export function getProcessRssMb(pid: number): number | null {
  try {
    if (process.platform === 'linux') {
      const statmPath = `/proc/${pid}/statm`;
      if (fs.existsSync(statmPath)) {
        const parts = fs.readFileSync(statmPath, 'utf-8').trim().split(/\s+/);
        const residentPages = parseInt(parts[1], 10);
        if (!isNaN(residentPages)) {
          return (residentPages * 4096) / (1024 * 1024);
        }
      }
    } else {
      const psBin = fs.existsSync('/bin/ps') ? '/bin/ps' : fs.existsSync('/usr/bin/ps') ? '/usr/bin/ps' : 'ps';
      const out = execFileSync(psBin, ['-o', 'rss=', '-p', String(pid)], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 1000,
        env: { PATH: '/bin:/usr/bin', NODE_ENV: process.env.NODE_ENV ?? 'production' } as NodeJS.ProcessEnv,
      }).trim();
      const rssKb = parseInt(out, 10);
      if (!isNaN(rssKb)) {
        return rssKb / 1024;
      }
    }
  } catch {}
  return null;
}

export interface UnshareCapability {
  available: boolean;
  path: string;
  args: string[];
  supportsNetNamespace: boolean;
}

let unshareCapability: UnshareCapability | null = null;

export function resetUnshareCapabilityCache(): void {
  unshareCapability = null;
}

/**
 * Probes the operating system to determine whether Linux unshare can actually create network namespaces.
 */
export function getUnshareCapability(): UnshareCapability {
  if (unshareCapability !== null) return unshareCapability;
  if (process.platform !== 'linux') {
    unshareCapability = { available: false, path: '', args: [], supportsNetNamespace: false };
    return unshareCapability;
  }

  const unsharePaths = ['/usr/bin/unshare', '/bin/unshare'];
  for (const p of unsharePaths) {
    if (fs.existsSync(p)) {
      // First probe -r -n (unprivileged user + net namespace)
      try {
        execFileSync(p, ['-r', '-n', '--', '/bin/true'], { stdio: 'ignore', timeout: 500 });
        unshareCapability = { available: true, path: p, args: ['-r', '-n'], supportsNetNamespace: true };
        return unshareCapability;
      } catch {}

      // Second probe -n (net namespace, requires CAP_SYS_ADMIN)
      try {
        execFileSync(p, ['-n', '--', '/bin/true'], { stdio: 'ignore', timeout: 500 });
        unshareCapability = { available: true, path: p, args: ['-n'], supportsNetNamespace: true };
        return unshareCapability;
      } catch {}
    }
  }

  unshareCapability = { available: false, path: '', args: [], supportsNetNamespace: false };
  return unshareCapability;
}

export interface UnshareIsolationOptions {
  userNamespace?: boolean;
  netNamespace?: boolean;
  mountNamespace?: boolean;
  ipcNamespace?: boolean;
  pidNamespace?: boolean;
}

/**
 * Assembles Linux unshare isolation CLI flags according to desired namespaces.
 */
export function buildUnshareIsolationArgs(
  cap: { available: boolean; path: string; args: string[] },
  options: UnshareIsolationOptions = {}
): string[] {
  const args = [...(cap.args || [])];
  if (options.userNamespace && !args.includes('-r')) {
    args.push('-r');
  }
  if (options.netNamespace && !args.includes('-n')) {
    args.push('-n');
  }
  if (options.mountNamespace && !args.includes('-m')) {
    args.push('-m');
  }
  if (options.ipcNamespace && !args.includes('-i')) {
    args.push('-i');
  }
  if (options.pidNamespace) {
    if (!args.includes('-p')) {
      args.push('-p');
    }
    if (!args.includes('--fork')) {
      args.push('--fork');
    }
  }
  return args;
}

export const DANGEROUS_SYSCALL_FILTER_LIST: string[] = [
  'ptrace',
  'bpf',
  'mount',
  'umount2',
  'reboot',
  'kexec_load',
  'kexec_file_load',
  'init_module',
  'finit_module',
  'delete_module',
  'iopl',
  'ioperm',
  'swapon',
  'swapoff',
  'sysfs',
  'settimeofday',
  'clock_settime',
  'adjtimex',
];

export interface SeccompBpfProfile {
  defaultAction: string;
  killAction: string;
  blockedSyscalls: string[];
}

/**
 * Generates a defensive Seccomp BPF syscall filter profile blocking privileged operations.
 */
export function generateSeccompBpfProfile(): SeccompBpfProfile {
  return {
    defaultAction: 'SCMP_ACT_ALLOW',
    killAction: 'SCMP_ACT_ERRNO',
    blockedSyscalls: [...DANGEROUS_SYSCALL_FILTER_LIST],
  };
}

/**
 * Resolves the final execution command, wrapping with unshare namespace isolation
 * when networkIsolated is requested and running on a supported Linux host with unshare capabilities.
 */
export function resolveSandboxedCommand(
  binaryPath: string,
  args: string[],
  networkIsolatedOrOptions?:
    | boolean
    | {
        networkIsolated?: boolean;
        sandboxOptions?: UnshareIsolationOptions;
      }
): { binary: string; args: string[]; wrapped: boolean } {
  let networkIsolated = true;
  let sandboxOptions: UnshareIsolationOptions = {};

  if (typeof networkIsolatedOrOptions === 'boolean') {
    networkIsolated = networkIsolatedOrOptions;
  } else if (networkIsolatedOrOptions && typeof networkIsolatedOrOptions === 'object') {
    networkIsolated = networkIsolatedOrOptions.networkIsolated ?? true;
    sandboxOptions = networkIsolatedOrOptions.sandboxOptions ?? {};
  }

  if (process.platform === 'linux' && networkIsolated) {
    const cap = getUnshareCapability();
    if (cap.available) {
      const isolationArgs = buildUnshareIsolationArgs(cap, sandboxOptions);
      return {
        binary: cap.path,
        args: [...isolationArgs, '--', binaryPath, ...args],
        wrapped: true,
      };
    }
  }
  return { binary: binaryPath, args, wrapped: false };
}

/**
 * Terminates a process group using negative PID signal delivery on POSIX systems,
 * or taskkill /T /F on Windows, preventing orphan/zombie child processes (e.g. soffice.bin).
 */
export function killProcessGroup(pid: number | undefined, signal: NodeJS.Signals = 'SIGKILL'): void {
  if (!pid || typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0) return;

  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
      return;
    } catch {
      try {
        process.kill(pid, signal);
      } catch {}
      return;
    }
  }

  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {}
  }
}

/**
 * Executes a binary under defensive process guards:
 * - Environment sanitization (credential purging)
 * - Strict stdio buffer threshold (default 50MB)
 * - Execution timeout enforcement (default 30s)
 * - Memory limit enforcement (optional memoryLimitMb)
 * - Network isolation guard (via unshare -n or proxy stripping)
 * - Process group detachment (detached: true) and whole process tree termination
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
    memoryLimitMb,
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
    let memoryExceeded = false;
    let memoryInterval: NodeJS.Timeout | null = null;

    const cleanup = () => {
      clearTimeout(timer);
      if (memoryInterval) {
        clearInterval(memoryInterval);
        memoryInterval = null;
      }
    };

    // Resolve unshare network namespace wrapper if available
    const resolvedCmd = resolveSandboxedCommand(binaryPath, args, networkIsolated);

    // Spawn directly without shell to prevent shell injection vulnerabilities.
    // Use detached: true so child becomes process group leader, preventing orphan leaks.
    const child = spawn(resolvedCmd.binary, resolvedCmd.args, {
      cwd,
      env: sanitizedEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      detached: true,
    });

    const timer = setTimeout(() => {
      if (bufferExceeded || memoryExceeded || timedOut) return;
      timedOut = true;
      cleanup();
      killProcessGroup(child.pid, 'SIGKILL');
      reject(new SandboxedTimeoutError(timeoutMs));
    }, timeoutMs);

    if (memoryLimitMb && memoryLimitMb > 0) {
      memoryInterval = setInterval(() => {
        if (!child.pid || timedOut || bufferExceeded || memoryExceeded) return;
        const rssMb = getProcessRssMb(child.pid);
        if (rssMb !== null && rssMb > memoryLimitMb) {
          memoryExceeded = true;
          cleanup();
          killProcessGroup(child.pid, 'SIGKILL');
          reject(new SandboxedMemoryLimitError(memoryLimitMb));
        }
      }, 50);
    }

    child.stdout.on('data', (chunk: Buffer) => {
      if (bufferExceeded || timedOut || memoryExceeded) return;
      currentBufferSize += chunk.length;
      if (currentBufferSize > maxBuffer) {
        bufferExceeded = true;
        cleanup();
        killProcessGroup(child.pid, 'SIGKILL');
        reject(new SandboxedBufferLimitError(maxBuffer));
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      if (bufferExceeded || timedOut || memoryExceeded) return;
      currentBufferSize += chunk.length;
      if (currentBufferSize > maxBuffer) {
        bufferExceeded = true;
        cleanup();
        killProcessGroup(child.pid, 'SIGKILL');
        reject(new SandboxedBufferLimitError(maxBuffer));
        return;
      }
      stderrChunks.push(chunk);
    });

    child.on('error', (err) => {
      cleanup();
      if (!timedOut && !bufferExceeded && !memoryExceeded) {
        reject(err);
      }
    });

    child.on('close', (code) => {
      cleanup();
      if (timedOut || bufferExceeded || memoryExceeded) return;

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
