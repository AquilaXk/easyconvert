import { buildOpenApiDocument } from '@/lib/api/openapi';
import { buildCurlSnippet } from './curl-builder';
import {
  dereferenceSchema,
  formatSchemaType,
  primarySchemaType,
  unwrapPrimarySchema,
  type OpenApiOperation,
  type OpenApiParameter,
  type OpenApiSchemaObject,
  type OpenApiSpec,
} from './openapi-types';
import type { ApiDocAnchor, ApiDocOperationRef } from './topics';

type SchemaMap = Record<string, OpenApiSchemaObject>;

export interface DocField {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
  readonly location?: OpenApiParameter['in'];
  readonly description?: string;
  readonly children: readonly DocField[];
}

export interface DocBody {
  readonly mediaType: string;
  readonly fields: readonly DocField[];
}

export interface DocResponse {
  readonly status: string;
  readonly description?: string;
  readonly headers: readonly DocField[];
  readonly bodies: readonly DocBody[];
}

export type DocAccess = { readonly kind: 'public' } | { readonly kind: 'key' | 'optionalKey'; readonly scopes: readonly string[] };

export type DocOperationRef = ApiDocOperationRef & { readonly anchor: ApiDocAnchor };

export interface DocOperation extends DocOperationRef {
  readonly access: DocAccess;
  readonly parameters: readonly DocField[];
  readonly requestBodies: readonly DocBody[];
  readonly responses: readonly DocResponse[];
  readonly errors: readonly { readonly status: string; readonly description: string }[];
  readonly curl: string;
}

const MAX_FIELD_DEPTH = 4;

function getOpenApiContext(): { spec: OpenApiSpec; schemas: SchemaMap } {
  const spec = buildOpenApiDocument() as unknown as OpenApiSpec;
  const schemas: SchemaMap = spec.components?.schemas ?? {};
  return { spec, schemas };
}

function objectShape(schema: OpenApiSchemaObject | undefined, schemas: SchemaMap): OpenApiSchemaObject | undefined {
  const effective = unwrapPrimarySchema(dereferenceSchema(schema, schemas));
  if (!effective) return undefined;
  if (effective.properties) return effective;
  if (primarySchemaType(effective) === 'array') {
    const items = unwrapPrimarySchema(dereferenceSchema(effective.items, schemas));
    return items?.properties ? items : undefined;
  }
  if (effective.additionalProperties && typeof effective.additionalProperties === 'object') {
    const valueShape = unwrapPrimarySchema(dereferenceSchema(effective.additionalProperties, schemas));
    return valueShape?.properties ? valueShape : undefined;
  }
  return undefined;
}

export function schemaFields(schema: OpenApiSchemaObject | undefined, depth = 0, schemas?: SchemaMap): DocField[] {
  const effectiveSchemas = schemas ?? getOpenApiContext().schemas;
  const shape = objectShape(schema, effectiveSchemas);
  if (!shape?.properties || depth >= MAX_FIELD_DEPTH) return [];
  const required = new Set(shape.required ?? []);
  return Object.entries(shape.properties).map(([name, raw]) => {
    const resolved = dereferenceSchema(raw, effectiveSchemas) ?? raw;
    return {
      name,
      type: typeLabel(resolved),
      required: required.has(name),
      description: raw.description ?? resolved.description,
      children: schemaFields(resolved, depth + 1, effectiveSchemas),
    };
  });
}

function typeLabel(schema: OpenApiSchemaObject | undefined): string {
  return schema?.format === 'binary' ? 'binary' : formatSchemaType(schema, primarySchemaType(schema));
}

function isBinaryMedia(schema: OpenApiSchemaObject | undefined, schemas: SchemaMap): boolean {
  return unwrapPrimarySchema(dereferenceSchema(schema, schemas))?.format === 'binary';
}

function parameterField(param: OpenApiParameter, schemas: SchemaMap): DocField {
  const resolved = dereferenceSchema(param.schema, schemas);
  return {
    name: param.name,
    type: typeLabel(resolved),
    required: Boolean(param.required),
    location: param.in,
    description: param.description ?? resolved?.description,
    children: [],
  };
}

function bodiesOf(content: Record<string, { schema?: OpenApiSchemaObject }> | undefined, schemas: SchemaMap): DocBody[] {
  return Object.entries(content ?? {})
    .filter(([mediaType]) => mediaType !== 'application/problem+json')
    .flatMap(([mediaType, media]) => {
      const fields = schemaFields(media.schema, 0, schemas);
      return fields.length > 0 || isBinaryMedia(media.schema, schemas) ? [{ mediaType, fields }] : [];
    });
}

function accessOf(security: OpenApiOperation['security'], spec: OpenApiSpec): DocAccess {
  const requirements = security ?? spec.security ?? [];
  if (requirements.length === 0) return { kind: 'public' };
  const scopes = requirements.find((requirement) => 'ApiKeyAuth' in requirement)?.ApiKeyAuth ?? [];
  const optional = requirements.some((requirement) => Object.keys(requirement).length === 0);
  return { kind: optional ? 'optionalKey' : 'key', scopes };
}

const isSuccess = (status: string) => status.startsWith('2');

function documentedOperation(ref: ApiDocOperationRef, spec: OpenApiSpec): OpenApiOperation {
  const operation = spec.paths[ref.path]?.[ref.method];
  if (!operation || operation['x-internal'] === true) {
    throw new Error(`The API documentation names ${ref.method.toUpperCase()} ${ref.path}, which the OpenAPI document does not publish`);
  }
  return operation;
}

export function docOperation(ref: DocOperationRef, origin: string): DocOperation {
  const { spec, schemas } = getOpenApiContext();
  const operation = documentedOperation(ref, spec);
  const responses = Object.entries(operation.responses ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return {
    ...ref,
    access: accessOf(operation.security, spec),
    parameters: (operation.parameters ?? []).map((p) => parameterField(p, schemas)),
    requestBodies: bodiesOf(operation.requestBody?.content, schemas),
    responses: responses
      .filter(([status]) => isSuccess(status))
      .map(([status, response]) => ({
        status,
        description: response.description,
        headers: Object.entries(response.headers ?? {}).map(([name, header]) => ({
          name,
          type: formatSchemaType(header.schema, 'string'),
          required: false,
          location: 'header',
          description: header.description ?? header.schema?.description,
          children: [],
        })),
        bodies: bodiesOf(response.content, schemas),
      })),
    errors: responses
      .filter(([status]) => !isSuccess(status))
      .map(([status, response]) => ({ status, description: response.description ?? '' })),
    curl: buildCurlSnippet({ key: `${ref.method}:${ref.path}`, ...ref, operation }, '', undefined, {
      schemas,
      runtimeOrigin: origin,
    }),
  };
}

export function problemDetailsFields(): DocField[] {
  return schemaFields({ $ref: '#/components/schemas/ProblemDetails' });
}

