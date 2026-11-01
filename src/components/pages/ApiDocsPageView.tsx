'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
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
import { useCopyFeedback } from '@/hooks/useCopyFeedback';

export default function ApiDocsPageView() {
  const t = useTranslations('apiDocs.page');
  const [spec, setSpec] = useState<OpenApiSpec | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedMethod, setSelectedMethod] = useState<string>('all');
  const [expandedEndpoints, setExpandedEndpoints] = useState<Record<string, boolean>>({});
  const { copiedKey, copyText } = useCopyFeedback(2000);
  const [apiKeyInput, setApiKeyInput] = useState('');

  useEffect(() => {
    let active = true;
    async function loadSpec() {
      try {
        setLoading(true);
        const res = await fetch('/api/v1/openapi.json');
        if (!res.ok) {
          if (active) setError(t('loadFailedStatus', { status: `${res.status} ${res.statusText}`.trim() }));
          return;
        }
        const data: OpenApiSpec = await res.json();
        if (active) {
          setSpec(data);
        }
      } catch {
        if (active) setError(t('loadFailedUnknown'));
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
  }, [t]);

  const toggleEndpoint = (key: string) => {
    setExpandedEndpoints((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const copyToClipboard = (text: string, id: string) => {
    void copyText(text, id);
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
  const schemas = spec?.components?.schemas;
  const runtimeOrigin = typeof window !== 'undefined' ? window.location.origin : undefined;

  return (
    <div className="min-h-screen flex flex-col">
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
              className="block py-16 text-center border-t border-rule-strong"
            >
              <span
                className="inline-block w-7 h-7 border-2 border-accent border-t-transparent rounded-full animate-spin mb-3"
                aria-hidden="true"
              />
              <span className="block text-ink-2 text-sm">
                {t('loading')}
              </span>
            </output>
          )}

          {error && (
            <div
              role="alert"
              className="p-5 rounded-md bg-danger-soft border border-danger-edge/30 text-danger flex items-start gap-3"
            >
              <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
              <div>
                <h3 className="font-semibold text-sm">{t('loadFailedHeading')}</h3>
                <p className="text-xs mt-1">{error}</p>
              </div>
            </div>
          )}

          {!loading && !error && (
            <div className="border-t border-rule-strong">
              {filteredEndpoints.length === 0 ? (
                <div className="py-14 text-center">
                  <FileCode className="w-8 h-8 text-ink-3 mx-auto mb-2.5" />
                  <p className="text-ink-2 text-sm">
                    {t('noMatches')}
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
                    schemas={schemas}
                    runtimeOrigin={runtimeOrigin}
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
