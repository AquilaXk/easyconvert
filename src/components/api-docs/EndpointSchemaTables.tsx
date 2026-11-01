import React from 'react';
import {
  dereferenceSchema,
  formatSchemaType,
  renderInlineCode,
  type OpenApiMediaType,
  type OpenApiOperation,
  type OpenApiParameter,
  type OpenApiSchemaObject,
} from './openapi-types';

function getStatusBadgeClass(statusCode: string): string {
  if (statusCode.startsWith('2')) {
    return 'text-success bg-success-soft border-success-edge';
  }
  if (statusCode.startsWith('4')) {
    return 'text-warning bg-warning-soft border-warning-edge';
  }
  return 'text-danger bg-danger-soft border-danger-edge';
}

export function ParametersTable({
  parameters,
  schemas,
}: Readonly<{
  parameters: OpenApiParameter[];
  schemas?: Record<string, OpenApiSchemaObject>;
}>) {
  return (
    <div>
      <h3 className="text-xs font-bold text-ink-2 uppercase tracking-wider mb-2">
        Parameters
      </h3>
      <div className="rounded-md border border-rule overflow-x-auto max-w-full">
        <table className="w-full text-left text-xs">
          <thead className="bg-sunken text-ink-2 border-b border-rule">
            <tr>
              <th className="px-4 py-2.5 font-semibold">Name</th>
              <th className="px-4 py-2.5 font-semibold">In</th>
              <th className="px-4 py-2.5 font-semibold">Type</th>
              <th className="px-4 py-2.5 font-semibold">Required</th>
              <th className="px-4 py-2.5 font-semibold">Description</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-rule bg-surface">
            {parameters.map((param) => {
              const resolvedSchema = dereferenceSchema(param.schema, schemas);
              const description = param.description ?? resolvedSchema?.description;
              return (
                <tr key={`${param.in}-${param.name}`}>
                  <td className="px-4 py-2.5 font-mono text-accent-ink font-semibold whitespace-nowrap">
                    {param.name}
                  </td>
                  <td className="px-4 py-2.5 text-ink-2 whitespace-nowrap">
                    {param.in}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-ink-2 whitespace-nowrap">
                    {formatSchemaType(resolvedSchema, 'string')}
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    {param.required ? (
                      <span className="text-danger font-bold">Yes</span>
                    ) : (
                      <span className="text-ink-3">No</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-ink min-w-[180px]">
                    {description ? renderInlineCode(description) : 'Optional parameter'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function RequestBodySection({
  content,
  schemas,
}: Readonly<{
  content: Record<string, OpenApiMediaType>;
  schemas?: Record<string, OpenApiSchemaObject>;
}>) {
  return (
    <div>
      <h3 className="text-xs font-bold text-ink-2 uppercase tracking-wider mb-2">
        Request Body
      </h3>
      <div className="space-y-3">
        {Object.entries(content).map(([contentType, media]) => {
          const resolvedSchema = dereferenceSchema(media.schema, schemas);
          return (
            <div
              key={contentType}
              className="p-3.5 rounded-md border border-rule text-xs min-w-0"
            >
              <div className="font-mono text-accent-ink font-semibold mb-2 break-all">
                Content-Type: <code>{contentType}</code>
              </div>
              {resolvedSchema?.properties ? (
                <div className="space-y-1.5 mt-2">
                  {Object.entries(resolvedSchema.properties).map(([propName, propDef]) => {
                    const resolvedProp = dereferenceSchema(propDef, schemas) ?? propDef;
                    const description = propDef.description ?? resolvedProp.description;
                    return (
                      <div key={propName} className="flex flex-wrap items-baseline gap-2">
                        <span className="font-mono text-ink font-semibold">
                          {propName}
                          {resolvedSchema.required?.includes(propName) && (
                            <span className="text-danger ml-0.5">*</span>
                          )}
                        </span>
                        <span className="font-mono text-ink-3 text-[11px]">
                          [{formatSchemaType(resolvedProp, 'object')}]
                        </span>
                        {description && (
                          <span className="text-ink-2 break-words">
                            {renderInlineCode(description)}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="text-ink-3">
                  Binary stream or structured schema payload.
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function ResponsesGrid({
  responses,
}: Readonly<{ responses: NonNullable<OpenApiOperation['responses']> }>) {
  return (
    <div>
      <h3 className="text-xs font-bold text-ink-2 uppercase tracking-wider mb-2">
        Responses
      </h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
        {Object.entries(responses).map(([statusCode, resp]) => (
          <div
            key={statusCode}
            className="p-3 rounded-md border border-rule flex flex-col justify-between"
          >
            <div className="flex items-center gap-2 mb-1">
              <span
                className={`px-2 py-0.5 rounded-md text-[11px] font-bold font-mono border ${getStatusBadgeClass(
                  statusCode
                )}`}
              >
                {statusCode}
              </span>
            </div>
            <p className="text-xs text-ink-2">
              {resp.description ? renderInlineCode(resp.description) : 'Response payload'}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
