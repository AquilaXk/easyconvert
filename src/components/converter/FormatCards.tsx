import React from 'react';
import { useTranslations } from 'next-intl';
import { ArrowRight } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import type { FormatSpecification } from './format-specs';

function FormatCard({ meta, linked }: Readonly<{ meta: FormatSpecification; linked: boolean }>) {
  const t = useTranslations('converterPage.formatCard');
  const name = meta.extension.toUpperCase();

  return (
    <div className="border-t border-rule pt-6 min-w-0">
      <h2 className="flex flex-wrap items-baseline gap-x-3 text-base sm:text-lg text-ink">
        <span className="font-bold uppercase">{name}</span>
        <span className="text-sm font-normal text-ink-2">{meta.fullName}</span>
      </h2>
      <p className="mt-3 text-sm text-ink-2 leading-relaxed">{meta.desc}</p>
      {linked && (
        <Link
          href={`/${meta.extension.toLowerCase()}-converter`}
          className="mt-2 min-h-[44px] inline-flex items-center gap-1.5 text-sm font-semibold text-accent-ink hover:underline rounded-md"
        >
          <span>{t('link', { format: name })}</span>
          <ArrowRight aria-hidden="true" className="size-3.5" />
        </Link>
      )}
    </div>
  );
}

interface FormatCardsProps {
  srcMeta: FormatSpecification;
  tgtMeta: FormatSpecification | null;
}

/** What each format of the page is: the one of a format page, the two of a pair page, each pair card linking its converter. */
export function FormatCards({ srcMeta, tgtMeta }: Readonly<FormatCardsProps>) {
  const isPair = tgtMeta !== null;
  return (
    <section className={`max-w-5xl mx-auto px-4 sm:px-6 mb-14 grid grid-cols-1 gap-8 ${isPair ? 'md:grid-cols-2' : ''}`}>
      <FormatCard meta={srcMeta} linked={isPair} />
      {tgtMeta && <FormatCard meta={tgtMeta} linked />}
    </section>
  );
}
