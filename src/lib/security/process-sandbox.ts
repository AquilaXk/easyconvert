import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream';
import { observeSandboxSpawnFailure } from '../metrics/instruments';
import { SandboxUnavailableError } from '../types';

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
  /**
   * The tasks (processes and threads) of the run. The kernel counts RLIMIT_NPROC over the tasks of the real uid in one user namespace
   * (Linux 5.14 and later), so the limit bounds the run alone only in a user namespace of its own: a run that cannot have one is
   * refused with SandboxUnavailableError instead of being started without the limit or with one that counts the worker.
   */
  nproc?: number;
  cpuSeconds?: number;
  /** Largest core file the run may write; 0 writes none, which a run ended by a signal that dumps core (SIGXFSZ) would otherwise leave behind. */
  coreBytes?: number;
}

/**
 * The files a sandboxed program may touch. The program reads the system (program files, libraries, fonts, settings) and its own /proc
 * entries, and may read, write, create and remove files only below `workDir` and `writeDirs` (a Landlock ruleset applied by pid-init
 * before the program starts, so the files of other people and the directories of other jobs are refused to it; see policy 232).
 *
 * `workDir` is the directory of this job and of nothing else: it is the directory the program works in, the home and temporary
 * directory it is given (TMPDIR, TEMP, TMP, HOME unless the caller sets them), and the only place it writes. `null` says the program
 * touches no file of its own (a filter on standard input and output). A directory that holds other jobs' files, such as the temporary
 * directory itself or the storage directory, is refused: it would make the ruleset allow what it is there to refuse. Left out, the run is not
 * confined: it keeps the access every run had, and STRICT_SANDBOX refuses it.
 */
export interface SandboxFileScope {
  workDir?: string | null;
  /** More directories the program may write below, each the program's own (a profile, a cache beside the job directory). */
  writeDirs?: readonly string[];
  /** More directories the program may read and run files from, beyond the system (model files, an installed tool outside the system paths). */
  readDirs?: readonly string[];
  /**
   * Directories in which the program may make and remove sockets, for a program that binds one at a place it cannot choose (the office suite:
   * `OFFICE_PIPE_DIR`). Rights cannot be limited to a name, so it may also remove the other files there; it can neither read nor write them.
   */
  socketDirs?: readonly string[];
  /** The worker's SANDBOX_CONFINE_FILES=false, handed to the launcher helper, whose own environment does not carry it. */
  fileConfinementOff?: boolean;
}

/** The part of the options of a run that says which files it may touch. */
function fileScopeOf(options: SandboxFileScope): SandboxFileScope {
  return { workDir: options.workDir, writeDirs: options.writeDirs, readDirs: options.readDirs, socketDirs: options.socketDirs, fileConfinementOff: options.fileConfinementOff };
}

/** Where the office suite binds its single-instance pipe, whatever TMPDIR says (sal's osl pipes are made below /tmp). */
export const OFFICE_PIPE_DIR = '/tmp';

export interface SandboxedExecutionOptions extends SandboxFileScope {
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
  /**
   * Bytes to leave free before and after the output in the buffer it is collected into. A caller that wraps the output
   * in a container format (a header before, padding after) writes them in place instead of copying the output again.
   */
  stdoutHeadroomBytes?: number;
  stdoutTailroomBytes?: number;
  /**
   * Collect stdout through an anonymous file instead of a pipe. A program that writes megabytes in 8 KiB blocks to a pipe
   * waits on the 64 KiB reads of this process and on every pause of its event loop, and the chunks are copied once more
   * into the buffer that is returned; into a file it never waits, and the output is read once into a buffer of its exact
   * size. The file is created in a private directory and unlinked before the program starts, so nothing stays on disk. Its
   * size is bounded by RLIMIT_FSIZE at one byte above `maxBuffer`, and a file past `maxBuffer` is reported as
   * SandboxedBufferLimitError, as a pipe past it is, whether the program died of SIGXFSZ, exited with a status of its own
   * or ignored the failed write. Core dumps are switched off for the run, which SIGXFSZ would otherwise leave behind.
   * Without prlimit on Linux that bound is missing, and the output goes through a pipe as before; the result is the same.
   */
  spoolStdout?: boolean;
}

export interface SandboxedExecutionResult {
  stdout: Buffer;
  /** With headroom or tailroom: the whole buffer the output sits in, `stdout` being the part between the two rooms. */
  stdoutFrame?: Buffer;
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
  /** The Node error code (ENOENT, EACCES, ENOEXEC) of a process that could not be started; unset when the process ran and exited. */
  public spawnErrorCode?: string;

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

/** What a byte limit bounded: what the program printed (`stdio`), or a file it wrote (`file-size`). */
export type BufferLimitKind = 'stdio' | 'file-size';

export class SandboxedBufferLimitError extends Error {
  public limitBytes: number;
  public kind: BufferLimitKind;

  constructor(limitBytes: number, kind: BufferLimitKind = 'stdio') {
    super(`Process output exceeded maximum buffer limit of ${limitBytes} bytes`);
    this.name = 'SandboxedBufferLimitError';
    this.limitBytes = limitBytes;
    this.kind = kind;
  }
}

export class SandboxedMemoryLimitError extends Error {
  public limitMb: number;
  /**
   * The signal that ended the program: SIGSEGV for a fault under the address-space limit, which in a C program is a failed
   * allocation it did not check or a stack overflow, SIGKILL for the kernel's out-of-memory killer. Unset when the resident-size
   * watch stopped it. A caller whose program ends those two otherwise (a Rust program aborts) reads SIGSEGV as a crash.
   */
  public signal?: NodeJS.Signals;

  constructor(limitMb: number, signal?: NodeJS.Signals) {
    super(`Process memory exceeded limit of ${limitMb}MB`);
    this.name = 'SandboxedMemoryLimitError';
    this.limitMb = limitMb;
    this.signal = signal;
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

/** The program search path of a sandboxed run when the server's own `PATH` is unset. */
export const SANDBOX_DEFAULT_PATH = '/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin';

/**
 * Sanitizes the process environment variables, stripping credentials, API keys, and sensitive tokens.
 */
export function getSanitizedEnvironment(customEnv: Record<string, string> = {}, networkIsolated = true, workDir?: string | null): NodeJS.ProcessEnv {
  // A run confined to its work directory writes its temporary files and its home there: the shared temporary directory is not its to use.
  const scratch = typeof workDir === 'string' && !fileConfinementDisabled() ? workDir : os.tmpdir();
  const sanitized: NodeJS.ProcessEnv = {
    NODE_ENV: (process.env.NODE_ENV as 'development' | 'production' | 'test') || 'production',
    PATH: process.env.PATH || SANDBOX_DEFAULT_PATH,
    TMPDIR: scratch,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TZ: 'UTC',
    HOME: scratch,
  };
  if (scratch !== os.tmpdir()) {
    sanitized.TEMP = scratch;
    sanitized.TMP = scratch;
  }

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

/**
 * The process to read the memory of for a run: the one `proc.pid` names, or the program itself when `levels` processes that hold
 * little (the `unshare` and `pid-init` it was started through) stand above it, each the only child of the one before.
 */
export function memoryWatchPid(pid: number, levels: number): number {
  if (levels === 0 || process.platform !== 'linux') return pid;
  let current = pid;
  for (let level = 0; level < levels; level++) {
    try {
      const [child] = fs.readFileSync(`/proc/${current}/task/${current}/children`, 'utf-8').trim().split(/\s+/);
      const childPid = Number(child);
      if (!Number.isInteger(childPid) || childPid <= 0) return current;
      current = childPid;
    } catch {
      return current;
    }
  }
  return current;
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
  if (rlimits.coreBytes !== undefined && Number.isInteger(rlimits.coreBytes) && rlimits.coreBytes >= 0) {
    args.push(`--core=${rlimits.coreBytes}`);
  }
  return args;
}

export interface UnshareCapability {
  available: boolean;
  path: string;
  args: string[];
  supportsNetNamespace: boolean;
  /** The `pid-init` program (native/pid-init) that runs a program in a PID namespace of its own on this host, or '' when it cannot. */
  pidInitPath: string;
  /** Whether `pid-init --confine` can confine the files of a program on this host (Landlock version 3: Linux 6.2 or later, the calls allowed by the seccomp profile). */
  confinesFiles: boolean;
}

export const PID_INIT_PATH_ENV = 'PID_INIT_PATH';
/** Set to `false` to start sandboxed programs without `pid-init`, so without the PID namespace of their own and without the hiding of the /proc entries of the other runs; on by default. */
export const SANDBOX_PID_NAMESPACE_ENV = 'SANDBOX_PID_NAMESPACE';
/** Set to `false` to start sandboxed programs without the Landlock ruleset that refuses them the /proc entries of the other runs (pid-init `--keep-proc`); the PID namespace stays. On by default. */
export const SANDBOX_HIDE_PROC_ENV = 'SANDBOX_HIDE_PROC';
/** Set to `false` to start sandboxed programs without confining their files to their work directory (see SandboxFileScope); the /proc hiding and the PID namespace stay. On by default; STRICT_SANDBOX does not override an explicit `false`. */
export const SANDBOX_CONFINE_FILES_ENV = 'SANDBOX_CONFINE_FILES';
/** What pid-init and qpdf-runner print at the start of the standard error of a program they could not hide /proc from. */
export const PROC_NOT_HIDDEN_NOTICE = 'pid-init: /proc not hidden: ';
/** What they print before a program they could not confine to its directories, and what they print instead of starting one that must be (`--require`). */
export const FILES_NOT_CONFINED_NOTICE = 'pid-init: files not confined: ';
export const CANNOT_CONFINE_REFUSAL = 'pid-init: cannot confine: ';
/** The exit status with which pid-init refuses to start a program (it also says so when it cannot make the PID namespace). */
const PID_INIT_REFUSED_STATUS = 125;
const PID_INIT_CANDIDATES = ['/usr/local/bin/pid-init', '/usr/bin/pid-init'];

/** The `pid-init` executable: the one `PID_INIT_PATH` names, or the first of the standard places. */
function findPidInit(): string | null {
  const custom = process.env[PID_INIT_PATH_ENV];
  if (custom !== undefined) return custom && fs.existsSync(custom) ? custom : null;
  return PID_INIT_CANDIDATES.find((candidate) => fs.existsSync(candidate)) ?? null;
}

let unshareCapability: UnshareCapability | null = null;
/** When `pid-init` was last tried, and whether the degrade it led to has been said. */
let pidInitTriedAt = 0;
let pidInitDegradeSaid = false;
let procHideDegradeSaid = false;
let confineDegradeSaid = false;
/** How long a host that could not give a PID namespace goes without one before it is tried again (a probe that failed on a cold start or under load is not a fact about the host). */
export const PID_INIT_REPROBE_MS = 60_000;
const PID_INIT_PROBE_TIMEOUT_MS = 2_000;

export function resetUnshareCapabilityCache(): void {
  unshareCapability = null;
  pidInitTriedAt = 0;
  pidInitDegradeSaid = false;
  procHideDegradeSaid = false;
  confineDegradeSaid = false;
}

/** Says once that runs go without a PID namespace, and why; a program that can signal its siblings is not something to find out from a test. */
function sayPidInitDegraded(reason: string): void {
  if (pidInitDegradeSaid) return;
  pidInitDegradeSaid = true;
  console.warn(`[sandbox] Programs run without a PID namespace of their own: ${reason}. A run can signal the other runs of this worker until it is fixed; the host is tried again every ${PID_INIT_REPROBE_MS / 1000} seconds.`);
}

/** Says once that runs can read the /proc entries of the other runs, and why. */
function sayProcHideDegraded(reason: string): void {
  if (procHideDegradeSaid) return;
  procHideDegradeSaid = true;
  console.warn(`[sandbox] Programs can read the command line and the status of the other runs of this worker in /proc: ${reason}. The Landlock ruleset that hides them needs Linux 5.13 or later with Landlock enabled (cat /sys/kernel/security/lsm) and a seccomp profile that allows the landlock_* calls.`);
}

/** Says once that runs can read and write the files of the other runs, and why. */
function sayConfineDegraded(reason: string): void {
  if (confineDegradeSaid) return;
  confineDegradeSaid = true;
  console.warn(`[sandbox] Programs can read and write the files of the other runs of this worker, such as the stored files of other people: ${reason}. The Landlock ruleset that confines them to their own directory needs Linux 6.2 or later with Landlock enabled (cat /sys/kernel/security/lsm) and a seccomp profile that allows the landlock_* calls.`);
}

/** Whether the confinement of the files of a run to its work directory is switched off for every run (SANDBOX_CONFINE_FILES=false, read as SANDBOX_PID_NAMESPACE is). */
export function fileConfinementDisabled(): boolean {
  return process.env[SANDBOX_CONFINE_FILES_ENV]?.trim().toLowerCase() === 'false';
}

/** Whether the hiding of the /proc entries of the other runs is switched off for every run (SANDBOX_HIDE_PROC=false, read as SANDBOX_PID_NAMESPACE is). */
export function procHidingDisabled(): boolean {
  return process.env[SANDBOX_HIDE_PROC_ENV]?.trim().toLowerCase() === 'false';
}

/**
 * Takes the lines off the start of a program's standard error with which pid-init or qpdf-runner say that they could not put the rulesets
 * in force for this run (the /proc hiding, the confinement of the files), and says so (once each, as the probe does). The lines are printed
 * before the program starts, so they are the first things in the output; a program's own output never starts with them.
 */
export function withoutProcHideNotice(stderr: Buffer): Buffer {
  let rest = stderr;
  for (;;) {
    const notice = [PROC_NOT_HIDDEN_NOTICE, FILES_NOT_CONFINED_NOTICE].find((prefix) => rest.length >= prefix.length && rest.toString('utf-8', 0, prefix.length) === prefix);
    if (notice === undefined) return rest;
    let end = rest.indexOf(0x0a);
    const reason = rest.toString('utf-8', notice.length, end === -1 ? rest.length : end).trim().slice(0, 200);
    end = end === -1 ? rest.length : end + 1;
    if (notice === PROC_NOT_HIDDEN_NOTICE) sayProcHideDegraded(`a run could not be started under the ruleset (${reason})`);
    else sayConfineDegraded(`a run could not be confined (${reason})`);
    rest = rest.subarray(end);
  }
}

/** The `pid-init` program that runs a program here with the namespaces of `base` around it, or '' (and a warning) when none does, and whether it can confine files. */
function probePidInit(base: Pick<UnshareCapability, 'path' | 'args'>): { pidInitPath: string; confinesFiles: boolean } {
  pidInitTriedAt = Date.now();
  // Read as the config schema reads a boolean (trimmed, any case), so `FALSE` turns it off as the startup check accepted.
  if (process.env[SANDBOX_PID_NAMESPACE_ENV]?.trim().toLowerCase() === 'false') return { pidInitPath: '', confinesFiles: false };
  const pidInit = findPidInit();
  if (pidInit === null) {
    sayPidInitDegraded(`no pid-init program was found (${PID_INIT_PATH_ENV}, ${PID_INIT_CANDIDATES.join(', ')})`);
    return { pidInitPath: '', confinesFiles: false };
  }
  try {
    execFileSync(base.path, [...base.args, '--', pidInit, '--', '/bin/true'], { stdio: 'ignore', timeout: PID_INIT_PROBE_TIMEOUT_MS });
    pidInitDegradeSaid = false;
    if (!procHidingDisabled()) probeProcHide(base, pidInit);
    return { pidInitPath: pidInit, confinesFiles: !fileConfinementDisabled() && probeConfinement(base, pidInit) };
  } catch {
    sayPidInitDegraded(`${pidInit} could not start a program in a PID namespace (a seccomp profile or kernel setting that denies it, or a host too busy to answer in ${PID_INIT_PROBE_TIMEOUT_MS} ms)`);
    return { pidInitPath: '', confinesFiles: false };
  }
}

/** Asks `pid-init` whether it can hide the /proc entries of the other runs from a program here; it starts the program without the hiding when it cannot. */
function probeProcHide(base: Pick<UnshareCapability, 'path' | 'args'>, pidInit: string): void {
  try {
    execFileSync(base.path, [...base.args, '--', pidInit, '--check'], { stdio: 'ignore', timeout: PID_INIT_PROBE_TIMEOUT_MS });
    procHideDegradeSaid = false;
  } catch {
    sayProcHideDegraded(`${pidInit} could not make the ruleset on this host`);
  }
}

/** Asks `pid-init` whether it can confine the files of a program here to its directories; the reason it cannot is said once. */
function probeConfinement(base: Pick<UnshareCapability, 'path' | 'args'>, pidInit: string): boolean {
  try {
    execFileSync(base.path, [...base.args, '--', pidInit, '--check', '--confine'], { stdio: 'ignore', timeout: PID_INIT_PROBE_TIMEOUT_MS });
    confineDegradeSaid = false;
    return true;
  } catch {
    sayConfineDegraded(`${pidInit} could not make the ruleset on this host`);
    return false;
  }
}

/**
 * Adds the `pid-init` program when it can run a program here, with the namespaces of `base` around it. A host may allow the user and
 * network namespaces and not a PID namespace (a seccomp profile that lets `clone` make the first two only), and a host without the
 * program has none to offer; runs there go without a PID namespace, which is said once and tried again after `PID_INIT_REPROBE_MS`.
 */
function withPidInitProbe(base: Omit<UnshareCapability, 'pidInitPath' | 'confinesFiles'>): UnshareCapability {
  return { ...base, ...probePidInit(base) };
}

/** The capability, with a host that went without `pid-init`, or without the confinement of files, tried again once `PID_INIT_REPROBE_MS` have passed since it was last tried. */
function withPidInitRetried(capability: UnshareCapability): UnshareCapability {
  const complete = capability.pidInitPath !== '' && (capability.confinesFiles || fileConfinementDisabled());
  if (!capability.available || complete || Date.now() - pidInitTriedAt < PID_INIT_REPROBE_MS) return capability;
  return { ...capability, ...probePidInit(capability) };
}

/**
 * Probes the operating system to determine whether Linux unshare can actually create network namespaces.
 */
export function getUnshareCapability(): UnshareCapability {
  if (unshareCapability !== null) {
    unshareCapability = withPidInitRetried(unshareCapability);
    return unshareCapability;
  }
  if (process.platform !== 'linux') {
    unshareCapability = { available: false, path: '', args: [], supportsNetNamespace: false, pidInitPath: '', confinesFiles: false };
    return unshareCapability;
  }

  const unsharePaths = ['/usr/bin/unshare', '/bin/unshare'];
  for (const p of unsharePaths) {
    if (fs.existsSync(p)) {
      // First probe -r -n (unprivileged user + net namespace)
      try {
        execFileSync(p, ['-r', '-n', '--', '/bin/true'], { stdio: 'ignore', timeout: 500 });
        unshareCapability = withPidInitProbe({ available: true, path: p, args: ['-r', '-n'], supportsNetNamespace: true });
        return unshareCapability;
      } catch {}

      // Second probe -n (net namespace, requires CAP_SYS_ADMIN)
      try {
        execFileSync(p, ['-n', '--', '/bin/true'], { stdio: 'ignore', timeout: 500 });
        unshareCapability = withPidInitProbe({ available: true, path: p, args: ['-n'], supportsNetNamespace: true });
        return unshareCapability;
      } catch {}
    }
  }

  unshareCapability = { available: false, path: '', args: [], supportsNetNamespace: false, pidInitPath: '', confinesFiles: false };
  return unshareCapability;
}

export interface UnshareIsolationOptions {
  userNamespace?: boolean;
  netNamespace?: boolean;
  mountNamespace?: boolean;
  ipcNamespace?: boolean;
  pidNamespace?: boolean;
  /** `false` starts the program with the /proc entries of the other runs readable (pid-init `--keep-proc`), for a program whose own children must read their /proc entries. On by default; SANDBOX_HIDE_PROC=false turns it off for every run. */
  hideProc?: boolean;
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

/** The rlimits of a run: the explicit ones, with the address space and the file size taken from memoryLimitMb and maxFileSize when unset. */
function effectiveRlimitsOf(rlimits: SandboxedRlimitsOptions | undefined, memoryLimitMb: number | undefined, maxFileSize: number | undefined): SandboxedRlimitsOptions {
  const effective: SandboxedRlimitsOptions = { ...(rlimits || {}) };
  if (!effective.asBytes && memoryLimitMb && memoryLimitMb > 0) {
    effective.asBytes = memoryLimitMb * 1024 * 1024;
  }
  if (!effective.fsizeBytes && maxFileSize && maxFileSize > 0) {
    effective.fsizeBytes = maxFileSize;
  }
  return effective;
}

/**
 * How a run gets a PID namespace. Unless the caller chose otherwise (and the host can make one) every run gets its own: without it a run
 * reaches the other runs of the worker with kill(2), as they share one user ID. pid-init runs the program as PID 2 of the namespace, so
 * it dies of its signals as it does outside one; `pidNamespace: true` is the program as PID 1 (`unshare -p --fork`), `false` is none.
 * `wrapper` goes between the `unshare` options and the program; `levelsAboveProgram` counts the processes the program stands below.
 */
function pidIsolationOf(
  unshare: UnshareCapability | undefined,
  isolationArgs: string[] | undefined,
  options: UnshareIsolationOptions,
  confinement: readonly string[]
): { wrapper: string[]; levelsAboveProgram: number } {
  if (!isolationArgs) return { wrapper: [], levelsAboveProgram: 0 };
  if (options.pidNamespace) {
    if (!isolationArgs.includes('--kill-child')) isolationArgs.push('--kill-child');
    return { wrapper: [], levelsAboveProgram: 1 };
  }
  if (unshare?.pidInitPath) {
    const flags = options.hideProc === false || procHidingDisabled() ? ['--keep-proc', ...confinement] : [...confinement];
    // `pidNamespace: false` still hides the /proc entries of the other runs: pid-init applies the ruleset and becomes the program (no process in between).
    if (options.pidNamespace === false) return { wrapper: [unshare.pidInitPath, '--no-pid-namespace', ...flags, '--'], levelsAboveProgram: 0 };
    if (options.pidNamespace === undefined) return { wrapper: [unshare.pidInitPath, ...flags, '--'], levelsAboveProgram: 2 };
  }
  return { wrapper: [], levelsAboveProgram: 0 };
}

/** A directory a run is confined to, as pid-init takes it: absolute, normalized, and never one that holds the files of other jobs. */
export function confinedDirectory(directory: string, what: string): string {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory.includes('\0')) {
    throw new Error(`The ${what} of a sandboxed run must be an absolute path without NUL (got ${JSON.stringify(directory)}).`);
  }
  const resolved = path.resolve(directory);
  if (resolved === path.parse(resolved).root || resolved === path.resolve(os.tmpdir())) {
    throw new Error(`The ${what} of a sandboxed run is the directory of one job, not ${resolved}: the confinement would allow the files of every other job.`);
  }
  return resolved;
}

/**
 * The pid-init options that confine the files of a run to its directories (see SandboxFileScope), or none when the run is not to be
 * confined: the operator turned it off, or the run did not name its directory and STRICT_SANDBOX is off, or this host cannot (said once by
 * the probe) and STRICT_SANDBOX is off. Under STRICT_SANDBOX a run that cannot be confined is refused before it starts, and pid-init is
 * told to refuse it as well (`--require`) should the ruleset fail after a good probe.
 */
function confinementOf(
  scope: SandboxFileScope,
  strict: boolean,
  unshare: UnshareCapability | undefined,
  isolationArgs: string[] | undefined,
  options: UnshareIsolationOptions,
  program: string
): string[] {
  if (!isolationArgs || fileConfinementDisabled() || scope.fileConfinementOff) return [];
  if (scope.workDir === undefined) {
    if (strict) throw sandboxUnavailable('Strict sandbox: the run does not name the directory of its job (workDir), so its files cannot be confined to it; the program is not started.');
    return [];
  }
  if (options.pidNamespace === true || !unshare?.pidInitPath || !unshare.confinesFiles) {
    if (strict) throw sandboxUnavailable('Strict sandbox: this host cannot confine the files of a program to the directory of its job (it needs pid-init, Linux 6.2 or later with Landlock, and the landlock_* calls in the seccomp profile); the program is not started.');
    return [];
  }
  const writable = [...(scope.workDir === null ? [] : [confinedDirectory(scope.workDir, 'workDir')]), ...(scope.writeDirs ?? []).map((directory) => confinedDirectory(directory, 'write directory'))];
  // The program itself is read and run wherever it is installed (a tool the operator keeps outside the system paths); its libraries are the system's.
  const readable = [...(scope.readDirs ?? []), ...(path.isAbsolute(program) ? [program] : [])].map((directory) => confinedDirectory(directory, 'read directory'));
  const sockets = (scope.socketDirs ?? []).map((directory) => path.resolve(directory));
  return ['--confine', ...(strict ? ['--require'] : []), ...writable.flatMap((directory) => ['--write', directory]), ...readable.flatMap((directory) => ['--read', directory]), ...sockets.flatMap((directory) => ['--sockets', directory])];
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
      } & SandboxFileScope
): { binary: string; args: string[]; wrapped: boolean; levelsAboveProgram: number } {
  let networkIsolated = true;
  let sandboxOptions: UnshareIsolationOptions = {};
  let strictIsolation = process.env.STRICT_SANDBOX === 'true';
  let memoryLimitMb: number | undefined;
  let maxFileSize: number | undefined;
  let rlimits: SandboxedRlimitsOptions | undefined;
  let scope: SandboxFileScope = {};

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
    scope = fileScopeOf(networkIsolatedOrOptions);
  }

  const effectiveRlimits = effectiveRlimitsOf(rlimits, memoryLimitMb, maxFileSize);
  const unshare = process.platform === 'linux' && networkIsolated ? getUnshareCapability() : undefined;
  const isolationArgs = unshare?.available ? buildUnshareIsolationArgs(unshare, sandboxOptions) : undefined;
  const confinement = confinementOf(scope, strictIsolation, unshare, isolationArgs, sandboxOptions, binaryPath);
  const pid = pidIsolationOf(unshare, isolationArgs, sandboxOptions, confinement);
  const capPrlimit = getPrlimitCapability();
  if (effectiveRlimits.nproc !== undefined && !(isolationArgs?.includes('-r') && capPrlimit.available)) {
    throw sandboxUnavailable('The task limit of a run is kept only by prlimit in a user namespace of its own (unshare -r), which this host cannot give the run; the program is not started.');
  }

  let finalBinary = binaryPath;
  let finalArgs = [...args];
  let isWrapped = false;

  // Apply prlimit wrapping if available on Linux and rlimits are specified
  const hasRlimits =
    effectiveRlimits.asBytes !== undefined ||
    effectiveRlimits.fsizeBytes !== undefined ||
    effectiveRlimits.nproc !== undefined ||
    effectiveRlimits.cpuSeconds !== undefined ||
    effectiveRlimits.coreBytes !== undefined;

  if (process.platform === 'linux' && capPrlimit.available && hasRlimits) {
    const prlimitArgs = buildPrlimitArgs(capPrlimit, effectiveRlimits);
    if (prlimitArgs.length > 0) {
      finalArgs = [...prlimitArgs, '--', finalBinary, ...finalArgs];
      finalBinary = capPrlimit.path;
      isWrapped = true;
    }
  }

  if (unshare) {
    if (isolationArgs) {
      return {
        binary: unshare.path,
        args: [...isolationArgs, '--', ...pid.wrapper, finalBinary, ...finalArgs],
        wrapped: true,
        levelsAboveProgram: pid.levelsAboveProgram,
      };
    } else if (strictIsolation) {
      // Typed for the API (503, retryable) and thrown before any spawn: no caller may run the tool unwrapped.
      throw sandboxUnavailable('Strict network isolation failed: Linux unshare capability is unavailable');
    }
  } else if (strictIsolation && networkIsolated && process.platform !== 'linux') {
    throw sandboxUnavailable(
      `Strict network isolation failed: OS platform "${process.platform}" does not support Linux network namespaces`
    );
  }

  return { binary: finalBinary, args: finalArgs, wrapped: isWrapped, levelsAboveProgram: 0 };
}

/**
 * What pid-init said when it did not start a program because the files could not be confined to its directories (`--require`, which a
 * STRICT_SANDBOX run passes): its reason, or null when the run ended any other way. The program never ran.
 */
export function confinementRefusal(exitCode: number | null, stderr: Buffer): string | null {
  if (exitCode !== PID_INIT_REFUSED_STATUS || stderr.length < CANNOT_CONFINE_REFUSAL.length || stderr.toString('utf-8', 0, CANNOT_CONFINE_REFUSAL.length) !== CANNOT_CONFINE_REFUSAL) return null;
  const end = stderr.indexOf(0x0a);
  return `Strict sandbox: the files of the program could not be confined to its directory, so it was not started (${stderr.toString('utf-8', CANNOT_CONFINE_REFUSAL.length, end === -1 ? stderr.length : end).trim().slice(0, 200)}).`;
}

/** The refusal of a host that cannot confine a program, counted for the metrics. */
export function sandboxUnavailable(reason: string): SandboxUnavailableError {
  observeSandboxSpawnFailure('sandbox_unavailable');
  return new SandboxUnavailableError(reason);
}

/**
 * Rethrows a SandboxUnavailableError and returns for any other error. Call it first in a catch block that would
 * otherwise turn a failed native run into a fallback, an empty result or a different error type: a host that cannot
 * confine its children must refuse the request, whatever engine a fallback would use instead.
 */
export function rethrowSandboxUnavailable(err: unknown): void {
  if (err instanceof SandboxUnavailableError) throw err;
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
 * it: as a SandboxedProcessError carrying the shell's status, so callers see one typed error. The status alone does not
 * tell a failed start from a program that exited with it, so spawnErrorCode keeps the code of the start failure.
 */
function spawnFailureError(err: Error): Error {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOENT' || code === 'EACCES' || code === 'ENOEXEC') {
    const status = code === 'ENOENT' ? SPAWN_NOT_FOUND_STATUS : SPAWN_NOT_EXECUTABLE_STATUS;
    const failure = new SandboxedProcessError(`Sandboxed execution error: ${err.message}`, status, err.message);
    failure.spawnErrorCode = code;
    return failure;
  }
  return err;
}

/** The chunks in one buffer with `headroom` bytes before them and `tailroom` after (both left as the allocator gave them). */
function collectFramed(chunks: Buffer[], headroom: number, tailroom: number): Buffer {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const frame = Buffer.allocUnsafe(headroom + total + tailroom);
  let at = headroom;
  for (const chunk of chunks) at += chunk.copy(frame, at);
  return frame;
}

/**
 * An anonymous file for a run's stdout: created exclusively in a private directory, then unlinked at once, so that nothing is
 * left on disk whatever happens to this process. The child gets the descriptor as its stdout; this process keeps its own to read
 * the output back by offset (the two share one open file, so the position is not used).
 */
function openStdoutSpool(): number {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'easyconvert-spool-'));
  const file = path.join(dir, 'stdout');
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'wx+', 0o600);
    fs.rmSync(dir, { recursive: true, force: true });
    return fd;
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

/** The anonymous file of `openStdoutSpool`, or null when it cannot be made: the output then goes through a pipe, which gives the same result. */
function tryOpenStdoutSpool(): number | null {
  try {
    return openStdoutSpool();
  } catch {
    return null;
  }
}

/** What a finished run left in its spool: the output in one buffer of `headroom + size + tailroom` bytes, the file past its bound, or the failure to read it. */
type SpoolRead = { frame: Buffer } | { boundHit: true } | { error: unknown };

/**
 * Reads the spool by offset, the output starting after the headroom. The file may hold one byte more than the output may, and that byte is
 * how a program past its bound shows, whether it died of SIGXFSZ, caught the signal and exited with a status of its own, as 7-Zip does, or
 * ignored the failed write and exited 0 with a cut file: such a file is not read.
 */
function readStdoutSpool(fd: number, limit: number, headroom: number, tailroom: number): SpoolRead {
  try {
    const size = fs.fstatSync(fd).size;
    if (size > limit) return { boundHit: true };
    const frame = Buffer.allocUnsafe(headroom + size + tailroom);
    let read = 0;
    while (read < size) {
      const count = fs.readSync(fd, frame, headroom + read, size - read, read);
      if (count === 0) throw new Error('The spooled output ended before its recorded size.');
      read += count;
    }
    return { frame };
  } catch (error) {
    return { error };
  }
}

/** The output of a run: from its spool, or from the chunks of its pipe, with the rooms around it when they were asked for. */
function outputOf(spooled: Buffer | undefined, chunks: Buffer[], headroom: number, tailroom: number): { stdout: Buffer; frame?: Buffer } {
  const framed = headroom > 0 || tailroom > 0;
  if (spooled !== undefined) return framed ? { stdout: spooled.subarray(headroom, spooled.length - tailroom), frame: spooled } : { stdout: spooled };
  if (!framed) return { stdout: Buffer.concat(chunks) };
  const frame = collectFramed(chunks, headroom, tailroom);
  return { stdout: frame.subarray(headroom, frame.length - tailroom), frame };
}

/** Why a run that did not exit 0 failed: the memory limit its signal shows, the file size limit, or the process error with what it printed. */
function failedRunError(run: { code: number | null; signal: NodeJS.Signals | null; stdout: Buffer; stderr: Buffer }, options: SandboxedExecutionOptions, maxBuffer: number): Error {
  const { code, signal, stdout, stderr } = run;
  // pid-init did not start a program it was told to confine and could not.
  const refusal = confinementRefusal(code, stderr);
  if (refusal !== null) return sandboxUnavailable(refusal);
  const effectiveMemLimit =
    options.memoryLimitMb ||
    (options.rlimits?.asBytes ? Math.round(options.rlimits.asBytes / (1024 * 1024)) : undefined);
  if ((signal === 'SIGKILL' || signal === 'SIGSEGV') && effectiveMemLimit && effectiveMemLimit > 0) {
    return new SandboxedMemoryLimitError(effectiveMemLimit, signal);
  }
  if (signal === 'SIGXFSZ') {
    const limit = options.maxFileSize || options.rlimits?.fsizeBytes || maxBuffer;
    return new SandboxedBufferLimitError(limit, 'file-size');
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
  return new SandboxedProcessError(errorSummary, code, stderr.toString('utf-8'), signal, stdout.toString('utf-8'));
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
    networkIsolated = true,
    stdin,
  } = options;
  const cwd = options.cwd ?? (typeof options.workDir === 'string' ? options.workDir : os.tmpdir());

  if (!binaryPath || typeof binaryPath !== 'string') {
    throw new SandboxedProcessError('Sandboxed execution error: invalid binary path provided.', null, '');
  }

  const sandboxEnv = detectSandboxEnvironment();
  const sanitizedEnv = getSanitizedEnvironment(customEnv, networkIsolated, options.workDir);
  const startTime = Date.now();
  // The bound on a spooled output is RLIMIT_FSIZE, which prlimit sets; without it the output goes through a pipe, bounded as it flows.
  const spoolLimit = Math.min(rlimits?.fsizeBytes ?? maxFileSize ?? maxBuffer, maxBuffer);
  // A spool without a finite bound would run with no RLIMIT_FSIZE at all, so such a run keeps the pipe.
  const spooled = options.spoolStdout === true && Number.isFinite(spoolLimit) && process.platform === 'linux' && getPrlimitCapability().available;

  return new Promise((resolve, reject) => {
    let stdoutChunks: Buffer[] = [];
    let stderrChunks: Buffer[] = [];
    let currentBufferSize = 0;
    let timer: NodeJS.Timeout | null = null;
    let memoryInterval: NodeJS.Timeout | null = null;
    let isSettled = false;
    let activeChild: ReturnType<typeof spawn> | null = null;
    let abortListener: (() => void) | null = null;
    let spoolFd: number | null = null;

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
      if (spoolFd !== null) {
        try {
          fs.closeSync(spoolFd);
        } catch {}
        spoolFd = null;
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
      rlimits: spooled
        ? { ...rlimits, fsizeBytes: spoolLimit + 1, coreBytes: 0 }
        : rlimits,
      ...fileScopeOf(options),
    });

    if (spooled) spoolFd = tryOpenStdoutSpool();

    // Spawn directly without shell to prevent shell injection vulnerabilities.
    // Use detached: true so child becomes process group leader, preventing orphan leaks.
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(resolvedCmd.binary, resolvedCmd.args, {
        cwd,
        env: sanitizedEnv,
        stdio: [stdin ? 'pipe' : 'ignore', spoolFd ?? 'pipe', 'pipe'],
        shell: false,
        detached: true,
      });
    } catch (error) {
      cleanup();
      throw error;
    }
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
        const rssMb = getProcessRssMb(memoryWatchPid(proc.pid, resolvedCmd.levelsAboveProgram));
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
      observeSandboxSpawnFailure('spawn_error');
      settle(() => {
        killProcessGroup(proc.pid, 'SIGKILL');
        try {
          proc.kill('SIGKILL');
        } catch {}
        reject(spawnFailureError(err));
      });
    });

    proc.on('close', (code, signal) => {
      // Read before settling: settling closes the descriptor.
      const headroom = options.stdoutHeadroomBytes ?? 0;
      const tailroom = options.stdoutTailroomBytes ?? 0;
      const spool = spoolFd !== null && !isSettled ? readStdoutSpool(spoolFd, spoolLimit, headroom, tailroom) : undefined;
      settle(() => {
        const durationMs = Date.now() - startTime;
        const stderr = withoutProcHideNotice(Buffer.concat(stderrChunks));

        if (spool !== undefined && 'boundHit' in spool) {
          reject(new SandboxedBufferLimitError(spoolLimit));
          return;
        }
        if (spool !== undefined && 'error' in spool) {
          reject(spool.error);
          return;
        }
        const { stdout, frame } = outputOf(spool?.frame, stdoutChunks, headroom, tailroom);

        if (signal !== null || code === null || code !== 0) {
          reject(failedRunError({ code, signal, stdout, stderr }, options, maxBuffer));
          return;
        }

        resolve({
          stdout,
          stdoutFrame: frame,
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
