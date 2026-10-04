import net from 'node:net';
import { S3CompatibleStorage } from '../s3-compatible-storage';
import type { S3Credentials } from '../credentials-vault';
import {
  IStorageAdapter,
  StorageAdapterMetadata,
  StorageNotFoundError,
  StorageSsrfError,
} from './adapter-interface';
import { isBlockedIpv4, isBlockedIpv6, validateUrlForSsrf } from '../../security/ssrf';

export class S3StorageAdapter implements IStorageAdapter {
  readonly providerName = 's3';
  private readonly storage: S3CompatibleStorage;

  constructor(private readonly credentials: S3Credentials) {
    if (credentials.endpoint) {
      try {
        const parsed = new URL(credentials.endpoint);
        // Synchronous check if IP or domain is private/restricted
        const host = parsed.hostname.toLowerCase();
        const ipVer = net.isIP(host);
        if (
          host === 'localhost' ||
          (ipVer === 4 && isBlockedIpv4(host)) ||
          (ipVer === 6 && isBlockedIpv6(host))
        ) {
          throw new StorageSsrfError(credentials.endpoint, 's3');
        }
      } catch (err) {
        if (err instanceof StorageSsrfError) throw err;
      }
    }

    this.storage = new S3CompatibleStorage({
      endpoint: credentials.endpoint,
      region: credentials.region,
      bucketName: credentials.bucket,
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      forcePathStyle: credentials.forcePathStyle,
    });
  }

  private async assertSsrfSafe(): Promise<void> {
    if (this.credentials.endpoint) {
      const url = new URL(this.credentials.endpoint);
      const isSafe = await validateUrlForSsrf(url);
      if (!isSafe) {
        throw new StorageSsrfError(this.credentials.endpoint, 's3');
      }
    }
  }

  async downloadStream(remotePath: string): Promise<NodeJS.ReadableStream> {
    await this.assertSsrfSafe();
    const result = await this.storage.getStream(remotePath);
    if (!result) {
      throw new StorageNotFoundError(remotePath, this.providerName);
    }
    return result.stream;
  }

  async uploadStream(
    remotePath: string,
    stream: NodeJS.ReadableStream | ReadableStream<Uint8Array>,
    options?: { contentType?: string; size?: number }
  ): Promise<StorageAdapterMetadata> {
    await this.assertSsrfSafe();
    const stored = await this.storage.putStream(remotePath, stream, {
      contentType: options?.contentType,
    });
    return {
      size: stored.size,
      etag: stored.etag,
      contentType: stored.mimeType,
      lastModified: new Date(stored.uploadedAt),
    };
  }

  async head(remotePath: string): Promise<StorageAdapterMetadata | null> {
    await this.assertSsrfSafe();
    const meta = await this.storage.head(remotePath);
    if (!meta) return null;
    return {
      size: meta.size,
      etag: meta.etag,
      contentType: meta.mimeType,
      lastModified: new Date(meta.uploadedAt),
    };
  }

  async delete(remotePath: string): Promise<boolean> {
    await this.assertSsrfSafe();
    return this.storage.delete(remotePath);
  }
}
