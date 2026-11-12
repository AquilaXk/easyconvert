import { ConversionFailedError } from '../types';
import type { ConversionRefusalCode } from '../refusal-codes';
import {
  StorageAdapterError,
  StorageAuthenticationError,
  StorageInputError,
  StorageListingLimitError,
  StorageNotFoundError,
  StorageServiceError,
  StorageSizeLimitError,
  StorageSsrfError,
  StorageTimeoutError,
} from './adapters/adapter-interface';

/**
 * How a node that reads from or writes to the customer's own store fails. Each cause has a code of its own, so a job view, a
 * webhook and the page word it (messages `refusals`), and says whether another attempt may end otherwise: a verdict about the
 * customer's settings is final, a store that did not answer is not.
 */
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const HTTP_BAD_GATEWAY = 502;

/** The saved credential a node names is not there, has expired, or belongs to another account. */
export class StorageCredentialNotFoundError extends ConversionFailedError {
  readonly refusalCode: ConversionRefusalCode = 'storage_credential_not_found';
  readonly status = HTTP_NOT_FOUND;
  constructor(message: string) {
    super(message);
    this.name = 'StorageCredentialNotFoundError';
  }
}

/** The store refused the credentials, or the permission the node needs. */
export class StorageAccessDeniedError extends ConversionFailedError {
  readonly refusalCode: ConversionRefusalCode = 'storage_access_denied';
  readonly status = HTTP_FORBIDDEN;
  constructor(message: string) {
    super(message);
    this.name = 'StorageAccessDeniedError';
  }
}

/** The endpoint or host is not a public address reached over TLS (S3), so nothing was sent to it. */
export class StorageEndpointBlockedError extends ConversionFailedError {
  readonly refusalCode: ConversionRefusalCode = 'storage_endpoint_blocked';
  readonly status = HTTP_FORBIDDEN;
  constructor(message: string) {
    super(message);
    this.name = 'StorageEndpointBlockedError';
  }
}

/** The key, the prefix or the file the node names is not in the store, or the prefix holds nothing. */
export class StorageObjectNotFoundError extends ConversionFailedError {
  readonly refusalCode: ConversionRefusalCode = 'storage_object_not_found';
  readonly status = HTTP_NOT_FOUND;
  constructor(message: string) {
    super(message);
    this.name = 'StorageObjectNotFoundError';
  }
}

/** The prefix or directory holds more files than the node's `maxObjects`. */
export class StorageTooManyObjectsError extends ConversionFailedError {
  readonly refusalCode: ConversionRefusalCode = 'storage_too_many_objects';
  readonly status = HTTP_PAYLOAD_TOO_LARGE;
  constructor(message: string) {
    super(message);
    this.name = 'StorageTooManyObjectsError';
  }
}

/** A file in the store is larger than the plan's file limit. */
export class StorageObjectTooLargeError extends ConversionFailedError {
  readonly refusalCode: ConversionRefusalCode = 'input_over_limit';
  readonly status = HTTP_PAYLOAD_TOO_LARGE;
  constructor(message: string) {
    super(message);
    this.name = 'StorageObjectTooLargeError';
  }
}

/** The store did not answer, or answered with a failure that is its own. Another attempt may end otherwise when `retryable`. */
export class StorageUnavailableError extends ConversionFailedError {
  readonly refusalCode: ConversionRefusalCode = 'storage_unavailable';
  readonly status = HTTP_BAD_GATEWAY;
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = 'StorageUnavailableError';
    this.retryable = retryable;
  }
}

/**
 * The typed failure of an error an adapter threw. The message is the adapter's, which masks userinfo and query of a URL and
 * carries no credential; an error that is not an adapter's passes through unchanged.
 */
export function customerStorageFailure(err: unknown): unknown {
  if (!(err instanceof StorageAdapterError)) return err;
  if (err instanceof StorageSsrfError) return new StorageEndpointBlockedError(err.message);
  if (err instanceof StorageAuthenticationError) return new StorageAccessDeniedError(err.message);
  if (err instanceof StorageNotFoundError) return new StorageObjectNotFoundError(err.message);
  if (err instanceof StorageSizeLimitError) return new StorageObjectTooLargeError(`A file in the store passed the ${err.maxBytes}-byte limit while it was fetched.`);
  if (err instanceof StorageListingLimitError) return new StorageTooManyObjectsError(`${err.message}; narrow the prefix or directory, or raise maxObjects`);
  // a name the store cannot address was refused at submission; this is the same check at the store
  if (err instanceof StorageInputError) return new ConversionFailedError(err.message);
  if (err instanceof StorageTimeoutError) return new StorageUnavailableError(err.message, true);
  if (err instanceof StorageServiceError) return new StorageUnavailableError(err.message, err.retryable);
  return new StorageUnavailableError(err.message, true);
}
