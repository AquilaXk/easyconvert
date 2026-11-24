import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import type { GcsCredentials } from '../credentials-vault';
import {
  IStorageAdapter,
  StorageAdapterMetadata,
  StorageInputError,
  StorageNotFoundError,
  StorageAuthenticationError,
  StorageAdapterError,
  StorageInvalidKeyError,
  StorageListingLimitError,
  StorageServiceError,
} from './adapter-interface';
import { assertValidObjectKey } from '../s3-sigv4';
import { remotePathProblem } from '../customer-storage-paths';
import { ADAPTER_LISTING_CAP_BYTES } from './http-limits';
import {
  adapterDispatcher,
  assertAdapterUrlSafe,
  assertValidGcsBucketName,
  assertValidMaxFiles,
  assertValidUploadSize,
  guardedRequest,
  isRetryableHttpStatus,
  isTrustedGcsOAuthEndpoint,
  mapAdapterTransportError,
  parseCleanBaseEndpointUrl,
  parseGcsServiceAccountKeyJson,
  readBoundedBody,
  readErrorText,
  readJsonBody,
  releaseDispatcher,
  stripLeadingSlashes,
  stripTrailingSlashes,
} from './http-guard';

const MAX_GCS_LIST_PAGES = 20;
const MAX_GCS_PAGE_RESULTS = 1000;

/** The object name of a remote path: dot segments are refused, as the other adapters and the S3 client do. */
function toObjectName(remotePath: string): string {
  if (typeof remotePath !== 'string') {
    throw new StorageInvalidKeyError('Object key must be a non-empty string.', 'gcs');
  }
  const name = stripLeadingSlashes(remotePath);
  try {
    assertValidObjectKey(name);
  } catch (err) {
    throw new StorageInvalidKeyError(err instanceof Error ? err.message : 'Invalid object key', 'gcs', err);
  }
  return name;
}

function signServiceAccountJwt(clientEmail: string, privateKey: string, provider: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/devstorage.read_write',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };

  const b64Header = Buffer.from(JSON.stringify(header)).toString('base64url');
  const b64Claims = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signInput = `${b64Header}.${b64Claims}`;
  try {
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(signInput);
    const signature = signer.sign(privateKey, 'base64url');
    return `${signInput}.${signature}`;
  } catch (err) {
    throw new StorageAuthenticationError(err instanceof Error ? err.message : String(err), provider);
  }
}

export class GcsStorageAdapter implements IStorageAdapter {
  readonly providerName = 'gcs';
  private readonly endpoint: string;
  private readonly bucket: string;
  private cachedToken: string | null = null;
  private tokenExpiresAt = 0;

  constructor(private readonly credentials: GcsCredentials) {
    assertValidGcsBucketName(credentials.bucket, this.providerName);
    if (credentials.projectId !== undefined && typeof credentials.projectId !== 'string') {
      throw new StorageInputError('Invalid GCS projectId: expected string', this.providerName);
    }
    if (credentials.clientEmail !== undefined && typeof credentials.clientEmail !== 'string') {
      throw new StorageInputError('Invalid GCS clientEmail: expected string', this.providerName);
    }
    if (credentials.privateKey !== undefined && typeof credentials.privateKey !== 'string') {
      throw new StorageInputError('Invalid GCS privateKey: expected string', this.providerName);
    }
    if (Boolean(credentials.clientEmail) !== Boolean(credentials.privateKey)) {
      throw new StorageInputError('GCS service account requires both clientEmail and privateKey', this.providerName);
    }
    if (credentials.serviceAccountKeyJson !== undefined) {
      parseGcsServiceAccountKeyJson(credentials.serviceAccountKeyJson, this.providerName);
    }
    this.bucket = credentials.bucket;
    const rawEndpoint = credentials.endpoint !== undefined ? credentials.endpoint : 'https://storage.googleapis.com';
    const parsedEndpoint = parseCleanBaseEndpointUrl(rawEndpoint, this.providerName);
    const hasOAuthMaterial = Boolean(
      credentials.serviceAccountKeyJson || credentials.clientEmail || credentials.privateKey
    );
    if (hasOAuthMaterial && !isTrustedGcsOAuthEndpoint(parsedEndpoint)) {
      throw new StorageAdapterError(
        'GCS service-account credentials may only be sent to storage.googleapis.com',
        this.providerName
      );
    }
    this.endpoint = stripTrailingSlashes(parsedEndpoint.href);
  }

  private assertSsrfSafe(urlStr: string): Promise<void> {
    return assertAdapterUrlSafe(urlStr, this.providerName);
  }

  private async getAccessToken(): Promise<string | null> {
    if (this.cachedToken && Date.now() < this.tokenExpiresAt - 60000) {
      return this.cachedToken;
    }

    let clientEmail = this.credentials.clientEmail;
    let privateKey = this.credentials.privateKey;

    if (this.credentials.serviceAccountKeyJson !== undefined) {
      const parsed = parseGcsServiceAccountKeyJson(this.credentials.serviceAccountKeyJson, this.providerName);
      clientEmail = parsed.clientEmail;
      privateKey = parsed.privateKey;
    }

    if (!clientEmail || !privateKey) {
      // In mock/test environments without service account keys, proceed without OAuth token
      return null;
    }

    const jwt = signServiceAccountJwt(clientEmail, privateKey, this.providerName);
    const tokenUrl = 'https://oauth2.googleapis.com/token';
    await this.assertSsrfSafe(tokenUrl);

    const dispatcher = adapterDispatcher(tokenUrl);
    try {
      const res = await guardedRequest(tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion: jwt,
        }).toString(),
        dispatcher,
      });

      if (res.statusCode !== 200) {
        const errBody = await readErrorText(res.body, this.providerName);
        if (isRetryableHttpStatus(res.statusCode)) {
          throw new StorageServiceError(`Token exchange failed (${res.statusCode}): ${errBody}`, this.providerName, {
            statusCode: res.statusCode,
            retryable: true,
          });
        }
        throw new StorageAuthenticationError(`Token exchange failed (${res.statusCode}): ${errBody}`, this.providerName);
      }

      const tokenData = await readJsonBody<{ access_token?: unknown; expires_in?: unknown }>(res.body, this.providerName);
      if (typeof tokenData?.access_token !== 'string' || !tokenData.access_token) {
        throw new StorageServiceError('Token exchange response did not include an access_token', this.providerName, {
          retryable: false,
        });
      }
      const expiresInSec =
        typeof tokenData.expires_in === 'number' && Number.isFinite(tokenData.expires_in) && tokenData.expires_in > 0
          ? tokenData.expires_in
          : 3600;
      this.cachedToken = tokenData.access_token;
      this.tokenExpiresAt = Date.now() + expiresInSec * 1000;
      return this.cachedToken;
    } catch (err) {
      throw mapAdapterTransportError(err, tokenUrl, this.providerName, 'Token exchange request');
    } finally {
      await releaseDispatcher(dispatcher);
    }
  }

  private async getAuthHeaders(): Promise<Record<string, string>> {
    const token = await this.getAccessToken();
    const headers: Record<string, string> = {};
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    return headers;
  }

  async downloadStream(remotePath: string): Promise<NodeJS.ReadableStream> {
    const encodedObj = encodeURIComponent(toObjectName(remotePath));
    const url = `${this.endpoint}/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${encodedObj}?alt=media`;
    await this.assertSsrfSafe(url);

    const headers = await this.getAuthHeaders();
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
        throw new StorageServiceError(`[GcsAdapter] Download failed (${res.statusCode}): ${errText}`, this.providerName, {
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
      throw mapAdapterTransportError(err, url, this.providerName, '[GcsAdapter] Download');
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
    const cleanPath = toObjectName(remotePath);
    const url = `${this.endpoint}/upload/storage/v1/b/${encodeURIComponent(this.bucket)}/o?uploadType=media&name=${encodeURIComponent(cleanPath)}`;
    await this.assertSsrfSafe(url);

    const authHeaders = await this.getAuthHeaders();
    const headers: Record<string, string> = {
      ...authHeaders,
      'Content-Type': options?.contentType || 'application/octet-stream',
    };
    if (typeof options?.size === 'number') {
      headers['Content-Length'] = String(options.size);
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
        method: 'POST',
        headers,
        body: nodeStream as any,
        dispatcher,
      });

      if (res.statusCode === 401 || res.statusCode === 403) {
        throw new StorageAuthenticationError(`HTTP ${res.statusCode}`, this.providerName);
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        const errText = await readErrorText(res.body, this.providerName);
        throw new StorageServiceError(`[GcsAdapter] Upload failed (${res.statusCode}): ${errText}`, this.providerName, {
          statusCode: res.statusCode,
          retryable: isRetryableHttpStatus(res.statusCode),
        });
      }

      const data = await readJsonBody<{ size?: string; etag?: string; contentType?: string; updated?: string }>(res.body, this.providerName);
      const size = data.size ? Number.parseInt(data.size, 10) : options?.size || 0;
      return {
        size,
        etag: data.etag,
        contentType: data.contentType || options?.contentType,
        lastModified: data.updated ? new Date(data.updated) : new Date(),
      };
    } catch (err) {
      throw mapAdapterTransportError(err, url, this.providerName, '[GcsAdapter] Upload');
    } finally {
      await releaseDispatcher(dispatcher);
    }
  }

  async head(remotePath: string): Promise<StorageAdapterMetadata | null> {
    const encodedObj = encodeURIComponent(toObjectName(remotePath));
    const url = `${this.endpoint}/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${encodedObj}`;
    await this.assertSsrfSafe(url);

    const headers = await this.getAuthHeaders();
    const dispatcher = adapterDispatcher(url);
    try {
      const res = await guardedRequest(url, {
        method: 'GET',
        headers,
        dispatcher,
      });

      if (res.statusCode === 404) {
        return null;
      }
      if (res.statusCode === 401 || res.statusCode === 403) {
        throw new StorageAuthenticationError(`HTTP ${res.statusCode}`, this.providerName);
      }
      if (isRetryableHttpStatus(res.statusCode)) {
        const errText = await readErrorText(res.body, this.providerName);
        throw new StorageServiceError(`[GcsAdapter] Head failed (${res.statusCode}): ${errText}`, this.providerName, {
          statusCode: res.statusCode,
          retryable: true,
        });
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return null;
      }

      const data = await readJsonBody<{ size?: string; etag?: string; contentType?: string; updated?: string }>(res.body, this.providerName);
      return {
        size: data.size ? Number.parseInt(data.size, 10) : 0,
        etag: data.etag,
        contentType: data.contentType,
        lastModified: data.updated ? new Date(data.updated) : undefined,
      };
    } catch (err) {
      throw mapAdapterTransportError(err, url, this.providerName, '[GcsAdapter] Head');
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
    const cleanPrefix = prefix ? toObjectName(prefix) : '';
    const files: Array<{ path: string; size: number }> = [];
    let pageToken: string | undefined;

    for (let page = 0; page < MAX_GCS_LIST_PAGES; page++) {
      const query = new URLSearchParams({
        maxResults: String(Math.min(MAX_GCS_PAGE_RESULTS, Math.max(1, maxFiles) + 1)),
      });
      if (cleanPrefix) query.set('prefix', cleanPrefix);
      if (pageToken) query.set('pageToken', pageToken);

      const url = `${this.endpoint}/storage/v1/b/${encodeURIComponent(this.bucket)}/o?${query.toString()}`;
      await this.assertSsrfSafe(url);
      const headers = await this.getAuthHeaders();
      const dispatcher = adapterDispatcher(url);
      try {
        const res = await guardedRequest(url, { method: 'GET', headers, dispatcher });
        if (res.statusCode === 404) throw new StorageNotFoundError(cleanPrefix || this.bucket, this.providerName);
        if (res.statusCode === 401 || res.statusCode === 403) {
          throw new StorageAuthenticationError(`HTTP ${res.statusCode}`, this.providerName);
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const errText = await readErrorText(res.body, this.providerName);
          throw new StorageServiceError(`[GcsAdapter] List failed (${res.statusCode}): ${errText}`, this.providerName, {
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
        let body: { items?: Array<{ name?: unknown; size?: unknown }>; nextPageToken?: unknown };
        try {
          body = JSON.parse(text) as typeof body;
        } catch (err) {
          throw new StorageServiceError(`The ${this.providerName} listing answer is not valid JSON`, this.providerName, { retryable: false }, err);
        }
        for (const item of body.items ?? []) {
          if (typeof item?.name !== 'string' || !item.name || item.name.endsWith('/')) continue;
          const size = Number.parseInt(String(item.size ?? 0), 10);
          files.push({ path: item.name, size: Number.isFinite(size) && size >= 0 ? size : 0 });
          if (files.length > maxFiles) {
            throw new StorageListingLimitError(maxFiles, this.providerName);
          }
        }
        if (typeof body.nextPageToken !== 'string' || !body.nextPageToken) return files;
        pageToken = body.nextPageToken;
      } catch (err) {
        throw mapAdapterTransportError(err, url, this.providerName, '[GcsAdapter] List');
      } finally {
        await releaseDispatcher(dispatcher);
      }
    }

    throw new StorageServiceError(`The listing did not finish within ${MAX_GCS_LIST_PAGES} pages`, this.providerName, { retryable: false });
  }

  async delete(remotePath: string): Promise<boolean> {
    const encodedObj = encodeURIComponent(toObjectName(remotePath));
    const url = `${this.endpoint}/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${encodedObj}`;
    await this.assertSsrfSafe(url);

    const headers = await this.getAuthHeaders();
    const dispatcher = adapterDispatcher(url);
    try {
      const res = await guardedRequest(url, {
        method: 'DELETE',
        headers,
        dispatcher,
      });

      if (res.statusCode === 204 || res.statusCode === 200) {
        return true;
      }
      if (res.statusCode === 401 || res.statusCode === 403) {
        throw new StorageAuthenticationError(`HTTP ${res.statusCode}`, this.providerName);
      }
      if (isRetryableHttpStatus(res.statusCode)) {
        const errText = await readErrorText(res.body, this.providerName);
        throw new StorageServiceError(`[GcsAdapter] Delete failed (${res.statusCode}): ${errText}`, this.providerName, {
          statusCode: res.statusCode,
          retryable: true,
        });
      }
      return false;
    } catch (err) {
      throw mapAdapterTransportError(err, url, this.providerName, '[GcsAdapter] Delete');
    } finally {
      await releaseDispatcher(dispatcher);
    }
  }
}
