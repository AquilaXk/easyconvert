import React from 'react';
import { Check, ChevronDown, ChevronRight, Copy, Shield, Terminal } from 'lucide-react';
import { buildCurlSnippet } from './curl-builder';
import { ParametersTable, RequestBodySection, ResponsesGrid } from './EndpointSchemaTables';
import { renderInlineCode, type ParsedEndpointItem } from './openapi-types';

const METHOD_BADGE_CLASSES: Record<string, string> = {
  get: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-500/15 dark:text-blue-300 dark:border-blue-500/30',
  post: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/30',
  put: 'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/30',
  patch: 'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/30',
  delete: 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-500/15 dark:text-rose-300 dark:border-rose-500/30',
  options:
    'bg-neutral-subtle text-brand-950 border-neutral-border dark:bg-dark-elevated dark:text-dark-text dark:border-dark-border',
  head: 'bg-neutral-subtle text-brand-950 border-neutral-border dark:bg-dark-elevated dark:text-dark-text dark:border-dark-border',
};

function getMethodBadgeClass(method: string): string {
  return (
    METHOD_BADGE_CLASSES[method] ??
    'bg-neutral-subtle text-brand-950 border-neutral-border dark:bg-dark-elevated dark:text-dark-text dark:border-dark-border'
  );
}

interface EndpointCardProps {
  endpoint: ParsedEndpointItem;
  isExpanded: boolean;
  apiKeyInput: string;
  serverUrl?: string;
  copiedKey: string | null;
  onToggle: (key: string) => void;
  onCopy: (text: string, id: string) => void;
}

export function EndpointCard({
  endpoint,
  isExpanded,
  apiKeyInput,
  serverUrl,
  copiedKey,
  onToggle,
  onCopy,
}: Readonly<EndpointCardProps>) {
  const { key, path, method, operation } = endpoint;
  const curlSnippet = buildCurlSnippet(endpoint, apiKeyInput, serverUrl);
  const copyId = `curl-${key}`;
  const isCopied = copiedKey === copyId;
  const panelId = `endpoint-panel-${key.replace(/[^a-zA-Z0-9_-]/g, '-')}`;

  return (
    <div className="rounded-xl border border-neutral-border dark:border-dark-border bg-white dark:bg-dark-surface shadow-sm overflow-hidden min-w-0">
      <button
        type="button"
        onClick={() => onToggle(key)}
        aria-expanded={isExpanded}
        aria-controls={panelId}
        className="w-full min-h-[52px] px-4 sm:px-5 py-3.5 flex items-center justify-between gap-3 text-left hover:bg-neutral-subtle/60 dark:hover:bg-dark-elevated/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-700 transition-colors"
      >
        <div className="flex flex-wrap sm:flex-nowrap items-center gap-2.5 sm:gap-3.5 min-w-0">
          <span
            className={`px-2.5 py-1 rounded-md text-xs font-bold uppercase tracking-wider border shrink-0 ${getMethodBadgeClass(
              method
            )}`}
          >
            {method}
          </span>
          <span className="font-mono text-sm sm:text-base font-semibold text-brand-950 dark:text-white break-all sm:truncate">
            {path}
          </span>
          {operation.summary && (
            <span className="hidden md:inline-block text-xs text-ink-secondary dark:text-dark-muted truncate max-w-md">
              {operation.summary}
            </span>
          )}
        </div>
        <div className="flex items-center shrink-0 text-ink-muted dark:text-dark-muted">
          {isExpanded ? <ChevronDown className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
        </div>
      </button>

      {isExpanded && (
        <div
          id={panelId}
          className="px-4 sm:px-5 pb-6 pt-4 border-t border-neutral-border dark:border-dark-border space-y-6 min-w-0"
        >
          {operation.summary && (
            <p className="md:hidden text-xs font-semibold text-brand-950 dark:text-white">
              {operation.summary}
            </p>
          )}

          {operation.description && (
            <p className="text-xs sm:text-sm text-ink-secondary dark:text-dark-muted leading-relaxed">
              {renderInlineCode(operation.description)}
            </p>
          )}

          {operation.security && operation.security.length > 0 && (
            <div>
              <h3 className="text-xs font-bold text-ink-secondary dark:text-dark-muted uppercase tracking-wider mb-2 flex items-center gap-1.5">
                <Shield className="w-3.5 h-3.5 text-brand-700 dark:text-brand-400" aria-hidden="true" />
                <span>Security &amp; Scopes</span>
              </h3>
              <div className="flex flex-wrap gap-2">
                {operation.security.flatMap((sec) =>
                  Object.entries(sec).map(([scheme, scopes]) => (
                    <span
                      key={scheme}
                      className="px-2.5 py-1 rounded-md bg-neutral-subtle dark:bg-dark-elevated border border-neutral-border dark:border-dark-border text-xs font-mono text-brand-950 dark:text-dark-text"
                    >
                      <strong>{scheme}</strong>
                      {scopes.length > 0 && ` (${scopes.join(', ')})`}
                    </span>
                  ))
                )}
              </div>
            </div>
          )}

          {operation.parameters && operation.parameters.length > 0 && (
            <ParametersTable parameters={operation.parameters} />
          )}

          {operation.requestBody?.content && (
            <RequestBodySection content={operation.requestBody.content} />
          )}

          <div className="min-w-0">
            <div className="flex items-center justify-between gap-2 mb-2">
              <h3 className="text-xs font-bold text-ink-secondary dark:text-dark-muted uppercase tracking-wider flex items-center gap-1.5">
                <Terminal className="w-3.5 h-3.5 text-brand-700 dark:text-brand-400" aria-hidden="true" />
                <span>Executable cURL</span>
              </h3>
              <button
                type="button"
                onClick={() => onCopy(curlSnippet, copyId)}
                aria-label={`Copy cURL command for ${method.toUpperCase()} ${path}`}
                className="min-w-[44px] min-h-[44px] inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-md bg-neutral-subtle dark:bg-dark-elevated hover:bg-brand-50 dark:hover:bg-dark-border border border-neutral-border dark:border-dark-border text-brand-950 dark:text-dark-text text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700 transition-colors"
              >
                {isCopied ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-status-success dark:text-emerald-400" />
                    <span>Copied</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    <span>Copy cURL</span>
                  </>
                )}
              </button>
              <output aria-live="polite" className="sr-only">
                {isCopied ? `Copied cURL command for ${method.toUpperCase()} ${path}` : ''}
              </output>
            </div>
            <pre className="p-3.5 rounded-lg bg-brand-950 dark:bg-dark-scaffold border border-neutral-border dark:border-dark-border text-xs font-mono text-neutral-subtle overflow-x-auto max-w-full leading-relaxed">
              <code>{curlSnippet}</code>
            </pre>
          </div>

          {operation.responses && <ResponsesGrid responses={operation.responses} />}
        </div>
      )}
    </div>
  );
}
