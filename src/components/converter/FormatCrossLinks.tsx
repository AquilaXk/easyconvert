import React from 'react';
import { useTranslations } from 'next-intl';
import { ArrowRight } from 'lucide-react';
import { Link } from '@/i18n/navigation';

interface ConversionGridCardProps {
  formatName: string;
  formats: string[];
  direction: 'from' | 'to';
}

function ConversionGridCard({
  formatName,
  formats,
  direction,
}: Readonly<ConversionGridCardProps>) {
  const t = useTranslations('converterPage.crossLinks');
  const isFrom = direction === 'from';
  const upperName = formatName.toUpperCase();

  return (
    <div className="border-t border-rule pt-6">
      <h2 className="text-xl sm:text-2xl text-ink mb-5">
        {t(`${direction}.heading`, { format: upperName })}
      </h2>

      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2.5">
        {formats.map((fmt) => {
          const fromFmt = isFrom ? formatName : fmt;
          const toFmt = isFrom ? fmt : formatName;
          return (
            <Link
              key={fmt}
              href={`/${fromFmt.toLowerCase()}-to-${toFmt.toLowerCase()}`}
              className="min-h-[44px] sm:min-h-[40px] flex items-center justify-between gap-2 px-3 py-2 rounded-sm bg-sunken border border-rule hover:border-accent hover:bg-accent-soft text-xs font-semibold text-ink transition-colors group"
            >
              <span className="truncate">
                {t('pair', { src: fromFmt.toUpperCase(), tgt: toFmt.toUpperCase() })}
              </span>
              <ArrowRight className="w-3.5 h-3.5 text-ink-3 group-hover:text-accent-ink shrink-0 transition-colors" />
            </Link>
          );
        })}
      </div>
    </div>
  );
}

interface FormatCrossLinksProps {
  sourceFormat: string;
  convertFromTargets: string[];
  targetForReverse: string;
  convertToSources: string[];
}

export function FormatCrossLinks({
  sourceFormat,
  convertFromTargets,
  targetForReverse,
  convertToSources,
}: Readonly<FormatCrossLinksProps>) {
  if (convertFromTargets.length === 0 && convertToSources.length === 0) {
    return null;
  }

  return (
    <section className="max-w-5xl mx-auto px-4 sm:px-6 my-12 space-y-6">
      {convertFromTargets.length > 0 && (
        <ConversionGridCard
          formatName={sourceFormat}
          formats={convertFromTargets}
          direction="from"
        />
      )}
      {convertToSources.length > 0 && (
        <ConversionGridCard
          formatName={targetForReverse}
          formats={convertToSources}
          direction="to"
        />
      )}
    </section>
  );
}
