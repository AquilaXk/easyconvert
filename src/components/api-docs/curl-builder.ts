import type { OpenApiMediaType, OpenApiParameter, ParsedEndpointItem } from './openapi-types';

const DEFAULT_API_ORIGIN = 'https://api.easyconvert.com';

const SAMPLE_PROP_VALUES: Record<string, unknown> = {
  sourceUrl: 'https://example.com/sample.docx',
  uploadId: 'upl_01J9EXAMPLE',
  targetFormat: 'pdf',
  name: 'Production Worker Key',
  scopes: ['jobs:read', 'jobs:write', 'convert:write'],
  expiresInDays: 90,
  webhookUrl: 'https://example.com/webhooks/easyconvert',
  filename: 'document.docx',
  contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  sizeBytes: 1048576,
};

const TYPE_DEFAULTS: Record<string, unknown> = {
  integer: 1,
  number: 1,
  boolean: true,
  array: [],
  object: {},
};

function resolveBaseUrl(serverUrl?: string): string {
  const normalized = serverUrl?.trim().replace(/\/+$/, '');
  if (!normalized) return DEFAULT_API_ORIGIN;
  return normalized.startsWith('/') ? `${DEFAULT_API_ORIGIN}${normalized}` : normalized;
}

function buildSampleJsonBody(media: OpenApiMediaType | undefined): string {
  const properties = media?.schema?.properties;
  if (!properties) return JSON.stringify({ targetFormat: 'pdf' });
  const requiredKeys = media?.schema?.required ?? [];
  const selectedKeys = requiredKeys.length > 0 ? requiredKeys : Object.keys(properties).slice(0, 3);
  const payload: Record<string, unknown> = {};
  for (const key of selectedKeys) {
    if (Object.hasOwn(SAMPLE_PROP_VALUES, key)) {
      payload[key] = SAMPLE_PROP_VALUES[key];
    } else {
      const propType = properties[key]?.type ?? 'string';
      payload[key] = Object.hasOwn(TYPE_DEFAULTS, propType) ? TYPE_DEFAULTS[propType] : 'sample';
    }
  }
  return JSON.stringify(payload);
}

function collectHeaderMap(parameters: OpenApiParameter[] | undefined): Map<string, string> {
  const headers = new Map<string, string>();
  if (!parameters) return headers;
  for (const param of parameters) {
    const lower = param.name.toLowerCase();
    if (param.in !== 'header' || (!param.required && lower !== 'tus-resumable')) continue;
    let fallback: string | number = '1.0.0';
    if (lower === 'upload-length') fallback = 1048576;
    else if (lower === 'upload-offset') fallback = 0;
    const sample = param.schema?.example ?? param.schema?.default ?? fallback;
    headers.set(lower, `${param.name}: ${String(sample)}`);
  }
  return headers;
}

function appendPayloadFlags(
  lines: string[],
  content: Record<string, OpenApiMediaType> | undefined,
  method: string,
  isTusCreate: boolean
): void {
  if (content?.['multipart/form-data']) {
    lines.push('  -F "file=@sample.docx"', '  -F "targetFormat=pdf"');
  } else if (content?.['application/json']) {
    lines.push('  -H "Content-Type: application/json"', `  -d '${buildSampleJsonBody(content['application/json'])}'`);
  } else if (!isTusCreate && content?.['application/offset+octet-stream']) {
    lines.push('  -H "Content-Type: application/offset+octet-stream"', '  --data-binary @./chunk.bin');
  } else if (content?.['application/octet-stream'] || method === 'put') {
    if (content?.['application/octet-stream']) {
      lines.push('  -H "Content-Type: application/octet-stream"');
    }
    lines.push('  --upload-file ./part.bin');
  }
}

export function buildCurlSnippet(
  endpoint: ParsedEndpointItem,
  apiKeyInput: string,
  serverUrl?: string
): string {
  const { method, path, operation } = endpoint;
  const lines: string[] = [`curl -X ${method.toUpperCase()} "${resolveBaseUrl(serverUrl)}${path}"`];
  const isPublic = Array.isArray(operation.security) && operation.security.length === 0;
  if (!isPublic) {
    lines.push(`  -H "Authorization: Bearer ${apiKeyInput.trim() || 'YOUR_API_KEY'}"`);
  }

  const content = operation.requestBody?.content;
  const isTusCreate =
    method === 'post' && /\/uploads\/?$/.test(path) && !content?.['application/json'] && !content?.['multipart/form-data'];

  const headers = collectHeaderMap(operation.parameters);
  if (isTusCreate) {
    if (!headers.has('tus-resumable')) headers.set('tus-resumable', 'Tus-Resumable: 1.0.0');
    if (!headers.has('upload-length')) headers.set('upload-length', 'Upload-Length: 1048576');
  }
  for (const headerValue of headers.values()) {
    lines.push(`  -H "${headerValue}"`);
  }

  appendPayloadFlags(lines, content, method, isTusCreate);
  return lines.join(' \\\n');
}
