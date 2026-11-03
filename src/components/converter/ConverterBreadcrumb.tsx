import React from 'react';
import { useTranslations } from 'next-intl';
import { ChevronRight, Home } from 'lucide-react';
import { Link } from '@/i18n/navigation';

interface ConverterBreadcrumbProps {
  categoryName: string;
  categoryLabel: string;
  srcKey: string;
  tgtKey: string;
  isCategorySlug: boolean;
  isPair: boolean;
}

export function ConverterBreadcrumb({
  categoryName,
  categoryLabel,
  srcKey,
  tgtKey,
  isCategorySlug,
  isPair,
}: Readonly<ConverterBreadcrumbProps>) {
  const t = useTranslations('converterPage');
  return (
    <nav aria-label={t('breadcrumb.label')} className="max-w-7xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-2.5">
      <ol className="flex items-center flex-wrap gap-1.5 text-xs text-ink-3">
        <li className="inline-flex items-center">
          <Link
            href="/"
            className="inline-flex items-center gap-1 py-1 rounded-md hover:text-accent-ink transition-colors"
          >
            <Home className="w-3.5 h-3.5" aria-hidden="true" />
            <span>{t('breadcrumb.home')}</span>
          </Link>
        </li>
        <ChevronRight className="w-3.5 h-3.5 text-ink-3 shrink-0" aria-hidden="true" />
        {isCategorySlug ? (
          <li
            className="font-semibold text-ink capitalize truncate"
            aria-current="page"
          >
            {categoryLabel}
          </li>
        ) : (
          <>
            <li className="inline-flex items-center">
              <Link
                href={`/${categoryName}-converter`}
                className="py-1 rounded-md hover:text-accent-ink transition-colors capitalize"
              >
                {categoryLabel}
              </Link>
            </li>
            <ChevronRight className="w-3.5 h-3.5 text-ink-3 shrink-0" aria-hidden="true" />
            {isPair ? (
              <>
                <li className="inline-flex items-center">
                  <Link
                    href={`/${srcKey}-converter`}
                    className="py-1 rounded-md hover:text-accent-ink transition-colors uppercase"
                  >
                    {t('formatConverter', { format: srcKey })}
                  </Link>
                </li>
                <ChevronRight
                  className="w-3.5 h-3.5 text-ink-3 shrink-0"
                  aria-hidden="true"
                />
                <li
                  className="font-semibold text-ink uppercase truncate"
                  aria-current="page"
                >
                  {t('breadcrumb.pair', { src: srcKey, tgt: tgtKey })}
                </li>
              </>
            ) : (
              <li
                className="font-semibold text-ink uppercase truncate"
                aria-current="page"
              >
                {t('formatConverter', { format: srcKey })}
              </li>
            )}
          </>
        )}
      </ol>
    </nav>
  );
}
