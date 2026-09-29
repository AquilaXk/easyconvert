import type { ApiKey, WebhookDlqEntry } from './types';

/** API key as returned by the API: no stored hash and no webhook signing secret. */
export type PublicApiKey = Omit<ApiKey, 'keyHash' | 'webhookSecret'> & {
  hasWebhookSecret: boolean;
};

/** Webhook DLQ entry as returned by the API: no webhook signing secret. */
export type PublicWebhookDlqEntry = Omit<WebhookDlqEntry, 'secret'>;

export function toPublicApiKey(key: ApiKey): PublicApiKey {
  const { keyHash: _keyHash, webhookSecret, ...rest } = key;
  return { ...rest, hasWebhookSecret: Boolean(webhookSecret) };
}

export function toPublicDlqEntry(entry: WebhookDlqEntry): PublicWebhookDlqEntry {
  const { secret: _secret, ...rest } = entry;
  return rest;
}
