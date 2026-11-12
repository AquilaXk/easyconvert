import { readBillingConfig, type BillingConfig } from './config';
import { PaddleBillingProvider } from './paddle-provider';
import type { BillingProvider } from './types';

export { isBillingConfigured } from './config';

let cached: { config: BillingConfig; provider: BillingProvider } | undefined;

/** The payment provider, or null when billing is not fully configured. Rebuilt when the configuration changes. */
export function getBillingProvider(): { config: BillingConfig; provider: BillingProvider } | null {
  const config = readBillingConfig();
  if (!config) return null;
  if (!cached || JSON.stringify(cached.config) !== JSON.stringify(config)) cached = { config, provider: new PaddleBillingProvider(config) };
  return cached;
}
