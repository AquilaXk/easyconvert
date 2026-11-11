/**
 * The store that decides who a caller is (accounts, sessions, API keys) could not answer. With Redis configured nothing else
 * may answer in its place: a process that fell back to its own memory or to a file on its disk would accept a deleted key, a
 * revoked session or an old plan. The error carries the status of the refusal (503) and the seconds a caller may retry after.
 */
export const AUTH_STORE_RETRY_AFTER_SECONDS = 5;

export class AuthStoreUnavailableError extends Error {
  readonly status = 503;
  readonly retryAfterSeconds = AUTH_STORE_RETRY_AFTER_SECONDS;

  constructor(message = 'The account store is temporarily unavailable.') {
    super(message);
    this.name = 'AuthStoreUnavailableError';
  }
}

/** Logs a failed Redis step (never a value) and throws the typed refusal. */
export function failClosed(store: string, step: string, cause: unknown): never {
  console.error(`[${store}] Redis ${step} failed; refusing instead of answering from this process:`, cause);
  throw new AuthStoreUnavailableError();
}
