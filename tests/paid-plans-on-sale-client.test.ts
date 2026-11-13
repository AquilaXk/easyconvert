// @vitest-environment jsdom
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PricingFaq from '../src/components/billing/PricingFaq';
import { useFileTooLargeMessage } from '../src/components/i18n/format';
import { applySessionChange, getPaidPlansOnSale, refreshViewerPlan } from '../src/lib/viewer-plan';
import { testMessages, type TestLocale } from './helpers/intl-messages';

/** A message about a file over the limit learns that paid plans can be bought from the session answer; until then it names none. */

const GIB = 1024 ** 3;
const FAQ_VALUES = { daily: 10, anonymous: 10, fileSize: '1 GB', concurrent: 5, processing: 5, deletion: 10 };

let root: Root | undefined;

function stubSession(paidPlansOnSale: boolean | undefined): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ success: false, authenticated: false, user: null, ...(paidPlansOnSale === undefined ? {} : { paidPlansOnSale }) }), { status: 200 }))
  );
}

function TooLarge({ sizeBytes = 3 * GIB }: Readonly<{ sizeBytes?: number }>) {
  const message = useFileTooLargeMessage();
  return createElement('p', null, message('free', sizeBytes));
}

async function mount(content: ReactElement, locale: TestLocale = 'en'): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    // eslint-disable-next-line react/no-children-prop -- the provider's typing requires `children` as a prop
    root?.render(createElement(NextIntlClientProvider, { locale, messages: testMessages(locale), timeZone: 'UTC', children: createElement('div', null, content) }));
  });
  return host;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  applySessionChange(null);
});

afterEach(async () => {
  stubSession(false);
  await act(async () => refreshViewerPlan());
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('a file over the limit, worded in the browser', () => {
  it('names no other plan until the session says paid plans can be bought, then names the next one', async () => {
    stubSession(undefined);
    const host = await mount(createElement(TooLarge));
    expect(host.textContent).toBe('File size 3 GB exceeds the 1 GB limit for the free plan.');

    stubSession(true);
    await act(async () => refreshViewerPlan());
    expect(getPaidPlansOnSale()).toBe(true);
    expect(host.textContent).toBe('File size 3 GB exceeds the 1 GB limit for the free plan. Pro allows files up to 5 GB.');
  });

  it('names the smallest plan that takes the file', async () => {
    stubSession(true);
    await act(async () => refreshViewerPlan());
    const host = await mount(createElement(TooLarge, { sizeBytes: 1.5 * GIB }));
    expect(host.textContent).toBe('File size 1.5 GB exceeds the 1 GB limit for the free plan. Basic allows files up to 2 GB.');
  });

  it('keeps what it knew when the session cannot be read', async () => {
    stubSession(true);
    await act(async () => refreshViewerPlan());
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    await act(async () => refreshViewerPlan());
    expect(getPaidPlansOnSale()).toBe(true);
  });
});

describe('the questions of the pricing page', () => {
  it.each(['en', 'ko'] as const)('answer as if no plan were on sale until the server says one is, in %s', async (locale) => {
    const messages = testMessages(locale) as unknown as { billing: { comingSoon: string }; pricing: { faq: { limits: { answerOnSale: string }; paid: { answer: string; answerOnSale: string }; monthly: { question: string } } } };
    const closed = await mount(createElement(PricingFaq, { values: FAQ_VALUES, onSale: false }), locale);
    expect(closed.textContent).toContain(messages.billing.comingSoon);
    expect(closed.textContent).not.toContain(messages.pricing.faq.paid.answerOnSale);
    expect(closed.textContent).not.toContain(messages.pricing.faq.monthly.question);

    act(() => root?.unmount());
    document.body.replaceChildren();
    const open = await mount(createElement(PricingFaq, { values: FAQ_VALUES, onSale: true }), locale);
    expect(open.textContent).toContain(messages.pricing.faq.paid.answerOnSale);
    expect(open.textContent).toContain(messages.pricing.faq.monthly.question);
    expect(open.textContent).not.toContain(messages.billing.comingSoon);
    // The limits themselves stand on the cards above the questions; the answer points there.
    expect(open.textContent).toContain(messages.pricing.faq.limits.answerOnSale);
  });
});
