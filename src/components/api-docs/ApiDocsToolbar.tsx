import React from 'react';
import { useTranslations } from 'next-intl';
import { Code2, Download, Layers, Search, Shield, Tag, Terminal } from 'lucide-react';
import { Link } from '@/i18n/navigation';
import { renderInlineCode, type OpenApiSpec } from './openapi-types';

const INLINE_CODE_CLASS = 'px-1.5 py-0.5 rounded-md bg-sunken font-mono text-xs text-accent-ink';

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
  const t = useTranslations('apiDocs.masthead');
  return (
    <section className="text-ink border-b border-rule">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10 sm:py-12">
        <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-6">
          <div className="min-w-0">
            <h1 className="text-3xl sm:text-5xl text-ink">
              {spec?.info.title || t('fallbackTitle')}
            </h1>
            <p className="mt-2.5 text-sm sm:text-base text-ink-3 max-w-3xl leading-relaxed">
              {spec?.info.description ? (
                renderInlineCode(spec.info.description, INLINE_CODE_CLASS)
              ) : (
                t.rich('fallbackDescription', {
                  code: (chunks) => <code className={INLINE_CODE_CLASS}>{chunks}</code>,
                })
              )}
            </p>

            <div className="mt-4 flex flex-wrap items-center gap-2.5 text-xs text-ink-3">
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-sm bg-sunken border border-rule">
                <Tag className="w-3.5 h-3.5 text-accent-ink" aria-hidden="true" />
                <span>
                  {t('version', { openapi: spec?.openapi || '3.1.0', version: spec?.info.version || '1.0.0' })}
                </span>
              </span>
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-sm bg-sunken border border-rule">
                <Shield className="w-3.5 h-3.5 text-success" aria-hidden="true" />
                <span>{t('auth')}</span>
              </span>
              {spec?.servers?.[0] && (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-sm bg-sunken border border-rule break-all">
                  <Layers className="w-3.5 h-3.5 text-accent-ink shrink-0" aria-hidden="true" />
                  <span>{t('base')}</span>
                  <code className="font-mono text-ink">{spec.servers[0].url}</code>
                </span>
              )}
            </div>
          </div>

          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 shrink-0">
            <a
              href="/api/v1/openapi.json"
              download="openapi.json"
              className="lift min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-sm bg-accent hover:bg-accent-hover hover:shadow-glow text-on-accent font-semibold text-sm"
            >
              <Download className="w-4 h-4" aria-hidden="true" />
              <span>{t('download')}</span>
            </a>
            <Link
              href="/dashboard"
              className="min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-sm hover:bg-sunken border border-rule hover:border-rule-strong text-ink font-semibold text-sm transition-colors"
            >
              <Code2 className="w-4 h-4" aria-hidden="true" />
              <span>{t('dashboard')}</span>
            </Link>
          </div>
        </div>

        <div className="mt-6 p-4 rounded-md bg-sunken border border-rule flex flex-col sm:flex-row sm:items-center gap-3">
          <label
            htmlFor="api-key-preview-input"
            className="flex items-center gap-2 text-xs font-semibold text-ink whitespace-nowrap"
          >
            <Terminal className="w-4 h-4 text-accent-ink" aria-hidden="true" />
            <span>{t('previewKey')}</span>
          </label>
          <input
            id="api-key-preview-input"
            type="text"
            placeholder={t('previewKeyPlaceholder')}
            value={apiKeyInput}
            onChange={(e) => onApiKeyChange(e.target.value)}
            className="flex-1 min-w-0 min-h-[44px] px-3.5 py-2 rounded-sm bg-surface/80 border border-rule-strong text-base font-mono text-ink placeholder:text-ink-3"
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
  const t = useTranslations('apiDocs.toolbar');
  return (
    <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
      <div>
        <h2 className="text-xl sm:text-2xl text-ink">
          {t('heading')}
        </h2>
        <p className="text-xs sm:text-sm text-ink-2 mt-0.5">
          {t('intro')}
        </p>
      </div>

      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 w-full md:w-auto">
        <div className="relative w-full sm:w-80">
          <label htmlFor="endpoint-search-input" className="sr-only">
            {t('searchLabel')}
          </label>
          <Search
            className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-3 pointer-events-none"
            aria-hidden="true"
          />
          <input
            id="endpoint-search-input"
            type="text"
            placeholder={t('searchPlaceholder')}
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="w-full min-h-[44px] pl-10 pr-4 py-2 rounded-sm bg-surface/80 border border-rule-strong text-base text-ink placeholder:text-ink-3"
          />
        </div>

        <fieldset className="border-0 p-0 m-0 min-w-0">
          <legend className="sr-only">{t('methodLegend')}</legend>
          <div className="flex flex-wrap items-center gap-1.5">
            {availableMethods.map((method) => {
              const active = selectedMethod === method;
              return (
                <button
                  key={method}
                  type="button"
                  onClick={() => onSelectMethod(method)}
                  aria-pressed={active}
                  className={`min-h-[44px] px-3.5 py-2 rounded-sm text-xs font-bold uppercase tracking-wider transition-colors ${
                    active
                      ? 'bg-accent text-on-accent'
                      : 'bg-surface border border-rule text-ink-2 hover:text-ink'
                  }`}
                >
                  {method === 'all' ? t('allMethods') : method}
                </button>
              );
            })}
          </div>
        </fieldset>
      </div>
    </div>
  );
}
