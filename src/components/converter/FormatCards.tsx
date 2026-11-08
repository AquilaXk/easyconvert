import React from 'react';
import { useTranslations } from 'next-intl';
import { ArrowRight } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { FormatIcon } from '@/components/workbench/FormatIcon';
import { useFormatDetail } from './format-specs';

/**
 * What each format of the page is: the one of a format page, or the two of a pair page, each card linking its converter.
 * `ids` are the ids the page names, as the slug writes them (`ultrahdr`, not the extension of its files).
 */
export function FormatCards({ ids }: Readonly<{ ids: readonly [string] | readonly [string, string] }>) {
  const t = useTranslations('converterPage');
  const getFormatDetail = useFormatDetail();
  const linked = ids.length > 1;
  return (
    <section
      aria-label={t('formatCardsLabel')}
      className={`max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 mb-14 grid grid-cols-1 gap-4 ${linked ? 'md:grid-cols-2' : ''}`}
    >
      {ids.map((id) => {
        const name = id.toUpperCase();
        const { fullName, desc } = getFormatDetail(id);
        return (
          <div key={id} className="flex items-start gap-4 border border-rule bg-surface/40 p-5 sm:p-6 min-w-0">
            <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-xs border border-accent/20 bg-accent/10 text-accent-ink">
              <FormatIcon format={id} className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-base text-ink">
                <span className="font-mono font-semibold uppercase tracking-wide">{name}</span>
                <span className="text-sm font-normal text-ink-3">{fullName}</span>
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-ink-3">{desc}</p>
              {linked && (
                <Link
                  href={`/${id}-converter`}
                  className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-accent-ink hover:underline"
                >
                  <span>{t('formatConverter', { format: name })}</span>
                  <ArrowRight aria-hidden="true" className="size-3.5" />
                </Link>
              )}
            </div>
          </div>
        );
      })}
    </section>
  );
}
