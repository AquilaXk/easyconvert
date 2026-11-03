import React from 'react';
import { useTranslations } from 'next-intl';
import { ArrowRight } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { useFormatDetail, type FormatSpecification } from './format-specs';

function FormatCard({ id, meta, linked }: Readonly<{ id: string; meta: FormatSpecification; linked: boolean }>) {
  const t = useTranslations('converterPage');
  const name = id.toUpperCase();

  return (
    <div className="border-t border-rule pt-6 min-w-0">
      <h2 className="flex flex-wrap items-baseline gap-x-3 text-base sm:text-lg text-ink">
        <span className="font-bold uppercase">{name}</span>
        <span className="text-sm font-normal text-ink-2">{meta.fullName}</span>
      </h2>
      <p className="mt-3 text-sm text-ink-2 leading-relaxed">{meta.desc}</p>
      {linked && (
        <Link
          href={`/${id}-converter`}
          className="mt-2 min-h-[44px] inline-flex items-center gap-1.5 text-sm font-semibold text-accent-ink hover:underline rounded-md"
        >
          <span>{t('formatConverter', { format: name })}</span>
          <ArrowRight aria-hidden="true" className="size-3.5" />
        </Link>
      )}
    </div>
  );
}

interface FormatCardsProps {
  /** The id of the format a page converts from, as the page names it (`ultrahdr`, not the extension of its files). */
  srcKey: string;
  /** The id of the format a pair page converts to; null on a format page. */
  tgtKey: string | null;
}

/** What each format of the page is: the one of a format page or the two of a pair page, a pair card linking its converter. */
export function FormatCards({ srcKey, tgtKey }: Readonly<FormatCardsProps>) {
  const t = useTranslations('converterPage.formatCard');
  const getFormatDetail = useFormatDetail();
  const isPair = tgtKey !== null;
  return (
    <section
      aria-label={t('label')}
      className={`max-w-5xl mx-auto px-4 sm:px-6 mb-14 grid grid-cols-1 gap-8 ${isPair ? 'md:grid-cols-2' : ''}`}
    >
      <FormatCard id={srcKey} meta={getFormatDetail(srcKey)} linked={isPair} />
      {isPair && <FormatCard id={tgtKey} meta={getFormatDetail(tgtKey)} linked />}
    </section>
  );
}
