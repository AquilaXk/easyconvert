import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { request } from 'undici';
import type { AzureBlobCredentials } from '../credentials-vault';
import {
  IStorageAdapter,
  StorageAdapterMetadata,
  StorageNotFoundError,
  StorageAuthenticationError,
  StorageSsrfError,
} from './adapter-interface';
import { createSsrfSafeAgent, validateUrlForSsrf } from '../../security/ssrf';

const AZURE_REST_VERSION = '2023-11-03';

export class AzureBlobStorageAdapter implements IStorageAdapter {
  readonly providerName = 'azure-blob';
  private storageAccount: string;
  private containerName: string;
  private accountKey?: string;
  private sasToken?: string;
  private baseUrl: string;

  constructor(credentials: AzureBlobCredentials) {
    this.storageAccount = credentials.storageAccount;
    this.containerName = credentials.containerName;
    this.accountKey = credentials.accountKey;
    this.sasToken = credentials.sasToken?.replace(/^\?/, '');

    if (credentials.customEndpoint) {
      this.baseUrl = credentials.customEndpoint.replace(/\/+$/, '');
    } else {
      this.baseUrl = `https://${this.storageAccount}.blob.core.windows.net`;
    }
  }

  private async assertSsrfSafe(urlStr: string): Promise<void> {
    const url = new URL(urlStr);
    const safe = await validateUrlForSsrf(url);
    if (!safe) {
      throw new StorageSsrfError(urlStr, this.providerName);
    }
  }

  private buildUrl(remotePath: string): string {
    const cleanPath = remotePath.replace(/^\/+/, '');
    let url = `${this.baseUrl}/${encodeURIComponent(this.containerName)}/${encodeURI(cleanPath)}`;
    if (this.sasToken) {
      url += `?${this.sasToken}`;
    }
    return url;
  }

  private signSharedKey(
    method: string,
    remotePath: string,
    headers: Record<string, string>,
    contentLength = ''
  ): void {
    if (!this.accountKey) return;

    const cleanPath = remotePath.replace(/^\/+/, '');
    const canonicalizedResource = `/${this.storageAccount}/${this.containerName}/${cleanPath}`;

    // Canonicalize x-ms-* headers in lexicographical order
    const msHeaders = Object.keys(headers)
      .filter((k) => k.toLowerCase().startsWith('x-ms-'))
      .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
      .map((k) => `${k.toLowerCase()}:${headers[k]}`)
      .join('\n');

    const stringToSign = [
      method.toUpperCase(),
      headers['Content-Encoding'] || '',
      headers['Content-Language'] || '',
      contentLength,
      headers['Content-MD5'] || '',
      headers['Content-Type'] || '',
      '', // Date is empty if x-ms-date is set
      headers['If-Modified-Since'] || '',
      headers['If-Match'] || '',
      headers['If-None-Match'] || '',
      headers['If-Unmodified-Since'] || '',
      headers['Range'] || '',
      msHeaders,
      canonicalizedResource,
    ].join('\n');

    const keyBuf = Buffer.from(this.accountKey, 'base64');
    const signature = crypto
      .createHmac('sha256', keyBuf)
      .update(stringToSign, 'utf-8')
      .digest('base64');

    headers.Authorization = `SharedKey ${this.storageAccount}:${signature}`;
  }

  async downloadStream(remotePath: string): Promise<NodeJS.ReadableStream> {
    const url = this.buildUrl(remotePath);
    await this.assertSsrfSafe(url);

    const headers: Record<string, string> = {
      'x-ms-version': AZURE_REST_VERSION,
      'x-ms-date': new Date().toUTCString(),
    };

    if (this.accountKey && !this.sasToken) {
      this.signSharedKey('GET', remotePath, headers);
    }

    const res = await request(url, {
      method: 'GET',
      headers,
      dispatcher: createSsrfSafeAgent(),
    });

    if (res.statusCode === 404) {
      throw new StorageNotFoundError(remotePath, this.providerName);
    }
    if (res.statusCode === 401 || res.statusCode === 403) {
      throw new StorageAuthenticationError(`HTTP ${res.statusCode}`, this.providerName);
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      const errText = await res.body.text();
      throw new Error(`[AzureBlobAdapter] Download failed (${res.statusCode}): ${errText}`);
    }

    return res.body as unknown as NodeJS.ReadableStream;
  }

  async uploadStream(
    remotePath: string,
    stream: NodeJS.ReadableStream | ReadableStream<Uint8Array>,
    options?: { contentType?: string; size?: number }
  ): Promise<StorageAdapterMetadata> {
    const url = this.buildUrl(remotePath);
    await this.assertSsrfSafe(url);

    const headers: Record<string, string> = {
      'x-ms-version': AZURE_REST_VERSION,
      'x-ms-date': new Date().toUTCString(),
      'x-ms-blob-type': 'BlockBlob',
      'Content-Type': options?.contentType || 'application/octet-stream',
    };

    const lenStr = typeof options?.size === 'number' ? String(options.size) : '';
    if (lenStr) {
      headers['Content-Length'] = lenStr;
    }

    if (this.accountKey && !this.sasToken) {
      this.signSharedKey('PUT', remotePath, headers, lenStr);
    }

    let nodeStream: NodeJS.ReadableStream;
    if ('getReader' in stream) {
      nodeStream = Readable.fromWeb(stream as import('node:stream/web').ReadableStream);
    } else {
      nodeStream = stream;
    }

    const res = await request(url, {
      method: 'PUT',
      headers,
      body: nodeStream as any,
      dispatcher: createSsrfSafeAgent(),
    });

    if (res.statusCode < 200 || res.statusCode >= 300) {
      const errText = await res.body.text();
      throw new Error(`[AzureBlobAdapter] Upload failed (${res.statusCode}): ${errText}`);
    }

    const etag = (res.headers.etag as string | undefined)?.replace(/"/g, '');
    const lastModifiedHeader = res.headers['last-modified'] as string | undefined;

    return {
      size: options?.size || 0,
      etag,
      contentType: options?.contentType,
      lastModified: lastModifiedHeader ? new Date(lastModifiedHeader) : new Date(),
    };
  }

  async head(remotePath: string): Promise<StorageAdapterMetadata | null> {
    const url = this.buildUrl(remotePath);
    await this.assertSsrfSafe(url);

    const headers: Record<string, string> = {
      'x-ms-version': AZURE_REST_VERSION,
      'x-ms-date': new Date().toUTCString(),
    };

    if (this.accountKey && !this.sasToken) {
      this.signSharedKey('HEAD', remotePath, headers);
    }

    const res = await request(url, {
      method: 'HEAD',
      headers,
      dispatcher: createSsrfSafeAgent(),
    });

    if (res.statusCode === 404) return null;
    if (res.statusCode < 200 || res.statusCode >= 300) return null;

    const lenStr = res.headers['content-length'] as string | undefined;
    const size = lenStr ? Number.parseInt(lenStr, 10) : 0;
    const etag = (res.headers.etag as string | undefined)?.replace(/"/g, '');
    const contentType = res.headers['content-type'] as string | undefined;
    const lastModified = res.headers['last-modified'] as string | undefined;

    return {
      size,
      etag,
      contentType,
      lastModified: lastModified ? new Date(lastModified) : undefined,
    };
  }

  async delete(remotePath: string): Promise<boolean> {
    const url = this.buildUrl(remotePath);
    await this.assertSsrfSafe(url);

    const headers: Record<string, string> = {
      'x-ms-version': AZURE_REST_VERSION,
      'x-ms-date': new Date().toUTCString(),
    };

    if (this.accountKey && !this.sasToken) {
      this.signSharedKey('DELETE', remotePath, headers);
    }

    const res = await request(url, {
      method: 'DELETE',
      headers,
      dispatcher: createSsrfSafeAgent(),
    });

    return res.statusCode === 202 || res.statusCode === 200 || res.statusCode === 204;
  }
}
