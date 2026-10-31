import React from 'react';

export const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export interface OpenApiSchemaObject {
  type?: string | readonly string[];
  description?: string;
  format?: string;
  enum?: ReadonlyArray<string | number | boolean>;
  const?: string | number | boolean;
  example?: unknown;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  items?: OpenApiSchemaObject;
  required?: readonly string[];
  properties?: Record<string, OpenApiSchemaObject>;
  $ref?: string;
}

export interface OpenApiParameter {
  name: string;
  in: 'query' | 'path' | 'header';
  required?: boolean;
  description?: string;
  schema?: OpenApiSchemaObject;
}

export interface OpenApiMediaType {
  schema?: OpenApiSchemaObject;
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
  components?: {
    schemas?: Record<string, OpenApiSchemaObject>;
  };
  paths: Record<string, Record<string, OpenApiOperation>>;
}

const COMPONENT_SCHEMA_PREFIX = '#/components/schemas/';

export function dereferenceSchema(
  schema: OpenApiSchemaObject | undefined,
  schemas?: Record<string, OpenApiSchemaObject>
): OpenApiSchemaObject | undefined {
  if (!schema) return undefined;
  let current: OpenApiSchemaObject | undefined = schema;
  const visited = new Set<string>();
  while (current?.$ref) {
    const ref: string = current.$ref;
    if (!ref.startsWith(COMPONENT_SCHEMA_PREFIX) || visited.has(ref)) {
      break;
    }
    visited.add(ref);
    const resolved: OpenApiSchemaObject | undefined = schemas?.[ref.slice(COMPONENT_SCHEMA_PREFIX.length)];
    if (!resolved) break;
    current = resolved;
  }
  return current;
}

export function formatSchemaType(
  schema: OpenApiSchemaObject | undefined,
  fallback: string
): string {
  const rawType = schema?.type;
  if (typeof rawType === 'string') return rawType;
  if (Array.isArray(rawType) && rawType.length > 0) return rawType.join(' | ');
  return fallback;
}

export function primarySchemaType(schema: OpenApiSchemaObject | undefined): string {
  if (!schema) return 'string';
  const raw = schema.type;
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return raw.find((item) => item !== 'null') ?? 'string';
  if (schema.properties) return 'object';
  if (schema.items) return 'array';
  return 'string';
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
