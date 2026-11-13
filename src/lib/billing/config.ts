import { PACKAGE_SIZES, SUBSCRIPTION_SIZES, priceIdVariable, type PackageSize, type Product, type SubscriptionSize } from './credits';
import type { PublicBillingConfig } from './types';

/** What the payment provider needs, read from the environment at call time (`PADDLE_*`; src/lib/config/schema-billing.ts). */
export interface BillingConfig {
  apiKey: string;
  webhookSecret: string;
  clientToken: string;
  environment: 'sandbox' | 'production';
  packagePriceIds: Readonly<Record<PackageSize, string>>;
  subscriptionPriceIds: Readonly<Record<SubscriptionSize, string>>;
}

function setValue(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  return value ? value : undefined;
}

/** The price id of every size of `kind`, or undefined when one of them is not set. */
function readPriceIds<Size extends number>(kind: 'package' | 'subscription', sizes: readonly Size[]): Record<Size, string> | undefined {
  const entries = sizes.map((size) => [size, setValue(process.env[priceIdVariable(kind, size)])] as const);
  if (entries.some(([, id]) => id === undefined)) return undefined;
  return Object.fromEntries(entries) as Record<Size, string>;
}

/**
 * The billing settings, or null when billing is not fully configured: the API key, the webhook secret, the client token, the
 * environment and a price id for every package and every subscription (nine, all different) are all required. A null result keeps
 * the purchases off: the pricing page shows them as coming soon and every billing route answers 503.
 */
export function readBillingConfig(): BillingConfig | null {
  const apiKey = setValue(process.env.PADDLE_API_KEY);
  const webhookSecret = setValue(process.env.PADDLE_WEBHOOK_SECRET);
  const clientToken = setValue(process.env.PADDLE_CLIENT_TOKEN);
  const environment = setValue(process.env.PADDLE_ENVIRONMENT)?.toLowerCase();
  const packagePriceIds = readPriceIds('package', PACKAGE_SIZES);
  const subscriptionPriceIds = readPriceIds('subscription', SUBSCRIPTION_SIZES);
  if (!apiKey || !webhookSecret || !clientToken || !packagePriceIds || !subscriptionPriceIds) return null;
  if (environment !== 'sandbox' && environment !== 'production') return null;
  const all = [...Object.values(packagePriceIds), ...Object.values(subscriptionPriceIds)];
  if (new Set(all).size !== all.length) return null;
  return { apiKey, webhookSecret, clientToken, environment, packagePriceIds, subscriptionPriceIds };
}

export function isBillingConfigured(): boolean {
  return readBillingConfig() !== null;
}

/** The price id that sells `product`. */
export function priceIdOf(config: BillingConfig, product: Product): string {
  return product.kind === 'package' ? config.packagePriceIds[product.credits] : config.subscriptionPriceIds[product.credits];
}

/** What a price id sells, or undefined for a price this configuration does not list. */
export function productOfPriceId(config: BillingConfig, priceId: string): Product | undefined {
  const pack = PACKAGE_SIZES.find((size) => config.packagePriceIds[size] === priceId);
  if (pack !== undefined) return { kind: 'package', credits: pack };
  const subscription = SUBSCRIPTION_SIZES.find((size) => config.subscriptionPriceIds[size] === priceId);
  return subscription === undefined ? undefined : { kind: 'subscription', credits: subscription };
}

/** The part of the configuration a page may carry to the browser, or null when nothing is on sale. */
export function readPublicBillingConfig(): PublicBillingConfig | null {
  const config = readBillingConfig();
  if (!config) return null;
  return {
    environment: config.environment,
    clientToken: config.clientToken,
    packages: PACKAGE_SIZES.map((credits) => ({ credits, priceId: config.packagePriceIds[credits] })),
    subscriptions: SUBSCRIPTION_SIZES.map((credits) => ({ credits, priceId: config.subscriptionPriceIds[credits] })),
  };
}
