'use client';

import React, { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { formatBytes } from '@/lib/format-bytes';
import { PLAN_MAX_FILE_BYTES } from '@/lib/plan-limits';

export interface FaqItem {
  q: string;
  a: string;
}

export interface FaqSectionProps {
  customFaqs?: FaqItem[];
  title?: string;
  subtitle?: string;
}

const DEFAULT_FAQS: FaqItem[] = [
  {
    q: 'Is EasyConvert free to use?',
    a: `Yes. You can convert without an account, up to ${formatBytes(PLAN_MAX_FILE_BYTES.anonymous)} per file and within a daily conversion limit. The Pro plan raises the file size to ${formatBytes(PLAN_MAX_FILE_BYTES.pro)} and the Enterprise plan to ${formatBytes(PLAN_MAX_FILE_BYTES.enterprise)}.`,
  },
  {
    q: 'How are my files handled during conversion?',
    a: 'Supported image, audio, and data pairs run directly inside browser memory on your device. Formats that require native codecs or document engines are transmitted over TLS 1.3 to isolated worker sandboxes and deleted automatically when their short retention TTL expires.',
  },
  {
    q: 'What is the maximum file size limit?',
    a: `EasyConvert supports individual files up to ${formatBytes(PLAN_MAX_FILE_BYTES.anonymous)} without an account or on the free plan, ${formatBytes(PLAN_MAX_FILE_BYTES.pro)} on Pro and ${formatBytes(PLAN_MAX_FILE_BYTES.enterprise)} on Enterprise. Browser-executed conversions start immediately without waiting for network uploads, and a file that needs the server goes up in parts, so a large upload shows its progress and can be cancelled.`,
  },
  {
    q: 'Can I convert multiple files in one batch?',
    a: 'Yes. Drop or select multiple files to queue them together, assign a shared or per-file output format, tune optional parameters, and download finished files individually or as one ZIP archive.',
  },
  {
    q: 'Do I need to install desktop software or browser plugins?',
    a: 'No installation is needed. EasyConvert runs in modern web browsers across macOS, Windows, Linux, iOS, and Android.',
  },
];

export default function FaqSection({ customFaqs, title, subtitle }: FaqSectionProps = {}) {
  const [openIndex, setOpenIndex] = useState<number | null>(0);
  const faqs = customFaqs && customFaqs.length > 0 ? customFaqs : DEFAULT_FAQS;

  return (
    <section className="py-14 border-t border-neutral-border dark:border-dark-border">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="mb-8">
          <h2 className="text-xl sm:text-2xl font-bold tracking-tight text-brand-950 dark:text-white">
            {title || 'Frequently Asked Questions'}
          </h2>
          <p className="mt-1.5 text-sm text-ink-secondary dark:text-dark-muted">
            {subtitle || 'Answers about format support, execution boundaries, and batch limits.'}
          </p>
        </div>

        <div className="rounded-xl border border-neutral-border dark:border-dark-border bg-white dark:bg-dark-surface divide-y divide-neutral-border dark:divide-dark-border overflow-hidden">
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
                  className="w-full min-h-[52px] px-5 py-4 text-left flex items-center justify-between gap-4 hover:bg-neutral-scaffold/70 dark:hover:bg-dark-elevated/40 transition-colors cursor-pointer"
                >
                  <span className="text-sm sm:text-base font-semibold text-brand-950 dark:text-dark-text">
                    {faq.q}
                  </span>
                  <ChevronDown
                    className={`w-4 h-4 text-brand-700 dark:text-brand-400 shrink-0 transition-transform duration-200 ${
                      isOpen ? 'rotate-180' : ''
                    }`}
                  />
                </button>
                {isOpen && (
                  <div
                    id={answerId}
                    role="region"
                    aria-labelledby={questionId}
                    className="px-5 pb-5 text-sm text-ink-secondary dark:text-dark-muted leading-relaxed"
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
