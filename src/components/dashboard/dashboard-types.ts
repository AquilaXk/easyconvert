import type { UserConversionFile } from '@/lib/api-keys/types';

export type DashboardTab = 'api' | 'files' | 'dlq' | 'usage';

export type KeyExpiryOption = '30d' | '60d' | '90d' | '1y' | 'never';

/** The expiry choices of a new key; each one's label is `dashboard.keys.expiry.<value>` in the messages. */
export const KEY_EXPIRY_OPTIONS: readonly KeyExpiryOption[] = ['30d', '60d', '90d', '1y', 'never'];

export function isKeyExpiryOption(value: string): value is KeyExpiryOption {
  return (KEY_EXPIRY_OPTIONS as readonly string[]).includes(value);
}

const EXPIRY_DAYS_BY_OPTION: Record<Exclude<KeyExpiryOption, 'never'>, number> = {
  '30d': 30,
  '60d': 60,
  '90d': 90,
  '1y': 365,
};

export function resolveExpiryTimestamp(expiry: KeyExpiryOption, nowMs: number): number | undefined {
  if (expiry === 'never') {
    return undefined;
  }
  return nowMs + EXPIRY_DAYS_BY_OPTION[expiry] * 86400 * 1000;
}

export interface FileWithRemaining extends UserConversionFile {
  remainingSeconds: number;
}
