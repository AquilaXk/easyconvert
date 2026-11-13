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

const { default: CreditPlans } = await import('../src/components/billing/CreditPlans');
const { applySessionChange } = await import('../src/lib/viewer-plan');
const { PLAN_CONCURRENCY, PLAN_MAX_FILE_BYTES, PLAN_PROCESSING_MINUTES } = await import('../src/lib/plan-limits');
const { formatBytesForDisplay } = await import('../src/lib/format-bytes');

/** The packages and subscriptions of the pricing page, driven as a visitor sees them: coming soon until the server says billing is on, then a checkout. */

const BILLING: PublicBillingConfig = {
  environment: 'sandbox',
  clientToken: 'test_fixture_client_token',
  packages: [500, 1000, 2500, 5000, 10000].map((credits) => ({ credits: credits as 500, priceId: `pri_package_${credits}_fixture` })),
  subscriptions: [1000, 2500, 5000, 10000].map((credits) => ({ credits: credits as 1000, priceId: `pri_subscription_${credits}_fixture` })),
};

/** The prices QA will enter in Paddle, in the lowest unit of US dollars; stub data of this test only. */
const PRICES: Record<string, string> = {
  pri_package_500_fixture: '499',
  pri_package_1000_fixture: '899',
  pri_package_2500_fixture: '1999',
  pri_package_5000_fixture: '3799',
  pri_package_10000_fixture: '6999',
  pri_subscription_1000_fixture: '499',
  pri_subscription_2500_fixture: '1199',
  pri_subscription_5000_fixture: '2199',
  pri_subscription_10000_fixture: '3999',
};

let root: Root | undefined;
const fetchLog: string[] = [];
const bodies: unknown[] = [];

function stubServer(options: { user?: { id: string; name: string; tier: string }; checkout?: unknown; subscription?: { credits: number; active: boolean } | null }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      fetchLog.push(`${init?.method ?? 'GET'} ${url}`);
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
      if (url === '/api/auth/me') return options.user ? json({ success: true, user: options.user }) : json({ success: false, user: null });
      if (url === '/api/billing/status') {
        const subscription = options.subscription ? { status: 'active', ...options.subscription } : null;
        return json({ success: true, enabled: true, ...BILLING, subscription });
      }
      if (url === '/api/billing/checkout') {
        bodies.push(JSON.parse(String(init?.body)));
        return json(options.checkout ?? {}, options.checkout ? 200 : 409);
      }
      throw new Error(`unexpected request ${url}`);
    })
  );
}

const freeCard = createElement('section', { 'aria-label': 'free' }, 'Free plan');

async function mount(billing: PublicBillingConfig | null, locale: TestLocale = 'en'): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(createElement(NextIntlClientProvider, { locale, messages: testMessages(locale), timeZone: 'UTC', children: createElement('div', null, createElement(CreditPlans, { billing, freeCard })) }));
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  return host;
}

const buttons = (host: HTMLElement) => [...host.querySelectorAll('button')];
const labels = (host: HTMLElement) => buttons(host).map((button) => button.textContent);
const radios = (host: HTMLElement) => [...host.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
const cards = (host: HTMLElement) => [...host.querySelectorAll('section')].map((section) => section.textContent ?? '');
const [PACKAGE_CARD, SUBSCRIPTION_CARD, ENTERPRISE_CARD] = [1, 2, 3];

async function pick(host: HTMLElement, volume: number) {
  const radio = radios(host).find((input) => input.value === String(volume))!;
  await act(async () => radio.click());
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fetchLog.length = 0;
  bodies.length = 0;
  paddle.checkoutOpen.mockReset();
  paddle.pricePreview.mockReset().mockImplementation(async ({ items }: { items: { priceId: string }[] }) => ({
    data: {
      currencyCode: 'USD',
      details: {
        lineItems: items.map(({ priceId }) => ({
          price: { id: priceId, billingCycle: priceId.includes('subscription') ? { interval: 'month', frequency: 1 } : null },
          formattedTotals: { total: `$${(Number(PRICES[priceId]) / 100).toFixed(2)}` },
          totals: { total: PRICES[priceId] },
        })),
      },
    },
  }));
  paddle.initializePaddle.mockReset().mockImplementation(async () => ({ Checkout: { open: paddle.checkoutOpen }, PricePreview: paddle.pricePreview }));
  applySessionChange(null);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('the plans while billing is not configured', () => {
  it.each(['en', 'ko'] as const)('show the package and the subscription as coming soon with disabled buttons, and Enterprise as contact only, in %s', async (locale) => {
    stubServer({});
    const host = await mount(null, locale);
    const soon = testMessages(locale).billing.comingSoon;
    expect(host.querySelectorAll('section')).toHaveLength(4);
    expect(labels(host)).toEqual([soon, soon]);
    for (const button of buttons(host)) {
      expect(button.disabled).toBe(true);
      expect(button.getAttribute('aria-disabled')).toBe('true');
    }
    // A badge and a button on the package and on the subscription, none on Enterprise.
    expect(host.textContent?.split(soon).length).toBe(2 * 2 + 1);
    const enterprise = host.querySelectorAll('section')[ENTERPRISE_CARD].querySelector('a');
    expect(enterprise?.getAttribute('href')).toMatch(/\/contact$/);
  });

  it('offers nothing to buy and asks the server nothing about billing: no checkout request, no Paddle.js, no price', async () => {
    stubServer({});
    const host = await mount(null);
    expect(fetchLog.filter((entry) => entry.includes('/api/billing'))).toEqual([]);
    expect(paddle.initializePaddle).not.toHaveBeenCalled();
    expect(host.textContent).not.toMatch(/[$€£₩]\s?\d/);
  });

  it('states the limits the server enforces for a paid account on the package and on the subscription', async () => {
    stubServer({});
    const host = await mount(null);
    for (const index of [PACKAGE_CARD, SUBSCRIPTION_CARD]) {
      const text = cards(host)[index];
      expect(text).toContain(`Up to ${formatBytesForDisplay(PLAN_MAX_FILE_BYTES.paid)} per file`);
      expect(text).toContain(`${PLAN_CONCURRENCY.paid} conversions at the same time`);
      expect(text).toContain(`Up to ${PLAN_PROCESSING_MINUTES.paid} minutes per conversion`);
      expect(text).toContain('High priority in the queue');
    }
    expect(PLAN_MAX_FILE_BYTES.paid).toBe(10 * 1024 ** 3);
    expect(PLAN_CONCURRENCY.paid).toBe(25);
    expect(PLAN_PROCESSING_MINUTES.paid).toBe(60);
  });
});

describe('the volume selector', () => {
  it('steps over every size that is sold, starts at 1,000 and moves the package and the subscription together', async () => {
    stubServer({});
    const host = await mount(null);
    expect(radios(host).map((input) => input.value)).toEqual(['500', '1000', '2500', '5000', '10000']);
    expect(radios(host).find((input) => input.checked)?.value).toBe('1000');
    expect(cards(host)[PACKAGE_CARD]).toContain('1,000 credits');
    expect(cards(host)[SUBSCRIPTION_CARD]).toContain('1,000 credits every month');

    await pick(host, 5000);
    expect(cards(host)[PACKAGE_CARD]).toContain('5,000 credits');
    expect(cards(host)[SUBSCRIPTION_CARD]).toContain('5,000 credits every month');
    expect(radios(host).find((input) => input.checked)?.value).toBe('5000');
  });

  it('gives a subscription of 1,000 credits at 500, which is the smallest it is sold in, and says so', async () => {
    stubServer({});
    const host = await mount(null);
    await pick(host, 500);
    expect(cards(host)[PACKAGE_CARD]).toContain('500 credits');
    expect(cards(host)[SUBSCRIPTION_CARD]).toContain('1,000 credits every month');
    expect(cards(host)[SUBSCRIPTION_CARD]).toContain('Subscriptions start at 1,000 credits a month.');
    await pick(host, 1000);
    expect(cards(host)[SUBSCRIPTION_CARD]).not.toContain('Subscriptions start at');
  });
});

describe('the plans once the server says billing is configured', () => {
  it('asks a visitor to sign in, and shows the prices Paddle gives and what a credit costs, in one request for all nine prices', async () => {
    stubServer({});
    const host = await mount(BILLING);
    expect(host.textContent).not.toContain('Coming soon');
    expect(buttons(host)).toEqual([]);
    expect([...host.querySelectorAll('a')].map((link) => link.textContent)).toEqual(['Sign in to buy', 'Sign in to subscribe', 'Contact us']);
    expect(paddle.initializePaddle).toHaveBeenCalledWith(expect.objectContaining({ environment: 'sandbox', token: 'test_fixture_client_token' }));
    expect(paddle.pricePreview).toHaveBeenCalledTimes(1);
    expect(paddle.pricePreview.mock.calls[0][0].items).toHaveLength(9);

    expect(cards(host)[PACKAGE_CARD]).toContain('$8.99 once');
    expect(cards(host)[PACKAGE_CARD]).toContain('$0.009 per credit');
    expect(cards(host)[SUBSCRIPTION_CARD]).toContain('$4.99 per month');
    expect(cards(host)[SUBSCRIPTION_CARD]).toContain('$0.005 per credit');
    expect(fetchLog.filter((entry) => entry.includes('/api/billing/status'))).toEqual([]);
  });

  it('follows the volume: the price and the price of a credit of each volume, with no further request to Paddle', async () => {
    stubServer({});
    const host = await mount(BILLING);
    await pick(host, 10000);
    expect(cards(host)[PACKAGE_CARD]).toContain('$69.99 once');
    expect(cards(host)[PACKAGE_CARD]).toContain('$0.007 per credit');
    expect(cards(host)[SUBSCRIPTION_CARD]).toContain('$39.99 per month');
    expect(cards(host)[SUBSCRIPTION_CARD]).toContain('$0.004 per credit');
    await pick(host, 500);
    expect(cards(host)[PACKAGE_CARD]).toContain('$4.99 once');
    // The 1,000-credit subscription is what is sold at the smallest volume.
    expect(cards(host)[SUBSCRIPTION_CARD]).toContain('$4.99 per month');
    expect(paddle.pricePreview).toHaveBeenCalledTimes(1);
  });

  it('opens the checkout of the package of the chosen volume for a signed-in account, with the signed account id', async () => {
    const checkout = { items: [{ priceId: 'pri_package_2500_fixture', quantity: 1 }], customer: { email: 'a@b.test' }, customData: { easyconvertUserId: 'u1', easyconvertBinding: 'tag' } };
    stubServer({ user: { id: 'u1', name: 'Ada', tier: 'free' }, checkout: { success: true, checkout }, subscription: null });
    const host = await mount(BILLING);
    expect(labels(host)).toEqual(['Buy package', 'Subscribe']);
    await pick(host, 2500);
    await act(async () => buttons(host)[0].click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(bodies).toEqual([{ kind: 'package', credits: 2500 }]);
    expect(paddle.checkoutOpen).toHaveBeenCalledWith({ ...checkout, settings: { displayMode: 'overlay', locale: 'en' } });
  });

  it('opens the checkout of the subscription for an account that has none', async () => {
    const checkout = { items: [{ priceId: 'pri_subscription_5000_fixture', quantity: 1 }], customer: { email: 'a@b.test' }, customData: { easyconvertUserId: 'u1', easyconvertBinding: 'tag' } };
    stubServer({ user: { id: 'u1', name: 'Ada', tier: 'free' }, checkout: { success: true, checkout }, subscription: null });
    const host = await mount(BILLING);
    await pick(host, 5000);
    await act(async () => buttons(host)[1].click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(bodies).toEqual([{ kind: 'subscription', credits: 5000 }]);
    expect(paddle.checkoutOpen).toHaveBeenCalled();
  });

  it('marks the subscription the account has, offers the other sizes as a switch, and keeps the package for sale', async () => {
    stubServer({ user: { id: 'u1', name: 'Ada', tier: 'paid' }, subscription: { credits: 2500, active: true } });
    const host = await mount(BILLING);
    await pick(host, 2500);
    expect(labels(host)).toEqual(['Buy package', 'Manage subscription']);
    await pick(host, 1000);
    expect(labels(host)).toEqual(['Buy package', 'Switch to this subscription']);
  });

  it('switches the subscription at once and tells the account, without opening a checkout', async () => {
    stubServer({ user: { id: 'u1', name: 'Ada', tier: 'paid' }, checkout: { success: true, changed: true }, subscription: { credits: 2500, active: true } });
    const host = await mount(BILLING);
    await act(async () => buttons(host)[1].click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(bodies).toEqual([{ kind: 'subscription', credits: 1000 }]);
    expect(paddle.checkoutOpen).not.toHaveBeenCalled();
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Done. The new subscription applies in a few moments.');
  });

  it('offers a first subscription to an account whose subscription has ended', async () => {
    stubServer({ user: { id: 'u1', name: 'Ada', tier: 'free' }, subscription: { credits: 2500, active: false } });
    const host = await mount(BILLING);
    expect(labels(host)).toEqual(['Buy package', 'Subscribe']);
  });

  it('words a refusal of the checkout and opens nothing', async () => {
    stubServer({ user: { id: 'u1', name: 'Ada', tier: 'free' }, subscription: null });
    const host = await mount(BILLING);
    await act(async () => buttons(host)[0].click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(paddle.checkoutOpen).not.toHaveBeenCalled();
  });
});
