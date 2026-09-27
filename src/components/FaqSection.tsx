'use client';

import React, { useState } from 'react';
import { ChevronDown } from 'lucide-react';

interface FaqItem {
  q: string;
  a: string;
}

interface FaqSectionProps {
  customFaqs?: FaqItem[];
  title?: string;
  subtitle?: string;
}

const DEFAULT_FAQS: FaqItem[] = [
  {
    q: 'Is EasyConvert 100% free to use?',
    a: 'Yes, EasyConvert is completely free. There are no paywalls, credit systems, hidden subscriptions, or watermarks. You can convert files without even creating an account.',
  },
  {
    q: 'Are my files safe and private?',
    a: 'Absolutely. Because EasyConvert executes conversions client-side directly inside your browser via WebAssembly, WebCodecs, and OPFS whenever possible, your sensitive files never even leave your device. When edge fallback is used, processing is strictly ephemeral in volatile RAM with zero retention.',
  },
  {
    q: 'What is the maximum file size limit?',
    a: 'Our optimized client-side engine allows conversions of files up to 1 GB without waiting for heavy network uploads. Performance depends directly on your device hardware.',
  },
  {
    q: 'Can I convert multiple files simultaneously?',
    a: 'Yes! Select or drop multiple files into the conversion queue. You can configure individual target formats and options for each file, convert them all in parallel, and download them individually or as a single consolidated ZIP archive.',
  },
  {
    q: 'Do I need to install any software or plugins?',
    a: 'No installation required! EasyConvert runs entirely inside modern web browsers on macOS, Windows, Linux, iOS, and Android.',
  },
];

export default function FaqSection({ customFaqs, title, subtitle }: FaqSectionProps = {}) {
  const [openIndex, setOpenIndex] = useState<number | null>(0);
  const faqs = customFaqs && customFaqs.length > 0 ? customFaqs : DEFAULT_FAQS;

  return (
    <section className="py-16 md:py-24 border-t border-neutral-border dark:border-dark-border bg-neutral-scaffold/30 dark:bg-dark-scaffold/30">
      <div className="max-w-4xl mx-auto px-4 sm:px-6">
        <div className="text-center mb-12">
          <h2 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-brand-950 dark:text-white mb-3">
            {title || 'Frequently Asked Questions'}
          </h2>
          <p className="text-sm text-ink-secondary dark:text-dark-muted">
            {subtitle || 'Everything you need to know about formats, privacy, and processing.'}
          </p>
        </div>

        <div className="space-y-3">
          {faqs.map((faq, idx) => {
            const isOpen = openIndex === idx;
            return (
              <div
                key={idx}
                className="rounded-2xl border border-neutral-border dark:border-dark-border bg-white dark:bg-dark-surface overflow-hidden transition-all"
              >
                <button
                  type="button"
                  onClick={() => setOpenIndex(isOpen ? null : idx)}
                  aria-expanded={isOpen}
                  aria-controls={`faq-answer-${idx}`}
                  className="w-full p-5 text-left flex items-center justify-between gap-4"
                >
                  <span className="text-sm sm:text-base font-bold text-brand-950 dark:text-dark-text">
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
                    id={`faq-answer-${idx}`}
                    role="region"
                    className="px-5 pb-5 pt-4 text-xs sm:text-sm text-ink-secondary dark:text-dark-muted leading-relaxed border-t border-neutral-border/50 dark:border-dark-border/50"
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
