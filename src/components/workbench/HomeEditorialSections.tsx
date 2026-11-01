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
    <div className="border-t border-rule-strong lg:col-span-4 min-w-0 pt-6 sm:pt-7">
      <h2 className="text-2xl text-ink">
        Security &amp; Data Handling
      </h2>
      <p className="mt-1.5 text-sm text-ink-2">
        Built around isolated execution and short-lived storage boundaries.
      </p>

      <div className="mt-5 divide-y divide-rule">
        <div className="py-4 first:pt-0">
          <div className="flex items-center gap-2 text-sm font-bold text-ink">
            <Lock className="w-4 h-4 text-accent-ink shrink-0" />
            <h3>TLS 1.3 Transport Encryption</h3>
          </div>
          <p className="mt-1.5 text-xs text-ink-2 leading-relaxed">
            Uploads, signed storage transfers, and result downloads run strictly over encrypted HTTPS
            channels.
          </p>
        </div>

        <div className="py-4">
          <div className="flex items-center gap-2 text-sm font-bold text-ink">
            <Cpu className="w-4 h-4 text-accent-ink shrink-0" />
            <h3>Sandboxed Browser &amp; Worker Execution</h3>
          </div>
          <p className="mt-1.5 text-xs text-ink-2 leading-relaxed">
            Supported pairs run locally in browser memory, while complex formats execute inside
            isolated worker sandboxes.
          </p>
        </div>

        <div className="py-4 last:pb-0">
          <div className="flex items-center gap-2 text-sm font-bold text-ink">
            <Clock className="w-4 h-4 text-accent-ink shrink-0" />
            <h3>Automatic TTL File Cleanup</h3>
          </div>
          <p className="mt-1.5 text-xs text-ink-2 leading-relaxed">
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
    <div className="border-t border-rule-strong lg:col-span-8 min-w-0 pt-6 sm:pt-7">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl">
          <h2 className="text-2xl sm:text-3xl text-ink">
            REST API &amp; Batch Workflows
          </h2>
          <p className="mt-1.5 text-sm text-ink-2 leading-relaxed">
            Automate single-file conversions via{' '}
            <code className="font-mono text-xs px-1.5 py-0.5 rounded bg-sunken">
              POST /api/v1/convert
            </code>{' '}
            or submit multi-step DAG pipelines to{' '}
            <code className="font-mono text-xs px-1.5 py-0.5 rounded bg-sunken">
              POST /api/v1/jobs
            </code>{' '}
            with signed webhook delivery.
          </p>
        </div>
      </div>

      <div className="mt-5 rounded-md text-ink border border-rule overflow-hidden">
        <div className="px-4 py-2 border-b border-rule flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-2 min-w-0 text-xs font-mono text-ink-2">
            <Terminal className="w-3.5 h-3.5 text-accent-ink shrink-0" />
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
              className="inline-flex items-center gap-1.5 min-h-[44px] px-3 rounded-sm text-xs font-medium text-ink hover:text-ink hover:bg-sunken transition-colors cursor-pointer"
            >
              {copied ? (
                <>
                  <Check className="w-3.5 h-3.5 text-success" />
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
        <pre className="p-4 text-xs font-mono text-ink overflow-x-auto leading-relaxed">
          <code>{API_CURL_EXAMPLE}</code>
        </pre>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Link
          href="/api-docs"
          className="lift inline-flex items-center justify-center gap-2 min-h-[44px] px-4 rounded-sm bg-accent hover:bg-accent-hover hover:shadow-glow text-on-accent text-sm font-semibold"
        >
          <span>OpenAPI 3.1 Reference</span>
          <ArrowRight className="w-4 h-4" />
        </Link>
        <Link
          href="/dashboard"
          className="inline-flex items-center justify-center min-h-[44px] px-4 rounded-sm border border-rule hover:border-accent text-sm font-medium text-ink transition-colors"
        >
          Manage API Keys
        </Link>
      </div>
    </div>
  );
}

export function HowConversionWorksCard() {
  return (
    <div className="border-t border-rule-strong lg:col-span-4 min-w-0 pt-6 sm:pt-7">
      <h2 className="text-2xl text-ink">
        How Conversion Works
      </h2>
      <p className="mt-1.5 text-sm text-ink-2">
        Three direct steps without account walls or watermarks.
      </p>

      <div className="mt-5 divide-y divide-rule">
        <div className="py-4 first:pt-0">
          <h3 className="text-sm font-bold text-ink">1. Add source files</h3>
          <p className="mt-1 text-xs text-ink-2 leading-relaxed">
            Select files from your device, drag them onto the workbench, paste from clipboard, or
            import from a public HTTP URL.
          </p>
        </div>

        <div className="py-4">
          <h3 className="text-sm font-bold text-ink">
            2. Pick format &amp; options
          </h3>
          <p className="mt-1 text-xs text-ink-2 leading-relaxed">
            Choose any compatible target extension and optionally tune codecs, dimensions, page
            ranges, or delimiters.
          </p>
        </div>

        <div className="py-4 last:pb-0">
          <h3 className="text-sm font-bold text-ink">
            3. Convert &amp; download
          </h3>
          <p className="mt-1 text-xs text-ink-2 leading-relaxed">
            Download converted files individually as soon as they finish, or bundle multi-file
            batches into one ZIP archive.
          </p>
        </div>
      </div>
    </div>
  );
}
