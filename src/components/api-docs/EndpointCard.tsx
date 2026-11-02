import React from 'react';
import { useTranslations } from 'next-intl';
import { Check, ChevronDown, ChevronRight, Copy, Shield, Terminal } from 'lucide-react';
import { buildCurlSnippet } from './curl-builder';
import { ParametersTable, RequestBodySection, ResponsesGrid } from './EndpointSchemaTables';
import { renderInlineCode, type OpenApiSchemaObject, type ParsedEndpointItem } from './openapi-types';

const METHOD_BADGE_CLASSES: Record<string, string> = {
  get: 'bg-info-soft text-info border-info-edge',
  post: 'bg-success-soft text-success border-success-edge',
  put: 'bg-warning-soft text-warning border-warning-edge',
  patch: 'bg-warning-soft text-warning border-warning-edge',
  delete: 'bg-danger-soft text-danger border-danger-edge',
  options:
    'bg-sunken text-ink border-rule',
  head: 'bg-sunken text-ink border-rule',
};

function getMethodBadgeClass(method: string): string {
  return (
    METHOD_BADGE_CLASSES[method] ??
    'bg-sunken text-ink border-rule'
  );
}

function SecurityBadges({
  security,
}: Readonly<{ security: Array<Record<string, string[]>> }>) {
  const t = useTranslations('apiDocs.endpoint');
  return (
    <div>
      <h3 className="text-xs font-bold text-ink-2 uppercase tracking-wider mb-2 flex items-center gap-1.5">
        <Shield className="w-3.5 h-3.5 text-accent-ink" aria-hidden="true" />
        <span>{t('security')}</span>
      </h3>
      <div className="flex flex-wrap gap-2">
        {security.flatMap((sec) =>
          Object.entries(sec).map(([scheme, scopes]) => (
            <span
              key={scheme}
              className="px-2.5 py-1 rounded-sm bg-sunken border border-rule text-xs font-mono text-ink"
            >
              <strong>{scheme}</strong>
              {scopes.length > 0 && ` (${scopes.join(', ')})`}
            </span>
          ))
        )}
      </div>
    </div>
  );
}

function ExecutableCurlSection({
  method,
  path,
  curlSnippet,
  copyId,
  isCopied,
  onCopy,
}: Readonly<{
  method: string;
  path: string;
  curlSnippet: string;
  copyId: string;
  isCopied: boolean;
  onCopy: (text: string, id: string) => void;
}>) {
  const t = useTranslations('apiDocs.endpoint');
  const upperMethod = method.toUpperCase();
  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-2 mb-2">
        <h3 className="text-xs font-bold text-ink-2 uppercase tracking-wider flex items-center gap-1.5">
          <Terminal className="w-3.5 h-3.5 text-accent-ink" aria-hidden="true" />
          <span>{t('curl')}</span>
        </h3>
        <button
          type="button"
          onClick={() => onCopy(curlSnippet, copyId)}
          aria-label={t('copyLabel', { method: upperMethod, path })}
          className="min-w-[44px] min-h-[44px] inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-sm bg-sunken hover:bg-accent-soft border border-rule text-ink text-xs font-semibold transition-colors"
        >
          {isCopied ? (
            <>
              <Check className="w-3.5 h-3.5 text-success" />
              <span>{t('copied')}</span>
            </>
          ) : (
            <>
              <Copy className="w-3.5 h-3.5" />
              <span>{t('copy')}</span>
            </>
          )}
        </button>
        <output aria-live="polite" className="sr-only">
          {isCopied ? t('copiedAnnouncement', { method: upperMethod, path }) : ''}
        </output>
      </div>
      <pre className="p-3.5 rounded-md border border-rule text-xs font-mono text-ink-3 overflow-x-auto max-w-full leading-relaxed">
        <code>{curlSnippet}</code>
      </pre>
    </div>
  );
}

interface EndpointCardProps {
  endpoint: ParsedEndpointItem;
  isExpanded: boolean;
  apiKeyInput: string;
  serverUrl?: string;
  schemas?: Record<string, OpenApiSchemaObject>;
  runtimeOrigin?: string;
  copiedKey: string | null;
  onToggle: (key: string) => void;
  onCopy: (text: string, id: string) => void;
}

export function EndpointCard({
  endpoint,
  isExpanded,
  apiKeyInput,
  serverUrl,
  schemas,
  runtimeOrigin,
  copiedKey,
  onToggle,
  onCopy,
}: Readonly<EndpointCardProps>) {
  const { key, path, method, operation } = endpoint;
  const curlSnippet = buildCurlSnippet(endpoint, apiKeyInput, serverUrl, { schemas, runtimeOrigin });
  const copyId = `curl-${key}`;
  const panelId = `endpoint-panel-${key.replace(/[^a-zA-Z0-9_-]/g, '-')}`;

  return (
    <div className="border-b border-rule min-w-0">
      <button
        type="button"
        onClick={() => onToggle(key)}
        aria-expanded={isExpanded}
        aria-controls={panelId}
        className="w-full min-h-[52px] px-1 sm:px-2 py-3.5 flex items-center justify-between gap-3 text-left hover:bg-sunken/50 transition-colors"
      >
        <div className="flex flex-wrap sm:flex-nowrap items-center gap-2.5 sm:gap-3.5 min-w-0">
          <span
            className={`px-2.5 py-1 rounded-sm text-xs font-bold uppercase tracking-wider border shrink-0 ${getMethodBadgeClass(
              method
            )}`}
          >
            {method}
          </span>
          <span className="font-mono text-sm sm:text-base font-semibold text-ink break-all sm:truncate">
            {path}
          </span>
          {operation.summary && (
            <span className="hidden md:inline-block text-xs text-ink-2 truncate max-w-md">
              {operation.summary}
            </span>
          )}
        </div>
        <div className="flex items-center shrink-0 text-ink-3">
          {isExpanded ? <ChevronDown className="w-5 h-5" /> : <ChevronRight className="w-5 h-5" />}
        </div>
      </button>

      {isExpanded && (
        <div
          id={panelId}
          className="px-4 sm:px-5 pb-6 pt-4 border-t border-rule space-y-6 min-w-0"
        >
          {operation.summary && (
            <p className="md:hidden text-xs font-semibold text-ink">
              {operation.summary}
            </p>
          )}
          {operation.description && (
            <p className="text-xs sm:text-sm text-ink-2 leading-relaxed">
              {renderInlineCode(operation.description)}
            </p>
          )}
          {Boolean(operation.security?.length) && <SecurityBadges security={operation.security!} />}
          {Boolean(operation.parameters?.length) && (
            <ParametersTable parameters={operation.parameters!} schemas={schemas} />
          )}
          {operation.requestBody?.content && (
            <RequestBodySection content={operation.requestBody.content} schemas={schemas} />
          )}
          <ExecutableCurlSection
            method={method}
            path={path}
            curlSnippet={curlSnippet}
            copyId={copyId}
            isCopied={copiedKey === copyId}
            onCopy={onCopy}
          />
          {operation.responses && <ResponsesGrid responses={operation.responses} />}
        </div>
      )}
    </div>
  );
}
