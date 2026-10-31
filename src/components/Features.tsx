'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import {
  ArrowRight,
  Check,
  Copy,
  Lock,
  Cpu,
  Clock,
  Terminal,
} from 'lucide-react';
import type { FormatCategory } from '@/lib/types';
import { CategoryRegistryStat, REGISTRY_STATS } from '@/lib/registry-stats';

export interface FeaturesProps {
  onSelectPreset?: (source: string, target: string) => void;
}

interface PopularPair {
  from: string;
  to: string;
  summary: string;
}

const POPULAR_PAIRS_BY_CATEGORY: Record<FormatCategory, ReadonlyArray<PopularPair>> = {
  image: [
    { from: 'png', to: 'webp', summary: 'Web image compression with alpha support' },
    { from: 'heic', to: 'jpg', summary: 'Camera photo compatibility across devices' },
    { from: 'jpg', to: 'pdf', summary: 'Printable single-page document export' },
  ],
  document: [
    { from: 'pdf', to: 'docx', summary: 'Editable Word document output' },
    { from: 'docx', to: 'pdf', summary: 'Fixed-layout PDF distribution' },
    { from: 'hwp', to: 'pdf', summary: 'Hangul office document rendering' },
  ],
  archive: [
    { from: 'rar', to: 'zip', summary: 'Standard ZIP archive repackaging' },
    { from: '7z', to: 'zip', summary: 'Cross-platform archive compatibility' },
    { from: 'tar', to: 'zip', summary: 'Compressed bundle conversion' },
  ],
  video: [
    { from: 'mp4', to: 'mp3', summary: 'Audio track extraction from video' },
    { from: 'mkv', to: 'mp4', summary: 'Browser and mobile playback container' },
    { from: 'mov', to: 'mp4', summary: 'Standard H.264 MP4 container export' },
  ],
  audio: [
    { from: 'wav', to: 'mp3', summary: 'Compact MP3 audio encoding' },
    { from: 'flac', to: 'mp3', summary: 'Lossless source to portable MP3' },
    { from: 'm4a', to: 'wav', summary: 'Uncompressed PCM waveform output' },
  ],
  ebook: [
    { from: 'epub', to: 'pdf', summary: 'Paginated PDF layout from e-book' },
    { from: 'mobi', to: 'epub', summary: 'Open EPUB e-reader format' },
    { from: 'fb2', to: 'txt', summary: 'Plain UTF-8 text extraction' },
  ],
  spreadsheet: [
    { from: 'xlsx', to: 'csv', summary: 'Delimited plain-text table export' },
    { from: 'xlsx', to: 'pdf', summary: 'Formatted spreadsheet printout' },
    { from: 'ods', to: 'xlsx', summary: 'Excel workbook compatibility' },
  ],
  presentation: [
    { from: 'pptx', to: 'pdf', summary: 'Portable slide deck handout' },
    { from: 'pptx', to: 'html', summary: 'Browser-viewable slide markup' },
    { from: 'odp', to: 'pptx', summary: 'PowerPoint slide deck export' },
  ],
  data: [
    { from: 'csv', to: 'json', summary: 'Structured JSON record array' },
    { from: 'yaml', to: 'json', summary: 'Configuration file normalization' },
    { from: 'json', to: 'csv', summary: 'Tabular row and column export' },
  ],
  vector: [
    { from: 'svg', to: 'png', summary: 'Crisp rasterized PNG graphic' },
    { from: 'ai', to: 'pdf', summary: 'Vector artwork preservation in PDF' },
    { from: 'eps', to: 'svg', summary: 'Web-ready scalable SVG vector' },
  ],
  font: [
    { from: 'ttf', to: 'woff2', summary: 'Compressed WOFF2 web font' },
    { from: 'otf', to: 'ttf', summary: 'TrueType desktop font binary' },
    { from: 'woff', to: 'ttf', summary: 'Installable TrueType font output' },
  ],
  cad: [
    { from: 'dwg', to: 'pdf', summary: 'Technical drawing PDF sheet' },
    { from: 'step', to: 'stl', summary: 'Triangle mesh for 3D printing' },
    { from: 'dxf', to: 'svg', summary: '2D vector CAD plot export' },
  ],
};

const API_CURL_EXAMPLE = [
  'curl -X POST https://easyconvert.com/api/v1/convert \\',
  '  -H "Authorization: Bearer $EASYCONVERT_API_KEY" \\',
  '  -F "file=@report.pdf" \\',
  '  -F "targetFormat=docx" \\',
  '  -o report.docx',
].join('\n');

function FormatDirectoryCard({
  activeCategory,
  onSelectCategory,
}: {
  activeCategory: CategoryRegistryStat;
  onSelectCategory: (id: FormatCategory) => void;
}) {
  const popularPairs = POPULAR_PAIRS_BY_CATEGORY[activeCategory.id];

  return (
    <div className="lg:col-span-8 min-w-0 rounded-xl border border-neutral-border dark:border-dark-border bg-white dark:bg-dark-surface p-6 sm:p-7">
      <div className="border-b border-neutral-border dark:border-dark-border pb-5">
        <h2 className="text-xl sm:text-2xl font-bold tracking-tight text-brand-950 dark:text-white">
          Supported Format Directory
        </h2>
        <p className="mt-1.5 text-sm text-ink-secondary dark:text-neutral-300">
          Browse {REGISTRY_STATS.formatCount} formats across {REGISTRY_STATS.categoryCount} categories
          covering {REGISTRY_STATS.pairCount.toLocaleString('en-US')} registered conversion pairs.
        </p>

        <div className="mt-5 flex flex-wrap gap-2">
          {REGISTRY_STATS.categories.map((cat) => {
            const isSelected = cat.id === activeCategory.id;
            const buttonStyle = isSelected
              ? 'bg-brand-700 text-white border-brand-700 font-semibold'
              : 'bg-neutral-scaffold dark:bg-dark-scaffold text-ink-secondary dark:text-neutral-300 border-neutral-border dark:border-dark-border hover:border-brand-700 hover:text-brand-950 dark:hover:text-white';
            const badgeStyle = isSelected
              ? 'bg-white/20 text-white'
              : 'bg-white dark:bg-dark-surface text-ink-muted dark:text-neutral-400';

            return (
              <button
                key={cat.id}
                type="button"
                aria-pressed={isSelected}
                onClick={() => onSelectCategory(cat.id)}
                className={`inline-flex items-center gap-2 min-h-[44px] px-3.5 rounded-md border text-xs transition-colors cursor-pointer ${buttonStyle}`}
              >
                <span>{cat.label}</span>
                <span className={`px-1.5 py-0.5 rounded font-mono text-[11px] ${badgeStyle}`}>
                  {cat.count}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="pt-5 space-y-6">
        <div>
          <div className="flex items-center justify-between gap-2 mb-3">
            <h3 className="text-sm font-bold text-brand-950 dark:text-white">
              {activeCategory.label} Extensions ({activeCategory.count})
            </h3>
            <span className="text-xs text-ink-muted dark:text-neutral-400">
              Select an extension to open its converter
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {activeCategory.formats.map((fmt) => (
              <Link
                key={fmt.id}
                href={`/${fmt.id}-converter`}
                className="inline-flex items-center justify-center min-h-[44px] px-3 rounded-md bg-neutral-scaffold dark:bg-dark-scaffold hover:bg-brand-50 dark:hover:bg-dark-elevated border border-neutral-border dark:border-dark-border hover:border-brand-700 dark:hover:border-brand-400 font-mono text-xs font-semibold uppercase text-brand-950 dark:text-neutral-200 transition-colors"
              >
                {fmt.extension}
              </Link>
            ))}
          </div>
        </div>

        <div className="pt-5 border-t border-neutral-border dark:border-dark-border">
          <h3 className="text-sm font-bold text-brand-950 dark:text-white mb-3">
            Common {activeCategory.label} Pairs
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {popularPairs.map((pair) => (
              <Link
                key={`${pair.from}-${pair.to}`}
                href={`/${pair.from}-to-${pair.to}`}
                className="group flex flex-col justify-between min-h-[44px] p-3.5 rounded-lg bg-neutral-scaffold dark:bg-dark-scaffold border border-neutral-border dark:border-dark-border hover:border-brand-700 dark:hover:border-brand-400 transition-colors"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1.5 font-mono text-xs font-bold uppercase text-brand-950 dark:text-white group-hover:text-brand-700 dark:group-hover:text-brand-300">
                    <span>{pair.from}</span>
                    <ArrowRight className="w-3.5 h-3.5 text-ink-muted" />
                    <span>{pair.to}</span>
                  </span>
                </div>
                <span className="mt-1.5 text-xs text-ink-secondary dark:text-neutral-400 leading-snug">
                  {pair.summary}
                </span>
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function SecurityDataHandlingCard() {
  return (
    <div className="lg:col-span-4 min-w-0 rounded-xl border border-neutral-border dark:border-dark-border bg-white dark:bg-dark-surface p-6 sm:p-7">
      <h2 className="text-xl font-bold tracking-tight text-brand-950 dark:text-white">
        Security &amp; Data Handling
      </h2>
      <p className="mt-1.5 text-sm text-ink-secondary dark:text-neutral-300">
        Built around isolated execution and short-lived storage boundaries.
      </p>

      <div className="mt-5 divide-y divide-neutral-border dark:divide-dark-border">
        <div className="py-4 first:pt-0">
          <div className="flex items-center gap-2 text-sm font-bold text-brand-950 dark:text-white">
            <Lock className="w-4 h-4 text-brand-700 dark:text-brand-400 shrink-0" />
            <h3>TLS 1.3 Transport Encryption</h3>
          </div>
          <p className="mt-1.5 text-xs text-ink-secondary dark:text-neutral-400 leading-relaxed">
            Uploads, signed storage transfers, and result downloads run strictly over encrypted HTTPS
            channels.
          </p>
        </div>

        <div className="py-4">
          <div className="flex items-center gap-2 text-sm font-bold text-brand-950 dark:text-white">
            <Cpu className="w-4 h-4 text-brand-700 dark:text-brand-400 shrink-0" />
            <h3>Sandboxed Browser &amp; Worker Execution</h3>
          </div>
          <p className="mt-1.5 text-xs text-ink-secondary dark:text-neutral-400 leading-relaxed">
            Supported pairs run locally in browser memory, while complex formats execute inside
            isolated worker sandboxes.
          </p>
        </div>

        <div className="py-4 last:pb-0">
          <div className="flex items-center gap-2 text-sm font-bold text-brand-950 dark:text-white">
            <Clock className="w-4 h-4 text-brand-700 dark:text-brand-400 shrink-0" />
            <h3>Automatic TTL File Cleanup</h3>
          </div>
          <p className="mt-1.5 text-xs text-ink-secondary dark:text-neutral-400 leading-relaxed">
            Temporary job inputs and converted outputs expire automatically after short retention
            windows.
          </p>
        </div>
      </div>
    </div>
  );
}

function RestApiWorkflowCard() {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      try {
        await navigator.clipboard.writeText(API_CURL_EXAMPLE);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch {
        setCopied(false);
      }
    }
  };

  return (
    <div className="lg:col-span-8 min-w-0 rounded-xl border border-neutral-border dark:border-dark-border bg-white dark:bg-dark-surface p-6 sm:p-7">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl">
          <h2 className="text-xl sm:text-2xl font-bold tracking-tight text-brand-950 dark:text-white">
            REST API &amp; Batch Workflows
          </h2>
          <p className="mt-1.5 text-sm text-ink-secondary dark:text-neutral-300 leading-relaxed">
            Automate single-file conversions via <code className="font-mono text-xs px-1.5 py-0.5 rounded bg-neutral-subtle dark:bg-dark-elevated">POST /api/v1/convert</code> or submit multi-step DAG pipelines to <code className="font-mono text-xs px-1.5 py-0.5 rounded bg-neutral-subtle dark:bg-dark-elevated">POST /api/v1/jobs</code> with signed webhook delivery.
          </p>
        </div>
      </div>

      <div className="mt-5 rounded-lg bg-brand-950 dark:bg-[#111526] text-slate-100 border border-white/10 overflow-hidden">
        <div className="px-4 py-2 border-b border-white/10 flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-2 text-xs font-mono text-slate-300">
            <Terminal className="w-3.5 h-3.5 text-brand-400" />
            <span>POST /api/v1/convert</span>
          </span>
          <button
            type="button"
            aria-label="Copy API example"
            onClick={handleCopy}
            className="inline-flex items-center gap-1.5 min-h-[44px] px-3 rounded-md text-xs font-medium text-slate-200 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
          >
            {copied ? (
              <>
                <Check className="w-3.5 h-3.5 text-emerald-400" />
                <span>Copied</span>
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5" />
                <span>Copy</span>
              </>
            )}
          </button>
        </div>
        <pre className="p-4 text-xs font-mono text-slate-100 overflow-x-auto leading-relaxed">
          <code>{API_CURL_EXAMPLE}</code>
        </pre>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Link
          href="/api-docs"
          className="inline-flex items-center justify-center gap-2 min-h-[44px] px-4 rounded-md bg-brand-700 hover:bg-brand-800 text-white text-sm font-semibold transition-colors"
        >
          <span>OpenAPI 3.1 Reference</span>
          <ArrowRight className="w-4 h-4" />
        </Link>
        <Link
          href="/dashboard"
          className="inline-flex items-center justify-center min-h-[44px] px-4 rounded-md border border-neutral-border dark:border-dark-border bg-neutral-scaffold dark:bg-dark-scaffold hover:border-brand-700 text-sm font-medium text-brand-950 dark:text-neutral-200 transition-colors"
        >
          Manage API Keys
        </Link>
      </div>
    </div>
  );
}

function HowConversionWorksCard() {
  return (
    <div className="lg:col-span-4 min-w-0 rounded-xl border border-neutral-border dark:border-dark-border bg-white dark:bg-dark-surface p-6 sm:p-7">
      <h2 className="text-xl font-bold tracking-tight text-brand-950 dark:text-white">
        How Conversion Works
      </h2>
      <p className="mt-1.5 text-sm text-ink-secondary dark:text-neutral-300">
        Three direct steps without account walls or watermarks.
      </p>

      <div className="mt-5 divide-y divide-neutral-border dark:divide-dark-border">
        <div className="py-4 first:pt-0">
          <h3 className="text-sm font-bold text-brand-950 dark:text-white">
            1. Add source files
          </h3>
          <p className="mt-1 text-xs text-ink-secondary dark:text-neutral-400 leading-relaxed">
            Select files from your device, drag them onto the workbench, paste from clipboard, or
            import from a public HTTP URL.
          </p>
        </div>

        <div className="py-4">
          <h3 className="text-sm font-bold text-brand-950 dark:text-white">
            2. Pick format &amp; options
          </h3>
          <p className="mt-1 text-xs text-ink-secondary dark:text-neutral-400 leading-relaxed">
            Choose any compatible target extension and optionally tune codecs, dimensions, page
            ranges, or delimiters.
          </p>
        </div>

        <div className="py-4 last:pb-0">
          <h3 className="text-sm font-bold text-brand-950 dark:text-white">
            3. Convert &amp; download
          </h3>
          <p className="mt-1 text-xs text-ink-secondary dark:text-neutral-400 leading-relaxed">
            Download converted files individually as soon as they finish, or bundle multi-file
            batches into one ZIP archive.
          </p>
        </div>
      </div>
    </div>
  );
}

export default function Features(_props: FeaturesProps = {}) {
  const [selectedCategory, setSelectedCategory] = useState<FormatCategory>('document');

  const activeCategory =
    REGISTRY_STATS.categories.find((cat) => cat.id === selectedCategory) ||
    REGISTRY_STATS.categories[0];

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-14 space-y-12">
      <section
        id="format-catalog"
        className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start"
      >
        <FormatDirectoryCard
          activeCategory={activeCategory}
          onSelectCategory={setSelectedCategory}
        />
        <SecurityDataHandlingCard />
      </section>

      <section
        id="how-it-works"
        className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start"
      >
        <RestApiWorkflowCard />
        <HowConversionWorksCard />
      </section>
    </div>
  );
}
