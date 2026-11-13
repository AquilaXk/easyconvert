// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicBillingConfig } from '../src/lib/billing/types';
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
const { PLAN_CONCURRENCY, PLAN_MAX_FILE_BYTES, PLAN_PROCESSING_MINUTES, TIER_LIMITS } = await import('../src/lib/plan-limits');
const { formatBytesForDisplay } = await import('../src/lib/format-bytes');

/** The paid plans of the pricing page, driven as a visitor sees them: coming soon until the server says billing is on, then a checkout. */

const BILLING: PublicBillingConfig = {
  environment: 'sandbox',
  clientToken: 'test_fixture_client_token',
  plans: [
    { plan: 'basic', priceId: 'pri_basic_fixture' },
    { plan: 'pro', priceId: 'pri_pro_fixture' },
    { plan: 'enterprise', priceId: 'pri_enterprise_fixture' },
  ],
};

let root: Root | undefined;
const fetchLog: string[] = [];

function stubServer(options: { user?: { id: string; name: string; tier: string }; checkout?: unknown }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      fetchLog.push(`${init?.method ?? 'GET'} ${url}`);
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
      if (url === '/api/auth/me') return options.user ? json({ success: true, user: options.user }) : json({ success: false, user: null });
      if (url === '/api/billing/checkout') return json(options.checkout ?? {}, options.checkout ? 200 : 409);
      throw new Error(`unexpected request ${url}`);
    })
  );
}

async function mount(billing: PublicBillingConfig | null, locale: TestLocale = 'en'): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(createElement(NextIntlClientProvider, { locale, messages: testMessages(locale), timeZone: 'UTC', children: createElement('div', null, createElement(PaidPlanCards, { billing })) }));
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
  it.each(['en', 'ko'] as const)('show the three plans as coming soon with disabled buttons in %s', async (locale) => {
    stubServer({});
    const host = await mount(null, locale);
    const soon = testMessages(locale).billing.comingSoon;
    expect(host.querySelectorAll('section')).toHaveLength(3);
    expect(labels(host)).toEqual([soon, soon, soon]);
    for (const button of buttons(host)) {
      expect(button.disabled).toBe(true);
      expect(button.getAttribute('aria-disabled')).toBe('true');
    }
    expect(host.textContent?.split(soon).length).toBe(3 * 2 + 1);
  });

  it('offers nothing to buy and asks the server nothing about billing: no checkout request, no Paddle.js, no price', async () => {
    stubServer({});
    const host = await mount(null);
    expect(fetchLog.filter((entry) => entry.includes('/api/billing'))).toEqual([]);
    expect(paddle.initializePaddle).not.toHaveBeenCalled();
    expect(host.textContent).not.toMatch(/[$€£₩]\s?\d/);
  });

  it('states the limits the server enforces for each plan', async () => {
    stubServer({});
    const text = (await mount(null)).textContent ?? '';
    for (const plan of ['basic', 'pro', 'enterprise'] as const) {
      expect(text).toContain(`${TIER_LIMITS[plan].toLocaleString('en-US')} conversions a month`);
      expect(text).toContain(`Up to ${formatBytesForDisplay(PLAN_MAX_FILE_BYTES[plan])} per file`);
      expect(text).toContain(`${PLAN_CONCURRENCY[plan]} conversions at the same time`);
      expect(text).toContain(`Up to ${PLAN_PROCESSING_MINUTES[plan]} minutes per conversion`);
    }
  });
});

describe('the paid plans once the server says billing is configured', () => {
  it('asks a visitor to sign in, and shows the price Paddle gives', async () => {
    stubServer({});
    const host = await mount(BILLING);
    expect(host.textContent).not.toContain('Coming soon');
    expect(buttons(host)).toEqual([]);
    expect([...host.querySelectorAll('a')].map((link) => link.textContent)).toEqual(['Sign in to subscribe', 'Sign in to subscribe', 'Sign in to subscribe']);
    expect(paddle.initializePaddle).toHaveBeenCalledWith(expect.objectContaining({ environment: 'sandbox', token: 'test_fixture_client_token' }));
    expect(host.textContent).toContain('$9.00 per month');
    expect(fetchLog.filter((entry) => entry.includes('/api/billing/status'))).toEqual([]);
  });

  it('opens the checkout of the plan for a signed-in account, with the signed account id', async () => {
    const checkout = { items: [{ priceId: 'pri_pro_fixture', quantity: 1 }], customer: { email: 'a@b.test' }, customData: { easyconvertUserId: 'u1', easyconvertBinding: 'tag' } };
    stubServer({ user: { id: 'u1', name: 'Ada', tier: 'free' }, checkout: { success: true, checkout } });
    const host = await mount(BILLING);
    expect(labels(host)).toEqual(['Subscribe', 'Subscribe', 'Subscribe']);
    await act(async () => buttons(host)[1].click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(fetchLog).toContain('POST /api/billing/checkout');
    expect(paddle.checkoutOpen).toHaveBeenCalledWith({ ...checkout, settings: { displayMode: 'overlay', locale: 'en' } });
  });

  it('marks the plan the account has and offers the other plans through the portal', async () => {
    stubServer({ user: { id: 'u1', name: 'Ada', tier: 'pro' } });
    const host = await mount(BILLING);
    expect(labels(host)).toEqual(['Manage subscription', 'Current plan', 'Manage subscription']);
    expect(buttons(host)[1].disabled).toBe(true);
  });

  it('treats a Basic subscriber as a paid account, which manages its plan in the portal', async () => {
    stubServer({ user: { id: 'u1', name: 'Ada', tier: 'basic' } });
    const host = await mount(BILLING);
    expect(labels(host)).toEqual(['Current plan', 'Manage subscription', 'Manage subscription']);
  });

  it('words a refusal of the checkout and opens nothing', async () => {
    stubServer({ user: { id: 'u1', name: 'Ada', tier: 'free' } });
    const host = await mount(BILLING);
    await act(async () => buttons(host)[1].click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(paddle.checkoutOpen).not.toHaveBeenCalled();
  });
});
