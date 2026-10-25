import dns from 'node:dns';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable, pipeline } from 'node:stream';
import { promisify } from 'node:util';
import type { SftpCredentials } from '../credentials-vault';
import {
  IStorageAdapter,
  StorageAdapterMetadata,
  StorageNotFoundError,
  StorageAuthenticationError,
  StorageSsrfError,
  StorageAdapterError,
} from './adapter-interface';
import { isPrivateOrRestrictedHost, isBlockedIp } from '../../security/ssrf';
import { REMOTE_STAGED_OBJECT_MAX_BYTES } from '../remote-storage-backend';
import {
  SFTP_BATCH_ARGS,
  SFTP_COMMAND_FAILED_EXIT,
  SFTP_CONNECTION_FAILED_EXIT,
  SFTP_MAX_OUTPUT_BYTES,
  assertSftpPort,
  isSftpNotFound,
  normalizeBasePath,
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

/** A hung connection or a stalled transfer is killed after this long, so its key file and the process do not outlive the request. */
const SFTP_COMMAND_TIMEOUT_MS = 15 * 60_000;

/**
 * A `get` is the one call that writes a file the server decides the size of. It may not grow past the largest object
 * the object store stages to scratch disk, and is measured this often, so it can pass the cap by what one interval writes.
 */
const SFTP_MAX_SPOOL_BYTES = REMOTE_STAGED_OBJECT_MAX_BYTES;
const SPOOL_CHECK_INTERVAL_MS = 100;

/** The known hosts file is named in an `-o` value, which `ssh` splits on spaces and quotes. */
const PLAIN_PATH = /^[A-Za-z0-9_/.+-]+$/;

interface Spool {
  file: string;
  maxBytes: number;
}

/** The client ran and a command of the batch failed (exit 1): a missing file, a refused write, a directory that is not there. */
class SftpCommandFailedError extends StorageAdapterError {
  constructor(message: string, public readonly stderr: string) {
    super(message, 'sftp');
    this.name = 'SftpCommandFailedError';
  }
}

function removeDirQuietly(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // a directory that cannot be removed now is swept with the temp directory
  }
}

export class SftpStorageAdapter implements IStorageAdapter {
  readonly providerName = 'sftp';
  private readonly port: number;
  private readonly basePath: string;
  private readonly knownHostsLine: string | undefined;

  constructor(private readonly credentials: SftpCredentials) {
    this.port = assertSftpPort(credentials.port ?? 22);
    sftpDestination(credentials.host, credentials.username);
    this.basePath = normalizeBasePath(credentials.basePath);
    this.knownHostsLine = credentials.hostKey === undefined ? undefined : sftpKnownHostsLine(credentials.hostKey);
  }

  /** The address the client is told to connect to: the first the name resolves to, after every address passed the check. */
  private async resolveAllowedAddress(): Promise<string> {
    const host = this.credentials.host;
    if (isPrivateOrRestrictedHost(host)) {
      throw new StorageSsrfError(host, this.providerName);
    }

    try {
      const addresses = await dns.promises.lookup(host, { all: true });
      if (!addresses || addresses.length === 0) {
        throw new StorageSsrfError(`Could not resolve host ${host}`, this.providerName);
      }
      for (const addr of addresses) {
        if (isBlockedIp(addr.address)) {
          throw new StorageSsrfError(`${host} resolves to restricted IP ${addr.address}`, this.providerName);
        }
      }
      return addresses[0].address;
    } catch (err) {
      if (err instanceof StorageSsrfError) throw err;
      throw new StorageAdapterError(`DNS lookup failed for ${host}: ${String(err)}`, this.providerName);
    }
  }

  async downloadStream(remotePath: string): Promise<NodeJS.ReadableStream> {
    const address = await this.resolveAllowedAddress();
    const resolved = resolveRemotePath(this.basePath, remotePath);

    // Spool download through safe temp file to guarantee zero Next.js heap buffering
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'easyconvert-sftp-down-'));
    const localTmp = path.join(tmpDir, 'downloaded.tmp');

    try {
      await this.runSftpBatch(address, sftpBatch(sftpCommandLine('get', resolved, localTmp)), {
        file: localTmp,
        maxBytes: SFTP_MAX_SPOOL_BYTES,
      });
    } catch (err) {
      removeDirQuietly(tmpDir);
      if (err instanceof SftpCommandFailedError && isSftpNotFound(err.stderr)) {
        throw new StorageNotFoundError(remotePath, this.providerName);
      }
      throw err;
    }

    const readStream = fs.createReadStream(localTmp);
    readStream.on('close', () => removeDirQuietly(tmpDir));

    return readStream;
  }

  async uploadStream(
    remotePath: string,
    stream: NodeJS.ReadableStream | ReadableStream<Uint8Array>,
    options?: { contentType?: string; size?: number }
  ): Promise<StorageAdapterMetadata> {
    const address = await this.resolveAllowedAddress();
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

      await streamPipeline(nodeStream, fs.createWriteStream(localTmp));
      const stats = fs.statSync(localTmp);

      await this.runSftpBatch(address, batchScript);

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
    const address = await this.resolveAllowedAddress();
    const resolved = resolveRemotePath(this.basePath, remotePath);

    let output: string;
    try {
      output = await this.runSftpBatch(address, sftpBatch(sftpCommandLine('ls -l', resolved)));
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

  async delete(remotePath: string): Promise<boolean> {
    const address = await this.resolveAllowedAddress();
    const resolved = resolveRemotePath(this.basePath, remotePath);

    try {
      await this.runSftpBatch(address, sftpBatch(sftpCommandLine('rm', resolved)));
      return true;
    } catch (err) {
      if (err instanceof SftpCommandFailedError) return false;
      throw err;
    }
  }

  /**
   * Runs one sftp session. The private key, the pinned host key and the child's HOME live in a directory of this
   * call (mkdtemp makes it 0700) that is removed on every way out: success, a failed exit, a spawn failure and
   * a kill by the timeout.
   */
  private async runSftpBatch(address: string, commands: string, spool?: Spool): Promise<string> {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'easyconvert-sftp-run-'));
    try {
      return await this.spawnSftp(this.buildArgs(workDir, address), commands, workDir, spool);
    } finally {
      removeDirQuietly(workDir);
    }
  }

  /**
   * The client connects to `address`, the one that passed the SSRF check, so a name that answers differently a
   * second time is never consulted. `HostKeyAlias` keeps the identity of the host key on the name.
   */
  private buildArgs(workDir: string, address: string): string[] {
    const args: string[] = [
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=10',
      '-o', `HostKeyAlias=${this.credentials.host}`,
      '-P', String(this.port),
      ...SFTP_BATCH_ARGS,
    ];
    args.push(...this.hostKeyOptions(workDir));
    if (this.credentials.privateKey) {
      const keyFile = path.join(workDir, 'identity');
      fs.writeFileSync(keyFile, this.credentials.privateKey, { mode: 0o600, flag: 'wx' });
      args.push('-i', keyFile);
    }
    args.push('--', sftpDestination(address, this.credentials.username));
    return args;
  }

  /**
   * With a pinned key the call trusts that key and no other: it is the only known hosts file read, and a host that
   * shows another key is refused. Without one a key is accepted on first use, as before.
   */
  private hostKeyOptions(workDir: string): string[] {
    if (this.knownHostsLine === undefined) return ['-o', 'StrictHostKeyChecking=accept-new'];
    const knownHosts = path.join(workDir, 'known_hosts');
    if (!PLAIN_PATH.test(knownHosts)) {
      throw new StorageAdapterError('The temporary directory path holds a character ssh would split an option value on', this.providerName);
    }
    fs.writeFileSync(knownHosts, this.knownHostsLine, { mode: 0o600, flag: 'wx' });
    return [
      '-o', 'StrictHostKeyChecking=yes',
      '-o', `UserKnownHostsFile=${knownHosts}`,
      '-o', 'GlobalKnownHostsFile=/dev/null',
    ];
  }

  private spawnSftp(args: string[], commands: string, workDir: string, spool?: Spool): Promise<string> {
    return new Promise((resolve, reject) => {
      const sftpBin = fs.existsSync('/usr/bin/sftp') ? '/usr/bin/sftp' : 'sftp';
      const child = spawn(sftpBin, args, {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: sftpChildEnv(workDir),
        timeout: SFTP_COMMAND_TIMEOUT_MS,
      });

      let spoolTimer: NodeJS.Timeout | undefined;
      let settled = false;
      const settle = (outcome: () => void) => {
        if (settled) return;
        settled = true;
        clearInterval(spoolTimer);
        outcome();
      };
      const stop = (reason: string) => {
        settle(() => reject(new StorageAdapterError(reason, this.providerName)));
        child.kill('SIGTERM');
      };

      const readStdout = collectBounded(child.stdout, () => stop(`SFTP output passed ${SFTP_MAX_OUTPUT_BYTES} bytes`));
      const readStderr = collectBounded(child.stderr, () => stop(`SFTP error output passed ${SFTP_MAX_OUTPUT_BYTES} bytes`));
      child.stdin.on('error', () => {
        // a child that never started or already exited reports its failure through 'error' and 'close'
      });

      if (spool) {
        spoolTimer = setInterval(() => {
          if (spoolSize(spool.file) > spool.maxBytes) stop(`SFTP download passed ${spool.maxBytes} bytes`);
        }, SPOOL_CHECK_INTERVAL_MS);
      }

      child.on('error', (err) => {
        settle(() => reject(new StorageAdapterError(`SFTP process failed to spawn: ${err.message}`, this.providerName, err)));
      });

      child.on('close', (code, signal) => {
        settle(() => {
          const stderr = readStderr();
          if (code === 0) {
            resolve(readStdout());
          } else if (code === SFTP_CONNECTION_FAILED_EXIT && /Permission denied|Authentication failed/.test(stderr)) {
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
function collectBounded(stream: NodeJS.ReadableStream, onOverflow: () => void): () => string {
  const chunks: Buffer[] = [];
  let size = 0;
  stream.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > SFTP_MAX_OUTPUT_BYTES) {
      onOverflow();
      return;
    }
    chunks.push(chunk);
  });
  return () => Buffer.concat(chunks).toString('utf8');
}
