import { afterEach, describe, expect, it, vi } from 'vitest';
import { isBillingConfigured, priceIdOf, productOfPriceId, readBillingConfig, readPublicBillingConfig } from '../src/lib/billing/config';
import { PACKAGE_SIZES, SUBSCRIPTION_SIZES, priceIdVariable } from '../src/lib/billing/credits';
import { ConfigurationError, parseConfig } from '../src/lib/config';

const PRICES = {
  ...Object.fromEntries(PACKAGE_SIZES.map((size) => [priceIdVariable('package', size), `pri_package_${size}_fixture`])),
  ...Object.fromEntries(SUBSCRIPTION_SIZES.map((size) => [priceIdVariable('subscription', size), `pri_subscription_${size}_fixture`])),
} as Record<string, string>;

const FULL = {
  PADDLE_API_KEY: 'pdl_sdbx_apikey_fixture',
  PADDLE_WEBHOOK_SECRET: 'pdl_ntfset_fixture',
  PADDLE_CLIENT_TOKEN: 'test_fixture_client_token',
  PADDLE_ENVIRONMENT: 'sandbox',
  ...PRICES,
} as Record<string, string>;
const NAMES = Object.keys(FULL);
const PACKAGE_500 = priceIdVariable('package', 500);
const PACKAGE_1000 = priceIdVariable('package', 1000);
const SUBSCRIPTION_1000 = priceIdVariable('subscription', 1000);
const SUBSCRIPTION_10000 = priceIdVariable('subscription', 10000);

function stub(values: Record<string, string | undefined>) {
  for (const name of NAMES) vi.stubEnv(name, values[name] ?? '');
}

afterEach(() => vi.unstubAllEnvs());

describe('isBillingConfigured', () => {
  it('is off when nothing is set', () => {
    stub({});
    expect(readBillingConfig()).toBeNull();
    expect(isBillingConfigured()).toBe(false);
  });

  it('is on only when all thirteen variables are set: the four of the account and nine price ids', () => {
    expect(NAMES).toHaveLength(13);
    stub(FULL);
    expect(isBillingConfigured()).toBe(true);
    for (const name of NAMES) {
      stub({ ...FULL, [name]: undefined });
      expect(isBillingConfigured(), name).toBe(false);
    }
  });

  it('is off when two products name the same price, a package and a subscription included', () => {
    stub({ ...FULL, [SUBSCRIPTION_10000]: FULL[SUBSCRIPTION_1000] });
    expect(isBillingConfigured()).toBe(false);
    stub({ ...FULL, [PACKAGE_500]: FULL[PACKAGE_1000] });
    expect(isBillingConfigured()).toBe(false);
    stub({ ...FULL, [SUBSCRIPTION_1000]: FULL[PACKAGE_1000] });
    expect(isBillingConfigured()).toBe(false);
  });

  it('is off without the smallest package price, though the other twelve are set', () => {
    stub({ ...FULL, [PACKAGE_500]: undefined });
    expect(isBillingConfigured()).toBe(false);
  });

  it('treats a blank value as unset and an unknown environment as not configured', () => {
    stub({ ...FULL, PADDLE_API_KEY: '   ' });
    expect(isBillingConfigured()).toBe(false);
    stub({ ...FULL, PADDLE_ENVIRONMENT: 'live' });
    expect(isBillingConfigured()).toBe(false);
  });

  it('reads the environment in any letter case and finds what a price id sells', () => {
    stub({ ...FULL, PADDLE_ENVIRONMENT: 'Production' });
    const config = readBillingConfig()!;
    expect(config.environment).toBe('production');
    expect(productOfPriceId(config, 'pri_package_500_fixture')).toEqual({ kind: 'package', credits: 500 });
    expect(productOfPriceId(config, 'pri_package_10000_fixture')).toEqual({ kind: 'package', credits: 10000 });
    expect(productOfPriceId(config, 'pri_subscription_1000_fixture')).toEqual({ kind: 'subscription', credits: 1000 });
    expect(productOfPriceId(config, 'pri_subscription_10000_fixture')).toEqual({ kind: 'subscription', credits: 10000 });
    expect(productOfPriceId(config, 'pri_other')).toBeUndefined();
    expect(priceIdOf(config, { kind: 'package', credits: 2500 })).toBe('pri_package_2500_fixture');
    expect(priceIdOf(config, { kind: 'subscription', credits: 2500 })).toBe('pri_subscription_2500_fixture');
  });

  it('hands a page the price ids and nothing secret', () => {
    stub(FULL);
    const publicConfig = readPublicBillingConfig()!;
    expect(publicConfig.packages.map((entry) => entry.credits)).toEqual([...PACKAGE_SIZES]);
    expect(publicConfig.subscriptions.map((entry) => entry.credits)).toEqual([...SUBSCRIPTION_SIZES]);
    expect(JSON.stringify(publicConfig)).not.toContain(FULL.PADDLE_API_KEY);
    expect(JSON.stringify(publicConfig)).not.toContain(FULL.PADDLE_WEBHOOK_SECRET);
    stub({});
    expect(readPublicBillingConfig()).toBeNull();
  });
});

describe('the configuration schema', () => {
  it('accepts no billing variable and all of them', () => {
    expect(parseConfig({}).PADDLE_ENVIRONMENT).toBe(undefined);
    expect(parseConfig({ ...FULL }).PADDLE_ENVIRONMENT).toBe('sandbox');
  });

  it('knows no variable of the retired plans', () => {
    const parsed = parseConfig({ ...FULL, PADDLE_PRICE_ID_BASIC: 'pri_basic', PADDLE_PRICE_ID_PRO: 'pri_pro', PADDLE_PRICE_ID_ENTERPRISE: 'pri_enterprise' }) as Record<string, unknown>;
    expect(parsed.PADDLE_PRICE_ID_BASIC).toBeUndefined();
    expect(parsed.PADDLE_PRICE_ID_PRO).toBeUndefined();
    expect(parsed.PADDLE_PRICE_ID_ENTERPRISE).toBeUndefined();
  });

  it('refuses a part of them and names the missing ones, never a value', () => {
    let error: unknown;
    try {
      parseConfig({ PADDLE_API_KEY: FULL.PADDLE_API_KEY, PADDLE_ENVIRONMENT: 'sandbox' });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigurationError);
    expect([...(error as ConfigurationError).variables].sort()).toEqual(NAMES.filter((name) => name !== 'PADDLE_API_KEY' && name !== 'PADDLE_ENVIRONMENT').sort());
    expect((error as ConfigurationError).message).not.toContain(FULL.PADDLE_API_KEY);
  });

  it('refuses one price id for two products, which could not tell a purchase of one from the other, and names the later one', () => {
    let error: unknown;
    try {
      parseConfig({ ...FULL, [SUBSCRIPTION_10000]: FULL[PACKAGE_500] });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigurationError);
    expect((error as ConfigurationError).variables).toEqual([SUBSCRIPTION_10000]);
    expect((error as ConfigurationError).message).not.toContain(FULL[PACKAGE_500]);
  });

  it('refuses an environment that is neither sandbox nor production', () => {
    expect(() => parseConfig({ ...FULL, PADDLE_ENVIRONMENT: 'live' })).toThrow(ConfigurationError);
  });
});
