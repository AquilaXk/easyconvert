import { SEALED_PREFIX, SecretSealError, sealJobSecret, unsealJobSecret } from './job-secret-seal';

/**
 * The signing secret of a webhook travels through the queues and the graph state sealed, like the passwords of a job: the stored
 * record holds an AES-256-GCM blob bound to the id of the record that carries it (a job id, a graph id, a delivery id), and
 * the process that signs a delivery opens it in memory. A copy of the blob in another record fails authentication.
 */

/** `secret` sealed for `boundTo`. An empty or missing secret is not a secret and stays as it is. */
export function sealWebhookSecret<T extends string | undefined>(secret: T, boundTo: string): T | string {
  return secret ? sealJobSecret(secret, boundTo) : secret;
}

/**
 * The plaintext of a stored webhook secret. A value that is not sealed is returned as it is: a job queued before sealing
 * existed carries it in plain text.
 *
 * @throws SecretSealError when the blob is not sealed for `boundTo` under a configured key.
 */
export function openWebhookSecret<T extends string | undefined>(stored: T, boundTo: string): T | string {
  return stored?.startsWith(SEALED_PREFIX) ? unsealJobSecret(stored, boundTo) : stored;
}

/** The plaintext of a stored webhook secret, or undefined (and a log line without the value) when it cannot be opened. */
export function openWebhookSecretOrLog(stored: string | undefined, boundTo: string, owner: string): string | undefined {
  try {
    return openWebhookSecret(stored, boundTo);
  } catch (err) {
    if (!(err instanceof SecretSealError)) throw err;
    console.error(`[WebhookSecret] The webhook secret of ${owner} could not be opened (${err.code}); no delivery is signed for it.`);
    return undefined;
  }
}
