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
  StorageAuthenticationError,
  StorageInputError,
  StorageSsrfError,
} from './adapter-interface';
import { GcsStorageAdapter, validateGcsAuthFields } from './gcs';
import { AzureBlobStorageAdapter, resolveAzureBlobAuthFields } from './azure-blob';
import { encodeWebDavBasePath, WebDavStorageAdapter } from './webdav';
import { SftpStorageAdapter, isSftpDevAllowlisted } from './sftp';
import { assertSftpPort, normalizeBasePath, sftpDestination, sftpKnownHostsLine } from './sftp-protocol';
import { S3StorageAdapter } from './s3';
import { SigV4SigningError, assertValidBucketName } from '../s3-sigv4';
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
  isDevAllowlistedEndpoint,
  isTrustedGcsOAuthEndpoint,
  parseCleanBaseEndpointUrl,
} from './http-guard';

/**
 * Providers whose adapter has no network client yet. Registration and every import/export
 * through them fail closed until a real client exists. Every provider currently has one.
 */
export const UNAVAILABLE_STORAGE_PROVIDERS: ReadonlySet<string> = new Set<string>();

const MAX_HTTP_ENDPOINT_URL_CHARS = 8192;
const S3_REGION_PATTERN = /^[a-z0-9-]{1,64}$/;

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

function validateS3Credentials(credentials: Extract<CustomerStorageCredentials, { type: 's3' }>): void {
  if (
    typeof credentials.bucket !== 'string' ||
    !credentials.bucket ||
    typeof credentials.accessKeyId !== 'string' ||
    !credentials.accessKeyId ||
    typeof credentials.secretAccessKey !== 'string' ||
    !credentials.secretAccessKey
  ) {
    throw new StorageAuthenticationError('bucket, accessKeyId, and secretAccessKey are required', 's3');
  }
  try {
    assertValidBucketName(credentials.bucket);
  } catch (err) {
    if (err instanceof SigV4SigningError) {
      throw new StorageInputError(err.message, 's3', err);
    }
    throw err;
  }
  if (credentials.sessionToken !== undefined && typeof credentials.sessionToken !== 'string') {
    throw new StorageInputError('Invalid S3 sessionToken: expected string', 's3');
  }
  if (credentials.region !== undefined && (typeof credentials.region !== 'string' || !S3_REGION_PATTERN.test(credentials.region))) {
    throw new StorageInputError('Region must be lowercase letters, digits, and hyphens.', 's3');
  }
  if (credentials.forcePathStyle !== undefined && typeof credentials.forcePathStyle !== 'boolean') {
    throw new StorageInputError('Invalid S3 forcePathStyle: expected boolean', 's3');
  }
  if (credentials.endpoint !== undefined) {
    validateHttpEndpointSyntax(credentials.endpoint, 's3', 'S3 endpoint does not form a valid URL');
  }
}

function validateGcsCredentials(credentials: Extract<CustomerStorageCredentials, { type: 'gcs' }>): void {
  validateGcsAuthFields(credentials, 'gcs');
  if (credentials.endpoint !== undefined) {
    validateExternalEndpointUrl(credentials.endpoint, 'gcs');
    const hasOAuth = Boolean(credentials.serviceAccountKeyJson || (credentials.clientEmail && credentials.privateKey));
    if (hasOAuth && !isTrustedGcsOAuthEndpoint(new URL(credentials.endpoint))) {
      throw new StorageAdapterError('GCS service-account credentials may only be used with storage.googleapis.com', 'gcs');
    }
  }
}

function validateAzureBlobCredentials(credentials: Extract<CustomerStorageCredentials, { type: 'azure-blob' }>): void {
  resolveAzureBlobAuthFields(credentials, 'azure-blob');
  if (credentials.customEndpoint !== undefined) {
    validateExternalEndpointUrl(credentials.customEndpoint, 'azure-blob');
  }
}

function validateWebDavCredentials(credentials: Extract<CustomerStorageCredentials, { type: 'webdav' }>): void {
  if (typeof credentials.url !== 'string' || !credentials.url) {
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

function validateSftpCredentials(credentials: Extract<CustomerStorageCredentials, { type: 'sftp' }>): void {
  if (typeof credentials.host !== 'string' || !credentials.host) {
    throw new StorageSsrfError('', 'sftp');
  }
  if (credentials.port !== undefined) {
    assertSftpPort(credentials.port);
  }
  if (!isSftpDevAllowlisted(credentials.host, credentials.port) && isPrivateOrRestrictedHost(credentials.host)) {
    throw new StorageSsrfError(credentials.host, 'sftp');
  }
  sftpDestination(credentials.host, credentials.username);
  normalizeBasePath(credentials.basePath);
  if (credentials.hostKey !== undefined) {
    sftpKnownHostsLine(credentials.hostKey);
  }
  if (credentials.password !== undefined && typeof credentials.password !== 'string') {
    throw new StorageInputError('The SFTP password must be a string', 'sftp');
  }
  if (credentials.privateKey !== undefined && typeof credentials.privateKey !== 'string') {
    throw new StorageInputError('The SFTP privateKey must be a string', 'sftp');
  }
  if (credentials.passphrase !== undefined && typeof credentials.passphrase !== 'string') {
    throw new StorageInputError('The SFTP passphrase must be a string', 'sftp');
  }
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
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) {
    throw new StorageAdapterError('Invalid storage credentials payload', 'unknown');
  }
  switch (credentials.type) {
    case 's3':
      validateS3Credentials(credentials);
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
      validateSftpCredentials(credentials);
      break;
    case 'http':
      validateHttpCredentials(credentials);
      break;
    default:
      throw new StorageInputError('Unsupported storage adapter provider type', 'unknown');
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
      throw new StorageInputError(
        `Unsupported storage adapter provider type: "${String((credentials as { type?: unknown }).type)}"`,
        'unknown'
      );
  }
}
