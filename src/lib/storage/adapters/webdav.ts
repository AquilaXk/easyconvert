import { Readable } from 'node:stream';
import { request } from 'undici';
import type { WebDavCredentials } from '../credentials-vault';
import {
  IStorageAdapter,
  StorageAdapterError,
  StorageAdapterMetadata,
  StorageNotFoundError,
  StorageAuthenticationError,
  StorageSsrfError,
} from './adapter-interface';
import { createSsrfSafeAgent, validateUrlForSsrf } from '../../security/ssrf';

function stripTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47) {
    end--;
  }
  return s.slice(0, end);
}

function stripLeadingSlashes(s: string): string {
  let start = 0;
  while (start < s.length && s.charCodeAt(start) === 47) {
    start++;
  }
  return s.slice(start);
}

function stripSlashes(s: string): string {
  return stripTrailingSlashes(stripLeadingSlashes(s));
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

export class WebDavStorageAdapter implements IStorageAdapter {
  readonly providerName = 'webdav';
  private readonly baseUrl: string;
  private readonly authHeader?: string;

  constructor(credentials: WebDavCredentials) {
    let base = stripTrailingSlashes(credentials.url);
    if (credentials.basePath) {
      const cleanBase = stripSlashes(credentials.basePath);
      if (cleanBase) {
        base = `${base}/${cleanBase}`;
      }
    }
    this.baseUrl = base;

    if (credentials.username && credentials.password) {
      const token = Buffer.from(`${credentials.username}:${credentials.password}`, 'utf-8').toString('base64');
      this.authHeader = `Basic ${token}`;
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
    return `${this.baseUrl}/${encodedPath}`;
  }

  private getHeaders(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = { ...extra };
    if (this.authHeader) {
      headers.Authorization = this.authHeader;
    }
    return headers;
  }

  async downloadStream(remotePath: string): Promise<NodeJS.ReadableStream> {
    const url = this.buildUrl(remotePath);
    await this.assertSsrfSafe(url);

    const dispatcher = createSsrfSafeAgent();
    let streaming = false;
    try {
      const res = await request(url, {
        method: 'GET',
        headers: this.getHeaders(),
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
        throw new Error(`[WebDavAdapter] Download failed (${res.statusCode}): ${errText}`);
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

    const headers = this.getHeaders({
      'Content-Type': options?.contentType || 'application/octet-stream',
    });
    if (typeof options?.size === 'number') {
      headers['Content-Length'] = String(options.size);
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

      if (res.statusCode === 401 || res.statusCode === 403) {
        throw new StorageAuthenticationError(`HTTP ${res.statusCode}`, this.providerName);
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        const errText = await res.body.text();
        throw new Error(`[WebDavAdapter] Upload failed (${res.statusCode}): ${errText}`);
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

    const dispatcher = createSsrfSafeAgent();
    try {
      const res = await request(url, {
        method: 'HEAD',
        headers: this.getHeaders(),
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

    const dispatcher = createSsrfSafeAgent();
    try {
      const res = await request(url, {
        method: 'DELETE',
        headers: this.getHeaders(),
        dispatcher,
      });

      return res.statusCode === 204 || res.statusCode === 200;
    } finally {
      try {
        await dispatcher.close?.();
      } catch {}
    }
  }
}
