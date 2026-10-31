import React from 'react';

export const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export interface OpenApiParameter {
  name: string;
  in: 'query' | 'path' | 'header';
  required?: boolean;
  description?: string;
  schema?: {
    type?: string;
    example?: string | number | boolean;
    default?: string | number | boolean;
  };
}

export interface OpenApiMediaType {
  schema?: {
    type?: string;
    required?: string[];
    properties?: Record<string, { type?: string; description?: string; format?: string }>;
    $ref?: string;
  };
}

export interface OpenApiOperation {
  summary?: string;
  description?: string;
  operationId?: string;
  tags?: string[];
  'x-internal'?: boolean;
  security?: Array<Record<string, string[]>>;
  parameters?: OpenApiParameter[];
  requestBody?: {
    required?: boolean;
    description?: string;
    content?: Record<string, OpenApiMediaType>;
  };
  responses?: Record<
    string,
    {
      description?: string;
      content?: Record<string, { schema?: Record<string, unknown> }>;
    }
  >;
}

export interface OpenApiSpec {
  openapi: string;
  info: {
    title: string;
    version: string;
    description?: string;
    contact?: { name?: string; url?: string };
    license?: { name?: string; url?: string };
  };
  servers?: Array<{ url: string; description?: string }>;
  paths: Record<string, Record<string, OpenApiOperation>>;
}

export interface ParsedEndpointItem {
  key: string;
  path: string;
  method: HttpMethod;
  operation: OpenApiOperation;
}

export function renderInlineCode(
  text: string,
  codeClassName = 'px-1.5 py-0.5 rounded bg-neutral-subtle dark:bg-dark-elevated font-mono text-xs text-brand-800 dark:text-brand-300'
): React.ReactNode {
  const parts = text.split(/(`[^`]+`)/g);
  const nodes: React.ReactNode[] = [];
  let offset = 0;

  for (const part of parts) {
    const tokenKey = `tok-${offset}`;
    offset += part.length;
    if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
      nodes.push(
        React.createElement('code', { key: tokenKey, className: codeClassName }, part.slice(1, -1))
      );
    } else if (part.length > 0) {
      nodes.push(React.createElement(React.Fragment, { key: tokenKey }, part));
    }
  }

  return nodes;
}
