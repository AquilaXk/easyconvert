import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { useBillingErrorWording } from '../src/components/i18n/error-wording';
import { BILLING_REFUSAL_CODES } from '../src/lib/refusal-codes';
import { renderDom, visibleText } from './helpers/rendered-dom';
import { testMessages, type TestLocale } from './helpers/intl-messages';

/** The sentences of the billing refusals and of the billing copy, in both languages. */

function worded(locale: TestLocale, body: unknown, status: number): string {
  let sentence = '';
  function Wording() {
    sentence = useBillingErrorWording()(body, status, 'fallback');
    return createElement('p', null, sentence);
  }
  visibleText(renderDom(createElement(Wording), locale));
  return sentence;
}

describe('the wording of a billing refusal', () => {
  it('has a sentence in both languages for every code of its closed list, and no other', () => {
    for (const locale of ['en', 'ko'] as const) {
      const sentences = testMessages(locale).errors.billing as Record<string, string>;
      expect(Object.keys(sentences).sort(), locale).toEqual([...BILLING_REFUSAL_CODES].sort());
    }
  });

  it('words a refusal by its code, with none of the English the route sent', () => {
    const refusal = { success: false, code: 'already_subscribed', error: 'This account already has a paid plan. Change or cancel it from the billing portal.' };
    expect(worded('ko', refusal, 409)).toBe('이미 유료 요금제를 쓰고 있어요. 구독 관리에서 변경하거나 해지할 수 있어요.');
    expect(worded('en', refusal, 409)).toBe('You already have a paid plan. Change or cancel it under Manage subscription.');
    expect(worded('ko', { success: false, code: 'billing_unavailable', error: 'Paid plans are not available on this server.' }, 503)).toBe('유료 요금제는 아직 이용할 수 없어요.');
  });

  it('falls back to the sentence of the action for an answer with no code it knows', () => {
    expect(worded('en', { success: false, code: 'something_new' }, 418)).toBe('fallback');
  });
});

describe('the Korean billing copy', () => {
  /** The words of a message without its ICU placeholders. */
  const words = (text: string) => text.replace(/\{[^{}]*(\{[^{}]*\}[^{}]*)*\}/g, '');
  const leaves = (node: unknown): string[] => (typeof node === 'string' ? [node] : Object.values(node as object).flatMap(leaves));

  it('has no English words in the billing messages and the billing refusals', () => {
    const messages = testMessages('ko');
    for (const text of [...leaves(messages.billing), ...leaves(messages.errors.billing)]) {
      expect(words(text), text).not.toMatch(/[A-Za-z]/);
    }
  });

  it('is polite 해요체 and names no payment provider', () => {
    const messages = testMessages('ko');
    for (const text of [...leaves(messages.billing), ...leaves(messages.errors.billing)]) expect(text, text).not.toMatch(/Paddle/i);
    for (const text of leaves(messages.errors.billing)) expect(text, text).toMatch(/(요|죠)\.$/);
  });
});
