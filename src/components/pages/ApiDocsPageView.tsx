'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import { AlertCircle, FileCode } from 'lucide-react';
import { ApiDocsFilterToolbar, ApiDocsMasthead, ENDPOINTS_HEADING_ID } from '@/components/api-docs/ApiDocsToolbar';
import { EndpointCard } from '@/components/api-docs/EndpointCard';
import {
  HTTP_METHODS,
  type OpenApiSpec,
  type ParsedEndpointItem,
} from '@/components/api-docs/openapi-types';
import { useCopyFeedback } from '@/hooks/useCopyFeedback';
import { warnBrowserFailure } from '@/lib/browser-failure';

export default function ApiDocsPageView() {
  const t = useTranslations('apiDocs.page');
  const [spec, setSpec] = useState<OpenApiSpec | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedMethod, setSelectedMethod] = useState<string>('all');
  const [expandedEndpoints, setExpandedEndpoints] = useState<Record<string, boolean>>({});
  const { copiedKey, copyText } = useCopyFeedback(2000);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const loadingRef = useRef<HTMLOutputElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  const endpointsRef = useRef<HTMLElement>(null);

  // A retry unmounts the button that had focus, and the loading notice unmounts in turn, so focus follows the page's
  // state (the notice, then the button again or the endpoints) only while it rests on the notice or fell to the body; focus
  // the person moved elsewhere, such as the search field, stays where it is.
  useEffect(() => {
    if (attempt === 0) return;
    const focused = document.activeElement;
    if (focused && focused !== document.body && focused !== loadingRef.current) return;
    if (loading) loadingRef.current?.focus();
    else if (failed) retryRef.current?.focus();
    else endpointsRef.current?.focus();
  }, [attempt, loading, failed]);

  useEffect(() => {
    let active = true;
    async function loadSpec() {
      try {
        setLoading(true);
        setFailed(false);
        const res = await fetch('/api/v1/openapi.json');
        if (!res.ok) {
          warnBrowserFailure('Loading the API specification failed', `the server answered ${res.status}`);
          if (active) setFailed(true);
          return;
        }
        const data: OpenApiSpec = await res.json();
        if (active) {
          setSpec(data);
        }
      } catch (error) {
        warnBrowserFailure('Loading the API specification failed', error);
        if (active) setFailed(true);
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
  }, [attempt]);

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
              ref={loadingRef}
              tabIndex={-1}
              aria-live="polite"
              className="block py-16 text-center border-t border-rule"
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

          {failed && (
            <div
              role="alert"
              className="p-5 rounded-md bg-danger-soft border border-danger-edge/30 text-danger flex items-start gap-3"
            >
              <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
              <div>
                <h3 className="font-semibold text-sm">{t('loadFailedHeading')}</h3>
                <p className="text-xs mt-1">{t('loadFailedBody')}</p>
                <button
                  ref={retryRef}
                  type="button" onClick={() => setAttempt((count) => count + 1)}
                  className="mt-3 transition-colors inline-flex items-center justify-center min-h-[44px] px-3.5 rounded-xs border border-danger-edge text-xs font-semibold text-danger hover:bg-danger-soft cursor-pointer"
                >
                  {t('retry')}
                </button>
              </div>
            </div>
          )}

          {!loading && !failed && (
            <section ref={endpointsRef} tabIndex={-1} aria-labelledby={ENDPOINTS_HEADING_ID} className="border-t border-rule">
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
            </section>
          )}
        </section>
      </main>

      <Footer />
    </div>
  );
}
