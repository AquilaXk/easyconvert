import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import PricingPageView from '../src/components/pages/PricingPageView';
import type { PublicBillingConfig } from '../src/lib/billing/types';
import {
  ANONYMOUS_DAILY_CONVERSIONS,
  DEFAULT_FREE_CONCURRENCY,
  DELIVERED_FILE_RETENTION_MINUTES,
  FREE_DAILY_CONVERSIONS,
  FREE_PROCESSING_MINUTES,
  PLAN_MAX_FILE_BYTES,
} from '../src/lib/plan-limits';
import { formatBytesForDisplay } from '../src/lib/format-bytes';
import { attrOf, headings, links, renderDom, select, visibleText } from './helpers/rendered-dom';
import { testMessages } from './helpers/intl-messages';
import { CONFIG_SCHEMA } from '../src/lib/config/schema';

const defaultOf = (name: string) => CONFIG_SCHEMA.find((spec) => spec.name === name)?.default;

const ON_SALE: PublicBillingConfig = {
  environment: 'sandbox',
  clientToken: 'test_fixture_client_token',
  plans: [
    { plan: 'basic', priceId: 'pri_basic_fixture' },
    { plan: 'pro', priceId: 'pri_pro_fixture' },
    { plan: 'enterprise', priceId: 'pri_enterprise_fixture' },
  ],
};

const page = (locale: 'en' | 'ko', anonymousDaily = ANONYMOUS_DAILY_CONVERSIONS, billing: PublicBillingConfig | null = null) =>
  select(renderDom(createElement(PricingPageView, { anonymousDaily, billing }), locale), 'main')[0];

describe('the pricing page', () => {
  it('shows the limits of the free plan as plan-limits holds them', () => {
    const text = visibleText(page('en'));
    expect(text).toContain(`${FREE_DAILY_CONVERSIONS} a day`);
    expect(text).toContain(formatBytesForDisplay(PLAN_MAX_FILE_BYTES.free));
    expect(text).toContain(`Simultaneous conversions ${DEFAULT_FREE_CONCURRENCY}`);
    expect(text).toContain(`${FREE_PROCESSING_MINUTES} minutes`);
    expect(text).toContain(`${DELIVERED_FILE_RETENTION_MINUTES} minutes after download`);
  });

  it('follows a change of the numbers: the daily figure is read, not written into the copy', () => {
    expect(visibleText(page('en', 25)).match(/(\d+) conversions a day without an account/)?.[1]).toBe('25');
    expect(visibleText(page('ko', 25)).match(/계정이 없으면 하루 (\d+)회/)?.[1]).toBe('25');
  });

  it('shows the paid plans as coming soon, with disabled buttons and no price but zero', () => {
    for (const locale of ['en', 'ko'] as const) {
      const tree = page(locale);
      const soon = (testMessages(locale) as unknown as { billing: { comingSoon: string } }).billing.comingSoon;
      const text = visibleText(tree);
      expect(text.split(soon).length - 1, locale).toBeGreaterThanOrEqual(7); // a badge and a button on each of the three plans, and the FAQ
      expect(headings(tree).filter((heading) => ['Basic', 'Pro', 'Enterprise'].includes(heading)), locale).toEqual(['Basic', 'Pro', 'Enterprise']);
      const disabled = select(tree, 'button').filter((button) => attrOf(button, 'disabled') !== null);
      expect(disabled.map((button) => visibleText(button)), locale).toEqual([soon, soon, soon]);
    }
    expect(visibleText(page('en')).match(/[$€£]\s?\d[\d.,]*/g)).toEqual(['$0']);
  });

  it('renders the paid plans for sale when the server says so, with no "coming soon" and a question on how a paid plan is counted', () => {
    for (const locale of ['en', 'ko'] as const) {
      const messages = testMessages(locale) as unknown as { billing: { comingSoon: string }; pricing: { faq: { monthly: { question: string }; paid: { answerOnSale: string } } } };
      const tree = page(locale, ANONYMOUS_DAILY_CONVERSIONS, ON_SALE);
      const text = visibleText(tree);
      expect(text, locale).not.toContain(messages.billing.comingSoon);
      expect(select(tree, 'button').filter((button) => attrOf(button, 'disabled') === null), locale).toEqual([]);
      expect(headings(tree), locale).toContain(messages.pricing.faq.monthly.question);
      expect(text, locale).toContain(messages.pricing.faq.paid.answerOnSale);
    }
  });

  it('lists the limits of each paid plan on its card, as plan-limits holds them', () => {
    const text = visibleText(page('en', ANONYMOUS_DAILY_CONVERSIONS, ON_SALE));
    expect(text).toContain('1,000 conversions a month');
    expect(text).toContain('3,000 conversions a month');
    expect(text).toContain('10,000 conversions a month');
    for (const [plan, size] of [['basic', '2 GB'], ['pro', '5 GB'], ['enterprise', '10 GB']] as const) {
      expect(text).toContain(`Up to ${formatBytesForDisplay(PLAN_MAX_FILE_BYTES[plan])} per file`);
      expect(formatBytesForDisplay(PLAN_MAX_FILE_BYTES[plan])).toBe(size);
    }
    for (const count of [10, 25, 50]) expect(text).toContain(`${count} conversions at the same time`);
    for (const minutes of [15, 30, 60]) expect(text).toContain(`Up to ${minutes} minutes per conversion`);
  });

  it('has a title, one free plan and an FAQ in both languages', () => {
    for (const locale of ['en', 'ko'] as const) {
      const messages = testMessages(locale) as unknown as { pricing: { title: string; faq: Record<string, unknown> } };
      const tree = page(locale);
      expect(headings(tree)).toContain(messages.pricing.title);
      const answered = Object.values(messages.pricing.faq)
        .filter((item) => 'answer' in (item as object))
        .map((item) => (item as { question: string }).question);
      for (const question of answered) expect(headings(tree)).toContain(question);
    }
  });

  it('links to sign up and to the home page', () => {
    const hrefs = links(page('en')).map((link) => link.href);
    expect(hrefs).toContain('/');
    expect(hrefs.some((href) => href.startsWith('/auth'))).toBe(true);
  });
});

describe('the figures plan-limits names match the defaults the server runs with', () => {
  it('has the same processing time and retention as the configuration schema', () => {
    expect(defaultOf('JOB_DEADLINE_MAX_MS_FREE')).toBe(FREE_PROCESSING_MINUTES * 60_000);
    expect(defaultOf('RESULT_DELIVERED_GRACE_SECONDS')).toBe(DELIVERED_FILE_RETENTION_MINUTES * 60);
  });
});
