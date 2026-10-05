import { redactSecrets, redactText, redactUrl } from '../security/redact';
import type { ApiKey, WebhookDlqEntry } from './types';

/** API key as returned by the API: no stored hash and no webhook signing secret. */
export type PublicApiKey = Omit<ApiKey, 'keyHash' | 'webhookSecret'> & {
  hasWebhookSecret: boolean;
};

/** Webhook DLQ entry as returned by the API: no webhook signing secret, and no credentials in the target URL, payload or error. */
export type PublicWebhookDlqEntry = Omit<WebhookDlqEntry, 'secret'>;

export function toPublicApiKey(key: ApiKey): PublicApiKey {
  const { keyHash: _keyHash, webhookSecret, ...rest } = key;
  return { ...rest, hasWebhookSecret: Boolean(webhookSecret) };
}

export function toPublicDlqEntry(entry: WebhookDlqEntry): PublicWebhookDlqEntry {
  const { secret: _secret, ...rest } = entry;
  return {
    ...rest,
    targetUrl: redactUrl(rest.targetUrl),
    payload: redactSecrets(rest.payload),
    errorMessage: rest.errorMessage === undefined ? undefined : redactText(rest.errorMessage),
  };
}
