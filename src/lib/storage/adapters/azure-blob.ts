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
  CONTROL_OR_LINE_CHAR,
  adapterDispatcher,
  assertAdapterUrlSafe,
  assertCredentialsObject,
  assertValidAzureContainerName,
  assertValidMaxFiles,
  assertValidUploadSize,
  encodeSafePathSegments,
  guardedRequest,
  isRetryableHttpStatus,
  mapAdapterTransportError,
  parseCleanBaseEndpointUrl,
  parseNonNegativeInt,
  parseValidDate,
  readBoundedBody,
  readErrorText,
  readHeaderString,
  releaseDispatcher,
  stripLeadingSlashes,
  stripTrailingSlashes,
} from './http-guard';

const AZURE_REST_VERSION = '2023-11-03';
const MAX_AZURE_LIST_PAGES = 20;
const MAX_AZURE_PAGE_RESULTS = 5000;

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

function normalizeAzureSasToken(rawSas: string | undefined, provider: string): string | undefined {
  if (rawSas === undefined || rawSas === '') return undefined;
  if (!rawSas.isWellFormed() || CONTROL_OR_LINE_CHAR.test(rawSas)) {
    throw new StorageInputError('Invalid Azure Blob sasToken: control characters or unpaired surrogates are not permitted', provider);
  }
  const cleaned = stripLeadingSlashes(rawSas.replace(/^\?/, ''));
  if (!cleaned || /[\s#]/.test(cleaned)) {
    throw new StorageInputError('Invalid Azure Blob sasToken: whitespace and fragments are not permitted', provider);
  }
  return cleaned;
}

export function resolveAzureBlobAuthFields(
  credentials: AzureBlobCredentials,
  provider = 'azure-blob'
): { accountKey?: string; sasToken?: string } {
  assertCredentialsObject(credentials, provider);
  if (typeof credentials.storageAccount !== 'string' || !AZURE_STORAGE_ACCOUNT_PATTERN.test(credentials.storageAccount)) {
    throw new StorageAdapterError('Invalid Azure Blob storageAccount: 3 to 24 lowercase letters and digits', provider);
  }
  assertValidAzureContainerName(credentials.containerName, provider);
  if (credentials.accountKey !== undefined && typeof credentials.accountKey !== 'string') {
    throw new StorageInputError('Invalid Azure Blob accountKey: expected string', provider);
  }
  if (credentials.accountKey !== undefined && credentials.accountKey.length > 0 && !credentials.accountKey.trim()) {
    throw new StorageInputError('Invalid Azure Blob accountKey: expected non-whitespace string', provider);
  }
  if (credentials.sasToken !== undefined && typeof credentials.sasToken !== 'string') {
    throw new StorageInputError('Invalid Azure Blob sasToken: expected string', provider);
  }
  if (credentials.connectionString !== undefined && typeof credentials.connectionString !== 'string') {
    throw new StorageInputError('Invalid Azure Blob connectionString: expected string', provider);
  }
  const accountKey = (credentials.accountKey || undefined) ?? extractConnectionStringPart(credentials.connectionString, 'AccountKey');
  const rawSas = (credentials.sasToken === '' ? undefined : credentials.sasToken) ?? extractConnectionStringPart(credentials.connectionString, 'SharedAccessSignature');
  return { accountKey, sasToken: normalizeAzureSasToken(rawSas, provider) };
}

export class AzureBlobStorageAdapter implements IStorageAdapter {
  readonly providerName = 'azure-blob';
  private readonly storageAccount: string;
  private readonly containerName: string;
  private readonly accountKey?: string;
  private readonly sasToken?: string;
  private readonly baseUrl: string;

  constructor(credentials: AzureBlobCredentials) {
    const auth = resolveAzureBlobAuthFields(credentials, this.providerName);
    this.storageAccount = credentials.storageAccount;
    this.containerName = credentials.containerName;
    this.accountKey = auth.accountKey;
    this.sasToken = auth.sasToken;

    if (credentials.customEndpoint !== undefined) {
      const parsedEndpoint = parseCleanBaseEndpointUrl(credentials.customEndpoint, this.providerName);
      this.baseUrl = stripTrailingSlashes(parsedEndpoint.href);
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
    } catch (err) {
      throw mapAdapterTransportError(err, url, this.providerName, '[AzureBlobAdapter] Download');
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
    assertValidUploadSize(options?.size, this.providerName);
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

      const etag = readHeaderString(res.headers.etag)?.replace(/"/g, '');
      const lastModifiedHeader = res.headers['last-modified'];

      return {
        size: options?.size || 0,
        etag,
        contentType: options?.contentType,
        lastModified: parseValidDate(lastModifiedHeader) ?? new Date(),
      };
    } catch (err) {
      throw mapAdapterTransportError(err, url, this.providerName, '[AzureBlobAdapter] Upload');
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

      const size = parseNonNegativeInt(res.headers['content-length']) ?? 0;
      const etag = readHeaderString(res.headers.etag)?.replace(/"/g, '');
      const contentType = readHeaderString(res.headers['content-type']);
      const lastModified = res.headers['last-modified'];

      return {
        size,
        etag,
        contentType,
        lastModified: parseValidDate(lastModified),
      };
    } catch (err) {
      throw mapAdapterTransportError(err, url, this.providerName, '[AzureBlobAdapter] Head');
    } finally {
      await releaseDispatcher(dispatcher);
    }
  }

  async listObjects(prefix: string, maxFiles: number): Promise<Array<{ path: string; size: number }>> {
    assertValidMaxFiles(maxFiles, this.providerName);
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
      } catch (err) {
        throw mapAdapterTransportError(err, url, this.providerName, '[AzureBlobAdapter] List');
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
    } catch (err) {
      throw mapAdapterTransportError(err, url, this.providerName, '[AzureBlobAdapter] Delete');
    } finally {
      await releaseDispatcher(dispatcher);
    }
  }
}
