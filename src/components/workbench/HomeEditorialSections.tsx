'use client';

import React, { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowRight, Check, Copy, Lock, Cpu, Clock, Terminal } from 'lucide-react';
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

export function SecurityDataHandlingCard() {
  const t = useTranslations('home.security');
  return (
    <div className="border-t border-rule lg:col-span-4 min-w-0 pt-6 sm:pt-7">
      <h2 className="text-2xl text-ink">
        {t('heading')}
      </h2>
      <p className="mt-1.5 text-sm text-ink-2">
        {t('intro')}
      </p>

      <div className="mt-5 divide-y divide-rule">
        <div className="py-4 first:pt-0">
          <div className="flex items-center gap-2 text-sm font-bold text-ink">
            <Lock className="w-4 h-4 text-accent-ink shrink-0" />
            <h3>{t('tls.heading')}</h3>
          </div>
          <p className="mt-1.5 text-xs text-ink-2 leading-relaxed">
            {t('tls.body')}
          </p>
        </div>

        <div className="py-4">
          <div className="flex items-center gap-2 text-sm font-bold text-ink">
            <Cpu className="w-4 h-4 text-accent-ink shrink-0" />
            <h3>{t('sandbox.heading')}</h3>
          </div>
          <p className="mt-1.5 text-xs text-ink-2 leading-relaxed">
            {t('sandbox.body')}
          </p>
        </div>

        <div className="py-4 last:pb-0">
          <div className="flex items-center gap-2 text-sm font-bold text-ink">
            <Clock className="w-4 h-4 text-accent-ink shrink-0" />
            <h3>{t('cleanup.heading')}</h3>
          </div>
          <p className="mt-1.5 text-xs text-ink-2 leading-relaxed">
            {t('cleanup.body')}
          </p>
        </div>
      </div>
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
    <div className="border-t border-rule min-w-0 pt-6 sm:pt-7">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl">
          <h2 className="text-2xl sm:text-3xl text-ink">
            {t('heading')}
          </h2>
          <p className="mt-1.5 text-sm text-ink-2 leading-relaxed">
            {t.rich('intro', CODE_TAG)}
          </p>
        </div>
      </div>

      <div className="mt-5 rounded-md text-ink border border-rule overflow-hidden">
        <div className="px-4 py-2 border-b border-rule flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-2 min-w-0 text-xs font-mono text-ink-2">
            <Terminal className="w-3.5 h-3.5 text-accent-ink shrink-0" />
            <span className="truncate">POST https://api.easyconvert.com/api/v1/convert</span>
          </span>
          <div className="flex items-center shrink-0">
            <output aria-live="polite" className="sr-only">
              {copied ? t('copiedAnnouncement') : ''}
            </output>
            <button
              type="button"
              aria-label={t('copyLabel')}
              onClick={() => {
                void handleCopy();
              }}
              className="inline-flex items-center gap-1.5 min-h-[44px] px-3 rounded-sm text-xs font-medium text-ink-2 hover:text-ink hover:bg-sunken transition-colors cursor-pointer"
            >
              {copied ? (
                <>
                  <Check className="w-3.5 h-3.5 text-success" />
                  <span>{t('copied')}</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  <span>{t('copy')}</span>
                </>
              )}
            </button>
          </div>
        </div>
        <pre className="p-4 text-xs font-mono text-ink overflow-x-auto leading-relaxed">
          <code>{API_CURL_EXAMPLE}</code>
        </pre>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Link
          href="/api-docs"
          className="btn-primary inline-flex items-center justify-center gap-2 min-h-[44px] px-4 rounded-sm text-sm font-semibold"
        >
          <span>{t('reference')}</span>
          <ArrowRight className="w-4 h-4" />
        </Link>
        <Link
          href="/dashboard"
          className="inline-flex items-center justify-center min-h-[44px] px-4 rounded-sm border border-rule hover:border-accent text-sm font-medium text-ink transition-colors"
        >
          {t('manageKeys')}
        </Link>
      </div>
    </div>
  );
}
