import React from 'react';

export const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export interface OpenApiSchemaObject {
  $id?: string;
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
  allOf?: ReadonlyArray<OpenApiSchemaObject>;
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

function lookupReferencedSchema(
  ref: string,
  schemas: Record<string, OpenApiSchemaObject> | undefined
): OpenApiSchemaObject | undefined {
  if (!schemas) return undefined;
  if (ref.startsWith(COMPONENT_SCHEMA_PREFIX)) {
    return schemas[ref.slice(COMPONENT_SCHEMA_PREFIX.length)];
  }
  return Object.values(schemas).find((candidate) => candidate.$id === ref);
}

function mergeAllOfSchema(
  outer: OpenApiSchemaObject,
  schemas: Record<string, OpenApiSchemaObject> | undefined,
  visited: ReadonlySet<string>
): OpenApiSchemaObject {
  const mergedProperties: Record<string, OpenApiSchemaObject> = {};
  const requiredSet = new Set<string>();
  let resolvedType: OpenApiSchemaObject['type'] = outer.type;
  let resolvedDescription: string | undefined = outer.description;

  for (const subSchema of outer.allOf ?? []) {
    const resolvedSub = dereferenceSchemaInternal(subSchema, schemas, new Set(visited));
    if (!resolvedSub) continue;
    if (resolvedType === undefined && resolvedSub.type !== undefined) resolvedType = resolvedSub.type;
    if (resolvedDescription === undefined && resolvedSub.description !== undefined) {
      resolvedDescription = resolvedSub.description;
    }
    if (resolvedSub.properties) Object.assign(mergedProperties, resolvedSub.properties);
    for (const reqKey of resolvedSub.required ?? []) requiredSet.add(reqKey);
  }

  if (outer.properties) Object.assign(mergedProperties, outer.properties);
  for (const reqKey of outer.required ?? []) requiredSet.add(reqKey);

  const merged: OpenApiSchemaObject = { ...outer };
  delete merged.allOf;
  if (resolvedType !== undefined) merged.type = resolvedType;
  if (resolvedDescription !== undefined) merged.description = resolvedDescription;
  if (Object.keys(mergedProperties).length > 0) merged.properties = mergedProperties;
  if (requiredSet.size > 0) merged.required = [...requiredSet];
  return merged;
}

function dereferenceSchemaInternal(
  schema: OpenApiSchemaObject | undefined,
  schemas: Record<string, OpenApiSchemaObject> | undefined,
  visited: Set<string>
): OpenApiSchemaObject | undefined {
  if (!schema) return undefined;
  let current: OpenApiSchemaObject = schema;
  while (current.$ref) {
    const ref: string = current.$ref;
    if (visited.has(ref)) break;
    const resolved = lookupReferencedSchema(ref, schemas);
    if (!resolved) break;
    visited.add(ref);
    current = resolved;
  }
  if (current !== schema && schema.description && !current.description) {
    current = { ...current, description: schema.description };
  }
  if (current.allOf && current.allOf.length > 0) {
    return mergeAllOfSchema(current, schemas, visited);
  }
  return current;
}

export function dereferenceSchema(
  schema: OpenApiSchemaObject | undefined,
  schemas?: Record<string, OpenApiSchemaObject>
): OpenApiSchemaObject | undefined {
  return dereferenceSchemaInternal(schema, schemas, new Set<string>());
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
