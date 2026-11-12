import { afterEach, describe, expect, it, vi } from 'vitest';
import { isBillingConfigured, planOfPriceId, readBillingConfig } from '../src/lib/billing/config';
import { ConfigurationError, parseConfig } from '../src/lib/config';

const FULL = {
  PADDLE_API_KEY: 'pdl_sdbx_apikey_fixture',
  PADDLE_WEBHOOK_SECRET: 'pdl_ntfset_fixture',
  PADDLE_CLIENT_TOKEN: 'test_fixture_client_token',
  PADDLE_ENVIRONMENT: 'sandbox',
  PADDLE_PRICE_ID_PRO: 'pri_pro_fixture',
  PADDLE_PRICE_ID_ENTERPRISE: 'pri_enterprise_fixture',
} as const;

function stub(values: Record<string, string | undefined>) {
  for (const name of Object.keys(FULL)) vi.stubEnv(name, values[name] ?? '');
}

afterEach(() => vi.unstubAllEnvs());

describe('isBillingConfigured', () => {
  it('is off when nothing is set', () => {
    stub({});
    expect(readBillingConfig()).toBeNull();
    expect(isBillingConfigured()).toBe(false);
  });

  it('is on only when all six variables are set', () => {
    stub(FULL);
    expect(isBillingConfigured()).toBe(true);
    for (const name of Object.keys(FULL)) {
      stub({ ...FULL, [name]: undefined });
      expect(isBillingConfigured(), name).toBe(false);
    }
  });

  it('treats a blank value as unset and an unknown environment as not configured', () => {
    stub({ ...FULL, PADDLE_API_KEY: '   ' });
    expect(isBillingConfigured()).toBe(false);
    stub({ ...FULL, PADDLE_ENVIRONMENT: 'live' });
    expect(isBillingConfigured()).toBe(false);
  });

  it('reads the environment in any letter case and finds the plan of a price id', () => {
    stub({ ...FULL, PADDLE_ENVIRONMENT: 'Production' });
    const config = readBillingConfig()!;
    expect(config.environment).toBe('production');
    expect(planOfPriceId(config, 'pri_pro_fixture')).toBe('pro');
    expect(planOfPriceId(config, 'pri_enterprise_fixture')).toBe('enterprise');
    expect(planOfPriceId(config, 'pri_other')).toBeUndefined();
  });
});

describe('the configuration schema', () => {
  it('accepts no billing variable and all of them', () => {
    expect(parseConfig({}).PADDLE_ENVIRONMENT).toBe(undefined);
    expect(parseConfig({ ...FULL }).PADDLE_ENVIRONMENT).toBe('sandbox');
  });

  it('refuses a part of them and names the missing ones, never a value', () => {
    let error: unknown;
    try {
      parseConfig({ PADDLE_API_KEY: FULL.PADDLE_API_KEY, PADDLE_ENVIRONMENT: 'sandbox' });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigurationError);
    expect([...(error as ConfigurationError).variables].sort()).toEqual(['PADDLE_CLIENT_TOKEN', 'PADDLE_PRICE_ID_ENTERPRISE', 'PADDLE_PRICE_ID_PRO', 'PADDLE_WEBHOOK_SECRET']);
    expect((error as ConfigurationError).message).not.toContain(FULL.PADDLE_API_KEY);
  });

  it('refuses an environment that is neither sandbox nor production', () => {
    expect(() => parseConfig({ ...FULL, PADDLE_ENVIRONMENT: 'live' })).toThrow(ConfigurationError);
  });
});
