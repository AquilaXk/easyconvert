import dns from 'node:dns';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Transform, pipeline } from 'node:stream';
import { promisify } from 'node:util';
import type { SftpCredentials } from '../credentials-vault';
import {
  IStorageAdapter,
  StorageAdapterMetadata,
  StorageInputError,
  StorageNotFoundError,
  StorageAuthenticationError,
  StorageSsrfError,
  StorageAdapterError,
  StorageListingLimitError,
  StorageSizeLimitError,
  assertCredentialsObject,
  assertValidMaxFiles,
  assertValidUploadSize,
} from './adapter-interface';
import { isPrivateOrRestrictedHost, isBlockedIp } from '../../security/ssrf';
import {
  confinementRefusal,
  resolveSandboxedCommand,
  sandboxUnavailable,
  withoutProcHideNotice,
} from '../../security/process-sandbox';
import { SandboxUnavailableError } from '../../types';
import { REMOTE_STAGED_OBJECT_MAX_BYTES } from '../remote-storage-backend';
import {
  MAX_KNOWN_HOSTS_BYTES,
  getPersistedSftpHostKey,
  persistSftpHostKeyFirstUse,
} from './sftp-host-key-store';
import {
  SFTP_BATCH_ARGS,
  SFTP_COMMAND_FAILED_EXIT,
  SFTP_CONNECTION_FAILED_EXIT,
  SFTP_MAX_OUTPUT_BYTES,
  assertSftpPort,
  isSftpNotFound,
  normalizeBasePath,
  parseSftpDirectoryFiles,
  parseSftpListingSize,
  resolveRemotePath,
  sftpBatch,
  sftpChildEnv,
  sftpCommandLine,
  sftpDestination,
  sftpKnownHostsLine,
  truncateSftpErrorText,
} from './sftp-protocol';

const streamPipeline = promisify(pipeline);

/** Cap on distinct DNS addresses validated and attempted sequentially for a single SFTP operation. */
export const MAX_SFTP_RESOLVED_ADDRESSES = 16;

/** Unconsumed `downloadStream` spools are destroyed and removed after this idle interval. */
export const SFTP_DOWNLOAD_IDLE_SWEEP_MS = 60_000;

/** A hung connection or a stalled transfer is killed after this long, so its key file and the process do not outlive the request. */
const SFTP_COMMAND_TIMEOUT_MS = 15 * 60_000;

/**
 * A `get` is the one call that writes a file the server decides the size of. It may not grow past the largest object
 * the object store stages to scratch disk, and is measured this often, so it can pass the cap by what one interval writes.
 */
const SFTP_MAX_SPOOL_BYTES = REMOTE_STAGED_OBJECT_MAX_BYTES;
const SPOOL_CHECK_INTERVAL_MS = 100;

/** A client stopped for a reason of ours gets this long to leave after SIGTERM before its whole process group is killed. */
const SFTP_KILL_GRACE_MS = 2_000;

/** The known hosts file is named in an `-o` value, which `ssh` splits on spaces and quotes. */
const PLAIN_PATH = /^[A-Za-z0-9_/.+-]+$/;

interface Spool {
  file: string;
  maxBytes: number;
}

interface SftpBatchOptions {
  spool?: Spool;
  readDirs?: readonly string[];
}

const downloadSpoolRegistry = new FinalizationRegistry<string>((dir) => {
  removeDirQuietly(dir);
});

/**
 * Comma-separated `host:port` list of SFTP servers that may be private, for a local test server during development. It is
 * server configuration, never a field of the customer's credentials, and is honoured only when NODE_ENV is exactly "development".
 */
export const SFTP_DEV_ENDPOINT_ALLOWLIST_ENV = 'BYOS_SFTP_DEV_ENDPOINT_ALLOWLIST';

/** Whether the server's development allowlist names exactly this host and port. */
export function isSftpDevAllowlisted(host: string, port: number | undefined): boolean {
  if (process.env.NODE_ENV !== 'development') return false;
  const entry = `${host}:${port ?? 22}`.toLowerCase();
  return (process.env[SFTP_DEV_ENDPOINT_ALLOWLIST_ENV] ?? '').split(',').some((listed) => listed.trim().toLowerCase() === entry);
}

/** The client ran and a command of the batch failed (exit 1): a missing file, a refused write, a directory that is not there. */
class SftpCommandFailedError extends StorageAdapterError {
  constructor(message: string, public readonly stderr: string) {
    super(message, 'sftp');
    this.name = 'SftpCommandFailedError';
  }
}

/** Signals the client and the `ssh` it started: the client leads a process group of its own (`detached`). */
function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // the group is already gone or cannot be signalled; the client itself is the last thing to try
    }
  }
  child.kill(signal);
}

function removeDirQuietly(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // a directory that cannot be removed now is swept with the temp directory
  }
}

function unlinkQuietly(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // the enclosing temp directory will be removed separately
  }
}

/**
 * Reads `workDir/known_hosts` without following symlinks and within `MAX_KNOWN_HOSTS_BYTES`.
 * Returns `undefined` when OpenSSH never wrote a file.
 */
function readKnownHostsBounded(knownHostsPath: string, provider: string): string | undefined {
  let fd: number;
  try {
    fd = fs.openSync(knownHostsPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw new StorageAdapterError(`Failed to open SFTP known_hosts file: ${String(err)}`, provider, err);
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw new StorageAdapterError('SFTP known_hosts entry is not a regular file', provider);
    }
    if (stat.size > MAX_KNOWN_HOSTS_BYTES) {
      throw new StorageAdapterError(`SFTP known_hosts file exceeds ${MAX_KNOWN_HOSTS_BYTES} bytes`, provider);
    }
    const buf = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const n = fs.readSync(fd, buf, offset, stat.size - offset, offset);
      if (n === 0) break;
      offset += n;
    }
    return buf.subarray(0, offset).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function attachDownloadSpoolCleanup(readStream: fs.ReadStream, tmpDir: string): void {
  let cleaned = false;
  let idleTimer: NodeJS.Timeout | undefined;

  const cleanupSpool = () => {
    if (cleaned) return;
    cleaned = true;
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
    downloadSpoolRegistry.unregister(readStream);
    removeDirQuietly(tmpDir);
  };

  const resetIdleTimer = () => {
    if (cleaned) return;
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!readStream.destroyed) readStream.destroy();
      cleanupSpool();
    }, SFTP_DOWNLOAD_IDLE_SWEEP_MS);
    idleTimer.unref();
  };

  const origPush = readStream.push.bind(readStream);
  readStream.push = ((chunk: Parameters<typeof readStream.push>[0], encoding?: BufferEncoding) => {
    if (chunk !== null) resetIdleTimer();
    return origPush(chunk, encoding);
  }) as typeof readStream.push;

  downloadSpoolRegistry.register(readStream, tmpDir, readStream);
  resetIdleTimer();
  readStream.on('close', cleanupSpool);
  readStream.on('end', cleanupSpool);
  readStream.on('error', cleanupSpool);
}

/** The file being fetched grew past the byte limit of the call, whatever size the listing gave it. */
class SftpSpoolLimitError extends StorageAdapterError {
  constructor(message: string) {
    super(message, 'sftp');
    this.name = 'SftpSpoolLimitError';
  }
}

/** The client wrote more output than a call keeps: a directory of more entries than one listing can hold. */
class SftpOutputLimitError extends StorageAdapterError {
  constructor(message: string) {
    super(message, 'sftp');
    this.name = 'SftpOutputLimitError';
  }
}

function isPostAuthSftpError(err: unknown): boolean {
  return (
    err instanceof SftpCommandFailedError ||
    err instanceof SftpSpoolLimitError ||
    err instanceof SftpOutputLimitError
  );
}

function isTransportRetryableError(err: unknown): boolean {
  if (!(err instanceof StorageAdapterError)) return false;
  if (err instanceof SandboxUnavailableError) return false;
  if (
    err instanceof StorageAuthenticationError ||
    err instanceof SftpCommandFailedError ||
    err instanceof SftpSpoolLimitError ||
    err instanceof SftpOutputLimitError
  ) {
    return false;
  }
  return true;
}

export class SftpStorageAdapter implements IStorageAdapter {
  readonly providerName = 'sftp';
  private readonly port: number;
  private readonly basePath: string;
  private readonly knownHostsLine: string | undefined;

  constructor(private readonly credentials: SftpCredentials) {
    assertCredentialsObject(credentials, this.providerName);
    this.port = assertSftpPort(credentials.port === undefined ? 22 : credentials.port);
    if (credentials.password !== undefined && typeof credentials.password !== 'string') {
      throw new StorageInputError('The SFTP password must be a string', this.providerName);
    }
    if (credentials.privateKey !== undefined && typeof credentials.privateKey !== 'string') {
      throw new StorageInputError('The SFTP privateKey must be a string', this.providerName);
    }
    if (credentials.passphrase !== undefined && typeof credentials.passphrase !== 'string') {
      throw new StorageInputError('The SFTP passphrase must be a string', this.providerName);
    }
    sftpDestination(credentials.host, credentials.username);
    this.basePath = normalizeBasePath(credentials.basePath);
    this.knownHostsLine = credentials.hostKey === undefined ? undefined : sftpKnownHostsLine(credentials.hostKey);
  }

  /**
   * Resolves `this.credentials.host` and verifies EVERY returned address against SSRF rules
   * before returning any address, deduplicating in DNS order up to `MAX_SFTP_RESOLVED_ADDRESSES`.
   */
  private async resolveAllowedAddresses(): Promise<string[]> {
    const host = this.credentials.host;
    const devAllowlisted = isSftpDevAllowlisted(host, this.port);
    if (!devAllowlisted && isPrivateOrRestrictedHost(host)) {
      throw new StorageSsrfError(host, this.providerName);
    }

    try {
      const addresses = await dns.promises.lookup(host, { all: true });
      if (!addresses || addresses.length === 0) {
        throw new StorageSsrfError(`Could not resolve host ${host}`, this.providerName);
      }
      const seen = new Set<string>();
      const allowed: string[] = [];
      for (const addr of addresses) {
        if (!devAllowlisted && isBlockedIp(addr.address)) {
          throw new StorageSsrfError(`${host} resolves to restricted IP ${addr.address}`, this.providerName);
        }
        if (!seen.has(addr.address) && allowed.length < MAX_SFTP_RESOLVED_ADDRESSES) {
          seen.add(addr.address);
          allowed.push(addr.address);
        }
      }
      return allowed;
    } catch (err) {
      if (err instanceof StorageSsrfError) throw err;
      throw new StorageAdapterError(`DNS lookup failed for ${host}: ${String(err)}`, this.providerName);
    }
  }

  async downloadStream(remotePath: string, options: { maxBytes?: number } = {}): Promise<NodeJS.ReadableStream> {
    const maxBytes = Math.min(options.maxBytes ?? SFTP_MAX_SPOOL_BYTES, SFTP_MAX_SPOOL_BYTES);
    const addresses = await this.resolveAllowedAddresses();
    const resolved = resolveRemotePath(this.basePath, remotePath);

    // Spool download through safe temp file to guarantee zero Next.js heap buffering
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'easyconvert-sftp-down-'));
    const localTmp = path.join(tmpDir, 'downloaded.tmp');

    try {
      await this.runSftpBatch(addresses, sftpBatch(sftpCommandLine('get', resolved, localTmp)), {
        spool: { file: localTmp, maxBytes },
      });
    } catch (err) {
      removeDirQuietly(tmpDir);
      if (err instanceof SftpSpoolLimitError) throw new StorageSizeLimitError(maxBytes, this.providerName);
      if (err instanceof SftpCommandFailedError && isSftpNotFound(err.stderr)) {
        throw new StorageNotFoundError(remotePath, this.providerName);
      }
      throw err;
    }

    const readStream = fs.createReadStream(localTmp);
    attachDownloadSpoolCleanup(readStream, tmpDir);

    return readStream;
  }

  async uploadStream(
    remotePath: string,
    stream: NodeJS.ReadableStream | ReadableStream<Uint8Array>,
    options?: { contentType?: string; size?: number; maxBytes?: number }
  ): Promise<StorageAdapterMetadata> {
    assertValidUploadSize(options?.size, this.providerName);
    const maxBytes = Math.min(options?.maxBytes ?? SFTP_MAX_SPOOL_BYTES, SFTP_MAX_SPOOL_BYTES);
    if (options?.size !== undefined && options.size > maxBytes) {
      throw new StorageSizeLimitError(maxBytes, this.providerName);
    }

    const addresses = await this.resolveAllowedAddresses();
    const resolved = resolveRemotePath(this.basePath, remotePath);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'easyconvert-sftp-up-'));
    const localTmp = path.join(tmpDir, 'upload.tmp');

    try {
      const batchScript = sftpBatch(sftpCommandLine('put', localTmp, resolved));
      let nodeStream: NodeJS.ReadableStream;
      if ('getReader' in stream) {
        nodeStream = Readable.fromWeb(stream as import('node:stream/web').ReadableStream);
      } else {
        nodeStream = stream;
      }

      const providerName = this.providerName;
      let spooledBytes = 0;
      const limitTransform = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          spooledBytes += chunk.byteLength;
          if (spooledBytes > maxBytes) {
            callback(new StorageSizeLimitError(maxBytes, providerName));
            return;
          }
          callback(null, chunk);
        },
      });
      const outStream = fs.createWriteStream(localTmp);
      try {
        await streamPipeline(nodeStream, limitTransform, outStream);
      } catch (err) {
        const destroyable = nodeStream as unknown as { destroy?: () => void };
        if (typeof destroyable.destroy === 'function') {
          destroyable.destroy();
        }
        outStream.destroy();
        try {
          fs.rmSync(localTmp, { force: true });
        } catch {}
        throw err;
      }
      const stats = fs.statSync(localTmp);

      await this.runSftpBatch(addresses, batchScript, { readDirs: [tmpDir] });

      return {
        size: stats.size,
        contentType: options?.contentType,
        lastModified: new Date(),
      };
    } finally {
      removeDirQuietly(tmpDir);
    }
  }

  async head(remotePath: string): Promise<StorageAdapterMetadata | null> {
    const addresses = await this.resolveAllowedAddresses();
    const resolved = resolveRemotePath(this.basePath, remotePath);

    let output: string;
    try {
      output = await this.runSftpBatch(addresses, sftpBatch(sftpCommandLine('ls -l', resolved)));
    } catch (err) {
      if (err instanceof SftpCommandFailedError) return null;
      throw err;
    }
    const size = parseSftpListingSize(output);
    if (size === undefined) {
      throw new StorageAdapterError('SFTP answered ls -l with no listing line this adapter can read', this.providerName);
    }
    return { size, lastModified: new Date() };
  }

  /**
   * The regular files of a directory, by name. More than `maxFiles` of them, or a listing too long for the client's output cap,
   * is refused with a `StorageListingLimitError`: nothing is listed short. A directory that is not there is `StorageNotFoundError`.
   */
  async listDirectory(directory: string, maxFiles: number): Promise<Array<{ name: string; size: number }>> {
    assertValidMaxFiles(maxFiles, this.providerName);
    const addresses = await this.resolveAllowedAddresses();
    const resolved = resolveRemotePath(this.basePath, directory);
    let output: string;
    try {
      output = await this.runSftpBatch(addresses, sftpBatch(sftpCommandLine('ls -l', resolved)));
    } catch (err) {
      if (err instanceof SftpOutputLimitError) throw new StorageListingLimitError(maxFiles, this.providerName);
      if (err instanceof SftpCommandFailedError && isSftpNotFound(err.stderr)) throw new StorageNotFoundError(directory, this.providerName);
      throw err;
    }
    const files = parseSftpDirectoryFiles(output);
    if (files.length > maxFiles) throw new StorageListingLimitError(maxFiles, this.providerName);
    return files;
  }

  async delete(remotePath: string): Promise<boolean> {
    const addresses = await this.resolveAllowedAddresses();
    const resolved = resolveRemotePath(this.basePath, remotePath);

    try {
      await this.runSftpBatch(addresses, sftpBatch(sftpCommandLine('rm', resolved)));
      return true;
    } catch (err) {
      if (err instanceof SftpCommandFailedError) return false;
      throw err;
    }
  }

  private async persistTofuKeyIfPresent(workDir: string): Promise<void> {
    const raw = readKnownHostsBounded(path.join(workDir, 'known_hosts'), this.providerName);
    if (raw === undefined || raw.trim().length === 0) return;
    await persistSftpHostKeyFirstUse(this.credentials.host, this.port, raw);
  }

  private async runSingleAttempt(
    address: string,
    commands: string,
    pinnedLine: string | undefined,
    isFirstUse: boolean,
    options?: SftpBatchOptions
  ): Promise<{ ok: true; output: string } | { ok: false; err: unknown }> {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'easyconvert-sftp-run-'));
    try {
      let output: string;
      try {
        output = await this.spawnSftp(this.buildArgs(workDir, address, pinnedLine), commands, workDir, options);
      } catch (err) {
        if (options?.spool) unlinkQuietly(options.spool.file);
        if (isFirstUse && isPostAuthSftpError(err)) {
          await this.persistTofuKeyIfPresent(workDir);
        }
        return { ok: false, err };
      }

      if (isFirstUse) {
        try {
          await this.persistTofuKeyIfPresent(workDir);
        } catch (persistErr) {
          if (options?.spool) unlinkQuietly(options.spool.file);
          throw persistErr;
        }
      }
      return { ok: true, output };
    } finally {
      removeDirQuietly(workDir);
    }
  }

  /**
   * Runs one sftp session across validated addresses, falling back on transport errors only.
   * Each attempt gets a fresh 0700 `workDir` removed in `finally`; TOFU keys are persisted only
   * after SSH authentication has succeeded.
   */
  private async runSftpBatch(addresses: readonly string[], commands: string, options?: SftpBatchOptions): Promise<string> {
    if (addresses.length === 0) {
      throw new StorageAdapterError('No validated SFTP addresses available', this.providerName);
    }
    const pinnedLine = this.knownHostsLine ?? (await getPersistedSftpHostKey(this.credentials.host, this.port));
    const isFirstUse = pinnedLine === undefined;

    for (let i = 0; i < addresses.length; i++) {
      const outcome = await this.runSingleAttempt(addresses[i], commands, pinnedLine, isFirstUse, options);
      if (outcome.ok) return outcome.output;
      if (i + 1 >= addresses.length || !isTransportRetryableError(outcome.err)) {
        throw outcome.err;
      }
    }

    throw new StorageAdapterError('All SFTP addresses failed', this.providerName);
  }

  /**
   * The client connects to `address`, the one that passed the SSRF check, so a name that answers differently a
   * second time is never consulted. `HostKeyAlias` keeps the identity of the host key on the name.
   */
  private buildArgs(workDir: string, address: string, pinnedLine: string | undefined): string[] {
    const args: string[] = [
      '-F', '/dev/null',
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=10',
      '-o', `HostKeyAlias=${this.credentials.host}`,
      '-P', String(this.port),
      ...SFTP_BATCH_ARGS,
    ];
    args.push(...this.hostKeyOptions(workDir, pinnedLine));
    if (this.credentials.privateKey) {
      const keyFile = path.join(workDir, 'identity');
      fs.writeFileSync(keyFile, this.credentials.privateKey, { mode: 0o600, flag: 'wx' });
      args.push('-i', keyFile);
    }
    args.push('--', sftpDestination(address, this.credentials.username));
    return args;
  }

  /**
   * Always isolates `UserKnownHostsFile` inside `workDir` and disables global known hosts,
   * pinning either the configured/TOFU key (`StrictHostKeyChecking=yes`) or first-use capture
   * (`StrictHostKeyChecking=accept-new`).
   */
  private hostKeyOptions(workDir: string, pinnedLine: string | undefined): string[] {
    const knownHosts = path.join(workDir, 'known_hosts');
    if (!PLAIN_PATH.test(knownHosts)) {
      throw new StorageAdapterError('The temporary directory path holds a character ssh would split an option value on', this.providerName);
    }
    if (pinnedLine !== undefined) {
      fs.writeFileSync(knownHosts, pinnedLine, { mode: 0o600, flag: 'wx' });
    }
    return [
      '-o', pinnedLine === undefined ? 'StrictHostKeyChecking=accept-new' : 'StrictHostKeyChecking=yes',
      '-o', `UserKnownHostsFile=${knownHosts}`,
      '-o', 'GlobalKnownHostsFile=/dev/null',
    ];
  }

  private spawnSftp(args: string[], commands: string, workDir: string, options?: SftpBatchOptions): Promise<string> {
    return new Promise((resolve, reject) => {
      const spool = options?.spool;
      const sftpBin = fs.existsSync('/usr/bin/sftp') ? '/usr/bin/sftp' : 'sftp';
      const sandboxed = resolveSandboxedCommand(sftpBin, args, {
        networkIsolated: false,
        sandboxOptions: { keepNetwork: true },
        workDir,
        writeDirs: spool ? [workDir, path.dirname(spool.file)] : [workDir],
        readDirs: options?.readDirs,
      });
      const child = spawn(sandboxed.binary, sandboxed.args, {
        shell: false,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: sftpChildEnv(workDir),
      });

      let spoolTimer: NodeJS.Timeout | undefined;
      let killTimer: NodeJS.Timeout | undefined;
      let commandTimer: NodeJS.Timeout | undefined;
      let settled = false;
      let stoppedFor: string | undefined;
      let stoppedByOutput = false;
      let stoppedBySpool = false;
      const settle = (outcome: () => void) => {
        if (settled) return;
        settled = true;
        clearInterval(spoolTimer);
        clearTimeout(killTimer);
        clearTimeout(commandTimer);
        outcome();
      };
      /**
       * Stops the client for a reason of ours and reports it once the client has exited ('close'). The caller removes
       * the key and the spool as soon as this promise settles, so it may not settle while the client can still write.
       */
      const stop = (reason: string) => {
        if (stoppedFor !== undefined) return;
        stoppedFor = reason;
        clearInterval(spoolTimer);
        signalProcessGroup(child, 'SIGTERM');
        killTimer = setTimeout(() => signalProcessGroup(child, 'SIGKILL'), SFTP_KILL_GRACE_MS);
      };

      // spawn's own `timeout` would signal the client alone; this one stops the whole group, as every other stop does
      commandTimer = setTimeout(() => stop(`SFTP command ran longer than ${SFTP_COMMAND_TIMEOUT_MS / 1000} s`), SFTP_COMMAND_TIMEOUT_MS);

      const readStdout = collectBounded(child.stdout, () => {
        if (stoppedFor === undefined) stoppedByOutput = true;
        stop(`SFTP output passed ${SFTP_MAX_OUTPUT_BYTES} bytes`);
      });
      const readStderr = collectBounded(child.stderr, () => stop(`SFTP error output passed ${SFTP_MAX_OUTPUT_BYTES} bytes`));
      child.stdin.on('error', () => {
        // a child that never started or already exited reports its failure through 'error' and 'close'
      });

      if (spool) {
        spoolTimer = setInterval(() => {
          if (spoolSize(spool.file) > spool.maxBytes) {
            if (stoppedFor === undefined) stoppedBySpool = true;
            stop(`SFTP download passed ${spool.maxBytes} bytes`);
          }
        }, SPOOL_CHECK_INTERVAL_MS);
      }

      child.on('error', (err) => {
        settle(() => reject(new StorageAdapterError(`SFTP process failed to spawn: ${err.message}`, this.providerName, err)));
      });

      child.on('close', (code, signal) => {
        settle(() => {
          const stderrBuf = withoutProcHideNotice(readStderr());
          const refusal = confinementRefusal(code, stderrBuf);
          if (refusal !== null) {
            reject(sandboxUnavailable(refusal));
            return;
          }
          const stderr = stderrBuf.toString('utf8');
          if (stoppedFor !== undefined) {
            reject(stoppedAs(stoppedFor, { output: stoppedByOutput, spool: stoppedBySpool }, this.providerName));
          } else if (code === 0 && spool && spoolSize(spool.file) > spool.maxBytes) {
            // a transfer that finished between two measurements of the spool is held to the limit too
            reject(new SftpSpoolLimitError(`SFTP download passed ${spool.maxBytes} bytes`));
          } else if (code === 0) {
            resolve(readStdout().toString('utf8'));
          } else if (code === SFTP_CONNECTION_FAILED_EXIT && /Permission denied|Authentication failed|Host key verification failed/.test(stderr)) {
            reject(new StorageAuthenticationError(truncateSftpErrorText(stderr), this.providerName));
          } else if (code === SFTP_COMMAND_FAILED_EXIT) {
            reject(new SftpCommandFailedError(`SFTP command failed: ${truncateSftpErrorText(stderr)}`, stderr));
          } else {
            reject(new StorageAdapterError(`SFTP command ended with ${code ?? signal}: ${truncateSftpErrorText(stderr)}`, this.providerName));
          }
        });
      });

      child.stdin.write(commands);
      child.stdin.end();
    });
  }
}

/** The error of a client that was stopped for a reason of ours: the one limit that stopped it, else a plain adapter error. */
function stoppedAs(reason: string, by: { output: boolean; spool: boolean }, provider: string): StorageAdapterError {
  if (by.output) return new SftpOutputLimitError(reason);
  if (by.spool) return new SftpSpoolLimitError(reason);
  return new StorageAdapterError(reason, provider);
}

/** The size of the spool so far; the file is not there until the client opens it. */
function spoolSize(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
}

/** Collects what a stream of the child writes, up to the cap; the first chunk past it calls `onOverflow` and is dropped. */
function collectBounded(stream: NodeJS.ReadableStream, onOverflow: () => void): () => Buffer {
  const chunks: Buffer[] = [];
  let size = 0;
  stream.on('data', (chunk: Buffer | string) => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > SFTP_MAX_OUTPUT_BYTES) {
      onOverflow();
      return;
    }
    chunks.push(buf);
  });
  return () => Buffer.concat(chunks);
}
