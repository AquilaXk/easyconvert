import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { request } from 'undici';
import type { AzureBlobCredentials } from '../credentials-vault';
import {
  IStorageAdapter,
  StorageAdapterError,
  StorageAdapterMetadata,
  StorageNotFoundError,
  StorageAuthenticationError,
  StorageSsrfError,
} from './adapter-interface';
import { createSsrfSafeAgent, validateUrlForSsrf } from '../../security/ssrf';

const AZURE_REST_VERSION = '2023-11-03';

function stripTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 47) {
    end--;
  }
  return url.slice(0, end);
}

function stripLeadingSlashes(pathStr: string): string {
  let start = 0;
  while (start < pathStr.length && pathStr.charCodeAt(start) === 47) {
    start++;
  }
  return pathStr.slice(start);
}

function encodeSafePathSegments(remotePath: string, provider: string): string {
  if (!remotePath || remotePath.includes('\\') || remotePath.includes('\0')) {
    throw new StorageAdapterError(`Invalid remote path "${remotePath}"`, provider);
  }
  const cleanPath = stripLeadingSlashes(remotePath);
  const segments = cleanPath.split('/');
  if (segments.length === 0 || segments.some((seg) => !seg || seg === '.' || seg === '..')) {
    throw new StorageAdapterError(`Path traversal or empty segment rejected in "${remotePath}"`, provider);
  }
  return segments.map((seg) => encodeURIComponent(seg)).join('/');
}

export class AzureBlobStorageAdapter implements IStorageAdapter {
  readonly providerName = 'azure-blob';
  private readonly storageAccount: string;
  private readonly containerName: string;
  private readonly accountKey?: string;
  private readonly sasToken?: string;
  private readonly baseUrl: string;

  constructor(credentials: AzureBlobCredentials) {
    this.storageAccount = credentials.storageAccount;
    this.containerName = credentials.containerName;
    this.accountKey = credentials.accountKey;
    this.sasToken = credentials.sasToken ? stripLeadingSlashes(credentials.sasToken.replace(/^\?/, '')) : undefined;

    if (credentials.customEndpoint) {
      this.baseUrl = stripTrailingSlashes(credentials.customEndpoint);
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
    const encodedPath = encodeSafePathSegments(remotePath, this.providerName);
    let url = `${this.baseUrl}/${encodeURIComponent(this.containerName)}/${encodedPath}`;
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

    const encodedPath = encodeSafePathSegments(remotePath, this.providerName);
    const canonicalizedResource = `/${this.storageAccount}/${encodeURIComponent(this.containerName)}/${encodedPath}`;

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

    const dispatcher = createSsrfSafeAgent();
    let streaming = false;
    try {
      const res = await request(url, {
        method: 'GET',
        headers,
        dispatcher,
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

      const bodyStream = res.body as unknown as NodeJS.ReadableStream;
      streaming = true;
      const closeDispatcher = () => {
        try {
          void Promise.resolve(dispatcher.close?.()).catch(() => {});
        } catch {}
      };
      bodyStream.once('close', closeDispatcher);
      bodyStream.once('end', closeDispatcher);
      bodyStream.once('error', closeDispatcher);
      return bodyStream;
    } finally {
      if (!streaming) {
        try {
          await dispatcher.close?.();
        } catch {}
      }
    }
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

    const dispatcher = createSsrfSafeAgent();
    try {
      const res = await request(url, {
        method: 'PUT',
        headers,
        body: nodeStream as any,
        dispatcher,
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
    } finally {
      try {
        await dispatcher.close?.();
      } catch {}
    }
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

    const dispatcher = createSsrfSafeAgent();
    try {
      const res = await request(url, {
        method: 'HEAD',
        headers,
        dispatcher,
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
    } finally {
      try {
        await dispatcher.close?.();
      } catch {}
    }
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

    const dispatcher = createSsrfSafeAgent();
    try {
      const res = await request(url, {
        method: 'DELETE',
        headers,
        dispatcher,
      });

      return res.statusCode === 202 || res.statusCode === 200 || res.statusCode === 204;
    } finally {
      try {
        await dispatcher.close?.();
      } catch {}
    }
  }
}
