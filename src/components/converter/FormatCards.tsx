import React from 'react';
import { useTranslations } from 'next-intl';
import { ArrowRight } from 'lucide-react';
import { Link } from '@/i18n/navigation';
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
      className={`max-w-5xl mx-auto px-4 sm:px-6 mb-14 grid grid-cols-1 gap-8 ${linked ? 'md:grid-cols-2' : ''}`}
    >
      {ids.map((id) => {
        const name = id.toUpperCase();
        const { fullName, desc } = getFormatDetail(id);
        return (
          <div key={id} className="border-t border-rule pt-6 min-w-0">
            <h2 className="flex flex-wrap items-baseline gap-x-3 text-base sm:text-lg text-ink">
              <span className="font-bold uppercase">{name}</span>
              <span className="text-sm font-normal text-ink-2">{fullName}</span>
            </h2>
            <p className="mt-3 text-sm text-ink-2 leading-relaxed">{desc}</p>
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
      })}
    </section>
  );
}
