import React from 'react';
import Link from 'next/link';
import {
  Archive,
  BookOpen,
  CheckCircle2,
  ChevronRight,
  Database,
  Download,
  FileImage,
  FileText,
  Home,
  Layers,
  Music,
  Presentation,
  Settings2,
  Type,
  UploadCloud,
  Video,
} from 'lucide-react';
import type { FormatSpecification } from './format-specs';

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
  return <Icon className="w-5 h-5 text-brand-700 dark:text-brand-400" />;
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
      <ol className="flex items-center flex-wrap gap-1.5 text-xs text-ink-muted dark:text-neutral-400">
        <li className="inline-flex items-center">
          <Link
            href="/"
            className="inline-flex items-center gap-1 py-1 hover:text-brand-700 dark:hover:text-brand-300 transition-colors"
          >
            <Home className="w-3.5 h-3.5" />
            <span>Home</span>
          </Link>
        </li>
        <ChevronRight className="w-3.5 h-3.5 text-neutral-400 shrink-0" />
        {isCategorySlug ? (
          <li className="font-semibold text-brand-950 dark:text-white capitalize truncate" aria-current="page">
            {categoryLabel}
          </li>
        ) : (
          <>
            <li className="inline-flex items-center">
              <a
                href={`/${categoryName}-converter`}
                className="py-1 hover:text-brand-700 dark:hover:text-brand-300 transition-colors capitalize"
              >
                {categoryLabel}
              </a>
            </li>
            <ChevronRight className="w-3.5 h-3.5 text-neutral-400 shrink-0" />
            {isPair ? (
              <>
                <li className="inline-flex items-center">
                  <a
                    href={`/${srcKey}-converter`}
                    className="py-1 hover:text-brand-700 dark:hover:text-brand-300 transition-colors uppercase"
                  >
                    {srcKey} Converter
                  </a>
                </li>
                <ChevronRight className="w-3.5 h-3.5 text-neutral-400 shrink-0" />
                <li className="font-semibold text-brand-950 dark:text-white uppercase truncate" aria-current="page">
                  {srcKey} to {tgtKey}
                </li>
              </>
            ) : (
              <li className="font-semibold text-brand-950 dark:text-white uppercase truncate" aria-current="page">
                {srcKey} Converter
              </li>
            )}
          </>
        )}
      </ol>
    </nav>
  );
}

export function ConverterGuaranteeBar() {
  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 mt-2 mb-10">
      <div className="flex flex-wrap items-center justify-between gap-4 py-3 px-5 rounded-xl bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border shadow-sm text-xs text-ink-secondary dark:text-neutral-400">
        <div className="flex items-center gap-2">
          <span className="size-2 rounded-full bg-emerald-600 dark:bg-emerald-400" aria-hidden="true" />
          <span className="font-semibold text-brand-950 dark:text-white">Client-Side WebAssembly Pipeline</span>
        </div>
        <div className="flex items-center flex-wrap gap-3 font-medium">
          <span className="text-emerald-700 dark:text-emerald-400 font-semibold">100% Free &amp; Unlimited</span>
          <span className="text-neutral-300 dark:text-neutral-700" aria-hidden="true">&bull;</span>
          <span>Zero Server Storage</span>
          <span className="text-neutral-300 dark:text-neutral-700" aria-hidden="true">&bull;</span>
          <span>Private &amp; Secure</span>
        </div>
      </div>
    </div>
  );
}

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
  const srcUpper = srcMeta.extension.toUpperCase();
  const tgtUpper = tgtMeta?.extension.toUpperCase() ?? '';

  return (
    <section className="max-w-5xl mx-auto px-4 sm:px-6 mb-14">
      <div className="mb-6">
        <h2 className="text-xl sm:text-2xl font-bold text-brand-950 dark:text-white tracking-tight">
          {isPair ? `How to Convert ${srcUpper} to ${tgtUpper}` : `How to Convert ${srcUpper} Files`}
        </h2>
        <p className="mt-1.5 text-sm text-ink-secondary dark:text-neutral-400">
          Step-by-Step Guide for converting and downloading your files in three steps.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        <div className="rounded-xl bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border p-6 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <span className="size-8 rounded-md bg-brand-700 text-white font-bold text-xs flex items-center justify-center">
              01
            </span>
            <div className="p-2 rounded-lg bg-brand-50 dark:bg-white/5 text-brand-700 dark:text-brand-400 border border-neutral-border dark:border-dark-border">
              <UploadCloud className="size-4" />
            </div>
          </div>
          <h3 className="text-base font-bold text-brand-950 dark:text-white mb-2">
            Upload {srcUpper} File(s)
          </h3>
          <p className="text-xs sm:text-sm text-ink-secondary dark:text-neutral-400 leading-relaxed">
            Click &apos;Choose Files&apos; or drag and drop {srcUpper} files into the workbench. You can also import a public HTTP URL.
          </p>
        </div>

        <div className="rounded-xl bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border p-6 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <span className="size-8 rounded-md bg-brand-700 text-white font-bold text-xs flex items-center justify-center">
              02
            </span>
            <div className="p-2 rounded-lg bg-brand-50 dark:bg-white/5 text-brand-700 dark:text-brand-400 border border-neutral-border dark:border-dark-border">
              <Settings2 className="size-4" />
            </div>
          </div>
          <h3 className="text-base font-bold text-brand-950 dark:text-white mb-2">
            {isPair ? `Choose to ${tgtUpper}` : 'Select Destination Format'}
          </h3>
          <p className="text-xs sm:text-sm text-ink-secondary dark:text-neutral-400 leading-relaxed">
            {isPair
              ? `Confirm ${tgtUpper} as the output format, or pick another target and adjust optional conversion settings.`
              : `Pick a target format from ${totalFormatCount} supported audio, video, image, document, CAD, and archive formats.`}
          </p>
        </div>

        <div className="rounded-xl bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border p-6 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <span className="size-8 rounded-md bg-brand-700 text-white font-bold text-xs flex items-center justify-center">
              03
            </span>
            <div className="p-2 rounded-lg bg-brand-50 dark:bg-white/5 text-brand-700 dark:text-brand-400 border border-neutral-border dark:border-dark-border">
              <Download className="size-4" />
            </div>
          </div>
          <h3 className="text-base font-bold text-brand-950 dark:text-white mb-2">
            {isPair ? `Download Your ${tgtUpper}` : 'Download Converted Files'}
          </h3>
          <p className="text-xs sm:text-sm text-ink-secondary dark:text-neutral-400 leading-relaxed">
            Click &apos;Convert&apos; to run the conversion and save each output file directly, or download a batch as one ZIP archive.
          </p>
        </div>
      </div>
    </section>
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
    <div className="bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border rounded-xl p-6 shadow-sm flex flex-col justify-between min-w-0">
      <div>
        <div className="flex items-start justify-between gap-3 pb-4 mb-4 border-b border-neutral-border dark:border-dark-border">
          <div className="flex items-start gap-3 min-w-0">
            <div className="p-2.5 rounded-lg bg-brand-50 dark:bg-white/5 text-brand-700 dark:text-brand-400 border border-neutral-border dark:border-dark-border shrink-0">
              <CategoryIcon category={meta.category} />
            </div>
            <div className="min-w-0">
              <span className="text-[11px] font-bold tracking-wider uppercase text-brand-700 dark:text-brand-400 block">
                {role === 'SOURCE' ? 'SOURCE FORMAT' : 'TARGET FORMAT'}
              </span>
              <h3 className="text-base sm:text-lg font-bold text-brand-950 dark:text-white leading-snug break-words">
                {meta.title}
              </h3>
            </div>
          </div>
          <span className="px-2.5 py-1 rounded-md text-xs font-mono font-bold bg-neutral-subtle dark:bg-white/5 border border-neutral-border dark:border-dark-border uppercase text-brand-950 dark:text-neutral-200 shrink-0">
            .{meta.extension}
          </span>
        </div>

        <dl className="space-y-2.5 mb-5 text-xs sm:text-sm">
          {rows.map((row) => (
            <div
              key={row.label}
              className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 py-1.5 border-b border-neutral-border/50 dark:border-dark-border/50"
            >
              <dt className="text-ink-secondary dark:text-neutral-400 shrink-0">{row.label}</dt>
              <dd
                className={
                  row.mono
                    ? 'font-mono text-xs text-brand-700 dark:text-brand-400 sm:text-right break-all'
                    : 'font-semibold text-brand-950 dark:text-white sm:text-right break-words'
                }
              >
                {row.value}
              </dd>
            </div>
          ))}
        </dl>

        <p className="text-xs sm:text-sm text-ink-secondary dark:text-neutral-300 leading-relaxed mb-5">
          {meta.desc}
        </p>

        <div className="space-y-2">
          <span className="text-xs font-bold uppercase tracking-wider text-brand-700 dark:text-brand-400 block">
            Key Capabilities
          </span>
          {(meta.advantages || []).map((adv) => (
            <div key={adv} className="flex items-start gap-2 text-xs text-ink-secondary dark:text-neutral-300">
              <CheckCircle2 className="size-3.5 text-brand-700 dark:text-brand-400 shrink-0 mt-0.5" />
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
        <h2 className="text-xl sm:text-2xl font-bold text-brand-950 dark:text-white tracking-tight">
          {isPair ? `${srcUpper} vs ${tgtUpper} Specifications` : `${srcUpper} Format Specification`}
        </h2>
        <p className="mt-1.5 text-sm text-ink-secondary dark:text-neutral-400">
          Technical Specifications covering container standards, MIME types, specification maintainers, and format capabilities.
        </p>
      </div>

      <div className={`grid grid-cols-1 ${isPair ? 'lg:grid-cols-2' : ''} gap-5`}>
        <FormatDossierCard meta={srcMeta} role="SOURCE" />
        {isPair && tgtMeta && <FormatDossierCard meta={tgtMeta} role="TARGET" />}
      </div>
    </section>
  );
}
