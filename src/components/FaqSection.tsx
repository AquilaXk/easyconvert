'use client';

import React, { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { PAID_PLANS_ON_SALE, PLAN_MAX_FILE_BYTES } from '@/lib/plan-limits';
import { useFormatBytes } from './i18n/format';

interface FaqItem {
  q: string;
  a: string;
}

interface FaqSectionProps {
  /** The anonymous daily allowance the server enforces, read on the server (`getAnonymousDailyLimit`). */
  dailyLimit: number;
}

const FAQ_KEYS = ['free', 'handling', 'maxSize', 'batch', 'install'] as const;

/**
 * The questions, in the page's language. The paid plans are named only once they can be bought (`PAID_PLANS_ON_SALE`).
 */
function useFaqs(dailyLimit: number): FaqItem[] {
  const t = useTranslations('faq');
  const formatBytes = useFormatBytes();
  const maxSize = formatBytes(PLAN_MAX_FILE_BYTES.free);
  const paidLimits = PAID_PLANS_ON_SALE
    ? ` ${t('paidLimits', { pro: formatBytes(PLAN_MAX_FILE_BYTES.pro), enterprise: formatBytes(PLAN_MAX_FILE_BYTES.enterprise) })}`
    : '';
  return FAQ_KEYS.map((key) => ({
    q: t(`items.${key}.q`),
    a: t(`items.${key}.a`, { maxSize, paidLimits, dailyLimit }),
  }));
}

export default function FaqSection({ dailyLimit }: Readonly<FaqSectionProps>) {
  const t = useTranslations('faq');
  const [openIndex, setOpenIndex] = useState<number | null>(0);
  const faqs = useFaqs(dailyLimit);

  return (
    <section className="py-14 border-t border-rule">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="mb-8">
          <h2 className="text-2xl sm:text-3xl text-ink">
            {t('title')}
          </h2>
          <p className="mt-1.5 text-sm text-ink-2">
            {t('subtitle')}
          </p>
        </div>

        <div className="border-y border-rule divide-y divide-rule">
          {faqs.map((faq, idx) => {
            const isOpen = openIndex === idx;
            const questionId = `faq-question-${idx}`;
            const answerId = `faq-answer-${idx}`;

            return (
              <div key={questionId}>
                <button
                  id={questionId}
                  type="button"
                  onClick={() => setOpenIndex(isOpen ? null : idx)}
                  aria-expanded={isOpen}
                  aria-controls={answerId}
                  className="group w-full min-h-[52px] px-1 py-4 text-left flex items-center justify-between gap-4 rounded-xs cursor-pointer"
                >
                  <span className="text-sm sm:text-base font-semibold text-ink group-hover:text-accent-ink transition-colors">
                    {faq.q}
                  </span>
                  <ChevronDown
                    className={`w-4 h-4 text-accent-ink shrink-0 transition-transform duration-200 ${
                      isOpen ? 'rotate-180' : ''
                    }`}
                  />
                </button>
                {isOpen && (
                  <div
                    id={answerId}
                    role="region"
                    aria-labelledby={questionId}
                    className="px-1 pb-5 max-w-3xl text-sm text-ink-2 leading-relaxed"
                  >
                    {faq.a}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
