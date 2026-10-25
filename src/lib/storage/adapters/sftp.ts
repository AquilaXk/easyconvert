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
import {
  assertSftpPort,
  normalizeBasePath,
  resolveRemotePath,
  sftpBatch,
  sftpChildEnv,
  sftpCommandLine,
  sftpDestination,
} from './sftp-protocol';

const streamPipeline = promisify(pipeline);

/** A hung connection or a stalled transfer is killed after this long, so its key file and the process do not outlive the request. */
const SFTP_COMMAND_TIMEOUT_MS = 15 * 60_000;

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
  private readonly destination: string;
  private readonly basePath: string;

  constructor(private readonly credentials: SftpCredentials) {
    this.port = assertSftpPort(credentials.port ?? 22);
    this.destination = sftpDestination(credentials.host, credentials.username);
    this.basePath = normalizeBasePath(credentials.basePath);
  }

  private async assertSsrfSafe(): Promise<void> {
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
    } catch (err) {
      if (err instanceof StorageSsrfError) throw err;
      throw new StorageAdapterError(`DNS lookup failed for ${host}: ${String(err)}`, this.providerName);
    }
  }

  async downloadStream(remotePath: string): Promise<NodeJS.ReadableStream> {
    await this.assertSsrfSafe();
    const resolved = resolveRemotePath(this.basePath, remotePath);

    // Spool download through safe temp file to guarantee zero Next.js heap buffering
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'easyconvert-sftp-down-'));
    const localTmp = path.join(tmpDir, 'downloaded.tmp');

    try {
      await this.runSftpBatch(sftpBatch(sftpCommandLine('get', resolved, localTmp)));
      if (!fs.existsSync(localTmp)) {
        throw new StorageNotFoundError(remotePath, this.providerName);
      }
    } catch (err) {
      removeDirQuietly(tmpDir);
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
    await this.assertSsrfSafe();
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

      await this.runSftpBatch(batchScript);

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
    await this.assertSsrfSafe();
    const resolved = resolveRemotePath(this.basePath, remotePath);

    const batchScript = sftpBatch(sftpCommandLine('ls -l', resolved));
    try {
      const output = await this.runSftpBatch(batchScript);
      if (!output || output.includes('not found') || output.includes('No such file')) {
        return null;
      }
      // Parse ls -l line: -rw-r--r-- 1 user group 123456 Oct 04 10:00 filename
      const lsRegex = /[-rwx]{10}\s+\d+\s+\S+\s+\S+\s+(\d+)\s+/;
      const match = lsRegex.exec(output);
      const size = match ? Number.parseInt(match[1], 10) : 0;
      return {
        size,
        lastModified: new Date(),
      };
    } catch {
      return null;
    }
  }

  async delete(remotePath: string): Promise<boolean> {
    await this.assertSsrfSafe();
    const resolved = resolveRemotePath(this.basePath, remotePath);

    const batchScript = sftpBatch(sftpCommandLine('rm', resolved));
    try {
      await this.runSftpBatch(batchScript);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Runs one sftp session. The private key and the child's HOME live in a directory of this call
   * (mkdtemp makes it 0700) that is removed on every way out: success, a failed exit, a spawn failure and
   * a kill by the timeout.
   */
  private async runSftpBatch(commands: string): Promise<string> {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'easyconvert-sftp-run-'));
    try {
      return await this.spawnSftp(this.buildArgs(workDir), commands, workDir);
    } finally {
      removeDirQuietly(workDir);
    }
  }

  private buildArgs(workDir: string): string[] {
    const args: string[] = [
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'ConnectTimeout=10',
      '-P', String(this.port),
    ];
    if (this.credentials.privateKey) {
      const keyFile = path.join(workDir, 'identity');
      fs.writeFileSync(keyFile, this.credentials.privateKey, { mode: 0o600, flag: 'wx' });
      args.push('-i', keyFile);
    }
    args.push('--', this.destination);
    return args;
  }

  private spawnSftp(args: string[], commands: string, workDir: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const sftpBin = fs.existsSync('/usr/bin/sftp') ? '/usr/bin/sftp' : 'sftp';
      const child = spawn(sftpBin, args, {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: sftpChildEnv(workDir),
        timeout: SFTP_COMMAND_TIMEOUT_MS,
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (d) => {
        stdout += d.toString();
      });
      child.stderr.on('data', (d) => {
        stderr += d.toString();
      });
      child.stdin.on('error', () => {
        // a child that never started or already exited reports its failure through 'error' and 'close'
      });

      child.on('error', (err) => {
        reject(new StorageAdapterError(`SFTP process failed to spawn: ${err.message}`, this.providerName, err));
      });

      child.on('close', (code, signal) => {
        if (code === 0) {
          resolve(stdout);
        } else if (stderr.includes('Permission denied') || stderr.includes('Authentication failed')) {
          reject(new StorageAuthenticationError(stderr.trim(), this.providerName));
        } else if (stderr.includes('No such file') || stderr.includes('not found')) {
          reject(new StorageNotFoundError(commands, this.providerName));
        } else {
          reject(new StorageAdapterError(`SFTP command ended with ${code ?? signal}: ${stderr}`, this.providerName));
        }
      });

      child.stdin.write(commands);
      child.stdin.end();
    });
  }
}
