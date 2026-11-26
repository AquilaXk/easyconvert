'use client';

import React, { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Download, Globe, Loader2, Sliders } from 'lucide-react';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import { useViewerPlan } from '@/hooks/useViewerPlan';
import { useWebsiteCaptureRun, type CompletedCapture } from '@/hooks/useWebsiteCaptureRun';
import { useConversionFailureWording } from '@/components/i18n/error-wording';
import { useFormatBytes } from '@/components/i18n/format';
import { QuotaExhaustedActions } from '@/components/workbench/QuotaExhaustedActions';
import type { ConversionFailure } from '@/lib/conversion-failure';
import { FREE_DAILY_CREDITS } from '@/lib/plan-limits';
import type { WebsiteCaptureOptions } from '@/lib/capture-options';
import CaptureOptionsModal from './CaptureOptionsModal';

const MAX_URL_CHARS = 8192;
const WEB_PORTS: ReadonlySet<string> = new Set(['', '80', '443']);

type ValidationKey = 'empty' | 'tooLong' | 'invalidUrl' | 'scheme' | 'credentials' | 'port';

export interface WebsiteCapturePageViewProps {
  targetFormat: 'pdf' | 'png' | 'jpg';
  title: string;
  description: string;
  dailyLimit: number;
}

function validateCaptureInputUrl(raw: string): ValidationKey | null {
  if (!raw) return 'empty';
  if (raw.length > MAX_URL_CHARS) return 'tooLong';
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return 'invalidUrl';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'scheme';
  if (parsed.username !== '' || parsed.password !== '') return 'credentials';
  if (!WEB_PORTS.has(parsed.port)) return 'port';
  return null;
}

function CaptureProgressPanel({
  phaseLabel,
  progress,
  onCancel,
}: Readonly<{ phaseLabel: 'queued' | 'capturing'; progress: number; onCancel: () => void }>) {
  const t = useTranslations('websiteCapture');
  const statusText = phaseLabel === 'capturing' ? t('capturing') : t('queued');
  return (
    <div className="mt-6 pt-5 border-t border-rule flex flex-col gap-3">
      <progress value={progress} max={100} aria-label={statusText} className="thread w-full" />
      <div className="flex items-center justify-between gap-3">
        <output aria-live="polite" className="inline-flex items-center gap-2 text-sm text-ink-2">
          <Loader2 aria-hidden="true" className="size-4 animate-spin shrink-0" />
          <span>{statusText}</span>
          {progress > 0 && <span className="tabular-nums text-xs text-ink-3">{t('progress', { percent: progress })}</span>}
        </output>
        <button
          type="button"
          onClick={onCancel}
          className="min-h-[40px] px-4 rounded-xs border border-rule bg-canvas text-sm font-medium text-ink hover:border-rule-strong cursor-pointer"
        >
          {t('cancel')}
        </button>
      </div>
    </div>
  );
}

function CaptureFailureBanner({ failure }: Readonly<{ failure: ConversionFailure }>) {
  const failureWording = useConversionFailureWording();
  return (
    <div className="mt-6 pt-5 border-t border-rule">
      <div className="rounded-xs border border-danger-edge bg-danger-soft/40 p-4 text-left space-y-2">
        <p role="alert" className="text-sm text-ink">
          {failureWording(failure)}
        </p>
        <QuotaExhaustedActions failure={failure} />
      </div>
    </div>
  );
}

function CaptureResultCard({
  result,
  onStartOver,
}: Readonly<{ result: CompletedCapture; onStartOver: () => void }>) {
  const t = useTranslations('websiteCapture');
  const formatBytes = useFormatBytes();
  return (
    <div className="mt-6 pt-5 border-t border-rule text-left space-y-3">
      <div className="rounded-xs border border-rule bg-canvas p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-accent-ink uppercase tracking-wider">{t('result.ready')}</p>
          <p className="text-sm font-semibold text-ink break-all mt-0.5">{result.filename}</p>
          <p className="text-xs text-ink-3 tabular-nums mt-0.5">{formatBytes(result.size)}</p>
        </div>
        <a
          href={result.downloadUrl}
          download={result.filename}
          className="btn-primary min-h-[44px] px-5 rounded-xs text-sm font-medium inline-flex items-center justify-center gap-2 shrink-0"
        >
          <Download aria-hidden="true" className="size-4" />
          <span>{t('result.download')}</span>
        </a>
      </div>
      {result.hasBlockedRequests && <p className="text-xs text-ink-3">{t('result.warningsHeading')}</p>}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={onStartOver}
          className="min-h-[40px] px-3 text-sm font-medium text-ink-2 hover:text-ink transition-colors cursor-pointer"
        >
          {t('result.startOver')}
        </button>
      </div>
    </div>
  );
}

/**
 * Dedicated URL-input workbench for `/save-website-as-pdf`, `/website-png-screenshot`, and `/website-jpg-screenshot`:
 * no file dropzone, no pair tiles, and no HTML format cards.
 */
export default function WebsiteCapturePageView({
  targetFormat,
  title,
  description,
  dailyLimit,
}: Readonly<WebsiteCapturePageViewProps>) {
  const t = useTranslations('websiteCapture');
  const tDropzone = useTranslations('hero.dropzone');
  const plan = useViewerPlan();
  const run = useWebsiteCaptureRun(targetFormat);

  const [url, setUrl] = useState('');
  const [options, setOptions] = useState<WebsiteCaptureOptions>({});
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [validationError, setValidationError] = useState<ValidationKey | null>(null);

  const creditsCopy =
    plan === 'paid'
      ? tDropzone('paidCredits')
      : tDropzone('dailyCredits', { count: plan === 'anonymous' ? dailyLimit : FREE_DAILY_CREDITS });
  const limits = [creditsCopy, tDropzone('autoDeleted')];

  const handleReset = () => {
    run.reset();
    setValidationError(null);
    setUrl('');
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (run.busy) return;
    const trimmed = url.trim();
    const problemKey = validateCaptureInputUrl(trimmed);
    if (problemKey) {
      setValidationError(problemKey);
      return;
    }
    setValidationError(null);
    void run.start(trimmed, options);
  };

  return (
    <div className="flex flex-col min-h-screen">
      <Header />

      <main id="main-content" className="flex-1">
        <section className="pt-10 pb-16 lg:pt-14 lg:pb-20">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="text-center max-w-2xl mx-auto">
              <h1 className="text-3xl sm:text-4xl lg:text-5xl text-ink">{title}</h1>
              <p className="mt-5 text-base sm:text-lg sm:leading-relaxed text-ink-3">{description}</p>
            </div>

            <div className="mt-10 lg:mt-12 max-w-2xl mx-auto">
              <div className="rounded-xs border border-rule bg-surface px-6 py-8 sm:px-10 sm:py-10 shadow-elev-2">
                <Globe aria-hidden="true" className="mx-auto mb-5 size-10 text-accent-ink" />
                <h2 className="text-xl sm:text-2xl text-ink text-center">{t(`heading.${targetFormat}`)}</h2>
                <p className="mt-1 text-sm sm:text-base text-ink-3 text-center">{t('hint')}</p>

                <form noValidate onSubmit={handleSubmit} className="mt-6 space-y-4">
                  <div>
                    <label htmlFor="capture-url-input" className="block text-sm font-medium text-ink text-left mb-1.5">
                      {t('urlLabel')}
                    </label>
                    <input
                      id="capture-url-input"
                      type="url"
                      inputMode="url"
                      autoComplete="url"
                      disabled={run.busy}
                      value={url}
                      placeholder={t('urlPlaceholder')}
                      onChange={(e) => {
                        setUrl(e.target.value);
                        if (validationError) setValidationError(null);
                      }}
                      className="w-full min-h-[44px] px-3.5 rounded-xs text-base md:text-sm font-normal bg-surface/80 border border-rule-strong text-ink placeholder-ink-3 focus:border-accent disabled:opacity-60"
                    />
                    {validationError && (
                      <p role="alert" className="mt-1.5 text-sm text-danger text-left">
                        {t(`validation.${validationError}`)}
                      </p>
                    )}
                  </div>

                  {!run.busy && (
                    <div className="flex flex-wrap items-center justify-center gap-3 pt-1">
                      <button
                        type="submit"
                        className="btn-primary min-h-[48px] px-6 rounded-xs text-base sm:text-lg font-medium inline-flex items-center justify-center gap-2 cursor-pointer"
                      >
                        <span>{t(`submit.${targetFormat}`)}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setOptionsOpen(true)}
                        className="transition-colors inline-flex items-center justify-center gap-2 min-h-[48px] px-4 rounded-xs border border-rule bg-canvas text-sm font-medium text-ink hover:border-rule-strong cursor-pointer"
                      >
                        <Sliders aria-hidden="true" className="size-4" />
                        <span>{t('optionsButton')}</span>
                      </button>
                    </div>
                  )}
                </form>

                {run.busy && (
                  <CaptureProgressPanel phaseLabel={run.phaseLabel} progress={run.progress} onCancel={run.cancel} />
                )}

                {run.failure && <CaptureFailureBanner failure={run.failure} />}

                {run.completedResult && <CaptureResultCard result={run.completedResult} onStartOver={handleReset} />}
              </div>

              <p className="mt-3 px-2 text-center text-[13px] font-semibold text-ink-3 tabular-nums">
                {limits.map((limit, index) => (
                  <React.Fragment key={limit}>
                    {index > 0 && <span aria-hidden="true">{' · '}</span>}
                    <span className="whitespace-nowrap">{limit}</span>
                  </React.Fragment>
                ))}
              </p>
            </div>
          </div>
        </section>
      </main>

      {optionsOpen && (
        <CaptureOptionsModal
          targetFormat={targetFormat}
          initialOptions={options}
          onSave={setOptions}
          onClose={() => setOptionsOpen(false)}
        />
      )}

      <Footer />
    </div>
  );
}
