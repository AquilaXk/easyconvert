/**
 * How long each text a caller sends and a route stores may be (docs/policy-decisions.md, entry 343). Redis does not evict, and the
 * edge lets a small JSON body reach 1 MiB, so a text with no limit lets one request store 1 MiB of its own choosing. Each figure is
 * far above what a person types and what the value is for.
 */

/** The display name of an account, in UTF-16 code units. */
export const MAX_DISPLAY_NAME_LENGTH = 100;
/** The avatar address of an account (a URL). */
export const MAX_AVATAR_URL_LENGTH = 2048;
/** The name of an API key. */
export const MAX_KEY_NAME_LENGTH = 100;
/** The entries of the address list of an API key, and the longest one (an IPv6 block with its prefix is 43). */
export const MAX_ALLOWED_IPS = 64;
export const MAX_ALLOWED_IP_LENGTH = 64;
/** A webhook address and the secret that signs its deliveries. */
export const MAX_WEBHOOK_URL_LENGTH = 2048;
export const MAX_WEBHOOK_SECRET_LENGTH = 512;
/** The name of a saved storage credential, and the credential itself as JSON (a service account key is about 2.4 KB). */
export const MAX_STORAGE_CREDENTIAL_NAME_LENGTH = 100;
export const MAX_STORAGE_CREDENTIAL_JSON_BYTES = 16 * 1024;
/** The most credentials one account keeps saved at once, the same number as its active API keys (docs/policy-decisions.md, entry 372). */
export const MAX_STORAGE_CREDENTIALS_PER_ACCOUNT = 20;

/** Why an address list of an API key is refused (its entries are checked as addresses where the key is used), or null when it is within the limits. */
export function allowedIpsListError(list: readonly unknown[]): string | null {
  if (list.length > MAX_ALLOWED_IPS) return `allowedIps can hold at most ${MAX_ALLOWED_IPS} entries.`;
  for (const ip of list) {
    if (typeof ip !== 'string' || !ip.trim()) return 'Every item in allowedIps must be a non-empty string.';
    if (ip.trim().length > MAX_ALLOWED_IP_LENGTH) return `Every item in allowedIps must be at most ${MAX_ALLOWED_IP_LENGTH} characters long.`;
  }
  return null;
}
