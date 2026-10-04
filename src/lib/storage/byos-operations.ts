import crypto from 'node:crypto';
import fs from 'node:fs';
import { request } from 'undici';
import { localFsStorage } from './local-fs-storage';
import { globalSharedObjects } from './shared-store';
import { credentialsVault, CustomerStorageCredentials } from './credentials-vault';
import { createStorageAdapter } from './adapters';
import {
  StorageNotFoundError,
  StorageAuthenticationError,
  StorageSsrfError,
  type IStorageAdapter,
} from './adapters/adapter-interface';
import { createSsrfSafeAgent, validateUrlForSsrf } from '../security/ssrf';
import type { ObjectReadStream, StoredObjectMetadata } from './object-storage';

export type ImportOperationType =
  | 'import/url'
  | 'import/s3'
  | 'import/gcs'
  | 'import/azure'
  | 'import/sftp'
  | 'import/webdav';

export type ExportOperationType =
  | 'export/url'
  | 'export/s3'
  | 'export/gcs'
  | 'export/azure'
  | 'export/sftp'
  | 'export/webdav';

export interface ImportOperationParams {
  operation: ImportOperationType;
  url?: string;
  remotePath?: string;
  credentialRef?: string;
  userId?: string;
  targetKey?: string;
  filename?: string;
}

export interface ImportOperationResult {
  key: string;
  size: number;
  filename: string;
  mimeType: string;
  etag: string;
}

export interface ExportOperationParams {
  operation: ExportOperationType;
  sourceKey: string;
  url?: string;
  remotePath?: string;
  credentialRef?: string;
  userId?: string;
  contentType?: string;
}

export interface ExportOperationResult {
  destination: string;
  size: number;
  etag?: string;
  success: boolean;
}

function registerSharedObject(
  targetKey: string,
  stored: StoredObjectMetadata
): void {
  const binPath = (localFsStorage as any).getPathsForKey(targetKey).binPath;
  let cachedBuffer: Buffer | null = null;
  globalSharedObjects.set(targetKey, {
    key: stored.key,
    filename: stored.filename,
    mimeType: stored.mimeType,
    size: stored.size,
    etag: stored.etag,
    uploadedAt: stored.uploadedAt,
    expiresAt: stored.expiresAt,
    filePath: binPath,
    get buffer(): Buffer {
      if (cachedBuffer) return cachedBuffer;
      if (fs.existsSync(binPath)) {
        cachedBuffer = fs.readFileSync(binPath);
        return cachedBuffer;
      }
      return Buffer.alloc(0);
    },
  });
}

async function executeUrlImport(
  params: ImportOperationParams,
  targetKey: string,
  filename: string
): Promise<ImportOperationResult> {
  if (!params.url) {
    throw new Error('[BYOS] "url" parameter is required for import/url operation');
  }

  const parsedUrl = new URL(params.url);
  const isSafe = await validateUrlForSsrf(parsedUrl);
  if (!isSafe) {
    throw new StorageSsrfError(params.url, 'import/url');
  }

  const headers: Record<string, string> = {};
  if (params.credentialRef) {
    const creds = await credentialsVault.get(params.credentialRef, params.userId);
    if (creds?.type === 'http') {
      if (creds.bearerToken) {
        headers.Authorization = `Bearer ${creds.bearerToken}`;
      }
      if (creds.headers) {
        Object.assign(headers, creds.headers);
      }
    }
  }

  const res = await request(params.url, {
    method: 'GET',
    headers,
    dispatcher: createSsrfSafeAgent(),
  });

  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`[BYOS] Remote URL fetch failed with HTTP ${res.statusCode}`);
  }

  const contentType = (res.headers['content-type'] as string) || 'application/octet-stream';
  const stored = await localFsStorage.putStream(targetKey, res.body as unknown as NodeJS.ReadableStream, {
    filename,
    contentType,
  });

  registerSharedObject(targetKey, stored);

  return {
    key: stored.key,
    size: stored.size,
    filename: stored.filename,
    mimeType: stored.mimeType,
    etag: stored.etag,
  };
}

async function executeAdapterImport(
  params: ImportOperationParams,
  targetKey: string,
  filename: string
): Promise<ImportOperationResult> {
  if (!params.remotePath) {
    throw new Error(`[BYOS] "remotePath" parameter is required for ${params.operation}`);
  }
  if (!params.credentialRef) {
    throw new StorageAuthenticationError(
      `"credentialRef" is required for customer storage ${params.operation}`,
      params.operation
    );
  }

  const creds = await credentialsVault.get(params.credentialRef, params.userId);
  if (!creds) {
    throw new StorageAuthenticationError(
      `Customer credential "${params.credentialRef}" not found or unauthorized`,
      params.operation
    );
  }

  const adapter = createStorageAdapter(creds as CustomerStorageCredentials);
  const stream = await adapter.downloadStream(params.remotePath);

  const stored = await localFsStorage.putStream(targetKey, stream, {
    filename,
  });

  registerSharedObject(targetKey, stored);

  return {
    key: stored.key,
    size: stored.size,
    filename: stored.filename,
    mimeType: stored.mimeType,
    etag: stored.etag,
  };
}

/**
 * Executes a streaming BYOS import task from customer storage or external URL directly into object storage.
 * Enforces strict zero-heap spooling and zero-trust SSRF protections.
 */
export async function executeImportTask(params: ImportOperationParams): Promise<ImportOperationResult> {
  const targetKey =
    params.targetKey || `import-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  const filename = params.filename || params.remotePath?.split('/').pop() || 'imported-file';

  if (params.operation === 'import/url') {
    return executeUrlImport(params, targetKey, filename);
  }

  return executeAdapterImport(params, targetKey, filename);
}

/** An export destination, validated and resolved before the source object is opened. */
type ExportDestination =
  | { kind: 'url'; url: string; headers: Record<string, string> }
  | { kind: 'adapter'; remotePath: string; adapter: IStorageAdapter };

async function resolveCredentialHeaders(params: ExportOperationParams): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  if (!params.credentialRef) {
    return headers;
  }
  const creds = await credentialsVault.get(params.credentialRef, params.userId);
  if (creds?.type === 'http') {
    if (creds.bearerToken) {
      headers.Authorization = `Bearer ${creds.bearerToken}`;
    }
    if (creds.headers) {
      Object.assign(headers, creds.headers);
    }
  }
  return headers;
}

async function resolveUrlDestination(params: ExportOperationParams): Promise<ExportDestination> {
  if (!params.url) {
    throw new Error('[BYOS] "url" parameter is required for export/url operation');
  }

  const parsedUrl = new URL(params.url);
  const isSafe = await validateUrlForSsrf(parsedUrl);
  if (!isSafe) {
    throw new StorageSsrfError(params.url, 'export/url');
  }

  return { kind: 'url', url: params.url, headers: await resolveCredentialHeaders(params) };
}

async function resolveAdapterDestination(params: ExportOperationParams): Promise<ExportDestination> {
  if (!params.remotePath) {
    throw new Error(`[BYOS] "remotePath" parameter is required for ${params.operation}`);
  }
  if (!params.credentialRef) {
    throw new StorageAuthenticationError(
      `"credentialRef" is required for customer storage ${params.operation}`,
      params.operation
    );
  }

  const creds = await credentialsVault.get(params.credentialRef, params.userId);
  if (!creds) {
    throw new StorageAuthenticationError(
      `Customer credential "${params.credentialRef}" not found or unauthorized`,
      params.operation
    );
  }

  const adapter = createStorageAdapter(creds as CustomerStorageCredentials);
  return { kind: 'adapter', remotePath: params.remotePath, adapter };
}

async function uploadToUrl(
  destination: Extract<ExportDestination, { kind: 'url' }>,
  params: ExportOperationParams,
  source: ObjectReadStream
): Promise<ExportOperationResult> {
  const headers: Record<string, string> = {
    'Content-Type': params.contentType || source.metadata.mimeType || 'application/octet-stream',
    'Content-Length': String(source.metadata.size),
    ...destination.headers,
  };

  const res = await request(destination.url, {
    method: 'POST',
    headers,
    body: source.stream as any,
    dispatcher: createSsrfSafeAgent(),
  });

  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`[BYOS] Remote webhook/URL export failed with HTTP ${res.statusCode}`);
  }

  return {
    destination: destination.url,
    size: source.metadata.size,
    success: true,
  };
}

async function uploadToAdapter(
  destination: Extract<ExportDestination, { kind: 'adapter' }>,
  params: ExportOperationParams,
  source: ObjectReadStream
): Promise<ExportOperationResult> {
  const result = await destination.adapter.uploadStream(destination.remotePath, source.stream, {
    contentType: params.contentType || source.metadata.mimeType,
    size: source.metadata.size,
  });

  return {
    destination: destination.remotePath,
    size: result.size,
    etag: result.etag,
    success: true,
  };
}

/** Closes a source stream that an upload did not consume to the end. */
function releaseSource(source: ObjectReadStream): void {
  const stream = source.stream as NodeJS.ReadableStream & { destroy?: () => void; destroyed?: boolean };
  if (typeof stream.destroy === 'function' && !stream.destroyed) {
    stream.destroy();
  }
}

/**
 * Executes a streaming BYOS export task from object storage directly to customer storage or remote URL.
 * Guarantees zero Next.js heap buffering and socket-level SSRF verification. The destination is
 * validated before the source object is opened, and the source is closed on every failure.
 */
export async function executeExportTask(params: ExportOperationParams): Promise<ExportOperationResult> {
  const destination =
    params.operation === 'export/url'
      ? await resolveUrlDestination(params)
      : await resolveAdapterDestination(params);

  const source = await localFsStorage.getStream(params.sourceKey);
  if (!source) {
    throw new StorageNotFoundError(params.sourceKey, 'local-fs');
  }

  try {
    if (destination.kind === 'url') {
      return await uploadToUrl(destination, params, source);
    }
    return await uploadToAdapter(destination, params, source);
  } catch (err) {
    releaseSource(source);
    throw err;
  }
}
