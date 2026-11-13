import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import PricingPageView from '../src/components/pages/PricingPageView';
import type { PublicBillingConfig } from '../src/lib/billing/types';
import {
  ANONYMOUS_DAILY_CREDITS,
  DEFAULT_FREE_CONCURRENCY,
  DELIVERED_FILE_RETENTION_MINUTES,
  FREE_DAILY_CREDITS,
  FREE_PROCESSING_MINUTES,
  PLAN_CONCURRENCY,
  PLAN_MAX_FILE_BYTES,
  PLAN_PROCESSING_MINUTES,
} from '../src/lib/plan-limits';
import { CREDITS_PER_CLASS } from '../src/lib/billing/credits';
import { formatBytesForDisplay } from '../src/lib/format-bytes';
import { attrOf, headings, links, renderDom, select, visibleText } from './helpers/rendered-dom';
import { testMessages } from './helpers/intl-messages';
import { CONFIG_SCHEMA } from '../src/lib/config/schema';

const defaultOf = (name: string) => CONFIG_SCHEMA.find((spec) => spec.name === name)?.default;

const ON_SALE: PublicBillingConfig = {
  environment: 'sandbox',
  clientToken: 'test_fixture_client_token',
  packages: [500, 1000, 2500, 5000, 10000].map((credits) => ({ credits: credits as 500, priceId: `pri_package_${credits}_fixture` })),
  subscriptions: [1000, 2500, 5000, 10000].map((credits) => ({ credits: credits as 1000, priceId: `pri_subscription_${credits}_fixture` })),
};

const page = (locale: 'en' | 'ko', anonymousDaily = ANONYMOUS_DAILY_CREDITS, billing: PublicBillingConfig | null = null) =>
  select(renderDom(createElement(PricingPageView, { anonymousDaily, billing }), locale), 'main')[0];

describe('the pricing page', () => {
  it('shows the limits of the free plan as plan-limits holds them', () => {
    const text = visibleText(page('en'));
    expect(text).toContain(`Credits ${FREE_DAILY_CREDITS} a day`);
    expect(text).toContain(formatBytesForDisplay(PLAN_MAX_FILE_BYTES.free));
    expect(text).toContain(`Simultaneous conversions ${DEFAULT_FREE_CONCURRENCY}`);
    expect(text).toContain(`${FREE_PROCESSING_MINUTES} minutes`);
    expect(text).toContain(`${DELIVERED_FILE_RETENTION_MINUTES} minutes after download`);
  });

  it('follows a change of the numbers: the daily figure is read, not written into the copy', () => {
    expect(visibleText(page('en', 25)).match(/(\d+) credits a day without an account/)?.[1]).toBe('25');
    expect(visibleText(page('ko', 25)).match(/계정이 없으면 하루 (\d+)크레딧/)?.[1]).toBe('25');
  });

  it('shows the four plans: Free, a package, a subscription and Enterprise, which has no checkout', () => {
    const names = {
      en: ['Free', 'Package', 'Subscription', 'Enterprise'],
      ko: ['무료', '크레딧 충전', '정기 구독', '엔터프라이즈'],
    } as const;
    for (const locale of ['en', 'ko'] as const) {
      const tree = page(locale, ANONYMOUS_DAILY_CREDITS, ON_SALE);
      const shown = headings(tree).filter((heading) => (names[locale] as readonly string[]).includes(heading));
      expect(shown, locale).toEqual(names[locale]);
      expect(links(tree).some((link) => link.href.endsWith('/contact')), locale).toBe(true);
    }
  });

  it('shows the package and the subscription as coming soon, with disabled buttons and no price but zero', () => {
    for (const locale of ['en', 'ko'] as const) {
      const tree = page(locale);
      const soon = (testMessages(locale) as unknown as { billing: { comingSoon: string } }).billing.comingSoon;
      const disabled = select(tree, 'button').filter((button) => attrOf(button, 'disabled') !== null);
      expect(disabled.map((button) => visibleText(button)), locale).toEqual([soon, soon]);
      expect(visibleText(tree).split(soon).length - 1, locale).toBe(4); // a badge and a button on each of the two
    }
    expect(visibleText(page('en')).match(/[$€£]\s?\d[\d.,]*/g)).toEqual(['$0']);
  });

  it('renders the volume selector with every size, the 1,000 credits chosen', () => {
    const tree = page('en', ANONYMOUS_DAILY_CREDITS, ON_SALE);
    const radios = select(tree, 'input', 'type', 'radio');
    expect(radios.map((input) => attrOf(input, 'value'))).toEqual(['500', '1000', '2500', '5000', '10000']);
    expect(radios.filter((input) => attrOf(input, 'checked') !== null).map((input) => attrOf(input, 'value'))).toEqual(['1000']);
    const text = visibleText(tree);
    expect(text).toContain('1,000 credits');
    expect(text).toContain('1,000 credits every month');
  });

  it('renders the plans for sale when the server says so, with no "coming soon"', () => {
    for (const locale of ['en', 'ko'] as const) {
      const messages = testMessages(locale) as unknown as { billing: { comingSoon: string } };
      const tree = page(locale, ANONYMOUS_DAILY_CREDITS, ON_SALE);
      expect(visibleText(tree), locale).not.toContain(messages.billing.comingSoon);
      expect(select(tree, 'button').filter((button) => attrOf(button, 'disabled') === null), locale).toEqual([]);
    }
  });

  it('lists the credits each kind of conversion uses, as the credit table holds them', () => {
    const rows = {
      en: ['Every other conversion 1 credit', 'Office documents to PDF 2 credits', 'Pages, Numbers and Keynote to PDF 2 credits', 'PDF to Word, Excel and PowerPoint 4 credits', 'Each started minute of processing after the first +1 credit'],
      ko: ['그 밖의 모든 변환 1크레딧', 'Office 문서에서 PDF로 2크레딧', 'Pages, Numbers, Keynote에서 PDF로 2크레딧', 'PDF에서 Word, Excel, PowerPoint로 4크레딧', '처리 1분 이후 시작하는 1분마다 +1크레딧'],
    } as const;
    for (const locale of ['en', 'ko'] as const) {
      const text = visibleText(page(locale));
      for (const row of rows[locale]) expect(text, `${locale}: ${row}`).toContain(row);
    }
    expect(CREDITS_PER_CLASS).toEqual({ general: 1, 'office-to-pdf': 2, 'iwork-to-pdf': 2, 'pdf-to-office': 4 });
  });

  it('lists the limits of a paid account in the answer about limits, as plan-limits holds them', () => {
    const text = visibleText(page('en'));
    expect(text).toContain(`a file can be up to ${formatBytesForDisplay(PLAN_MAX_FILE_BYTES.paid)}`);
    expect(text).toContain(`you can run ${PLAN_CONCURRENCY.paid} conversions at the same time`);
    expect(text).toContain(`up to ${PLAN_PROCESSING_MINUTES.paid} minutes`);
  });

  it('has a title, one free plan and an FAQ in both languages', () => {
    for (const locale of ['en', 'ko'] as const) {
      const messages = testMessages(locale) as unknown as { pricing: { title: string; faq: Record<string, unknown> } };
      const tree = page(locale);
      expect(headings(tree)).toContain(messages.pricing.title);
      const questions = Object.values(messages.pricing.faq).map((item) => (item as { question: string }).question);
      expect(questions).toHaveLength(10);
      for (const question of questions) expect(headings(tree)).toContain(question);
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
