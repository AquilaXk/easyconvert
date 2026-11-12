import { PAID_PLANS, type PaidPlan } from './types';

/** What the payment provider needs, read from the environment at call time (`PADDLE_*`; src/lib/config/schema.ts). */
export interface BillingConfig {
  apiKey: string;
  webhookSecret: string;
  clientToken: string;
  environment: 'sandbox' | 'production';
  priceIds: Readonly<Record<PaidPlan, string>>;
}

function setValue(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  return value ? value : undefined;
}

/**
 * The billing settings, or null when billing is not fully configured: the API key, the webhook secret, the client token, the
 * environment and a price id for every paid plan are all required. A null result keeps the paid plans off: the pricing page
 * shows them as coming soon and every billing route answers 503.
 */
export function readBillingConfig(): BillingConfig | null {
  const apiKey = setValue(process.env.PADDLE_API_KEY);
  const webhookSecret = setValue(process.env.PADDLE_WEBHOOK_SECRET);
  const clientToken = setValue(process.env.PADDLE_CLIENT_TOKEN);
  const environment = setValue(process.env.PADDLE_ENVIRONMENT)?.toLowerCase();
  const pro = setValue(process.env.PADDLE_PRICE_ID_PRO);
  const enterprise = setValue(process.env.PADDLE_PRICE_ID_ENTERPRISE);
  if (!apiKey || !webhookSecret || !clientToken || !pro || !enterprise) return null;
  if (environment !== 'sandbox' && environment !== 'production') return null;
  if (pro === enterprise) return null;
  const priceIds: Record<PaidPlan, string> = { pro, enterprise };
  return { apiKey, webhookSecret, clientToken, environment, priceIds };
}

export function isBillingConfigured(): boolean {
  return readBillingConfig() !== null;
}

/** The plan a price id sells, or undefined for a price this configuration does not list. */
export function planOfPriceId(config: BillingConfig, priceId: string): PaidPlan | undefined {
  return PAID_PLANS.find((plan) => config.priceIds[plan] === priceId);
}
