import React from 'react';
import {
  renderInlineCode,
  type OpenApiMediaType,
  type OpenApiOperation,
  type OpenApiParameter,
} from './openapi-types';

function getStatusBadgeClass(statusCode: string): string {
  if (statusCode.startsWith('2')) {
    return 'text-emerald-700 bg-emerald-50 border-emerald-200 dark:text-emerald-300 dark:bg-emerald-500/15 dark:border-emerald-500/30';
  }
  if (statusCode.startsWith('4')) {
    return 'text-amber-800 bg-amber-50 border-amber-200 dark:text-amber-300 dark:bg-amber-500/15 dark:border-amber-500/30';
  }
  return 'text-rose-700 bg-rose-50 border-rose-200 dark:text-rose-300 dark:bg-rose-500/15 dark:border-rose-500/30';
}

export function ParametersTable({ parameters }: Readonly<{ parameters: OpenApiParameter[] }>) {
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

export function RequestBodySection({
  content,
}: Readonly<{ content: Record<string, OpenApiMediaType> }>) {
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
              <div className="text-ink-muted dark:text-dark-muted">
                Binary stream or structured schema payload.
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export function ResponsesGrid({
  responses,
}: Readonly<{ responses: NonNullable<OpenApiOperation['responses']> }>) {
  return (
    <div>
      <h3 className="text-xs font-bold text-ink-secondary dark:text-dark-muted uppercase tracking-wider mb-2">
        Responses
      </h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
        {Object.entries(responses).map(([statusCode, resp]) => (
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
  );
}
