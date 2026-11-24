export * from './adapter-interface';
export * from './gcs';
export * from './azure-blob';
export * from './webdav';
export * from './sftp';
export * from './s3';

import type { CustomerStorageCredentials } from '../credentials-vault';
import {
  type IStorageAdapter,
  StorageAdapterError,
  StorageInputError,
  StorageSsrfError,
} from './adapter-interface';
import { GcsStorageAdapter } from './gcs';
import { AZURE_STORAGE_ACCOUNT_PATTERN, AzureBlobStorageAdapter } from './azure-blob';
import { encodeWebDavBasePath, WebDavStorageAdapter } from './webdav';
import { SftpStorageAdapter, isSftpDevAllowlisted } from './sftp';
import { S3StorageAdapter } from './s3';
import {
  CUSTOM_HEADER_VALUE_REGEX,
  DEFAULT_MAX_CUSTOM_HEADERS,
  DEFAULT_MAX_CUSTOM_HEADER_NAME_CHARS,
  DEFAULT_MAX_CUSTOM_HEADER_VALUE_CHARS,
  formatCustomHeaderIssue,
  inspectCustomHeaders,
} from '../../security/http-headers';
import { isPrivateOrRestrictedHost, validateUrlForSsrf } from '../../security/ssrf';
import {
  assertTlsEndpoint,
  assertValidAzureContainerName,
  isDevAllowlistedEndpoint,
  isTrustedGcsOAuthEndpoint,
  parseCleanBaseEndpointUrl,
} from './http-guard';

/**
 * Providers whose adapter has no network client yet. Registration and every import/export
 * through them fail closed until a real client exists. Every provider currently has one.
 */
export const UNAVAILABLE_STORAGE_PROVIDERS: ReadonlySet<string> = new Set<string>();

const GCS_BUCKET_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,220}[a-z0-9])?$/i;
const MAX_HTTP_ENDPOINT_URL_CHARS = 8192;

function validateHttpEndpointSyntax(rawUrl: string, provider: string, invalidMessage?: string): URL {
  const parsed = parseCleanBaseEndpointUrl(rawUrl, provider, invalidMessage);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new StorageSsrfError(rawUrl, provider);
  }
  return parsed;
}

export function validateExternalEndpointUrl(rawUrl: string, provider: string): void {
  const parsed = validateHttpEndpointSyntax(rawUrl, provider);
  if (isDevAllowlistedEndpoint(parsed)) return;
  assertTlsEndpoint(parsed, provider);
  if (isPrivateOrRestrictedHost(parsed.hostname)) {
    throw new StorageSsrfError(rawUrl, provider);
  }
}

function isSimpleContainerIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('..') && !value.includes('/') && !value.includes('\\');
}

function validateGcsCredentials(credentials: Extract<CustomerStorageCredentials, { type: 'gcs' }>): void {
  if (!isSimpleContainerIdentifier(credentials.bucket) || !GCS_BUCKET_PATTERN.test(credentials.bucket)) {
    throw new StorageAdapterError(`Invalid GCS bucket name: "${credentials.bucket}"`, 'gcs');
  }
  if (Boolean(credentials.clientEmail) !== Boolean(credentials.privateKey)) {
    throw new StorageAdapterError('GCS service account requires both clientEmail and privateKey', 'gcs');
  }
  if (credentials.serviceAccountKeyJson) {
    try {
      const parsed = JSON.parse(credentials.serviceAccountKeyJson) as { client_email?: unknown; private_key?: unknown };
      if (!parsed || typeof parsed !== 'object' || typeof parsed.client_email !== 'string' || typeof parsed.private_key !== 'string') {
        throw new StorageAdapterError('Invalid GCS serviceAccountKeyJson: missing client_email or private_key', 'gcs');
      }
    } catch (err) {
      if (err instanceof StorageAdapterError) throw err;
      throw new StorageAdapterError('Invalid GCS serviceAccountKeyJson format', 'gcs');
    }
  }
  if (credentials.endpoint) {
    validateExternalEndpointUrl(credentials.endpoint, 'gcs');
    const hasOAuth = Boolean(credentials.serviceAccountKeyJson || (credentials.clientEmail && credentials.privateKey));
    if (hasOAuth && !isTrustedGcsOAuthEndpoint(new URL(credentials.endpoint))) {
      throw new StorageAdapterError('GCS service-account credentials may only be used with storage.googleapis.com', 'gcs');
    }
  }
}

function validateAzureBlobCredentials(credentials: Extract<CustomerStorageCredentials, { type: 'azure-blob' }>): void {
  if (typeof credentials.storageAccount !== 'string' || !AZURE_STORAGE_ACCOUNT_PATTERN.test(credentials.storageAccount)) {
    throw new StorageAdapterError('Invalid Azure Blob storageAccount', 'azure-blob');
  }
  assertValidAzureContainerName(credentials.containerName, 'azure-blob');
  if (credentials.customEndpoint) {
    validateExternalEndpointUrl(credentials.customEndpoint, 'azure-blob');
  }
}

function validateWebDavCredentials(credentials: Extract<CustomerStorageCredentials, { type: 'webdav' }>): void {
  if (!credentials.url) {
    throw new StorageAdapterError('WebDAV url is required', 'webdav');
  }
  validateHttpEndpointSyntax(credentials.url, 'webdav');
  if (
    (credentials.username !== undefined && typeof credentials.username !== 'string') ||
    (credentials.password !== undefined && typeof credentials.password !== 'string')
  ) {
    throw new StorageInputError('Invalid WebDAV username or password: expected string', 'webdav');
  }
  encodeWebDavBasePath(credentials.basePath, 'webdav');
}

function validateHttpCredentials(credentials: Extract<CustomerStorageCredentials, { type: 'http' }>): void {
  if (credentials.bearerToken !== undefined) {
    if (
      typeof credentials.bearerToken !== 'string' ||
      credentials.bearerToken.trim().length === 0 ||
      credentials.bearerToken.length > DEFAULT_MAX_CUSTOM_HEADER_VALUE_CHARS ||
      !CUSTOM_HEADER_VALUE_REGEX.test(credentials.bearerToken)
    ) {
      throw new StorageAdapterError('Invalid HTTP bearerToken', 'http');
    }
  }
  if (credentials.headers !== undefined) {
    const issues = inspectCustomHeaders(credentials.headers, {
      maxHeaders: DEFAULT_MAX_CUSTOM_HEADERS,
      maxNameChars: DEFAULT_MAX_CUSTOM_HEADER_NAME_CHARS,
      maxValueChars: DEFAULT_MAX_CUSTOM_HEADER_VALUE_CHARS,
    });
    if (issues.length > 0) {
      throw new StorageAdapterError(`Invalid HTTP credentials headers (${formatCustomHeaderIssue(issues[0])})`, 'http');
    }
  }
  if (credentials.url !== undefined) {
    if (typeof credentials.url !== 'string' || credentials.url.length === 0 || credentials.url.length > MAX_HTTP_ENDPOINT_URL_CHARS) {
      throw new StorageAdapterError('Invalid HTTP endpoint URL', 'http');
    }
    let parsed: URL;
    try {
      parsed = new URL(credentials.url);
    } catch {
      throw new StorageAdapterError('Invalid HTTP endpoint URL', 'http');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new StorageSsrfError(credentials.url, 'http');
    }
    if (!isDevAllowlistedEndpoint(parsed)) {
      const hasHeaders = credentials.headers !== undefined && Object.keys(credentials.headers).length > 0;
      if (Boolean(credentials.bearerToken) || hasHeaders || parsed.username !== '' || parsed.password !== '') {
        assertTlsEndpoint(parsed, 'http');
      }
      if (isPrivateOrRestrictedHost(parsed.hostname)) {
        throw new StorageSsrfError(credentials.url, 'http');
      }
    }
  }
}

export function validateCredentials(credentials: CustomerStorageCredentials): void {
  if (!credentials || typeof credentials !== 'object') {
    throw new StorageAdapterError('Invalid storage credentials payload', 'unknown');
  }
  switch (credentials.type) {
    case 's3':
      if (credentials.endpoint) {
        validateHttpEndpointSyntax(credentials.endpoint, 's3', 'S3 endpoint does not form a valid URL');
      }
      break;
    case 'gcs':
      validateGcsCredentials(credentials);
      break;
    case 'azure-blob':
      validateAzureBlobCredentials(credentials);
      break;
    case 'webdav':
      validateWebDavCredentials(credentials);
      break;
    case 'sftp':
      if (!credentials.host || (!isSftpDevAllowlisted(credentials.host, credentials.port) && isPrivateOrRestrictedHost(credentials.host))) {
        throw new StorageSsrfError(credentials.host || '', 'sftp');
      }
      break;
    case 'http':
      validateHttpCredentials(credentials);
      break;
    default:
      break;
  }
}

/**
 * Validates customer credentials before they are stored: an s3 endpoint must be a valid,
 * TLS, publicly resolving host unless it is dev-allowlisted. Throws a StorageAdapterError.
 */
export async function validateStorageCredentials(credentials: CustomerStorageCredentials): Promise<void> {
  validateCredentials(credentials);
  if (credentials.type === 'webdav') {
    validateExternalEndpointUrl(credentials.url, 'webdav');
  }
  if (credentials.type === 'http' && credentials.url) {
    const parsed = new URL(credentials.url);
    if (!isDevAllowlistedEndpoint(parsed) && !(await validateUrlForSsrf(parsed))) {
      throw new StorageSsrfError(credentials.url, 'http');
    }
  }
  if (credentials.type === 's3') {
    await new S3StorageAdapter(credentials).verifyEndpoint();
  }
}

/**
 * Instantiates the appropriate storage adapter for given customer BYOS credentials.
 */
export function createStorageAdapter(credentials: CustomerStorageCredentials): IStorageAdapter {
  validateCredentials(credentials);
  switch (credentials.type) {
    case 's3':
      return new S3StorageAdapter(credentials);
    case 'gcs':
      return new GcsStorageAdapter(credentials);
    case 'azure-blob':
      return new AzureBlobStorageAdapter(credentials);
    case 'webdav':
      return new WebDavStorageAdapter(credentials);
    case 'sftp':
      return new SftpStorageAdapter(credentials);
    default:
      throw new Error(`Unsupported storage adapter provider type: "${(credentials as { type: string }).type}"`);
  }
}
