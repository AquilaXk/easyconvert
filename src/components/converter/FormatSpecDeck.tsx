import React from 'react';
import Link from 'next/link';
import {
  Archive, BookOpen, CheckCircle2, ChevronRight, Database, FileImage,
  FileText, Home, Layers, Music, Presentation, Type, Video,
} from 'lucide-react';
import type { FormatSpecification } from './format-specs';

export { ConverterGuaranteeBar, ConverterWorkflowSteps } from './FormatFaqAndSteps';

const CATEGORY_ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
  audio: Music,
  'audio media': Music,
  video: Video,
  'video media': Video,
  image: FileImage,
  'raster image': FileImage,
  vector: Layers,
  'vector graphic': Layers,
  spreadsheet: Database,
  presentation: Presentation,
  'slide deck': Presentation,
  archive: Archive,
  'archive package': Archive,
  ebook: BookOpen,
  'digital e-book': BookOpen,
  font: Type,
  'vector font': Type,
};

function CategoryIcon({ category }: Readonly<{ category: string }>) {
  const Icon = CATEGORY_ICON_MAP[category.toLowerCase()] ?? FileText;
  return <Icon className="w-5 h-5 text-accent-ink" />;
}

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
  return (
    <nav aria-label="Breadcrumb" className="max-w-7xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-2.5">
      <ol className="flex items-center flex-wrap gap-1.5 text-xs text-ink-3">
        <li className="inline-flex items-center">
          <Link
            href="/"
            className="inline-flex items-center gap-1 py-1 rounded-md hover:text-accent-ink transition-colors"
          >
            <Home className="w-3.5 h-3.5" aria-hidden="true" />
            <span>Home</span>
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
                    {srcKey} Converter
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
                  {srcKey} to {tgtKey}
                </li>
              </>
            ) : (
              <li
                className="font-semibold text-ink uppercase truncate"
                aria-current="page"
              >
                {srcKey} Converter
              </li>
            )}
          </>
        )}
      </ol>
    </nav>
  );
}

function FormatDossierCard({
  meta,
  role,
}: Readonly<{
  meta: FormatSpecification;
  role: 'SOURCE' | 'TARGET';
}>) {
  const rows = [
    { label: 'Full Name', value: meta.fullName, mono: false },
    { label: 'Developer', value: meta.developer, mono: false },
    { label: 'MIME Type', value: meta.mimeType, mono: true },
    { label: 'Category', value: meta.category, mono: false },
  ];

  return (
    <div className="border-t border-rule-strong pt-6 flex flex-col justify-between min-w-0">
      <div>
        <div className="flex items-start justify-between gap-3 pb-4 mb-4 border-b border-rule">
          <div className="flex items-start gap-3 min-w-0">
            <div className="text-accent-ink shrink-0">
              <CategoryIcon category={meta.category} />
            </div>
            <div className="min-w-0">
              <span className="text-[11px] font-bold tracking-wider uppercase text-accent-ink block">
                {role === 'SOURCE' ? 'SOURCE FORMAT' : 'TARGET FORMAT'}
              </span>
              <h3 className="text-base sm:text-lg font-bold text-ink leading-snug break-words">
                {meta.title}
              </h3>
            </div>
          </div>
          <span className="px-2.5 py-1 rounded-sm text-xs font-mono font-bold bg-sunken border border-rule uppercase text-ink shrink-0">
            .{meta.extension}
          </span>
        </div>

        <dl className="space-y-2.5 mb-5 text-xs sm:text-sm">
          {rows.map((row) => (
            <div
              key={row.label}
              className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 py-1.5 border-b border-rule/50"
            >
              <dt className="text-ink-2 shrink-0">{row.label}</dt>
              <dd
                className={
                  row.mono
                    ? 'font-mono text-xs text-accent-ink sm:text-right break-all'
                    : 'font-semibold text-ink sm:text-right break-words'
                }
              >
                {row.value}
              </dd>
            </div>
          ))}
        </dl>

        <p className="text-xs sm:text-sm text-ink-2 leading-relaxed mb-5">
          {meta.desc}
        </p>

        <div className="space-y-2">
          <span className="text-xs font-bold uppercase tracking-wider text-accent-ink block">
            Key Capabilities
          </span>
          {(meta.advantages || []).map((adv) => (
            <div key={adv} className="flex items-start gap-2 text-xs text-ink-2">
              <CheckCircle2 className="size-3.5 text-accent-ink shrink-0 mt-0.5" />
              <span>{adv}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

interface FormatSpecDeckProps {
  srcMeta: FormatSpecification;
  tgtMeta: FormatSpecification | null;
  isPair: boolean;
}

export function FormatSpecDeck({ srcMeta, tgtMeta, isPair }: Readonly<FormatSpecDeckProps>) {
  const srcUpper = srcMeta.extension.toUpperCase();
  const tgtUpper = tgtMeta?.extension.toUpperCase() ?? '';

  return (
    <section className="max-w-5xl mx-auto px-4 sm:px-6 mb-14">
      <div className="mb-6">
        <h2 className="text-2xl sm:text-3xl text-ink">
          {isPair
            ? `${srcUpper} vs ${tgtUpper} Specifications`
            : `${srcUpper} Format Specification`}
        </h2>
        <p className="mt-1.5 text-sm text-ink-2">
          Technical Specifications covering container standards, MIME types, specification
          maintainers, and format capabilities.
        </p>
      </div>

      <div className={`grid grid-cols-1 ${isPair ? 'lg:grid-cols-2' : ''} gap-5`}>
        <FormatDossierCard meta={srcMeta} role="SOURCE" />
        {isPair && tgtMeta && <FormatDossierCard meta={tgtMeta} role="TARGET" />}
      </div>
    </section>
  );
}
