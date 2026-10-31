import type { UserConversionFile } from '@/lib/api-keys/types';

export type DashboardTab = 'api' | 'files' | 'dlq' | 'usage';

export type KeyExpiryOption = '30d' | '60d' | '90d' | '1y' | 'never';

export const KEY_EXPIRY_OPTIONS: ReadonlyArray<{ value: KeyExpiryOption; label: string }> = [
  { value: '30d', label: '30 Days' },
  { value: '60d', label: '60 Days' },
  { value: '90d', label: '90 Days' },
  { value: '1y', label: '1 Year' },
  { value: 'never', label: 'Never (No Expiration)' },
];

export function isKeyExpiryOption(value: string): value is KeyExpiryOption {
  return KEY_EXPIRY_OPTIONS.some((opt) => opt.value === value);
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

export function formatCountdown(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${minutes}m ${secs < 10 ? '0' : ''}${secs}s`;
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const base = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(base)));
  return `${Number.parseFloat((bytes / Math.pow(base, index)).toFixed(1))} ${sizes[index]}`;
}
