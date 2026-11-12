// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testMessages, type TestLocale } from './helpers/intl-messages';

const paddle = vi.hoisted(() => ({
  checkoutOpen: vi.fn(),
  pricePreview: vi.fn(),
  initializePaddle: vi.fn(),
}));
vi.mock('@paddle/paddle-js', () => ({ initializePaddle: paddle.initializePaddle }));
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined, prefetch: () => Promise.resolve() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/pricing',
}));

const { default: PaidPlanCards } = await import('../src/components/billing/PaidPlanCards');
const { applySessionChange } = await import('../src/lib/viewer-plan');
const { PLAN_MAX_FILE_BYTES, TIER_LIMITS } = await import('../src/lib/plan-limits');
const { formatBytesForDisplay } = await import('../src/lib/format-bytes');

/** The paid plans of the pricing page, driven as a visitor sees them: coming soon until billing is on, then a checkout. */

const ENABLED_STATUS = {
  success: true,
  enabled: true,
  environment: 'sandbox',
  clientToken: 'test_fixture_client_token',
  plans: [
    { plan: 'pro', priceId: 'pri_pro_fixture' },
    { plan: 'enterprise', priceId: 'pri_enterprise_fixture' },
  ],
  subscription: null,
};

let root: Root | undefined;
const fetchLog: string[] = [];

function stubServer(options: { status: unknown; user?: { id: string; name: string; tier: string }; checkout?: unknown }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      fetchLog.push(`${init?.method ?? 'GET'} ${url}`);
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
      if (url === '/api/auth/me') return options.user ? json({ success: true, user: options.user }) : json({ success: false, user: null });
      if (url === '/api/billing/status') return options.status === 'fail' ? json({}, 500) : json(options.status);
      if (url === '/api/billing/checkout') return json(options.checkout ?? {}, options.checkout ? 200 : 409);
      throw new Error(`unexpected request ${url}`);
    })
  );
}

async function mount(locale: TestLocale = 'en'): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(createElement(NextIntlClientProvider, { locale, messages: testMessages(locale), timeZone: 'UTC', children: createElement('div', null, createElement(PaidPlanCards)) }));
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  return host;
}

const buttons = (host: HTMLElement) => [...host.querySelectorAll('button')];
const labels = (host: HTMLElement) => buttons(host).map((button) => button.textContent);

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fetchLog.length = 0;
  paddle.checkoutOpen.mockReset();
  paddle.pricePreview.mockReset().mockResolvedValue({
    data: { details: { lineItems: [{ price: { billingCycle: { interval: 'month', frequency: 1 } }, formattedTotals: { total: '$9.00' } }] } },
  });
  paddle.initializePaddle.mockReset().mockImplementation(async () => ({ Checkout: { open: paddle.checkoutOpen }, PricePreview: paddle.pricePreview }));
  applySessionChange(null);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('the paid plans while billing is not configured', () => {
  it.each(['en', 'ko'] as const)('show both plans as coming soon with disabled buttons in %s', async (locale) => {
    stubServer({ status: { success: true, enabled: false } });
    const host = await mount(locale);
    const soon = testMessages(locale).billing.comingSoon;
    expect(host.querySelectorAll('section')).toHaveLength(2);
    expect(labels(host)).toEqual([soon, soon]);
    for (const button of buttons(host)) {
      expect(button.disabled).toBe(true);
      expect(button.getAttribute('aria-disabled')).toBe('true');
    }
    expect(host.textContent?.split(soon).length).toBe(2 * 2 + 1);
  });

  it('offers nothing to buy: no checkout request, no Paddle.js, no price', async () => {
    stubServer({ status: { success: true, enabled: false } });
    const host = await mount();
    expect(fetchLog.filter((entry) => entry.includes('/api/billing/checkout'))).toEqual([]);
    expect(paddle.initializePaddle).not.toHaveBeenCalled();
    expect(host.textContent).not.toMatch(/[$€£₩]\s?\d/);
  });

  it('keeps them coming soon when the status cannot be read', async () => {
    stubServer({ status: 'fail' });
    const host = await mount();
    expect(labels(host)).toEqual(['Coming soon', 'Coming soon']);
    expect(paddle.initializePaddle).not.toHaveBeenCalled();
  });

  it('states the limits the server enforces for each plan', async () => {
    stubServer({ status: { success: true, enabled: false } });
    const text = (await mount()).textContent ?? '';
    for (const plan of ['pro', 'enterprise'] as const) {
      expect(text).toContain(`${TIER_LIMITS[plan].toLocaleString('en-US')} conversions a day`);
      expect(text).toContain(`Up to ${formatBytesForDisplay(PLAN_MAX_FILE_BYTES[plan])} per file`);
    }
  });
});

describe('the paid plans once billing is configured', () => {
  it('asks a visitor to sign in, and shows the price Paddle gives', async () => {
    stubServer({ status: ENABLED_STATUS });
    const host = await mount();
    expect(host.textContent).not.toContain('Coming soon');
    expect(buttons(host)).toEqual([]);
    expect([...host.querySelectorAll('a')].map((link) => link.textContent)).toEqual(['Sign in to subscribe', 'Sign in to subscribe']);
    expect(paddle.initializePaddle).toHaveBeenCalledWith(expect.objectContaining({ environment: 'sandbox', token: 'test_fixture_client_token' }));
    expect(host.textContent).toContain('$9.00 per month');
  });

  it('opens the checkout of the plan for a signed-in account, with the signed account id', async () => {
    const checkout = { items: [{ priceId: 'pri_pro_fixture', quantity: 1 }], customer: { email: 'a@b.test' }, customData: { easyconvertUserId: 'u1', easyconvertBinding: 'tag' } };
    stubServer({ status: ENABLED_STATUS, user: { id: 'u1', name: 'Ada', tier: 'free' }, checkout: { success: true, checkout } });
    const host = await mount();
    expect(labels(host)).toEqual(['Subscribe', 'Subscribe']);
    await act(async () => buttons(host)[0].click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(fetchLog).toContain('POST /api/billing/checkout');
    expect(paddle.checkoutOpen).toHaveBeenCalledWith({ ...checkout, settings: { displayMode: 'overlay', locale: 'en' } });
  });

  it('marks the plan the account has and offers the other plan through the portal', async () => {
    stubServer({ status: ENABLED_STATUS, user: { id: 'u1', name: 'Ada', tier: 'pro' } });
    const host = await mount();
    expect(labels(host)).toEqual(['Current plan', 'Manage subscription']);
    expect(buttons(host)[0].disabled).toBe(true);
  });

  it('words a refusal of the checkout and opens nothing', async () => {
    stubServer({ status: ENABLED_STATUS, user: { id: 'u1', name: 'Ada', tier: 'free' } });
    const host = await mount();
    await act(async () => buttons(host)[1].click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(paddle.checkoutOpen).not.toHaveBeenCalled();
  });
});
