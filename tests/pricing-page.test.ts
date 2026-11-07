import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import PricingPageView from '../src/components/pages/PricingPageView';
import {
  ANONYMOUS_DAILY_CONVERSIONS,
  DEFAULT_FREE_CONCURRENCY,
  DELIVERED_FILE_RETENTION_MINUTES,
  FREE_DAILY_CONVERSIONS,
  FREE_PROCESSING_MINUTES,
  PLAN_MAX_FILE_BYTES,
} from '../src/lib/plan-limits';
import { formatBytes } from '../src/lib/format-bytes';
import { headings, links, renderDom, select, visibleText } from './helpers/rendered-dom';
import { testMessages } from './helpers/intl-messages';
import { CONFIG_SCHEMA } from '../src/lib/config/schema';

const defaultOf = (name: string) => CONFIG_SCHEMA.find((spec) => spec.name === name)?.default;

const page = (locale: 'en' | 'ko', anonymousDaily = ANONYMOUS_DAILY_CONVERSIONS) =>
  select(renderDom(createElement(PricingPageView, { anonymousDaily }), locale), 'main')[0];

describe('the pricing page', () => {
  it('shows the limits of the free plan as plan-limits holds them', () => {
    const text = visibleText(page('en'));
    expect(text).toContain(`${FREE_DAILY_CONVERSIONS} a day`);
    expect(text).toContain(formatBytes(PLAN_MAX_FILE_BYTES.free));
    expect(text).toContain(`Simultaneous conversions ${DEFAULT_FREE_CONCURRENCY}`);
    expect(text).toContain(`${FREE_PROCESSING_MINUTES} minutes`);
    expect(text).toContain(`${DELIVERED_FILE_RETENTION_MINUTES} minutes after download`);
  });

  it('follows a change of the numbers: the daily figure is read, not written into the copy', () => {
    expect(visibleText(page('en', 25)).match(/(\d+) conversions a day without an account/)?.[1]).toBe('25');
    expect(visibleText(page('ko', 25)).match(/계정이 없으면 하루 (\d+)회/)?.[1]).toBe('25');
  });

  it('says no paid plan is on sale, with no price but zero', () => {
    const text = visibleText(page('en'));
    expect(text).toContain('No paid plans are on sale yet');
    expect(text.match(/[$€£]\s?\d[\d.,]*/g)).toEqual(['$0']);
  });

  it('has a title, one free plan and an FAQ in both languages', () => {
    for (const locale of ['en', 'ko'] as const) {
      const messages = testMessages(locale) as unknown as { pricing: { title: string; faq: Record<string, unknown> } };
      const tree = page(locale);
      expect(headings(tree)).toContain(messages.pricing.title);
      const answered = Object.values(messages.pricing.faq).map((item) => (item as { question: string }).question);
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
