// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testMessages } from './helpers/intl-messages';

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined, prefetch: () => Promise.resolve() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/dashboard',
}));

const { SubscriptionPanel } = await import('../src/components/billing/SubscriptionPanel');

/** The subscription block of the dashboard: absent until paid plans are on sale, then the plan and where it stands. */

const NOW = Date.UTC(2026, 10, 12);
const ENABLED = { success: true, enabled: true, environment: 'sandbox', clientToken: 'test_x', plans: [] };
let root: Root | undefined;
let assign: ReturnType<typeof vi.fn>;

function stub(status: unknown, portal?: { status: number; body: unknown }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/billing/status') return new Response(JSON.stringify(status), { status: 200 });
      if (url === '/api/billing/portal') return new Response(JSON.stringify(portal?.body ?? {}), { status: portal?.status ?? 200 });
      return new Response(JSON.stringify({ success: false }), { status: 401 });
    })
  );
}

async function mount(): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(createElement(NextIntlClientProvider, { locale: 'en', messages: testMessages('en'), timeZone: 'UTC', children: createElement(SubscriptionPanel) }));
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  return host;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  assign = vi.fn();
  vi.stubGlobal('location', { ...window.location, assign });
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('the subscription block of the dashboard', () => {
  it('is not there while paid plans are not on sale', async () => {
    stub({ success: true, enabled: false });
    expect((await mount()).textContent).toBe('');
  });

  it('points an account without a subscription to the plans', async () => {
    stub({ ...ENABLED, subscription: null });
    const host = await mount();
    expect(host.textContent).toContain('You are on the Free plan.');
    expect(host.querySelector('a')?.getAttribute('href')).toBe('/pricing');
  });

  it.each([
    ['renews', { plan: 'pro', status: 'active', active: true, currentPeriodEnd: NOW + 20 * 86_400_000 }, 'Renews on Dec 2, 2026.'],
    ['is canceled at the end of the period', { plan: 'pro', status: 'active', active: true, currentPeriodEnd: NOW + 20 * 86_400_000, cancelAt: NOW + 20 * 86_400_000 }, 'Ends on Dec 2, 2026. After that you are on the Free plan.'],
    ['failed to pay', { plan: 'enterprise', status: 'past_due', active: true, currentPeriodEnd: NOW + 86_400_000 }, 'The last payment did not go through. The plan stays until Nov 13, 2026.'],
    ['has ended', { plan: 'pro', status: 'canceled', active: false }, 'The subscription has ended. You are on the Free plan.'],
  ])('says where a subscription that %s stands', async (_name, subscription, sentence) => {
    stub({ ...ENABLED, subscription });
    const host = await mount();
    expect(host.textContent).toContain(sentence);
    expect(host.textContent).toContain(`${subscription.plan === 'pro' ? 'Pro' : 'Enterprise'} plan`);
    expect(host.querySelector('button')?.textContent).toBe('Manage subscription');
  });

  it('goes to the portal link of the provider when the subscriber asks to manage', async () => {
    stub({ ...ENABLED, subscription: { plan: 'pro', status: 'active', active: true } }, { status: 200, body: { success: true, url: 'https://portal.example/o' } });
    const host = await mount();
    await act(async () => host.querySelector('button')?.click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(assign).toHaveBeenCalledWith('https://portal.example/o');
  });

  it('words a refusal of the portal and goes nowhere', async () => {
    stub({ ...ENABLED, subscription: { plan: 'pro', status: 'active', active: true } }, { status: 502, body: { success: false, code: 'billing_provider_failed', error: 'x' } });
    const host = await mount();
    await act(async () => host.querySelector('button')?.click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Could not reach the payment service. Try again in a moment.');
    expect(assign).not.toHaveBeenCalled();
  });
});
