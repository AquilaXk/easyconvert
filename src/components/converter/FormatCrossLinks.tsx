import React from 'react';
import { useTranslations } from 'next-intl';
import { Link } from '@/i18n/navigation';
import type { FormatCategory } from '@/lib/types';
import { REGISTRY_STATS } from '@/lib/registry-stats';

const CHIP_CLASS =
  'inline-flex items-center rounded-xs border border-rule bg-surface/80 px-2.5 py-1 font-mono text-xs uppercase text-ink transition-colors hover:border-accent/40 hover:bg-accent/5 hover:text-accent-ink';

interface ChipBlockProps {
  eyebrow: string;
  heading: string;
  intro: string;
  chips: ReadonlyArray<{ href: string; label: string }>;
}

/** A heading and a one-line intro over a dashed box of small monospace chips, each a link. */
function ChipBlock({ eyebrow, heading, intro, chips }: Readonly<ChipBlockProps>) {
  return (
    <article className="min-w-0">
      <div className="text-[11px] font-medium uppercase tracking-[0.18em] [:lang(ko)_&]:tracking-[0.05em] text-ink-3">{eyebrow}</div>
      <h2 className="mt-2 text-lg font-semibold tracking-tight text-ink sm:text-xl">{heading}</h2>
      <p className="mt-2 max-w-xl text-sm leading-relaxed text-ink-3">{intro}</p>
      <div className="mt-4 border border-dashed border-rule bg-canvas/30 p-4">
        <div className="flex flex-wrap gap-1.5">
          {chips.map((chip) => (
            <Link key={chip.href} href={chip.href} className={CHIP_CLASS}>
              {chip.label}
            </Link>
          ))}
        </div>
      </div>
    </article>
  );
}

interface FormatCrossLinksProps {
  format: string;
  /** The formats `format` converts to. */
  targets: string[];
  /** The formats that convert to `format`. */
  sources: string[];
}

/** The format page's two lists of conversions, from the format and to it. */
export function FormatCrossLinks({ format, targets, sources }: Readonly<FormatCrossLinksProps>) {
  const t = useTranslations('converterPage.crossLinks');
  if (targets.length === 0 && sources.length === 0) {
    return null;
  }
  const upper = format.toUpperCase();
  const chipsOf = (others: string[], isFrom: boolean) =>
    others.map((other) => {
      const from = isFrom ? format : other;
      const to = isFrom ? other : format;
      return {
        href: `/${from.toLowerCase()}-to-${to.toLowerCase()}`,
        label: t('pair', { src: from.toUpperCase(), tgt: to.toUpperCase() }),
      };
    });

  return (
    <section className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 mt-12 pb-16 grid gap-x-10 gap-y-8 lg:grid-cols-2">
      {targets.length > 0 && (
        <ChipBlock
          eyebrow={t('eyebrow')}
          heading={t('from.heading', { format: upper })}
          intro={t('from.intro', { format: upper })}
          chips={chipsOf(targets, true)}
        />
      )}
      {sources.length > 0 && (
        <ChipBlock
          eyebrow={t('eyebrow')}
          heading={t('to.heading', { format: upper })}
          intro={t('to.intro', { format: upper })}
          chips={chipsOf(sources, false)}
        />
      )}
    </section>
  );
}

/** The category page's list of every format of the category, each linking its own converter. */
export function CategoryConverters({ category }: Readonly<{ category: FormatCategory }>) {
  const t = useTranslations('converterPage.crossLinks.category');
  const tCategory = useTranslations('formatCategories');
  const stat = REGISTRY_STATS.categories.find((entry) => entry.id === category);
  if (!stat) {
    return null;
  }
  const label = tCategory(category);

  return (
    <section className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 mt-12 pb-16">
      <ChipBlock
        eyebrow={t('eyebrow')}
        heading={t('heading', { category: label })}
        intro={t('intro')}
        chips={stat.formats.map((fmt) => ({ href: `/${fmt.id}-converter`, label: fmt.extension }))}
      />
    </section>
  );
}
