'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Check, Copy, Lock, Cpu, Clock, Terminal } from 'lucide-react';

const API_CURL_EXAMPLE = [
  'curl -X POST https://api.easyconvert.com/api/v1/convert \\',
  '  -H "Authorization: Bearer $EASYCONVERT_API_KEY" \\',
  '  -F "file=@report.pdf" \\',
  '  -F "targetFormat=docx" \\',
  '  -o report.docx',
].join('\n');

export function SecurityDataHandlingCard() {
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

export function RestApiWorkflowCard() {
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
            Automate single-file conversions via{' '}
            <code className="font-mono text-xs px-1.5 py-0.5 rounded bg-neutral-subtle dark:bg-dark-elevated">
              POST /api/v1/convert
            </code>{' '}
            or submit multi-step DAG pipelines to{' '}
            <code className="font-mono text-xs px-1.5 py-0.5 rounded bg-neutral-subtle dark:bg-dark-elevated">
              POST /api/v1/jobs
            </code>{' '}
            with signed webhook delivery.
          </p>
        </div>
      </div>

      <div className="mt-5 rounded-lg bg-brand-950 dark:bg-[#111526] text-slate-100 border border-white/10 overflow-hidden">
        <div className="px-4 py-2 border-b border-white/10 flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-2 min-w-0 text-xs font-mono text-slate-300">
            <Terminal className="w-3.5 h-3.5 text-brand-400 shrink-0" />
            <span className="truncate">POST https://api.easyconvert.com/api/v1/convert</span>
          </span>
          <div className="flex items-center shrink-0">
            <output aria-live="polite" className="sr-only">
              {copied ? 'Copied API example to clipboard' : ''}
            </output>
            <button
              type="button"
              aria-label="Copy API example"
              onClick={() => {
                void handleCopy();
              }}
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

export function HowConversionWorksCard() {
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
          <h3 className="text-sm font-bold text-brand-950 dark:text-white">1. Add source files</h3>
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
