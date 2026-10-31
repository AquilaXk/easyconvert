import React from 'react';
import { Download, Settings2, UploadCloud } from 'lucide-react';
import type { FormatSpecification } from './format-specs';

export function ConverterGuaranteeBar() {
  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 mt-2 mb-10">
      <div className="flex flex-wrap items-center justify-between gap-4 py-3 px-5 rounded-xl bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border shadow-sm text-xs text-ink-secondary dark:text-neutral-400">
        <div className="flex items-center gap-2">
          <span className="size-2 rounded-full bg-emerald-600 dark:bg-emerald-400" aria-hidden="true" />
          <span className="font-semibold text-brand-950 dark:text-white">
            Browser Edge &amp; Isolated Worker Pipeline
          </span>
        </div>
        <div className="flex items-center flex-wrap gap-3 font-medium">
          <span className="text-emerald-700 dark:text-emerald-400 font-semibold">
            100% Free &amp; Unlimited
          </span>
          <span className="text-neutral-300 dark:text-neutral-700" aria-hidden="true">
            &bull;
          </span>
          <span>Encrypted Ephemeral Processing</span>
          <span className="text-neutral-300 dark:text-neutral-700" aria-hidden="true">
            &bull;
          </span>
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
            Click &apos;Select File&apos; or drag and drop {srcUpper} files into the workbench. You
            can also import a public HTTP URL.
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
            Click &apos;Convert&apos; to run the conversion and save each output file directly, or
            download a batch as one ZIP archive.
          </p>
        </div>
      </div>
    </section>
  );
}

export function buildContextualFaqs(
  srcMeta: FormatSpecification,
  tgtMeta: FormatSpecification | null,
  isPair: boolean,
  totalFormatCount: number
) {
  const srcUpper = srcMeta.extension.toUpperCase();
  const tgtUpper = tgtMeta?.extension.toUpperCase() ?? '';

  return [
    {
      q: isPair
        ? `How do I convert ${srcUpper} to ${tgtUpper} for free?`
        : `How do I convert ${srcUpper} files online for free?`,
      a: isPair
        ? `Drop your ${srcUpper} file into the workbench above or click 'Select File', confirm ${tgtUpper} as the output format, and click Convert. Download the converted ${tgtUpper} file right away with no watermarks or account requirement.`
        : `Add your ${srcUpper} file to the workbench above, select any output format from ${totalFormatCount} supported formats, and click Convert. Conversions are free without watermarks or daily paywalls.`,
    },
    {
      q: isPair
        ? `How are ${srcUpper} to ${tgtUpper} files handled for privacy?`
        : `How are ${srcUpper} files handled for privacy?`,
      a: 'Supported client formats run directly inside your browser using WebAssembly. Server-assisted jobs transmit over TLS 1.3 into isolated worker sandboxes and delete temporary output automatically upon download or short TTL expiration.',
    },
    {
      q: isPair
        ? `Does converting ${srcUpper} to ${tgtUpper} preserve layout and quality?`
        : `Does ${srcUpper} conversion preserve formatting and quality?`,
      a: 'Yes. Dedicated format engines translate vector paths, embedded fonts, tables, colour profiles, and media streams to match the source structure.',
    },
    {
      q: `Can I batch-convert multiple ${srcUpper} files at once?`,
      a: 'Yes. Drop multiple files into the queue to convert them in parallel, then save each output individually or download a single consolidated ZIP archive.',
    },
    {
      q: 'Do I need to install desktop software or browser extensions?',
      a: 'No installation is needed. EasyConvert runs in standard web browsers across macOS, Windows, Linux, iOS, and Android.',
    },
  ];
}
