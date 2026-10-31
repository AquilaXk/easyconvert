import React from 'react';
import Link from 'next/link';
import { Code2, Download, Layers, Search, Shield, Tag, Terminal } from 'lucide-react';
import { renderInlineCode, type OpenApiSpec } from './openapi-types';

interface ApiDocsMastheadProps {
  spec: OpenApiSpec | null;
  apiKeyInput: string;
  onApiKeyChange: (val: string) => void;
}

export function ApiDocsMasthead({
  spec,
  apiKeyInput,
  onApiKeyChange,
}: Readonly<ApiDocsMastheadProps>) {
  return (
    <section className="bg-brand-950 dark:bg-[#111526] text-white border-b border-white/10">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10 sm:py-12">
        <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-6">
          <div className="min-w-0">
            <h1 className="text-2xl sm:text-4xl font-bold tracking-tight text-white">
              {spec?.info.title || 'EasyConvert Developer API'}
            </h1>
            <p className="mt-2.5 text-sm sm:text-base text-neutral-subtle/90 max-w-3xl leading-relaxed">
              {spec?.info.description ? (
                renderInlineCode(
                  spec.info.description,
                  'px-1.5 py-0.5 rounded bg-white/15 font-mono text-xs text-brand-200'
                )
              ) : (
                <>
                  REST API for asynchronous conversion queues, multipart uploads, and webhook
                  delivery. Operations marked{' '}
                  <code className="px-1.5 py-0.5 rounded bg-white/15 font-mono text-xs text-brand-200">
                    x-internal
                  </code>{' '}
                  serve the web application and are excluded from external client contracts.
                </>
              )}
            </p>

            <div className="mt-4 flex flex-wrap items-center gap-2.5 text-xs text-neutral-subtle/90">
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-white/10 border border-white/15">
                <Tag className="w-3.5 h-3.5 text-brand-300" aria-hidden="true" />
                <span>
                  OpenAPI {spec?.openapi || '3.1.0'} | v{spec?.info.version || '1.0.0'}
                </span>
              </span>
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-white/10 border border-white/15">
                <Shield className="w-3.5 h-3.5 text-emerald-300" aria-hidden="true" />
                <span>Auth: Bearer API Key</span>
              </span>
              {spec?.servers?.[0] && (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-white/10 border border-white/15 break-all">
                  <Layers className="w-3.5 h-3.5 text-brand-300 shrink-0" aria-hidden="true" />
                  <span>Base:</span>
                  <code className="font-mono text-white">{spec.servers[0].url}</code>
                </span>
              )}
            </div>
          </div>

          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 shrink-0">
            <a
              href="/api/v1/openapi.json"
              download="openapi.json"
              className="min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-md bg-brand-700 hover:bg-brand-800 text-white font-semibold text-sm transition-colors shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
            >
              <Download className="w-4 h-4" aria-hidden="true" />
              <span>Download OpenAPI JSON</span>
            </a>
            <Link
              href="/dashboard"
              className="min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-md bg-white/10 hover:bg-white/15 border border-white/20 text-white font-semibold text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
            >
              <Code2 className="w-4 h-4" aria-hidden="true" />
              <span>API Key Dashboard</span>
            </Link>
          </div>
        </div>

        <div className="mt-6 p-4 rounded-xl bg-white/5 border border-white/15 flex flex-col sm:flex-row sm:items-center gap-3">
          <label
            htmlFor="api-key-preview-input"
            className="flex items-center gap-2 text-xs font-semibold text-white whitespace-nowrap"
          >
            <Terminal className="w-4 h-4 text-brand-300" aria-hidden="true" />
            <span>cURL Preview Key</span>
          </label>
          <input
            id="api-key-preview-input"
            type="text"
            placeholder="Paste an ec_live_... key to populate cURL snippets locally"
            value={apiKeyInput}
            onChange={(e) => onApiKeyChange(e.target.value)}
            className="flex-1 min-w-0 min-h-[44px] px-3.5 py-2 rounded-md bg-brand-950/80 dark:bg-dark-scaffold border border-white/20 text-base font-mono text-white placeholder:text-white/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
          />
        </div>
      </div>
    </section>
  );
}

interface ApiDocsFilterToolbarProps {
  searchQuery: string;
  selectedMethod: string;
  availableMethods: readonly string[];
  onSearchChange: (value: string) => void;
  onSelectMethod: (method: string) => void;
}

export function ApiDocsFilterToolbar({
  searchQuery,
  selectedMethod,
  availableMethods,
  onSearchChange,
  onSelectMethod,
}: Readonly<ApiDocsFilterToolbarProps>) {
  return (
    <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
      <div>
        <h2 className="text-lg sm:text-xl font-bold text-brand-950 dark:text-white">
          Endpoints Reference
        </h2>
        <p className="text-xs sm:text-sm text-ink-secondary dark:text-dark-muted mt-0.5">
          Inspect request parameters, RBAC scopes, and executable cURL commands.
        </p>
      </div>

      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 w-full md:w-auto">
        <div className="relative w-full sm:w-80">
          <label htmlFor="endpoint-search-input" className="sr-only">
            Search API endpoints
          </label>
          <Search
            className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted dark:text-dark-muted pointer-events-none"
            aria-hidden="true"
          />
          <input
            id="endpoint-search-input"
            type="text"
            placeholder="Search endpoints (convert, jobs, uploads)..."
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="w-full min-h-[44px] pl-10 pr-4 py-2 rounded-md bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border text-base text-brand-950 dark:text-white placeholder:text-ink-muted dark:placeholder:text-dark-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700"
          />
        </div>

        <fieldset className="border-0 p-0 m-0 min-w-0">
          <legend className="sr-only">Filter endpoints by HTTP method</legend>
          <div className="flex flex-wrap items-center gap-1.5">
            {availableMethods.map((method) => {
              const active = selectedMethod === method;
              return (
                <button
                  key={method}
                  type="button"
                  onClick={() => onSelectMethod(method)}
                  aria-pressed={active}
                  className={`min-h-[44px] px-3.5 py-2 rounded-md text-xs font-bold uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700 ${
                    active
                      ? 'bg-brand-700 text-white shadow-sm'
                      : 'bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border text-ink-secondary dark:text-dark-muted hover:text-brand-950 dark:hover:text-white'
                  }`}
                >
                  {method}
                </button>
              );
            })}
          </div>
        </fieldset>
      </div>
    </div>
  );
}
