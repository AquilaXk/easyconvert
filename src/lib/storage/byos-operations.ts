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
} from './adapters/adapter-interface';
import { createSsrfSafeAgent, validateUrlForSsrf } from '../security/ssrf';

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

/**
 * Executes a streaming BYOS import task from customer storage or external URL directly into object storage.
 * Enforces strict zero-heap spooling and zero-trust SSRF protections.
 */
export async function executeImportTask(params: ImportOperationParams): Promise<ImportOperationResult> {
  const targetKey = params.targetKey || `import-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  const filename = params.filename || params.remotePath?.split('/').pop() || 'imported-file';

  if (params.operation === 'import/url') {
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
      if (creds && creds.type === 'http') {
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

    // Mirror in shared objects for immediate worker consumption
    const urlBinPath = (localFsStorage as any).getPathsForKey(targetKey).binPath;
    let urlCachedBuffer: Buffer | null = null;
    globalSharedObjects.set(targetKey, {
      key: stored.key,
      filename: stored.filename,
      mimeType: stored.mimeType,
      size: stored.size,
      etag: stored.etag,
      uploadedAt: stored.uploadedAt,
      expiresAt: stored.expiresAt,
      filePath: urlBinPath,
      get buffer(): Buffer {
        if (urlCachedBuffer) return urlCachedBuffer;
        if (fs.existsSync(urlBinPath)) {
          urlCachedBuffer = fs.readFileSync(urlBinPath);
          return urlCachedBuffer;
        }
        return Buffer.alloc(0);
      },
    });

    return {
      key: stored.key,
      size: stored.size,
      filename: stored.filename,
      mimeType: stored.mimeType,
      etag: stored.etag,
    };
  }

  // Cloud/Remote Storage Adapters (S3, GCS, Azure, SFTP, WebDAV)
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

  const adapterBinPath = (localFsStorage as any).getPathsForKey(targetKey).binPath;
  let adapterCachedBuffer: Buffer | null = null;
  globalSharedObjects.set(targetKey, {
    key: stored.key,
    filename: stored.filename,
    mimeType: stored.mimeType,
    size: stored.size,
    etag: stored.etag,
    uploadedAt: stored.uploadedAt,
    expiresAt: stored.expiresAt,
    filePath: adapterBinPath,
    get buffer(): Buffer {
      if (adapterCachedBuffer) return adapterCachedBuffer;
      if (fs.existsSync(adapterBinPath)) {
        adapterCachedBuffer = fs.readFileSync(adapterBinPath);
        return adapterCachedBuffer;
      }
      return Buffer.alloc(0);
    },
  });

  return {
    key: stored.key,
    size: stored.size,
    filename: stored.filename,
    mimeType: stored.mimeType,
    etag: stored.etag,
  };
}

/**
 * Executes a streaming BYOS export task from object storage directly to customer storage or remote URL.
 * Guarantees zero Next.js heap buffering and socket-level SSRF verification.
 */
export async function executeExportTask(params: ExportOperationParams): Promise<ExportOperationResult> {
  const source = await localFsStorage.getStream(params.sourceKey);
  if (!source) {
    throw new StorageNotFoundError(params.sourceKey, 'local-fs');
  }

  if (params.operation === 'export/url') {
    if (!params.url) {
      throw new Error('[BYOS] "url" parameter is required for export/url operation');
    }

    const parsedUrl = new URL(params.url);
    const isSafe = await validateUrlForSsrf(parsedUrl);
    if (!isSafe) {
      throw new StorageSsrfError(params.url, 'export/url');
    }

    const headers: Record<string, string> = {
      'Content-Type': params.contentType || source.metadata.mimeType || 'application/octet-stream',
      'Content-Length': String(source.metadata.size),
    };

    if (params.credentialRef) {
      const creds = await credentialsVault.get(params.credentialRef, params.userId);
      if (creds && creds.type === 'http') {
        if (creds.bearerToken) {
          headers.Authorization = `Bearer ${creds.bearerToken}`;
        }
        if (creds.headers) {
          Object.assign(headers, creds.headers);
        }
      }
    }

    const res = await request(params.url, {
      method: 'POST',
      headers,
      body: source.stream as any,
      dispatcher: createSsrfSafeAgent(),
    });

    if (res.statusCode < 200 || res.statusCode >= 300) {
      throw new Error(`[BYOS] Remote webhook/URL export failed with HTTP ${res.statusCode}`);
    }

    return {
      destination: params.url,
      size: source.metadata.size,
      success: true,
    };
  }

  // Cloud/Remote Storage Adapters
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
  const result = await adapter.uploadStream(params.remotePath, source.stream, {
    contentType: params.contentType || source.metadata.mimeType,
    size: source.metadata.size,
  });

  return {
    destination: params.remotePath,
    size: result.size,
    etag: result.etag,
    success: true,
  };
}
