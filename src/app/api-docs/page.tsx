'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import {
  AlertCircle,
  Code2,
  Download,
  FileCode,
  Layers,
  Search,
  Shield,
  Tag,
  Terminal,
} from 'lucide-react';
import { EndpointCard } from '@/components/api-docs/EndpointCard';
import {
  renderInlineCode,
  type OpenApiSpec,
  type ParsedEndpointItem,
} from '@/components/api-docs/openapi-types';

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
const FILTER_METHODS = ['all', 'get', 'post', 'patch', 'delete'] as const;

interface ApiDocsMastheadProps {
  spec: OpenApiSpec | null;
  apiKeyInput: string;
  onApiKeyChange: (val: string) => void;
}

function ApiDocsMasthead({ spec, apiKeyInput, onApiKeyChange }: Readonly<ApiDocsMastheadProps>) {
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
                  REST API for asynchronous conversion queues, multipart uploads, and webhook delivery. Operations
                  marked{' '}
                  <code className="px-1.5 py-0.5 rounded bg-white/15 font-mono text-xs text-brand-200">
                    x-internal
                  </code>{' '}
                  serve the web application and are excluded from external client contracts.
                </>
              )}
            </p>

            <div className="mt-4 flex flex-wrap items-center gap-2.5 text-xs text-neutral-subtle/90">
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-white/10 border border-white/15">
                <Tag className="w-3.5 h-3.5 text-brand-300" />
                OpenAPI {spec?.openapi || '3.1.0'} | v{spec?.info.version || '1.0.0'}
              </span>
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-white/10 border border-white/15">
                <Shield className="w-3.5 h-3.5 text-emerald-300" />
                Auth: Bearer API Key
              </span>
              {spec?.servers?.[0] && (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-white/10 border border-white/15 break-all">
                  <Layers className="w-3.5 h-3.5 text-brand-300 shrink-0" />
                  Base: <code className="font-mono text-white">{spec.servers[0].url}</code>
                </span>
              )}
            </div>
          </div>

          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 shrink-0">
            <a
              href="/api/v1/openapi.json"
              download="openapi.json"
              className="min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-md bg-brand-700 hover:bg-brand-800 text-white font-semibold text-sm transition-colors shadow-sm"
            >
              <Download className="w-4 h-4" />
              <span>Download OpenAPI JSON</span>
            </a>
            <Link
              href="/dashboard"
              className="min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-md bg-white/10 hover:bg-white/15 border border-white/20 text-white font-semibold text-sm transition-colors"
            >
              <Code2 className="w-4 h-4" />
              <span>API Key Dashboard</span>
            </Link>
          </div>
        </div>

        <div className="mt-6 p-4 rounded-xl bg-white/5 border border-white/15 flex flex-col sm:flex-row sm:items-center gap-3">
          <label
            htmlFor="api-key-preview-input"
            className="flex items-center gap-2 text-xs font-semibold text-white whitespace-nowrap"
          >
            <Terminal className="w-4 h-4 text-brand-300" />
            <span>cURL Preview Key</span>
          </label>
          <input
            id="api-key-preview-input"
            type="text"
            placeholder="Paste an ec_live_... key to populate cURL snippets locally"
            value={apiKeyInput}
            onChange={(e) => onApiKeyChange(e.target.value)}
            className="flex-1 min-w-0 min-h-[44px] px-3.5 py-2 rounded-md bg-brand-950/80 dark:bg-dark-scaffold border border-white/20 text-base font-mono text-white placeholder:text-white/50 focus:outline-none focus:ring-2 focus:ring-brand-400"
          />
        </div>
      </div>
    </section>
  );
}

export default function ApiDocsPage() {
  const [spec, setSpec] = useState<OpenApiSpec | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedMethod, setSelectedMethod] = useState<string>('all');
  const [expandedEndpoints, setExpandedEndpoints] = useState<Record<string, boolean>>({});
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState('');

  useEffect(() => {
    let active = true;
    async function loadSpec() {
      try {
        setLoading(true);
        const res = await fetch('/api/v1/openapi.json');
        if (!res.ok) {
          throw new Error(`Failed to load OpenAPI spec (${res.status} ${res.statusText})`);
        }
        const data: OpenApiSpec = await res.json();
        if (active) {
          setSpec(data);
        }
      } catch (err: unknown) {
        if (active) {
          setError(err instanceof Error ? err.message : 'Unknown error loading OpenAPI specification');
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }
    loadSpec();
    return () => {
      active = false;
    };
  }, []);

  const toggleEndpoint = (key: string) => {
    setExpandedEndpoints((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const copyToClipboard = (text: string, id: string) => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(text);
      setCopiedKey(id);
      setTimeout(() => setCopiedKey(null), 2000);
    }
  };

  const parsedEndpoints = useMemo<ParsedEndpointItem[]>(() => {
    if (!spec?.paths) return [];
    const list: ParsedEndpointItem[] = [];

    for (const [path, pathItem] of Object.entries(spec.paths)) {
      for (const method of HTTP_METHODS) {
        const operation = pathItem[method];
        if (operation) {
          list.push({
            key: `${method.toUpperCase()}:${path}`,
            path,
            method,
            operation,
          });
        }
      }
    }
    return list;
  }, [spec]);

  const filteredEndpoints = useMemo(() => {
    const query = searchQuery.toLowerCase().trim();
    return parsedEndpoints.filter((item) => {
      const matchMethod = selectedMethod === 'all' || item.method === selectedMethod;
      if (!matchMethod) return false;
      if (!query) return true;

      const matchPath = item.path.toLowerCase().includes(query);
      const matchSummary = item.operation.summary?.toLowerCase().includes(query) ?? false;
      const matchDesc = item.operation.description?.toLowerCase().includes(query) ?? false;
      const matchTags = item.operation.tags?.some((tag) => tag.toLowerCase().includes(query)) ?? false;

      return matchPath || matchSummary || matchDesc || matchTags;
    });
  }, [parsedEndpoints, selectedMethod, searchQuery]);

  return (
    <div className="min-h-screen bg-neutral-scaffold dark:bg-dark-scaffold text-brand-950 dark:text-dark-text flex flex-col transition-colors">
      <Header />

      <main id="main-content" className="flex-1">
        <ApiDocsMasthead spec={spec} apiKeyInput={apiKeyInput} onApiKeyChange={setApiKeyInput} />

        <section className="max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-10">
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
                <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted dark:text-dark-muted pointer-events-none" />
                <input
                  id="endpoint-search-input"
                  type="text"
                  placeholder="Search endpoints (convert, jobs, uploads)..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full min-h-[44px] pl-10 pr-4 py-2 rounded-md bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border text-base text-brand-950 dark:text-white placeholder:text-ink-muted dark:placeholder:text-dark-muted focus:outline-none focus:ring-2 focus:ring-brand-700/40"
                />
              </div>

              <div
                role="group"
                aria-label="Filter endpoints by HTTP method"
                className="flex flex-wrap items-center gap-1.5"
              >
                {FILTER_METHODS.map((method) => {
                  const active = selectedMethod === method;
                  return (
                    <button
                      key={method}
                      type="button"
                      onClick={() => setSelectedMethod(method)}
                      aria-pressed={active}
                      className={`min-h-[44px] px-3.5 py-2 rounded-md text-xs font-bold uppercase tracking-wider transition-colors ${
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
            </div>
          </div>

          {loading && (
            <div
              role="status"
              className="py-16 text-center rounded-xl bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border shadow-sm"
            >
              <div className="inline-block w-7 h-7 border-2 border-brand-700 border-t-transparent rounded-full animate-spin mb-3" />
              <p className="text-ink-secondary dark:text-dark-muted text-sm">
                Loading OpenAPI specification...
              </p>
            </div>
          )}

          {error && (
            <div
              role="alert"
              className="p-5 rounded-xl bg-status-dangerSoft dark:bg-rose-950/30 border border-status-danger/30 dark:border-rose-800/50 text-status-danger dark:text-rose-300 flex items-start gap-3"
            >
              <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
              <div>
                <h3 className="font-semibold text-sm">Failed to Load OpenAPI Specification</h3>
                <p className="text-xs mt-1">{error}</p>
              </div>
            </div>
          )}

          {!loading && !error && (
            <div className="space-y-3">
              {filteredEndpoints.length === 0 ? (
                <div className="py-14 text-center rounded-xl bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border shadow-sm">
                  <FileCode className="w-8 h-8 text-ink-muted dark:text-dark-muted mx-auto mb-2.5" />
                  <p className="text-ink-secondary dark:text-dark-muted text-sm">
                    No matching API endpoints found.
                  </p>
                </div>
              ) : (
                filteredEndpoints.map((endpoint) => (
                  <EndpointCard
                    key={endpoint.key}
                    endpoint={endpoint}
                    isExpanded={Boolean(expandedEndpoints[endpoint.key])}
                    apiKeyInput={apiKeyInput}
                    copiedKey={copiedKey}
                    onToggle={toggleEndpoint}
                    onCopy={copyToClipboard}
                  />
                ))
              )}
            </div>
          )}
        </section>
      </main>

      <Footer />
    </div>
  );
}
