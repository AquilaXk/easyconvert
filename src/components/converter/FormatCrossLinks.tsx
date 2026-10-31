import React from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';

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
  const isFrom = direction === 'from';
  const upperName = formatName.toUpperCase();

  return (
    <div className="bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border rounded-xl p-6 shadow-sm">
      <h2 className="text-lg sm:text-xl font-bold text-brand-950 dark:text-white mb-1">
        Convert {direction} {upperName}
      </h2>
      <p className="text-xs sm:text-sm text-ink-secondary dark:text-neutral-400 mb-5">
        {isFrom
          ? `Pick a target format to start a ${upperName} conversion.`
          : `Pick a source format to convert into ${upperName}.`}
      </p>

      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2.5">
        {formats.map((fmt) => {
          const fromFmt = isFrom ? formatName : fmt;
          const toFmt = isFrom ? fmt : formatName;
          return (
            <Link
              key={fmt}
              href={`/${fromFmt.toLowerCase()}-to-${toFmt.toLowerCase()}`}
              className="min-h-[44px] sm:min-h-[40px] flex items-center justify-between gap-2 px-3 py-2 rounded-md bg-neutral-subtle dark:bg-white/5 border border-neutral-border dark:border-dark-border hover:border-brand-700 hover:bg-brand-50 dark:hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700 text-xs font-semibold text-brand-950 dark:text-neutral-200 transition-colors group"
            >
              <span className="truncate">
                {fromFmt.toUpperCase()} to {toFmt.toUpperCase()}
              </span>
              <ArrowRight className="w-3.5 h-3.5 text-ink-muted group-hover:text-brand-700 dark:group-hover:text-brand-400 shrink-0 transition-colors" />
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
