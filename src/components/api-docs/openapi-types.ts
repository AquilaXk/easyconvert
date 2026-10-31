import React from 'react';

export const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export interface OpenApiSchemaObject {
  $id?: string;
  type?: string | readonly string[];
  description?: string;
  format?: string;
  enum?: ReadonlyArray<string | number | boolean | null>;
  const?: string | number | boolean | null;
  example?: unknown;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  items?: OpenApiSchemaObject;
  required?: readonly string[];
  properties?: Record<string, OpenApiSchemaObject>;
  allOf?: ReadonlyArray<OpenApiSchemaObject>;
  oneOf?: ReadonlyArray<OpenApiSchemaObject>;
  anyOf?: ReadonlyArray<OpenApiSchemaObject>;
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

function applyOuterDescription(
  resolved: OpenApiSchemaObject,
  outer: OpenApiSchemaObject
): OpenApiSchemaObject {
  if (resolved === outer || !outer.description || resolved.description) {
    return resolved;
  }
  return { ...resolved, description: outer.description };
}

function followSchemaRef(
  schema: OpenApiSchemaObject,
  schemas: Record<string, OpenApiSchemaObject> | undefined,
  visited: Set<string>
): OpenApiSchemaObject {
  let current = schema;
  while (current.$ref && !visited.has(current.$ref)) {
    const resolved = lookupReferencedSchema(current.$ref, schemas);
    if (!resolved) break;
    visited.add(current.$ref);
    current = resolved;
  }
  return applyOuterDescription(current, schema);
}

function collectSubSchemaInto(
  sub: OpenApiSchemaObject,
  mergedProps: Record<string, OpenApiSchemaObject>,
  requiredSet: Set<string>
): void {
  if (sub.properties) {
    Object.assign(mergedProps, sub.properties);
  }
  for (const reqKey of sub.required ?? []) {
    requiredSet.add(reqKey);
  }
}

function pickFirstDefined<T>(
  initial: T | undefined,
  items: ReadonlyArray<OpenApiSchemaObject>,
  selector: (item: OpenApiSchemaObject) => T | undefined
): T | undefined {
  if (initial !== undefined) return initial;
  for (const item of items) {
    const value = selector(item);
    if (value !== undefined) return value;
  }
  return undefined;
}

function dereferenceSchemaList(
  list: ReadonlyArray<OpenApiSchemaObject>,
  schemas: Record<string, OpenApiSchemaObject> | undefined,
  visited: ReadonlySet<string>
): OpenApiSchemaObject[] {
  return list
    .map((item) => dereferenceSchemaInternal(item, schemas, new Set(visited)))
    .filter((item): item is OpenApiSchemaObject => item !== undefined);
}

function mergeAllOfSchema(
  outer: OpenApiSchemaObject,
  schemas: Record<string, OpenApiSchemaObject> | undefined,
  visited: ReadonlySet<string>
): OpenApiSchemaObject {
  const resolvedSubs = dereferenceSchemaList(outer.allOf ?? [], schemas, visited);
  const mergedProps: Record<string, OpenApiSchemaObject> = {};
  const requiredSet = new Set<string>();
  for (const sub of resolvedSubs) {
    collectSubSchemaInto(sub, mergedProps, requiredSet);
  }
  collectSubSchemaInto(outer, mergedProps, requiredSet);

  const merged: OpenApiSchemaObject = { ...outer };
  delete merged.allOf;
  const resolvedType = pickFirstDefined(outer.type, resolvedSubs, (item) => item.type);
  const resolvedDescription = pickFirstDefined(
    outer.description,
    resolvedSubs,
    (item) => item.description
  );
  if (resolvedType !== undefined) merged.type = resolvedType;
  if (resolvedDescription !== undefined) merged.description = resolvedDescription;
  if (Object.keys(mergedProps).length > 0) merged.properties = mergedProps;
  if (requiredSet.size > 0) merged.required = [...requiredSet];
  return merged;
}

function dereferenceSchemaInternal(
  schema: OpenApiSchemaObject | undefined,
  schemas: Record<string, OpenApiSchemaObject> | undefined,
  visited: Set<string>
): OpenApiSchemaObject | undefined {
  if (!schema) return undefined;
  let current = followSchemaRef(schema, schemas, visited);
  if (current.allOf?.length) {
    current = mergeAllOfSchema(current, schemas, visited);
  }
  if (current.oneOf?.length) {
    current = { ...current, oneOf: dereferenceSchemaList(current.oneOf, schemas, visited) };
  }
  if (current.anyOf?.length) {
    current = { ...current, anyOf: dereferenceSchemaList(current.anyOf, schemas, visited) };
  }
  return current;
}

export function dereferenceSchema(
  schema: OpenApiSchemaObject | undefined,
  schemas?: Record<string, OpenApiSchemaObject>
): OpenApiSchemaObject | undefined {
  return dereferenceSchemaInternal(schema, schemas, new Set<string>());
}

function formatUnionBranchLabel(branch: OpenApiSchemaObject): string {
  const direct = formatSchemaType(branch, '');
  if (direct) return direct;
  if (branch.const !== undefined) return JSON.stringify(branch.const);
  if (branch.properties) return 'object';
  if (branch.items) return 'array';
  return '';
}

function formatUnionType(union: ReadonlyArray<OpenApiSchemaObject>): string {
  const labels = Array.from(
    new Set(union.map(formatUnionBranchLabel).filter((label) => label.length > 0))
  );
  return labels.join(' | ');
}

export function formatSchemaType(
  schema: OpenApiSchemaObject | undefined,
  fallback: string
): string {
  const rawType = schema?.type;
  if (typeof rawType === 'string') return rawType;
  if (Array.isArray(rawType) && rawType.length > 0) return rawType.join(' | ');
  const union = schema?.oneOf ?? schema?.anyOf;
  const unionLabel = union?.length ? formatUnionType(union) : '';
  if (unionLabel) return unionLabel;
  return fallback;
}

function isNullOnlyEnum(values: OpenApiSchemaObject['enum']): boolean {
  return values !== undefined && values.length > 0 && values.every((item) => item === null);
}

function isNullOnlyType(raw: OpenApiSchemaObject['type']): boolean {
  if (raw === 'null') return true;
  return Array.isArray(raw) && raw.length > 0 && raw.every((item) => item === 'null');
}

function resolveExplicitPrimaryType(raw: OpenApiSchemaObject['type']): string | undefined {
  if (typeof raw === 'string') return raw === 'null' ? undefined : raw;
  if (Array.isArray(raw)) return raw.find((item) => item !== 'null');
  return undefined;
}

const MAX_UNION_UNWRAP_STEPS = 8;

function hasConcreteSchemaShape(branch: OpenApiSchemaObject): boolean {
  if (resolveExplicitPrimaryType(branch.type) !== undefined) return true;
  if (branch.const !== undefined && branch.const !== null) return true;
  if (branch.enum?.length && !isNullOnlyEnum(branch.enum)) return true;
  return Boolean(branch.properties || branch.items || branch.oneOf?.length || branch.anyOf?.length);
}

function isNullUnionBranch(branch: OpenApiSchemaObject): boolean {
  if (hasConcreteSchemaShape(branch)) return false;
  return isNullOnlyType(branch.type) || branch.const === null || isNullOnlyEnum(branch.enum);
}

function shouldStopUnionUnwrap(schema: OpenApiSchemaObject): boolean {
  if (schema.items !== undefined) return true;
  if (schema.const !== undefined && schema.const !== null) return true;
  if (schema.enum?.length && !isNullOnlyEnum(schema.enum)) return true;
  return !(schema.oneOf?.length || schema.anyOf?.length);
}

function omitUnionKeywords(schema: OpenApiSchemaObject): OpenApiSchemaObject {
  const copy: OpenApiSchemaObject = { ...schema };
  delete copy.oneOf;
  delete copy.anyOf;
  return copy;
}

function applyMergedObjectFields(
  merged: OpenApiSchemaObject,
  outer: OpenApiSchemaObject,
  branch: OpenApiSchemaObject
): void {
  if (outer.properties || branch.properties) {
    merged.properties = { ...outer.properties, ...branch.properties };
  }
  if (outer.required?.length || branch.required?.length) {
    merged.required = Array.from(new Set([...(outer.required ?? []), ...(branch.required ?? [])]));
  }
}

function clearOuterNullLiterals(
  merged: OpenApiSchemaObject,
  outer: OpenApiSchemaObject,
  branch: OpenApiSchemaObject
): void {
  if (isNullOnlyType(outer.type) && branch.type === undefined) delete merged.type;
  if (outer.const === null && branch.const === undefined) delete merged.const;
  if (isNullOnlyEnum(outer.enum) && !branch.enum) delete merged.enum;
  if (outer.example === null && branch.example === undefined) delete merged.example;
  if (outer.default === null && branch.default === undefined) delete merged.default;
}

function mergeUnionStep(
  outer: OpenApiSchemaObject,
  branch: OpenApiSchemaObject
): OpenApiSchemaObject {
  const outerRest = omitUnionKeywords(outer);
  const merged: OpenApiSchemaObject = { ...outerRest, ...branch };
  if (outerRest.example !== undefined && outerRest.example !== null) {
    merged.example = outerRest.example;
  }
  if (outerRest.default !== undefined && outerRest.default !== null) {
    merged.default = outerRest.default;
  }
  if (branch.type === undefined && outerRest.type !== undefined) merged.type = outerRest.type;
  if (!isNullUnionBranch(branch)) {
    clearOuterNullLiterals(merged, outerRest, branch);
  }
  applyMergedObjectFields(merged, outerRest, branch);
  return merged;
}

function nextUnionPrimaryStep(schema: OpenApiSchemaObject): OpenApiSchemaObject | undefined {
  if (shouldStopUnionUnwrap(schema)) return undefined;
  const union = schema.oneOf ?? schema.anyOf;
  if (!union?.length) return undefined;
  const branch = union.find((item) => !isNullUnionBranch(item)) ?? union[0];
  return branch ? mergeUnionStep(schema, branch) : undefined;
}

export function unwrapPrimarySchema(
  schema: OpenApiSchemaObject | undefined
): OpenApiSchemaObject | undefined {
  let current = schema;
  for (let step = 0; step < MAX_UNION_UNWRAP_STEPS && current; step += 1) {
    const next = nextUnionPrimaryStep(current);
    if (!next) break;
    current = next;
  }
  return current;
}

export function primarySchemaType(schema: OpenApiSchemaObject | undefined): string {
  const effective = unwrapPrimarySchema(schema);
  if (!effective) return 'string';
  const explicit = resolveExplicitPrimaryType(effective.type);
  if (explicit) return explicit;
  if (effective.properties) return 'object';
  if (effective.items) return 'array';
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
