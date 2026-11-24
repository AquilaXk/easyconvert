import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import type { AzureBlobCredentials } from '../credentials-vault';
import {
  IStorageAdapter,
  StorageAdapterError,
  StorageAdapterMetadata,
  StorageInputError,
  StorageNotFoundError,
  StorageAuthenticationError,
  StorageInvalidKeyError,
  StorageListingLimitError,
  StorageServiceError,
} from './adapter-interface';
import { remotePathProblem } from '../customer-storage-paths';
import { ADAPTER_LISTING_CAP_BYTES } from './http-limits';
import { parseAzureListBlobsXml } from './listing-xml';
import {
  adapterDispatcher,
  assertAdapterUrlSafe,
  guardedRequest,
  parseCleanBaseEndpointUrl,
  readBoundedBody,
  readErrorText,
  releaseDispatcher,
} from './http-guard';

const AZURE_REST_VERSION = '2023-11-03';
const MAX_AZURE_LIST_PAGES = 20;
const MAX_AZURE_PAGE_RESULTS = 5000;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR_MIN = 500;
const HTTP_SERVER_ERROR_MAX = 599;
const FORBIDDEN_PATH_CHAR = /[\p{Cc}\p{Zl}\p{Zp}\\]/u;

function isRetryableHttpStatus(statusCode: number): boolean {
  return statusCode === HTTP_TOO_MANY_REQUESTS || (statusCode >= HTTP_SERVER_ERROR_MIN && statusCode <= HTTP_SERVER_ERROR_MAX);
}

function compareAsciiLower(a: string, b: string): number {
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  if (al < bl) return -1;
  return al > bl ? 1 : 0;
}

function extractConnectionStringPart(connStr: string | undefined, key: string): string | undefined {
  if (!connStr) return undefined;
  for (const part of connStr.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim().toLowerCase() === key.toLowerCase()) {
      const value = part.slice(eq + 1).trim();
      if (value) return value;
    }
  }
  return undefined;
}

/** The naming rule of an Azure storage account: it becomes the host name of the default endpoint and part of the signed resource. */
export const AZURE_STORAGE_ACCOUNT_PATTERN = /^[a-z0-9]{3,24}$/;

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
  if (typeof remotePath !== 'string' || !remotePath || !remotePath.isWellFormed() || FORBIDDEN_PATH_CHAR.test(remotePath)) {
    throw new StorageInvalidKeyError(`Invalid remote path "${String(remotePath)}"`, provider);
  }
  const cleanPath = stripLeadingSlashes(remotePath);
  const segments = cleanPath.split('/');
  if (segments.length === 0 || segments.some((seg) => !seg || seg === '.' || seg === '..')) {
    throw new StorageInvalidKeyError(`Path traversal or empty segment rejected in "${remotePath}"`, provider);
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
    if (typeof credentials.storageAccount !== 'string' || !AZURE_STORAGE_ACCOUNT_PATTERN.test(credentials.storageAccount)) {
      throw new StorageAdapterError('Invalid Azure Blob storageAccount: 3 to 24 lowercase letters and digits', this.providerName);
    }
    if (
      typeof credentials.containerName !== 'string' ||
      !credentials.containerName ||
      !credentials.containerName.isWellFormed() ||
      FORBIDDEN_PATH_CHAR.test(credentials.containerName) ||
      credentials.containerName.includes('/') ||
      credentials.containerName.includes('..') ||
      credentials.containerName === '.'
    ) {
      throw new StorageInputError('Invalid Azure Blob containerName', this.providerName);
    }
    this.storageAccount = credentials.storageAccount;
    this.containerName = credentials.containerName;
    this.accountKey = credentials.accountKey ?? extractConnectionStringPart(credentials.connectionString, 'AccountKey');
    const rawSas = credentials.sasToken ?? extractConnectionStringPart(credentials.connectionString, 'SharedAccessSignature');
    this.sasToken = rawSas ? stripLeadingSlashes(rawSas.replace(/^\?/, '')) : undefined;

    if (credentials.customEndpoint) {
      parseCleanBaseEndpointUrl(credentials.customEndpoint, this.providerName);
      this.baseUrl = stripTrailingSlashes(credentials.customEndpoint);
    } else {
      this.baseUrl = `https://${this.storageAccount}.blob.core.windows.net`;
    }
  }

  private assertSsrfSafe(urlStr: string): Promise<void> {
    return assertAdapterUrlSafe(urlStr, this.providerName);
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
    contentLength = '',
    queryParams?: Readonly<Record<string, string>>
  ): void {
    if (!this.accountKey) return;

    const baseResource = remotePath
      ? `/${this.storageAccount}/${encodeURIComponent(this.containerName)}/${encodeSafePathSegments(remotePath, this.providerName)}`
      : `/${this.storageAccount}/${encodeURIComponent(this.containerName)}`;
    const queryLines = queryParams
      ? Object.keys(queryParams)
          .sort(compareAsciiLower)
          .map((k) => `${k.toLowerCase()}:${queryParams[k]}`)
      : [];
    const canonicalizedResource = queryLines.length > 0 ? `${baseResource}\n${queryLines.join('\n')}` : baseResource;

    // Canonicalize x-ms-* headers in lexicographical order
    const msHeaders = Object.keys(headers)
      .filter((k) => k.toLowerCase().startsWith('x-ms-'))
      .sort(compareAsciiLower)
      .map((k) => `${k.toLowerCase()}:${headers[k]}`)
      .join('\n');

    // Azure SharedKey (API version >= 2015-02-21) keeps Content-Length: 0 on the wire
    // while requiring an empty Content-Length line in StringToSign when the length is 0.
    const rawContentLength = contentLength || headers['Content-Length'] || '';
    const canonicalContentLength = rawContentLength === '0' ? '' : rawContentLength;

    const stringToSign = [
      method.toUpperCase(),
      headers['Content-Encoding'] || '',
      headers['Content-Language'] || '',
      canonicalContentLength,
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

    const dispatcher = adapterDispatcher(url);
    let streaming = false;
    try {
      const res = await guardedRequest(url, {
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
        const errText = await readErrorText(res.body, this.providerName);
        throw new StorageServiceError(`[AzureBlobAdapter] Download failed (${res.statusCode}): ${errText}`, this.providerName, {
          statusCode: res.statusCode,
          retryable: isRetryableHttpStatus(res.statusCode),
        });
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
        await releaseDispatcher(dispatcher);
      }
    }
  }

  async uploadStream(
    remotePath: string,
    stream: NodeJS.ReadableStream | ReadableStream<Uint8Array>,
    options?: { contentType?: string; size?: number }
  ): Promise<StorageAdapterMetadata> {
    if (options?.size !== undefined && (!Number.isFinite(options.size) || !Number.isInteger(options.size) || options.size < 0)) {
      throw new StorageInputError(`Invalid upload size: ${options.size}`, this.providerName);
    }
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

    const dispatcher = adapterDispatcher(url);
    try {
      const res = await guardedRequest(url, {
        method: 'PUT',
        headers,
        body: nodeStream as any,
        dispatcher,
      });

      if (res.statusCode === 401 || res.statusCode === 403) {
        throw new StorageAuthenticationError(`HTTP ${res.statusCode}`, this.providerName);
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        const errText = await readErrorText(res.body, this.providerName);
        throw new StorageServiceError(`[AzureBlobAdapter] Upload failed (${res.statusCode}): ${errText}`, this.providerName, {
          statusCode: res.statusCode,
          retryable: isRetryableHttpStatus(res.statusCode),
        });
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
      await releaseDispatcher(dispatcher);
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

    const dispatcher = adapterDispatcher(url);
    try {
      const res = await guardedRequest(url, {
        method: 'HEAD',
        headers,
        dispatcher,
      });

      if (res.statusCode === 404) return null;
      if (res.statusCode === 401 || res.statusCode === 403) {
        throw new StorageAuthenticationError(`HTTP ${res.statusCode}`, this.providerName);
      }
      if (isRetryableHttpStatus(res.statusCode)) {
        const errText = await readErrorText(res.body, this.providerName);
        throw new StorageServiceError(`[AzureBlobAdapter] Head failed (${res.statusCode}): ${errText}`, this.providerName, {
          statusCode: res.statusCode,
          retryable: true,
        });
      }
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
      await releaseDispatcher(dispatcher);
    }
  }

  async listObjects(prefix: string, maxFiles: number): Promise<Array<{ path: string; size: number }>> {
    const prefixProblem = remotePathProblem(prefix, { allowEmpty: true });
    if (prefixProblem) {
      throw new StorageInvalidKeyError(`prefix ${prefixProblem}`, this.providerName);
    }
    const cleanPrefix = stripLeadingSlashes(prefix);
    const files: Array<{ path: string; size: number }> = [];
    let marker: string | undefined;

    for (let page = 0; page < MAX_AZURE_LIST_PAGES; page++) {
      const signParams: Record<string, string> = {
        comp: 'list',
        maxresults: String(Math.min(MAX_AZURE_PAGE_RESULTS, Math.max(1, maxFiles) + 1)),
        restype: 'container',
      };
      if (cleanPrefix) signParams.prefix = cleanPrefix;
      if (marker) signParams.marker = marker;

      const query = new URLSearchParams(signParams);
      const querySuffix = this.sasToken ? `${query.toString()}&${this.sasToken}` : query.toString();
      const url = `${this.baseUrl}/${encodeURIComponent(this.containerName)}?${querySuffix}`;
      await this.assertSsrfSafe(url);

      const headers: Record<string, string> = {
        'x-ms-version': AZURE_REST_VERSION,
        'x-ms-date': new Date().toUTCString(),
      };
      if (this.accountKey && !this.sasToken) {
        this.signSharedKey('GET', '', headers, '', signParams);
      }

      const dispatcher = adapterDispatcher(url);
      try {
        const res = await guardedRequest(url, { method: 'GET', headers, dispatcher });
        if (res.statusCode === 404) throw new StorageNotFoundError(cleanPrefix || this.containerName, this.providerName);
        if (res.statusCode === 401 || res.statusCode === 403) {
          throw new StorageAuthenticationError(`HTTP ${res.statusCode}`, this.providerName);
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const errText = await readErrorText(res.body, this.providerName);
          throw new StorageServiceError(`[AzureBlobAdapter] List failed (${res.statusCode}): ${errText}`, this.providerName, {
            statusCode: res.statusCode,
            retryable: isRetryableHttpStatus(res.statusCode),
          });
        }

        const { text, truncated } = await readBoundedBody(res.body, this.providerName, ADAPTER_LISTING_CAP_BYTES);
        if (truncated) {
          throw new StorageServiceError(`The ${this.providerName} listing answer is longer than ${ADAPTER_LISTING_CAP_BYTES} bytes`, this.providerName, {
            retryable: false,
          });
        }
        const parsed = parseAzureListBlobsXml(text);
        for (const blob of parsed.blobs) {
          if (!blob.name || blob.name.endsWith('/')) continue;
          files.push({ path: blob.name, size: blob.size });
          if (files.length > maxFiles) {
            throw new StorageListingLimitError(maxFiles, this.providerName);
          }
        }
        if (!parsed.nextMarker) return files;
        marker = parsed.nextMarker;
      } finally {
        await releaseDispatcher(dispatcher);
      }
    }

    throw new StorageServiceError(`The listing did not finish within ${MAX_AZURE_LIST_PAGES} pages`, this.providerName, { retryable: false });
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

    const dispatcher = adapterDispatcher(url);
    try {
      const res = await guardedRequest(url, {
        method: 'DELETE',
        headers,
        dispatcher,
      });

      if (res.statusCode === 202 || res.statusCode === 200 || res.statusCode === 204) {
        return true;
      }
      if (res.statusCode === 401 || res.statusCode === 403) {
        throw new StorageAuthenticationError(`HTTP ${res.statusCode}`, this.providerName);
      }
      if (isRetryableHttpStatus(res.statusCode)) {
        const errText = await readErrorText(res.body, this.providerName);
        throw new StorageServiceError(`[AzureBlobAdapter] Delete failed (${res.statusCode}): ${errText}`, this.providerName, {
          statusCode: res.statusCode,
          retryable: true,
        });
      }
      return false;
    } finally {
      await releaseDispatcher(dispatcher);
    }
  }
}
