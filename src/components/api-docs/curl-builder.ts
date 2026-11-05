import {
  dereferenceSchema,
  primarySchemaType,
  unwrapPrimarySchema,
  type OpenApiMediaType,
  type OpenApiParameter,
  type OpenApiSchemaObject,
  type ParsedEndpointItem,
} from './openapi-types';

type SchemaMap = Record<string, OpenApiSchemaObject>;

export interface CurlBuildOptions {
  schemas?: SchemaMap;
  runtimeOrigin?: string;
}

const SAMPLE_PROP_VALUES: Record<string, unknown> = {
  sourceUrl: 'https://example.com/sample.docx',
  uploadId: 'upl_01J9EXAMPLE',
  targetFormat: 'pdf',
  webhookUrl: 'https://example.com/webhooks/easyconvert',
  filename: 'document.docx',
  contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  sizeBytes: 1048576,
  totalSize: 1048576,
  etag: 'etag_01J9EXAMPLE',
  storageKey: 'uploads/01J9EXAMPLE/document.docx',
};

const escapeDoubleQuoted = (value: string): string =>
  value.replace(/[\r\n]+/g, ' ').replace(/[\\"$`]/g, String.raw`\$&`);

const escapeSingleQuoted = (value: string): string => value.replaceAll("'", String.raw`'\''`);

function stripTrailingSlashes(input: string): string {
  let end = input.length;
  while (end > 0 && input.codePointAt(end - 1) === 47) {
    end -= 1;
  }
  return end === input.length ? input : input.slice(0, end);
}

function substitutePathParams(
  pathTemplate: string,
  resolveValue: (name: string) => string
): string {
  let result = '';
  let cursor = 0;
  while (cursor < pathTemplate.length) {
    const openIdx = pathTemplate.indexOf('{', cursor);
    if (openIdx === -1) {
      result += pathTemplate.slice(cursor);
      break;
    }
    const closeIdx = pathTemplate.indexOf('}', openIdx + 1);
    if (closeIdx === -1) {
      result += pathTemplate.slice(cursor);
      break;
    }
    result += pathTemplate.slice(cursor, openIdx);
    const paramName = pathTemplate.slice(openIdx + 1, closeIdx);
    result += paramName.length > 0 ? resolveValue(paramName) : '{}';
    cursor = closeIdx + 1;
  }
  return result;
}

export function resolveBaseUrl(serverUrl?: string, runtimeOrigin?: string): string {
  const origin = stripTrailingSlashes(runtimeOrigin?.trim() ?? '');
  const trimmed = serverUrl?.trim();
  if (!trimmed || trimmed === '/') return origin;
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('http://') || lower.startsWith('https://')) {
    return stripTrailingSlashes(trimmed);
  }
  const normalized = stripTrailingSlashes(trimmed);
  return normalized.startsWith('/') ? `${origin}${normalized}` : `${origin}/${normalized}`;
}

function isScalarSample(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function readSchemaExplicitValue(
  schema: OpenApiSchemaObject | undefined
): { found: true; value: unknown } | { found: false } {
  if (!schema) return { found: false };
  for (const candidate of [schema.example, schema.default, schema.const]) {
    if (candidate !== undefined && candidate !== null) return { found: true, value: candidate };
  }
  const nonNullEnum = schema.enum?.find((item) => item !== null);
  if (nonNullEnum !== undefined) return { found: true, value: nonNullEnum };
  return { found: false };
}

function resolveExplicitSample(
  key: string,
  schema: OpenApiSchemaObject | undefined,
  effective: OpenApiSchemaObject | undefined
): { found: true; value: unknown } | { found: false } {
  const outerExplicit = readSchemaExplicitValue(schema);
  if (outerExplicit.found) return outerExplicit;
  const innerExplicit = effective !== schema ? readSchemaExplicitValue(effective) : outerExplicit;
  if (innerExplicit.found) return innerExplicit;
  if (key && Object.hasOwn(SAMPLE_PROP_VALUES, key)) {
    return { found: true, value: SAMPLE_PROP_VALUES[key] };
  }
  return { found: false };
}

function selectPayloadKeys(
  schema: OpenApiSchemaObject,
  properties: Record<string, OpenApiSchemaObject>,
  method?: string
): readonly string[] {
  const requiredKeys = schema.required ?? [];
  if (requiredKeys.length > 0) return requiredKeys;
  if ('uploadId' in properties && 'targetFormat' in properties) {
    return ['uploadId', 'targetFormat'];
  }
  if (method === 'patch') {
    return Object.keys(properties).slice(0, 1);
  }
  return Object.keys(properties).slice(0, 3);
}

function synthesizeObjectPayload(
  schema: OpenApiSchemaObject,
  schemas: SchemaMap | undefined,
  depth: number,
  method?: string
): Record<string, unknown> {
  const properties = schema.properties;
  if (!properties || depth > 4) return {};
  const selectedKeys = selectPayloadKeys(schema, properties, method);
  const payload: Record<string, unknown> = {};
  for (const propKey of selectedKeys) {
    payload[propKey] = synthesizeSchemaValue(propKey, properties[propKey], schemas, depth + 1);
  }
  return payload;
}

function synthesizeArrayItems(
  schema: OpenApiSchemaObject,
  schemas: SchemaMap | undefined,
  depth: number
): unknown[] {
  return schema.items ? [synthesizeSchemaValue('', schema.items, schemas, depth + 1)] : [];
}

function synthesizePrimitiveValue(type: string, schema: OpenApiSchemaObject): unknown {
  if (type === 'integer' || type === 'number') return schema.minimum ?? 1;
  if (type === 'boolean') return true;
  return 'sample';
}

function synthesizeSchemaValue(
  key: string,
  rawSchema: OpenApiSchemaObject | undefined,
  schemas: SchemaMap | undefined,
  depth: number
): unknown {
  const schema = dereferenceSchema(rawSchema, schemas);
  const effective = unwrapPrimarySchema(schema);
  const explicit = resolveExplicitSample(key, schema, effective);
  if (explicit.found) return explicit.value;
  if (!effective) return 'sample';
  const type = primarySchemaType(effective);
  if (type === 'array') return synthesizeArrayItems(effective, schemas, depth);
  if (type === 'object') return synthesizeObjectPayload(effective, schemas, depth);
  return synthesizePrimitiveValue(type, effective);
}

function buildSampleJsonBody(
  media: OpenApiMediaType | undefined,
  schemas: SchemaMap | undefined,
  method?: string
): string {
  const resolved = dereferenceSchema(media?.schema, schemas);
  const effective = unwrapPrimarySchema(resolved);
  const explicit = resolveExplicitSample('', resolved, effective);
  if (explicit.found) return JSON.stringify(explicit.value);
  if (effective && primarySchemaType(effective) === 'array') {
    return JSON.stringify(synthesizeArrayItems(effective, schemas, 0));
  }
  if (!effective?.properties) return JSON.stringify({ targetFormat: 'pdf' });
  return JSON.stringify(synthesizeObjectPayload(effective, schemas, 0, method));
}

function resolveParameterSample(param: OpenApiParameter, schemas: SchemaMap | undefined): string {
  const schema = dereferenceSchema(param.schema, schemas);
  const effective = unwrapPrimarySchema(schema);
  const explicit = resolveExplicitSample(param.name, schema, effective);
  if (explicit.found && isScalarSample(explicit.value)) {
    return String(explicit.value);
  }
  const type = primarySchemaType(effective);
  if (type === 'integer' || type === 'number') return String(effective?.minimum ?? 1);
  if (type === 'boolean') return 'true';
  return `${param.name}_01J9EXAMPLE`;
}

function resolveEndpointUrl(
  baseUrl: string,
  path: string,
  parameters: OpenApiParameter[] | undefined,
  schemas: SchemaMap | undefined
): string {
  const pathParams = new Map<string, OpenApiParameter>();
  const queryParts: string[] = [];
  for (const param of parameters ?? []) {
    if (param.in === 'path') pathParams.set(param.name, param);
    else if (param.in === 'query' && param.required) {
      queryParts.push(`${encodeURIComponent(param.name)}=${encodeURIComponent(resolveParameterSample(param, schemas))}`);
    }
  }
  const resolvedPath = substitutePathParams(path, (name) =>
    encodeURIComponent(resolveParameterSample(pathParams.get(name) ?? { name, in: 'path' }, schemas))
  );
  return queryParts.length > 0 ? `${baseUrl}${resolvedPath}?${queryParts.join('&')}` : `${baseUrl}${resolvedPath}`;
}

function resolveHeaderSample(lowerName: string, schema: OpenApiSchemaObject | undefined): string {
  const effective = unwrapPrimarySchema(schema);
  const explicit = resolveExplicitSample('', schema, effective);
  if (explicit.found && isScalarSample(explicit.value)) {
    return String(explicit.value);
  }
  if (lowerName === 'upload-length') return '1048576';
  if (lowerName === 'upload-offset') return '0';
  const type = primarySchemaType(effective);
  if (type === 'integer' || type === 'number') return String(effective?.minimum ?? 1);
  if (type === 'boolean') return 'true';
  return '1.0.0';
}

function collectHeaderMap(
  parameters: OpenApiParameter[] | undefined,
  schemas: SchemaMap | undefined,
  isTusCreate: boolean
): Map<string, string> {
  const headers = new Map<string, string>();
  for (const param of parameters ?? []) {
    const lower = param.name.toLowerCase();
    if (param.in !== 'header' || (!param.required && lower !== 'tus-resumable')) continue;
    const sample = resolveHeaderSample(lower, dereferenceSchema(param.schema, schemas));
    headers.set(lower, `${escapeDoubleQuoted(param.name)}: ${escapeDoubleQuoted(sample)}`);
  }
  if (isTusCreate) {
    if (!headers.has('tus-resumable')) headers.set('tus-resumable', 'Tus-Resumable: 1.0.0');
    if (!headers.has('upload-length')) headers.set('upload-length', 'Upload-Length: 1048576');
  }
  return headers;
}

function isTusCreationEndpoint(endpoint: ParsedEndpointItem): boolean {
  const trimmedPath = stripTrailingSlashes(endpoint.path);
  if (endpoint.method !== 'post' || !trimmedPath.endsWith('/uploads')) return false;
  const content = endpoint.operation.requestBody?.content;
  return !content || (!content['application/json'] && !content['multipart/form-data']);
}

function formatMultipartValue(propName: string, prop: OpenApiSchemaObject, schemas: SchemaMap | undefined): string {
  const sample = synthesizeSchemaValue(propName, prop, schemas, 1);
  if (typeof sample === 'string') return sample;
  if (isScalarSample(sample)) return String(sample);
  return JSON.stringify(sample);
}

function buildMultipartPropertyFlag(
  propName: string,
  rawProp: OpenApiSchemaObject,
  binaryFile: string,
  requiredSet: ReadonlySet<string>,
  schemas: SchemaMap | undefined
): string | null {
  const prop = dereferenceSchema(rawProp, schemas) ?? rawProp;
  const effectiveProp = unwrapPrimarySchema(prop) ?? prop;
  if (effectiveProp.format === 'binary' || propName === 'file') {
    return `  -F "${escapeDoubleQuoted(propName)}=${binaryFile}"`;
  }
  if (requiredSet.has(propName) || propName === 'targetFormat') {
    const formatted = formatMultipartValue(propName, prop, schemas);
    return `  -F "${escapeDoubleQuoted(propName)}=${escapeDoubleQuoted(formatted)}"`;
  }
  return null;
}

function buildMultipartFlags(media: OpenApiMediaType, path: string, schemas: SchemaMap | undefined): string[] {
  const effective = unwrapPrimarySchema(dereferenceSchema(media.schema, schemas));
  const binaryFile = path.includes('archives') ? '@archive.zip' : '@sample.docx';
  if (!effective?.properties) return [`  -F "file=${binaryFile}"`, '  -F "targetFormat=pdf"'];
  const requiredSet = new Set(effective.required ?? []);
  const flags: string[] = [];
  for (const [propName, rawProp] of Object.entries(effective.properties)) {
    const flag = buildMultipartPropertyFlag(propName, rawProp, binaryFile, requiredSet, schemas);
    if (flag) flags.push(flag);
  }
  return flags.length > 0 ? flags : [`  -F "file=${binaryFile}"`];
}

function appendPayloadFlags(
  lines: string[],
  endpoint: ParsedEndpointItem,
  isTusCreate: boolean,
  schemas: SchemaMap | undefined
): void {
  const content = endpoint.operation.requestBody?.content;
  if (!content) {
    if (endpoint.method === 'put') lines.push('  --upload-file ./part.bin');
    return;
  }
  if (content['multipart/form-data']) {
    lines.push(...buildMultipartFlags(content['multipart/form-data'], endpoint.path, schemas));
  } else if (content['application/json']) {
    lines.push(
      '  -H "Content-Type: application/json"',
      `  -d '${escapeSingleQuoted(buildSampleJsonBody(content['application/json'], schemas, endpoint.method))}'`
    );
  } else if (!isTusCreate && content['application/offset+octet-stream']) {
    lines.push('  -H "Content-Type: application/offset+octet-stream"', '  --data-binary @./chunk.bin');
  } else if (content['application/octet-stream'] || endpoint.method === 'put') {
    if (content['application/octet-stream']) lines.push('  -H "Content-Type: application/octet-stream"');
    lines.push('  --upload-file ./part.bin');
  }
}

function resolveAuthFlag(
  security: Array<Record<string, string[]>> | undefined,
  apiKeyInput: string
): string | null {
  if (Array.isArray(security) && security.length === 0) {
    return null;
  }
  const trimmedKey = apiKeyInput.trim();
  const token = trimmedKey ? escapeDoubleQuoted(trimmedKey) : '$EASYCONVERT_API_KEY';
  return `  -H "Authorization: Bearer ${token}"`;
}

export function buildCurlSnippet(
  endpoint: ParsedEndpointItem,
  apiKeyInput: string,
  serverUrl?: string,
  options?: CurlBuildOptions
): string {
  const { method, path, operation } = endpoint;
  const schemas = options?.schemas;
  const baseUrl = resolveBaseUrl(serverUrl, options?.runtimeOrigin);
  const escapedUrl = escapeDoubleQuoted(resolveEndpointUrl(baseUrl, path, operation.parameters, schemas));
  const lines: string[] = [
    method === 'head' ? `curl -I "${escapedUrl}"` : `curl -X ${method.toUpperCase()} "${escapedUrl}"`,
  ];
  const authFlag = resolveAuthFlag(operation.security, apiKeyInput);
  if (authFlag) lines.push(authFlag);
  const isTusCreate = isTusCreationEndpoint(endpoint);
  const headerMap = collectHeaderMap(operation.parameters, schemas, isTusCreate);
  for (const headerValue of headerMap.values()) {
    lines.push(`  -H "${headerValue}"`);
  }
  if (method !== 'head') appendPayloadFlags(lines, endpoint, isTusCreate, schemas);
  return lines.join(' \\\n');
}
