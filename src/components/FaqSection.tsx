'use client';

import React, { useState } from 'react';
import { ChevronDown } from 'lucide-react';

export default function FaqSection() {
  const [openIndex, setOpenIndex] = useState<number | null>(0);

  const faqs = [
    {
      q: 'Is EasyConvert free to use?',
      a: 'Yes, EasyConvert provides free in-browser and server-assisted conversion for standard files. No hidden watermarks, forced signups, or subscription locks.',
    },
    {
      q: 'Are my files secure and kept private?',
      a: 'Absolutely. We practice strict ephemeral processing with a fail-closed architecture. Uploaded files are immediately processed in temporary worker instances and permanently deleted right after conversion. No files are ever saved, indexed, or shared.',
    },
    {
      q: 'What is the maximum file size limit?',
      a: 'The public web interface supports files up to 100 MB per conversion job. For higher capacities or high-volume enterprise pipelines, our REST API provides scalable endpoints.',
    },
    {
      q: 'Can I convert multiple files simultaneously?',
      a: 'Yes! Simply select or drop multiple files into the conversion queue. You can configure individual target formats and options for each file, convert them all in parallel, and download them individually or as a single consolidated ZIP archive.',
    },
    {
      q: 'Does EasyConvert provide a developer API?',
      a: 'Yes, full RESTful endpoints are exposed for querying format capabilities (/api/formats) and executing multipart file conversions (/api/convert and /api/convert/batch).',
    },
  ];

  return (
    <section className="py-16 md:py-24 border-t border-neutral-border dark:border-dark-border bg-neutral-scaffold/30 dark:bg-dark-scaffold/30">
      <div className="max-w-4xl mx-auto px-4 sm:px-6">
        <div className="text-center mb-12">
          <h2 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-brand-950 dark:text-white mb-3">
            Frequently Asked Questions
          </h2>
          <p className="text-sm text-ink-secondary dark:text-dark-muted">
            Everything you need to know about formats, privacy, and processing.
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
                  <div className="px-5 pb-5 pt-0 text-xs sm:text-sm text-ink-secondary dark:text-dark-muted leading-relaxed border-t border-neutral-border/50 dark:border-dark-border/50 pt-4">
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
