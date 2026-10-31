import React from 'react';
import { Check, ChevronDown, ChevronRight, Copy, Shield, Terminal } from 'lucide-react';
import {
  renderInlineCode,
  type OpenApiMediaType,
  type OpenApiParameter,
  type ParsedEndpointItem,
} from './openapi-types';

const METHOD_BADGE_CLASSES: Record<string, string> = {
  get: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-500/15 dark:text-blue-300 dark:border-blue-500/30',
  post: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/30',
  put: 'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/30',
  patch: 'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/30',
  delete: 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-500/15 dark:text-rose-300 dark:border-rose-500/30',
};

function getMethodBadgeClass(method: string): string {
  return (
    METHOD_BADGE_CLASSES[method] ??
    'bg-neutral-subtle text-brand-950 border-neutral-border dark:bg-dark-elevated dark:text-dark-text dark:border-dark-border'
  );
}

function getStatusBadgeClass(statusCode: string): string {
  if (statusCode.startsWith('2')) {
    return 'text-emerald-700 bg-emerald-50 border-emerald-200 dark:text-emerald-300 dark:bg-emerald-500/15 dark:border-emerald-500/30';
  }
  if (statusCode.startsWith('4')) {
    return 'text-amber-800 bg-amber-50 border-amber-200 dark:text-amber-300 dark:bg-amber-500/15 dark:border-amber-500/30';
  }
  return 'text-rose-700 bg-rose-50 border-rose-200 dark:text-rose-300 dark:bg-rose-500/15 dark:border-rose-500/30';
}

function buildCurlSnippet(method: string, path: string, apiKeyInput: string): string {
  const effectiveKey = apiKeyInput.trim() || 'YOUR_API_KEY';
  if (method === 'post') {
    return `curl -X POST "https://easyconvert.app${path}" \\\n  -H "Authorization: Bearer ${effectiveKey}" \\\n  -F "file=@sample.docx" \\\n  -F "targetFormat=pdf"`;
  }
  return `curl -X ${method.toUpperCase()} "https://easyconvert.app${path}" \\\n  -H "Authorization: Bearer ${effectiveKey}"`;
}

function ParametersTable({ parameters }: Readonly<{ parameters: OpenApiParameter[] }>) {
  return (
    <div>
      <h3 className="text-xs font-bold text-ink-secondary dark:text-dark-muted uppercase tracking-wider mb-2">
        Parameters
      </h3>
      <div className="rounded-lg border border-neutral-border dark:border-dark-border overflow-x-auto max-w-full">
        <table className="w-full text-left text-xs">
          <thead className="bg-neutral-subtle dark:bg-dark-elevated text-ink-secondary dark:text-dark-muted border-b border-neutral-border dark:border-dark-border">
            <tr>
              <th className="px-4 py-2.5 font-semibold">Name</th>
              <th className="px-4 py-2.5 font-semibold">In</th>
              <th className="px-4 py-2.5 font-semibold">Type</th>
              <th className="px-4 py-2.5 font-semibold">Required</th>
              <th className="px-4 py-2.5 font-semibold">Description</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-border dark:divide-dark-border bg-white dark:bg-dark-surface">
            {parameters.map((param) => (
              <tr key={`${param.in}-${param.name}`}>
                <td className="px-4 py-2.5 font-mono text-brand-700 dark:text-brand-300 font-semibold whitespace-nowrap">
                  {param.name}
                </td>
                <td className="px-4 py-2.5 text-ink-secondary dark:text-dark-muted whitespace-nowrap">
                  {param.in}
                </td>
                <td className="px-4 py-2.5 font-mono text-ink-secondary dark:text-dark-muted whitespace-nowrap">
                  {param.schema?.type || 'string'}
                </td>
                <td className="px-4 py-2.5 whitespace-nowrap">
                  {param.required ? (
                    <span className="text-status-danger dark:text-rose-400 font-bold">Yes</span>
                  ) : (
                    <span className="text-ink-muted dark:text-dark-muted">No</span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-brand-950 dark:text-dark-text min-w-[180px]">
                  {param.description ? renderInlineCode(param.description) : 'Optional parameter'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RequestBodySection({ content }: Readonly<{ content: Record<string, OpenApiMediaType> }>) {
  return (
    <div>
      <h3 className="text-xs font-bold text-ink-secondary dark:text-dark-muted uppercase tracking-wider mb-2">
        Request Body
      </h3>
      <div className="space-y-3">
        {Object.entries(content).map(([contentType, media]) => (
          <div
            key={contentType}
            className="p-3.5 rounded-lg bg-neutral-scaffold dark:bg-dark-scaffold border border-neutral-border dark:border-dark-border text-xs min-w-0"
          >
            <div className="font-mono text-brand-700 dark:text-brand-300 font-semibold mb-2 break-all">
              Content-Type: <code>{contentType}</code>
            </div>
            {media.schema?.properties ? (
              <div className="space-y-1.5 mt-2">
                {Object.entries(media.schema.properties).map(([propName, propDef]) => (
                  <div key={propName} className="flex flex-wrap items-baseline gap-2">
                    <span className="font-mono text-brand-950 dark:text-white font-semibold">
                      {propName}
                      {media.schema?.required?.includes(propName) && (
                        <span className="text-status-danger dark:text-rose-400 ml-0.5">*</span>
                      )}
                    </span>
                    <span className="font-mono text-ink-muted dark:text-dark-muted text-[11px]">
                      [{propDef.type || 'object'}]
                    </span>
                    {propDef.description && (
                      <span className="text-ink-secondary dark:text-dark-muted break-words">
                        {renderInlineCode(propDef.description)}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-ink-muted dark:text-dark-muted">Binary stream or structured schema payload.</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

interface EndpointCardProps {
  endpoint: ParsedEndpointItem;
  isExpanded: boolean;
  apiKeyInput: string;
  copiedKey: string | null;
  onToggle: (key: string) => void;
  onCopy: (text: string, id: string) => void;
}

export function EndpointCard({
  endpoint,
  isExpanded,
  apiKeyInput,
  copiedKey,
  onToggle,
  onCopy,
}: Readonly<EndpointCardProps>) {
  const { key, path, method, operation } = endpoint;
  const curlSnippet = buildCurlSnippet(method, path, apiKeyInput);
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
        className="w-full min-h-[52px] px-4 sm:px-5 py-3.5 flex items-center justify-between gap-3 text-left hover:bg-neutral-subtle/60 dark:hover:bg-dark-elevated/60 transition-colors"
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
                <Shield className="w-3.5 h-3.5 text-brand-700 dark:text-brand-400" />
                Security &amp; Scopes
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
                <Terminal className="w-3.5 h-3.5 text-brand-700 dark:text-brand-400" />
                Executable cURL
              </h3>
              <button
                type="button"
                onClick={() => onCopy(curlSnippet, copyId)}
                aria-label={`Copy cURL command for ${method.toUpperCase()} ${path}`}
                className="min-w-[44px] min-h-[44px] inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-md bg-neutral-subtle dark:bg-dark-elevated hover:bg-brand-50 dark:hover:bg-dark-border border border-neutral-border dark:border-dark-border text-brand-950 dark:text-dark-text text-xs font-semibold transition-colors"
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
            </div>
            <pre className="p-3.5 rounded-lg bg-brand-950 dark:bg-dark-scaffold border border-neutral-border dark:border-dark-border text-xs font-mono text-neutral-subtle overflow-x-auto max-w-full leading-relaxed">
              <code>{curlSnippet}</code>
            </pre>
          </div>

          {operation.responses && (
            <div>
              <h3 className="text-xs font-bold text-ink-secondary dark:text-dark-muted uppercase tracking-wider mb-2">
                Responses
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
                {Object.entries(operation.responses).map(([statusCode, resp]) => (
                  <div
                    key={statusCode}
                    className="p-3 rounded-lg bg-neutral-scaffold dark:bg-dark-scaffold border border-neutral-border dark:border-dark-border flex flex-col justify-between"
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span
                        className={`px-2 py-0.5 rounded text-[11px] font-bold font-mono border ${getStatusBadgeClass(
                          statusCode
                        )}`}
                      >
                        {statusCode}
                      </span>
                    </div>
                    <p className="text-xs text-ink-secondary dark:text-dark-muted">
                      {resp.description ? renderInlineCode(resp.description) : 'Response payload'}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
