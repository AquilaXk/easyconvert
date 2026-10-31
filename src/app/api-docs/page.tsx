'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import { AlertCircle, FileCode } from 'lucide-react';
import { ApiDocsFilterToolbar, ApiDocsMasthead } from '@/components/api-docs/ApiDocsToolbar';
import { EndpointCard } from '@/components/api-docs/EndpointCard';
import {
  HTTP_METHODS,
  type OpenApiSpec,
  type ParsedEndpointItem,
} from '@/components/api-docs/openapi-types';

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
          setError(
            err instanceof Error ? err.message : 'Unknown error loading OpenAPI specification'
          );
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }
    void loadSpec();
    return () => {
      active = false;
    };
  }, []);

  const toggleEndpoint = (key: string) => {
    setExpandedEndpoints((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const copyToClipboard = (text: string, id: string) => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      void navigator.clipboard.writeText(text);
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
        if (operation && operation['x-internal'] !== true) {
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

  const availableMethods = useMemo<readonly string[]>(() => {
    const present = HTTP_METHODS.filter((method) =>
      parsedEndpoints.some((item) => item.method === method)
    );
    return ['all', ...(present.length > 0 ? present : ['get', 'post', 'put', 'patch', 'delete'])];
  }, [parsedEndpoints]);

  useEffect(() => {
    if (!availableMethods.includes(selectedMethod)) {
      setSelectedMethod('all');
    }
  }, [availableMethods, selectedMethod]);

  const filteredEndpoints = useMemo(() => {
    const query = searchQuery.toLowerCase().trim();
    return parsedEndpoints.filter((item) => {
      const matchMethod = selectedMethod === 'all' || item.method === selectedMethod;
      if (!matchMethod) return false;
      if (!query) return true;

      const matchPath = item.path.toLowerCase().includes(query);
      const matchSummary = item.operation.summary?.toLowerCase().includes(query) ?? false;
      const matchDesc = item.operation.description?.toLowerCase().includes(query) ?? false;
      const matchTags =
        item.operation.tags?.some((tag) => tag.toLowerCase().includes(query)) ?? false;

      return matchPath || matchSummary || matchDesc || matchTags;
    });
  }, [parsedEndpoints, selectedMethod, searchQuery]);

  const serverUrl = spec?.servers?.[0]?.url;

  return (
    <div className="min-h-screen bg-neutral-scaffold dark:bg-dark-scaffold text-brand-950 dark:text-dark-text flex flex-col transition-colors">
      <Header />

      <main id="main-content" className="flex-1">
        <ApiDocsMasthead spec={spec} apiKeyInput={apiKeyInput} onApiKeyChange={setApiKeyInput} />

        <section className="max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-10">
          <ApiDocsFilterToolbar
            searchQuery={searchQuery}
            selectedMethod={selectedMethod}
            availableMethods={availableMethods}
            onSearchChange={setSearchQuery}
            onSelectMethod={setSelectedMethod}
          />

          {loading && (
            <output
              aria-live="polite"
              className="block py-16 text-center rounded-xl bg-white dark:bg-dark-surface border border-neutral-border dark:border-dark-border shadow-sm"
            >
              <span
                className="inline-block w-7 h-7 border-2 border-brand-700 border-t-transparent rounded-full animate-spin mb-3"
                aria-hidden="true"
              />
              <span className="block text-ink-secondary dark:text-dark-muted text-sm">
                Loading OpenAPI specification...
              </span>
            </output>
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
                    serverUrl={serverUrl}
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
