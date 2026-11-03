import React from 'react';
import { useTranslations } from 'next-intl';
import { Download, Settings2, UploadCloud } from 'lucide-react';
import type { FormatSpecification } from './format-specs';

interface ConverterWorkflowStepsProps {
  srcMeta: FormatSpecification;
  tgtMeta: FormatSpecification | null;
  isPair: boolean;
  totalFormatCount: number;
}

export function ConverterWorkflowSteps({
  srcMeta,
  tgtMeta,
  isPair,
  totalFormatCount,
}: Readonly<ConverterWorkflowStepsProps>) {
  const t = useTranslations('converterPage.steps');
  const src = srcMeta.extension.toUpperCase();
  const tgt = tgtMeta?.extension.toUpperCase() ?? '';
  const values = { src, tgt, count: totalFormatCount };
  const variant = isPair ? 'pair' : 'single';

  return (
    <section className="max-w-5xl mx-auto px-4 sm:px-6 mb-14">
      <div className="mb-6">
        <h2 className="text-2xl sm:text-3xl text-ink">
          {t(`heading.${variant}`, values)}
        </h2>
        <p className="mt-1.5 text-sm text-ink-2">
          {t('intro')}
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        <div className="border-t border-rule pt-6">
          <div className="flex items-center justify-between mb-4">
            <span className="size-8 rounded-sm bg-accent text-on-accent font-bold text-xs flex items-center justify-center">
              01
            </span>
            <div className="text-accent-ink">
              <UploadCloud className="size-4" />
            </div>
          </div>
          <h3 className="text-base font-bold text-ink mb-2">
            {t('upload.heading', values)}
          </h3>
          <p className="text-xs sm:text-sm text-ink-2 leading-relaxed">
            {t('upload.body', values)}
          </p>
        </div>

        <div className="border-t border-rule pt-6">
          <div className="flex items-center justify-between mb-4">
            <span className="size-8 rounded-sm bg-accent text-on-accent font-bold text-xs flex items-center justify-center">
              02
            </span>
            <div className="text-accent-ink">
              <Settings2 className="size-4" />
            </div>
          </div>
          <h3 className="text-base font-bold text-ink mb-2">
            {t(`choose.${variant}.heading`, values)}
          </h3>
          <p className="text-xs sm:text-sm text-ink-2 leading-relaxed">
            {t(`choose.${variant}.body`, values)}
          </p>
        </div>

        <div className="border-t border-rule pt-6">
          <div className="flex items-center justify-between mb-4">
            <span className="size-8 rounded-sm bg-accent text-on-accent font-bold text-xs flex items-center justify-center">
              03
            </span>
            <div className="text-accent-ink">
              <Download className="size-4" />
            </div>
          </div>
          <h3 className="text-base font-bold text-ink mb-2">
            {t(`download.${variant}.heading`, values)}
          </h3>
          <p className="text-xs sm:text-sm text-ink-2 leading-relaxed">
            {t('download.body')}
          </p>
        </div>
      </div>
    </section>
  );
}

type ConverterPageTranslator = ReturnType<typeof useTranslations<'converterPage'>>;

/** The questions of a converter page, about its own formats, in the page's language. */
export function buildContextualFaqs(
  t: ConverterPageTranslator,
  srcMeta: FormatSpecification,
  tgtMeta: FormatSpecification | null,
  isPair: boolean,
  totalFormatCount: number
) {
  const src = srcMeta.extension.toUpperCase();
  const tgt = tgtMeta?.extension.toUpperCase() ?? '';
  const values = { src, tgt, count: totalFormatCount };
  const variant = isPair ? 'pair' : 'single';

  return [
    { q: t(`faq.howTo.${variant}.q`, values), a: t(`faq.howTo.${variant}.a`, values) },
    { q: t(`faq.privacy.${variant}.q`, values), a: t('faq.privacy.a') },
    { q: t(`faq.quality.${variant}.q`, values), a: t('faq.quality.a') },
    { q: t('faq.batch.q', values), a: t('faq.batch.a') },
    { q: t('faq.install.q'), a: t('faq.install.a') },
  ];
}
