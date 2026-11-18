import { Readable } from 'node:stream';
import type { WebDavCredentials } from '../credentials-vault';
import {
  IStorageAdapter,
  StorageAdapterError,
  StorageAdapterMetadata,
  StorageNotFoundError,
  StorageAuthenticationError,
  StorageInvalidKeyError,
  StorageListingLimitError,
  StorageServiceError,
} from './adapter-interface';
import { remotePathProblem } from '../customer-storage-paths';
import { ADAPTER_LISTING_CAP_BYTES } from './http-limits';
import { parseWebDavPropfindXml } from './listing-xml';
import {
  adapterDispatcher,
  assertAdapterUrlSafe,
  guardedRequest,
  parseCleanBaseEndpointUrl,
  readBoundedBody,
  readErrorText,
  releaseDispatcher,
} from './http-guard';

const WEBDAV_PROPFIND_BODY = '<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/><D:getcontentlength/></D:prop></D:propfind>';

function trimTrailingSlash(pathname: string): string {
  return pathname.endsWith('/') && pathname.length > 1 ? pathname.slice(0, -1) : pathname;
}

function extractWebDavChildName(href: string, targetUrl: URL, basePathNorm: string): string | null {
  let entryUrl: URL;
  try {
    entryUrl = new URL(href, targetUrl);
  } catch {
    return null;
  }
  const entryPathNorm = trimTrailingSlash(entryUrl.pathname);
  if (entryPathNorm === basePathNorm) return null;
  const prefix = basePathNorm === '/' ? '/' : `${basePathNorm}/`;
  if (!entryPathNorm.startsWith(prefix)) return null;
  const rawRelative = entryPathNorm.slice(prefix.length);
  if (!rawRelative || rawRelative.includes('/')) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawRelative);
  } catch {
    return null;
  }
  if (!decoded || decoded.startsWith('.') || decoded === '..' || decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0')) {
    return null;
  }
  return decoded;
}

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
    parseCleanBaseEndpointUrl(credentials.url, this.providerName);
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

  private assertSsrfSafe(urlStr: string): Promise<void> {
    return assertAdapterUrlSafe(urlStr, this.providerName);
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

    const dispatcher = adapterDispatcher(url);
    let streaming = false;
    try {
      const res = await guardedRequest(url, {
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
        const errText = await readErrorText(res.body, this.providerName);
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
        await releaseDispatcher(dispatcher);
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
      await releaseDispatcher(dispatcher);
    }
  }

  async head(remotePath: string): Promise<StorageAdapterMetadata | null> {
    const url = this.buildUrl(remotePath);
    await this.assertSsrfSafe(url);

    const dispatcher = adapterDispatcher(url);
    try {
      const res = await guardedRequest(url, {
        method: 'HEAD',
        headers: this.getHeaders(),
        dispatcher,
      });

      if (res.statusCode === 404) return null;
      if (res.statusCode === 401 || res.statusCode === 403) {
        throw new StorageAuthenticationError(`HTTP ${res.statusCode}`, this.providerName);
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

  async listDirectory(directory: string, maxFiles: number): Promise<Array<{ name: string; size: number }>> {
    const dirProblem = remotePathProblem(directory, { allowEmpty: true });
    if (dirProblem) {
      throw new StorageInvalidKeyError(`directory ${dirProblem}`, this.providerName);
    }
    const cleanDir = stripLeadingSlashes(directory);
    const url = cleanDir
      ? `${this.baseUrl}/${encodeSafePathSegments(cleanDir, this.providerName)}/`
      : `${this.baseUrl}/`;
    await this.assertSsrfSafe(url);

    const targetUrl = new URL(url);
    const basePathNorm = trimTrailingSlash(targetUrl.pathname);
    const dispatcher = adapterDispatcher(url);
    try {
      const res = await guardedRequest(url, {
        method: 'PROPFIND',
        headers: this.getHeaders({ Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' }),
        body: WEBDAV_PROPFIND_BODY,
        dispatcher,
      });

      if (res.statusCode === 404) throw new StorageNotFoundError(cleanDir || '/', this.providerName);
      if (res.statusCode === 401 || res.statusCode === 403) {
        throw new StorageAuthenticationError(`HTTP ${res.statusCode}`, this.providerName);
      }
      if (res.statusCode !== 207 && (res.statusCode < 200 || res.statusCode >= 300)) {
        const errText = await readErrorText(res.body, this.providerName);
        throw new StorageServiceError(`[WebDavAdapter] PROPFIND failed (${res.statusCode}): ${errText}`, this.providerName, {
          statusCode: res.statusCode,
          retryable: res.statusCode >= 500 || res.statusCode === 429,
        });
      }

      const { text, truncated } = await readBoundedBody(res.body, this.providerName, ADAPTER_LISTING_CAP_BYTES);
      if (truncated) {
        throw new StorageServiceError(`The ${this.providerName} listing answer is longer than ${ADAPTER_LISTING_CAP_BYTES} bytes`, this.providerName, {
          retryable: false,
        });
      }

      const files: Array<{ name: string; size: number }> = [];
      for (const entry of parseWebDavPropfindXml(text)) {
        if (entry.isCollection || entry.href.endsWith('/')) continue;
        const name = extractWebDavChildName(entry.href, targetUrl, basePathNorm);
        if (!name) continue;
        files.push({ name, size: entry.size });
        if (files.length > maxFiles) {
          throw new StorageListingLimitError(maxFiles, this.providerName);
        }
      }
      return files;
    } finally {
      await releaseDispatcher(dispatcher);
    }
  }

  async delete(remotePath: string): Promise<boolean> {
    const url = this.buildUrl(remotePath);
    await this.assertSsrfSafe(url);

    const dispatcher = adapterDispatcher(url);
    try {
      const res = await guardedRequest(url, {
        method: 'DELETE',
        headers: this.getHeaders(),
        dispatcher,
      });

      return res.statusCode === 204 || res.statusCode === 200;
    } finally {
      await releaseDispatcher(dispatcher);
    }
  }
}
