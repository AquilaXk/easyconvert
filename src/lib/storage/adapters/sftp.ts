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

const streamPipeline = promisify(pipeline);

export class SftpStorageAdapter implements IStorageAdapter {
  readonly providerName = 'sftp';
  private port: number;

  constructor(private credentials: SftpCredentials) {
    this.port = credentials.port || 22;
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

  private resolveRemotePath(remotePath: string): string {
    const clean = remotePath.replace(/^\/+/, '');
    if (this.credentials.basePath) {
      const base = this.credentials.basePath.replace(/\/+$/, '');
      return `${base}/${clean}`;
    }
    return `/${clean}`;
  }

  async downloadStream(remotePath: string): Promise<NodeJS.ReadableStream> {
    await this.assertSsrfSafe();
    const resolved = this.resolveRemotePath(remotePath);

    // Spool download through safe temp file to guarantee zero Next.js heap buffering
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'easyconvert-sftp-down-'));
    const localTmp = path.join(tmpDir, 'downloaded.tmp');

    const batchScript = `get "${resolved}" "${localTmp}"\nquit\n`;
    await this.runSftpBatch(batchScript);

    if (!fs.existsSync(localTmp)) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
      throw new StorageNotFoundError(remotePath, this.providerName);
    }

    const readStream = fs.createReadStream(localTmp);
    readStream.on('close', () => {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    });

    return readStream;
  }

  async uploadStream(
    remotePath: string,
    stream: NodeJS.ReadableStream | ReadableStream<Uint8Array>,
    options?: { contentType?: string; size?: number }
  ): Promise<StorageAdapterMetadata> {
    await this.assertSsrfSafe();
    const resolved = this.resolveRemotePath(remotePath);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'easyconvert-sftp-up-'));
    const localTmp = path.join(tmpDir, 'upload.tmp');

    try {
      let nodeStream: NodeJS.ReadableStream;
      if ('getReader' in stream) {
        nodeStream = Readable.fromWeb(stream as import('node:stream/web').ReadableStream);
      } else {
        nodeStream = stream;
      }

      await streamPipeline(nodeStream, fs.createWriteStream(localTmp));
      const stats = fs.statSync(localTmp);

      const batchScript = `put "${localTmp}" "${resolved}"\nquit\n`;
      await this.runSftpBatch(batchScript);

      return {
        size: stats.size,
        contentType: options?.contentType,
        lastModified: new Date(),
      };
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }

  async head(remotePath: string): Promise<StorageAdapterMetadata | null> {
    await this.assertSsrfSafe();
    const resolved = this.resolveRemotePath(remotePath);

    const batchScript = `ls -l "${resolved}"\nquit\n`;
    try {
      const output = await this.runSftpBatch(batchScript);
      if (!output || output.includes('not found') || output.includes('No such file')) {
        return null;
      }
      // Parse ls -l line: -rw-r--r-- 1 user group 123456 Oct 04 10:00 filename
      const match = output.match(/[-rwx]{10}\s+\d+\s+\S+\s+\S+\s+(\d+)\s+/);
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
    const resolved = this.resolveRemotePath(remotePath);

    const batchScript = `rm "${resolved}"\nquit\n`;
    try {
      await this.runSftpBatch(batchScript);
      return true;
    } catch {
      return false;
    }
  }

  private async runSftpBatch(commands: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const args: string[] = [
        '-o', 'BatchMode=yes',
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', 'ConnectTimeout=10',
        '-P', String(this.port),
      ];

      if (this.credentials.privateKey) {
        const keyTmp = path.join(os.tmpdir(), `sftp-key-${Date.now()}.tmp`);
        fs.writeFileSync(keyTmp, this.credentials.privateKey, { mode: 0o600 });
        args.push('-i', keyTmp);
      }

      const destination = `${this.credentials.username}@${this.credentials.host}`;
      args.push(destination);

      const child = spawn('sftp', args, {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (d) => {
        stdout += d.toString();
      });
      child.stderr.on('data', (d) => {
        stderr += d.toString();
      });

      child.on('error', (err) => {
        reject(new StorageAdapterError(`SFTP process failed to spawn: ${err.message}`, this.providerName, err));
      });

      child.on('close', (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          if (stderr.includes('Permission denied') || stderr.includes('Authentication failed')) {
            reject(new StorageAuthenticationError(stderr.trim(), this.providerName));
          } else if (stderr.includes('No such file') || stderr.includes('not found')) {
            reject(new StorageNotFoundError(commands, this.providerName));
          } else {
            reject(new StorageAdapterError(`SFTP command exited with code ${code}: ${stderr}`, this.providerName));
          }
        }
      });

      child.stdin.write(commands);
      child.stdin.end();
    });
  }
}
