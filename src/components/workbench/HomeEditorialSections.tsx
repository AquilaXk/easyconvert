'use client';

import React, { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowRight, Check, Copy, Lock, Cpu, Clock } from 'lucide-react';
import { Link } from '@/i18n/navigation';

const API_CURL_EXAMPLE = [
  'curl -X POST https://api.easyconvert.com/api/v1/convert \\',
  '  -H "Authorization: Bearer $EASYCONVERT_API_KEY" \\',
  '  -F "file=@report.pdf" \\',
  '  -F "targetFormat=docx" \\',
  '  -o report.docx',
].join('\n');

const CODE_TAG = {
  code: (chunks: React.ReactNode) => (
    <code className="font-mono text-xs px-1.5 py-0.5 rounded-md bg-sunken">{chunks}</code>
  ),
};

const SECURITY_ITEMS = [
  { key: 'tls', Icon: Lock },
  { key: 'sandbox', Icon: Cpu },
  { key: 'cleanup', Icon: Clock },
] as const;

export function SecurityDataHandlingCard() {
  const t = useTranslations('home.security');
  return (
    <div className="min-w-0">
      <h2 className="text-lg sm:text-xl text-ink">{t('heading')}</h2>
      <p className="mt-3 max-w-xl text-sm leading-relaxed text-ink-3">{t('intro')}</p>

      <ul className="mt-4 space-y-3">
        {SECURITY_ITEMS.map(({ key, Icon }) => (
          <li key={key} className="flex gap-3 text-sm leading-5 text-ink-3">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-xs bg-accent/10 text-accent-ink">
              <Icon aria-hidden="true" className="size-3.5" />
            </span>
            <span>
              <span className="font-medium text-ink">{t(`${key}.heading`)}:</span> {t(`${key}.body`)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function RestApiWorkflowCard() {
  const t = useTranslations('home.api');
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      try {
        await navigator.clipboard.writeText(API_CURL_EXAMPLE);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch {
        setCopied(false);
      }
    }
  };

  return (
    <div className="min-w-0">
      <h2 className="text-lg sm:text-xl text-ink">{t('heading')}</h2>
      <p className="mt-3 max-w-xl text-sm leading-relaxed text-ink-3">
        {t.rich('intro', CODE_TAG)}{' '}
        <Link href="/api-docs" className="inline-flex items-center gap-1 font-medium text-accent-ink hover:underline">
          <span>{t('explore')}</span>
          <ArrowRight aria-hidden="true" className="size-3.5" />
        </Link>
      </p>

      <div className="group mt-6 border border-rule bg-sunken/40 text-ink">
        <div className="border-b border-rule bg-canvas/60 px-3 py-2 font-mono text-[11px] uppercase tracking-wider [:lang(ko)_&]:tracking-[0.05em] text-ink-3">
          POST /api/v1/convert
        </div>
        <div className="relative">
          <output aria-live="polite" className="sr-only">
            {copied ? t('copiedAnnouncement') : ''}
          </output>
          <button
            type="button"
            aria-label={t('copyLabel')}
            onClick={() => {
              void handleCopy();
            }}
            className="absolute right-2 top-2 inline-flex size-7 items-center justify-center rounded-xs border border-rule bg-transparent text-ink-2 transition-colors hover:bg-sunken hover:text-ink cursor-pointer lg:opacity-0 lg:group-hover:opacity-100 focus-visible:opacity-100"
          >
            {copied ? <Check aria-hidden="true" className="size-3.5 text-success" /> : <Copy aria-hidden="true" className="size-3.5" />}
          </button>
          <pre className="overflow-x-auto px-4 py-3 pr-12 font-mono text-xs leading-[14px] text-ink">
            <code>{API_CURL_EXAMPLE}</code>
          </pre>
        </div>
      </div>
    </div>
  );
}
