import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream';

export interface SandboxEnvironment {
  isContainer: boolean;
  isGVisor: boolean;
  hasRunsc: boolean;
  sandboxType: 'gvisor' | 'container' | 'host';
  platform: string;
}

export interface SandboxedRlimitsOptions {
  asBytes?: number;
  fsizeBytes?: number;
  nproc?: number;
  cpuSeconds?: number;
}

export interface SandboxedExecutionOptions {
  timeoutMs?: number;
  maxBuffer?: number;
  env?: Record<string, string>;
  cwd?: string;
  networkIsolated?: boolean;
  strictIsolation?: boolean;
  sandboxOptions?: UnshareIsolationOptions;
  memoryLimitMb?: number;
  maxFileSize?: number;
  rlimits?: SandboxedRlimitsOptions;
  stdin?: NodeJS.ReadableStream | Buffer | null;
  signal?: AbortSignal;
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
  public exitCode: number | null;
  public stderr: string;
  public signal: NodeJS.Signals | null;
  /** What the process printed before it failed; some tools print a report and exit non-zero. */
  public stdout: string;

  constructor(
    message: string,
    exitCode: number | null,
    stderr: string,
    signal: NodeJS.Signals | null = null,
    stdout = ''
  ) {
    super(message);
    this.name = 'SandboxedProcessError';
    this.exitCode = exitCode;
    this.stderr = stderr;
    this.signal = signal;
    this.stdout = stdout;
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

export interface PrlimitCapability {
  available: boolean;
  path: string;
}

let prlimitCapability: PrlimitCapability | null = null;

export function resetPrlimitCapabilityCache(): void {
  prlimitCapability = null;
}

/**
 * Probes the operating system to determine whether Linux prlimit is available for per-child resource confinement.
 */
export function getPrlimitCapability(): PrlimitCapability {
  if (prlimitCapability !== null) return prlimitCapability;
  if (process.platform !== 'linux') {
    prlimitCapability = { available: false, path: '' };
    return prlimitCapability;
  }

  const knownPaths = ['/usr/bin/prlimit', '/bin/prlimit'];
  for (const p of knownPaths) {
    try {
      if (fs.existsSync(p)) {
        prlimitCapability = { available: true, path: p };
        return prlimitCapability;
      }
    } catch {}
  }

  prlimitCapability = { available: false, path: '' };
  return prlimitCapability;
}

/**
 * Assembles Linux prlimit CLI arguments from requested resource limits.
 */
export function buildPrlimitArgs(
  _cap: PrlimitCapability,
  rlimits: SandboxedRlimitsOptions
): string[] {
  const args: string[] = [];
  if (rlimits.asBytes && Number.isFinite(rlimits.asBytes) && rlimits.asBytes > 0) {
    args.push(`--as=${Math.round(rlimits.asBytes)}`);
  }
  if (rlimits.fsizeBytes && Number.isFinite(rlimits.fsizeBytes) && rlimits.fsizeBytes > 0) {
    args.push(`--fsize=${Math.round(rlimits.fsizeBytes)}`);
  }
  if (rlimits.nproc && Number.isFinite(rlimits.nproc) && rlimits.nproc > 0) {
    args.push(`--nproc=${Math.round(rlimits.nproc)}`);
  }
  if (rlimits.cpuSeconds && Number.isFinite(rlimits.cpuSeconds) && rlimits.cpuSeconds > 0) {
    args.push(`--cpu=${Math.round(rlimits.cpuSeconds)}`);
  }
  return args;
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

export const NETWORK_SYSCALL_FILTER_LIST: string[] = [
  'socket',
  'socketpair',
  'connect',
  'bind',
  'listen',
  'accept',
  'accept4',
  'sendto',
  'recvfrom',
  'sendmsg',
  'recvmsg',
  'sendmmsg',
  'recvmmsg',
  'shutdown',
];

export interface SeccompBpfProfile {
  defaultAction: string;
  killAction: string;
  blockedSyscalls: string[];
}

/**
 * Generates a defensive Seccomp BPF syscall filter profile blocking privileged operations and optional network syscalls.
 */
export function generateSeccompBpfProfile(options?: { blockNetwork?: boolean }): SeccompBpfProfile {
  const blocked = [...DANGEROUS_SYSCALL_FILTER_LIST];
  if (options?.blockNetwork) {
    blocked.push(...NETWORK_SYSCALL_FILTER_LIST);
  }
  return {
    defaultAction: 'SCMP_ACT_ALLOW',
    killAction: 'SCMP_ACT_ERRNO',
    blockedSyscalls: blocked,
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
        strictIsolation?: boolean;
        memoryLimitMb?: number;
        maxFileSize?: number;
        rlimits?: SandboxedRlimitsOptions;
      }
): { binary: string; args: string[]; wrapped: boolean } {
  let networkIsolated = true;
  let sandboxOptions: UnshareIsolationOptions = {};
  let strictIsolation = process.env.STRICT_SANDBOX === 'true';
  let memoryLimitMb: number | undefined;
  let maxFileSize: number | undefined;
  let rlimits: SandboxedRlimitsOptions | undefined;

  if (typeof networkIsolatedOrOptions === 'boolean') {
    networkIsolated = networkIsolatedOrOptions;
  } else if (networkIsolatedOrOptions && typeof networkIsolatedOrOptions === 'object') {
    networkIsolated = networkIsolatedOrOptions.networkIsolated ?? true;
    sandboxOptions = networkIsolatedOrOptions.sandboxOptions ?? {};
    if (networkIsolatedOrOptions.strictIsolation !== undefined) {
      strictIsolation = networkIsolatedOrOptions.strictIsolation;
    }
    memoryLimitMb = networkIsolatedOrOptions.memoryLimitMb;
    maxFileSize = networkIsolatedOrOptions.maxFileSize;
    rlimits = networkIsolatedOrOptions.rlimits;
  }

  // Construct effective rlimits from explicit options or memoryLimitMb / maxFileSize
  const effectiveRlimits: SandboxedRlimitsOptions = {
    ...(rlimits || {}),
  };
  if (!effectiveRlimits.asBytes && memoryLimitMb && memoryLimitMb > 0) {
    effectiveRlimits.asBytes = memoryLimitMb * 1024 * 1024;
  }
  if (!effectiveRlimits.fsizeBytes && maxFileSize && maxFileSize > 0) {
    effectiveRlimits.fsizeBytes = maxFileSize;
  }

  let finalBinary = binaryPath;
  let finalArgs = [...args];
  let isWrapped = false;

  // Apply prlimit wrapping if available on Linux and rlimits are specified
  const capPrlimit = getPrlimitCapability();
  const hasRlimits =
    effectiveRlimits.asBytes !== undefined ||
    effectiveRlimits.fsizeBytes !== undefined ||
    effectiveRlimits.nproc !== undefined ||
    effectiveRlimits.cpuSeconds !== undefined;

  if (process.platform === 'linux' && capPrlimit.available && hasRlimits) {
    const prlimitArgs = buildPrlimitArgs(capPrlimit, effectiveRlimits);
    if (prlimitArgs.length > 0) {
      finalArgs = [...prlimitArgs, '--', finalBinary, ...finalArgs];
      finalBinary = capPrlimit.path;
      isWrapped = true;
    }
  }

  if (process.platform === 'linux' && networkIsolated) {
    const cap = getUnshareCapability();
    if (cap.available) {
      const isolationArgs = buildUnshareIsolationArgs(cap, sandboxOptions);
      return {
        binary: cap.path,
        args: [...isolationArgs, '--', finalBinary, ...finalArgs],
        wrapped: true,
      };
    } else if (strictIsolation) {
      throw new SandboxedProcessError(
        'Strict network isolation failed: Linux unshare capability is unavailable',
        126,
        'EPERM: unshare namespace isolation unavailable'
      );
    }
  } else if (strictIsolation && networkIsolated && process.platform !== 'linux') {
    throw new SandboxedProcessError(
      `Strict network isolation failed: OS platform "${process.platform}" does not support Linux network namespaces`,
      126,
      'ENOSYS: unshare unsupported on platform'
    );
  }

  return { binary: finalBinary, args: finalArgs, wrapped: isWrapped };
}

/**
 * Terminates a process group using negative PID signal delivery on POSIX systems,
 * falling back to single-process termination. Prevents orphan/zombie child processes (e.g. soffice.bin).
 */
export function killProcessGroup(pid: number | undefined, signal: NodeJS.Signals = 'SIGKILL'): void {
  if (!pid || typeof pid !== 'number' || pid <= 0) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {}
  }
}

/** Exit statuses a shell gives a command it cannot execute or cannot find. */
const SPAWN_NOT_EXECUTABLE_STATUS = 126;
const SPAWN_NOT_FOUND_STATUS = 127;

/**
 * A process that could not be started fails the same way whether or not a confinement wrapper ran
 * it: as a SandboxedProcessError carrying the shell's status, so callers see one typed error.
 */
function spawnFailureError(err: Error): Error {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') {
    return new SandboxedProcessError(`Sandboxed execution error: ${err.message}`, SPAWN_NOT_FOUND_STATUS, err.message);
  }
  if (code === 'EACCES' || code === 'ENOEXEC') {
    return new SandboxedProcessError(`Sandboxed execution error: ${err.message}`, SPAWN_NOT_EXECUTABLE_STATUS, err.message);
  }
  return err;
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
    maxFileSize,
    rlimits,
    env: customEnv = {},
    cwd = os.tmpdir(),
    networkIsolated = true,
    stdin,
  } = options;

  if (!binaryPath || typeof binaryPath !== 'string') {
    throw new SandboxedProcessError('Sandboxed execution error: invalid binary path provided.', null, '');
  }

  const sandboxEnv = detectSandboxEnvironment();
  const sanitizedEnv = getSanitizedEnvironment(customEnv, networkIsolated);
  const startTime = Date.now();

  return new Promise((resolve, reject) => {
    let stdoutChunks: Buffer[] = [];
    let stderrChunks: Buffer[] = [];
    let currentBufferSize = 0;
    let timer: NodeJS.Timeout | null = null;
    let memoryInterval: NodeJS.Timeout | null = null;
    let isSettled = false;
    let activeChild: ReturnType<typeof spawn> | null = null;
    let abortListener: (() => void) | null = null;

    if (options.signal?.aborted) {
      reject(options.signal.reason || new Error('The operation was aborted'));
      return;
    }

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (memoryInterval) {
        clearInterval(memoryInterval);
        memoryInterval = null;
      }
      if (options.signal && abortListener) {
        options.signal.removeEventListener('abort', abortListener);
        abortListener = null;
      }
      if (stdin && typeof (stdin as any).destroy === 'function' && !(stdin as any).destroyed) {
        try {
          (stdin as any).destroy();
        } catch {}
      }
      if (activeChild && activeChild.stdin && !activeChild.stdin.destroyed) {
        try {
          activeChild.stdin.destroy();
        } catch {}
      }
    };

    const settle = (action: () => void) => {
      if (isSettled) return;
      isSettled = true;
      cleanup();
      action();
    };

    // Resolve unshare network namespace and prlimit wrapper if requested and available
    const resolvedCmd = resolveSandboxedCommand(binaryPath, args, {
      networkIsolated,
      sandboxOptions: options.sandboxOptions,
      strictIsolation: options.strictIsolation,
      memoryLimitMb,
      maxFileSize,
      rlimits,
    });

    // Spawn directly without shell to prevent shell injection vulnerabilities.
    // Use detached: true so child becomes process group leader, preventing orphan leaks.
    const proc = spawn(resolvedCmd.binary, resolvedCmd.args, {
      cwd,
      env: sanitizedEnv,
      stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      shell: false,
      detached: true,
    });
    activeChild = proc;

    if (options.signal) {
      abortListener = () => {
        settle(() => {
          killProcessGroup(proc.pid, 'SIGKILL');
          try {
            proc.kill('SIGKILL');
          } catch {}
          reject(options.signal!.reason || new Error('The operation was aborted'));
        });
      };
      options.signal.addEventListener('abort', abortListener, { once: true });
      if (options.signal.aborted) {
        abortListener();
        return;
      }
    }

    if (stdin && proc.stdin) {
      proc.stdin.on('error', (err: any) => {
        // EPIPE or ECONNRESET can occur if child closes stdin before stream is exhausted.
        if (err.code === 'EPIPE' || err.code === 'ECONNRESET') {
          return;
        }
      });

      if (Buffer.isBuffer(stdin)) {
        proc.stdin.end(stdin);
      } else {
        pipeline(stdin, proc.stdin, (err) => {
          if (err) {
            const code = (err as any).code;
            if (code !== 'EPIPE' && code !== 'ERR_STREAM_PREMATURE_CLOSE' && code !== 'ECONNRESET') {
              settle(() => {
                killProcessGroup(proc.pid, 'SIGKILL');
                try {
                  proc.kill('SIGKILL');
                } catch {}
                reject(err);
              });
            }
          }
        });
      }
    }

    timer = setTimeout(() => {
      settle(() => {
        killProcessGroup(proc.pid, 'SIGKILL');
        try {
          proc.kill('SIGKILL');
        } catch {}
        reject(new SandboxedTimeoutError(timeoutMs));
      });
    }, timeoutMs);

    const effectiveMemoryLimitMb =
      memoryLimitMb ||
      (options.rlimits?.asBytes && Number.isFinite(options.rlimits.asBytes) && options.rlimits.asBytes > 0
        ? Math.round(options.rlimits.asBytes / (1024 * 1024))
        : undefined);

    if (effectiveMemoryLimitMb && effectiveMemoryLimitMb > 0) {
      memoryInterval = setInterval(() => {
        if (!proc.pid || isSettled) return;
        const rssMb = getProcessRssMb(proc.pid);
        if (rssMb !== null && rssMb > effectiveMemoryLimitMb) {
          settle(() => {
            killProcessGroup(proc.pid, 'SIGKILL');
            try {
              proc.kill('SIGKILL');
            } catch {}
            reject(new SandboxedMemoryLimitError(effectiveMemoryLimitMb));
          });
        }
      }, 50);
    }

    if (proc.stdout) {
      proc.stdout.on('data', (chunk: Buffer) => {
        if (isSettled) return;
        currentBufferSize += chunk.length;
        if (currentBufferSize > maxBuffer) {
          settle(() => {
            killProcessGroup(proc.pid, 'SIGKILL');
            try {
              proc.kill('SIGKILL');
            } catch {}
            reject(new SandboxedBufferLimitError(maxBuffer));
          });
          return;
        }
        stdoutChunks.push(chunk);
      });
    }

    if (proc.stderr) {
      proc.stderr.on('data', (chunk: Buffer) => {
        if (isSettled) return;
        currentBufferSize += chunk.length;
        if (currentBufferSize > maxBuffer) {
          settle(() => {
            killProcessGroup(proc.pid, 'SIGKILL');
            try {
              proc.kill('SIGKILL');
            } catch {}
            reject(new SandboxedBufferLimitError(maxBuffer));
          });
          return;
        }
        stderrChunks.push(chunk);
      });
    }

    proc.on('error', (err) => {
      settle(() => {
        killProcessGroup(proc.pid, 'SIGKILL');
        try {
          proc.kill('SIGKILL');
        } catch {}
        reject(spawnFailureError(err));
      });
    });

    proc.on('close', (code, signal) => {
      settle(() => {
        const durationMs = Date.now() - startTime;
        const stdout = Buffer.concat(stdoutChunks);
        const stderr = Buffer.concat(stderrChunks);

        if (signal !== null || code === null || code !== 0) {
          const effectiveMemLimit =
            memoryLimitMb ||
            (options.rlimits?.asBytes ? Math.round(options.rlimits.asBytes / (1024 * 1024)) : undefined);
          if ((signal === 'SIGKILL' || signal === 'SIGSEGV') && effectiveMemLimit && effectiveMemLimit > 0) {
            reject(new SandboxedMemoryLimitError(effectiveMemLimit));
            return;
          }
          if (signal === 'SIGXFSZ') {
            const limit = options.maxFileSize || options.rlimits?.fsizeBytes || maxBuffer;
            reject(new SandboxedBufferLimitError(limit));
            return;
          }
          const stderrText = stderr.toString('utf-8').trim();
          let errorSummary: string;
          if (signal !== null) {
            errorSummary = stderrText
              ? `Process terminated by signal ${signal}: ${stderrText}`
              : `Process terminated by signal ${signal}`;
          } else {
            errorSummary = stderrText || `Process exited with code ${code}`;
          }
          reject(new SandboxedProcessError(errorSummary, code, stderr.toString('utf-8'), signal, stdout.toString('utf-8')));
          return;
        }

        resolve({
          stdout,
          stderr,
          exitCode: 0,
          durationMs,
          sandboxed: sandboxEnv.sandboxType !== 'host',
          sandboxType: sandboxEnv.sandboxType,
        });
      });
    });
  });
}
