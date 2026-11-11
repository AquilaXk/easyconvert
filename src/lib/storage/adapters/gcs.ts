import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import type { GcsCredentials } from '../credentials-vault';
import {
  IStorageAdapter,
  StorageAdapterMetadata,
  StorageNotFoundError,
  StorageAuthenticationError,
  StorageAdapterError,
  StorageInvalidKeyError,
} from './adapter-interface';
import { assertValidObjectKey } from '../s3-sigv4';
import { adapterDispatcher, guardedRequest, assertAdapterUrlSafe, readErrorText, releaseDispatcher, readJsonBody } from './http-guard';

/** The object name of a remote path: dot segments are refused, as the other adapters and the S3 client do. */
function toObjectName(remotePath: string): string {
  const name = remotePath.replace(/^\/+/, '');
  try {
    assertValidObjectKey(name);
  } catch (err) {
    throw new StorageInvalidKeyError(err instanceof Error ? err.message : 'Invalid object key', 'gcs', err);
  }
  return name;
}

export class GcsStorageAdapter implements IStorageAdapter {
  readonly providerName = 'gcs';
  private readonly endpoint: string;
  private readonly bucket: string;
  private cachedToken: string | null = null;
  private tokenExpiresAt = 0;

  constructor(private readonly credentials: GcsCredentials) {
    this.bucket = credentials.bucket;
    this.endpoint = credentials.endpoint || 'https://storage.googleapis.com';
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

    if (this.credentials.serviceAccountKeyJson) {
      try {
        const parsed = JSON.parse(this.credentials.serviceAccountKeyJson);
        clientEmail = parsed.client_email;
        privateKey = parsed.private_key;
      } catch (err) {
        // Rethrow JSON parse failure as typed StorageAuthenticationError
        throw new StorageAuthenticationError(
          `Invalid serviceAccountKeyJson format: ${err instanceof Error ? err.message : String(err)}`,
          this.providerName
        );
      }
    }

    if (!clientEmail || !privateKey) {
      // In mock/test environments without service account keys, proceed without OAuth token
      return null;
    }

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
      const jwt = `${signInput}.${signature}`;

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
          throw new StorageAuthenticationError(`Token exchange failed (${res.statusCode}): ${errBody}`, this.providerName);
        }

        const tokenData = await readJsonBody<{ access_token: string; expires_in: number }>(res.body, this.providerName);
        this.cachedToken = tokenData.access_token;
        this.tokenExpiresAt = Date.now() + tokenData.expires_in * 1000;
        return this.cachedToken;
      } finally {
        await releaseDispatcher(dispatcher);
      }
    } catch (err) {
      if (err instanceof StorageAdapterError) throw err;
      throw new StorageAuthenticationError(err instanceof Error ? err.message : String(err), this.providerName);
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
        throw new Error(`[GcsAdapter] Download failed (${res.statusCode}): ${errText}`);
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

      if (res.statusCode < 200 || res.statusCode >= 300) {
        const errText = await readErrorText(res.body, this.providerName);
        throw new Error(`[GcsAdapter] Upload failed (${res.statusCode}): ${errText}`);
      }

      const data = await readJsonBody<{ size?: string; etag?: string; contentType?: string; updated?: string }>(res.body, this.providerName);
      const size = data.size ? Number.parseInt(data.size, 10) : options?.size || 0;
      return {
        size,
        etag: data.etag,
        contentType: data.contentType || options?.contentType,
        lastModified: data.updated ? new Date(data.updated) : new Date(),
      };
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
    } finally {
      await releaseDispatcher(dispatcher);
    }
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

      return res.statusCode === 204 || res.statusCode === 200;
    } finally {
      await releaseDispatcher(dispatcher);
    }
  }
}
