import { describe, expect, it } from 'vitest';
import { createElement, type ComponentType } from 'react';
import { buildCurlSnippet } from '../src/components/api-docs/curl-builder';
import { RequestBodySection } from '../src/components/api-docs/EndpointSchemaTables';
import {
  dereferenceSchema,
  formatSchemaType,
  primarySchemaType,
  unwrapPrimarySchema,
  type OpenApiOperation,
  type OpenApiSchemaObject,
} from '../src/components/api-docs/openapi-types';
import { buildOpenApiDocument } from '../src/lib/api/openapi';
import { phrasesMissing, renderDom, visibleText } from './helpers/rendered-dom';

const render = <P extends object>(component: ComponentType<P>, props: P) =>
  renderDom(createElement(component, props));

describe('OpenAPI schema resolution, union unwrapping, and cURL synthesis', () => {
  it('synthesizes JSON and binary PUT cURL flags without spurious multipart defaults', () => {
    const jsonPostCurl = buildCurlSnippet(
      {
        key: 'post:/api/v1/jobs',
        method: 'post',
        path: '/api/v1/jobs',
        operation: {
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  properties: { uploadId: { type: 'string' }, targetFormat: { type: 'string' } },
                  required: ['uploadId', 'targetFormat'],
                },
              },
            },
          },
        },
      },
      '',
      'https://api.easyconvert.com'
    );
    expect(jsonPostCurl).toContain('-H "Content-Type: application/json"');
    expect(jsonPostCurl).not.toContain('-F "file=@sample.docx"');
    const jsonFlagPrefix = "  -d '";
    const jsonLine = jsonPostCurl.split(' \\\n').find((line) => line.startsWith(jsonFlagPrefix))!;
    expect(JSON.parse(jsonLine.slice(jsonFlagPrefix.length, -1))).toEqual({
      uploadId: 'upl_01J9EXAMPLE',
      targetFormat: 'pdf',
    });

    const publicPutCurl = buildCurlSnippet(
      {
        key: 'put:/api/v1/uploads/direct/part',
        method: 'put',
        path: '/api/v1/uploads/direct/part',
        operation: {
          security: [],
          requestBody: { content: { 'application/octet-stream': {} } },
        },
      },
      ''
    );
    expect(publicPutCurl.split(' \\\n')).toEqual([
      'curl -X PUT "https://api.easyconvert.com/api/v1/uploads/direct/part"',
      '  -H "Content-Type: application/octet-stream"',
      '  --upload-file ./part.bin',
    ]);
  });

  it('synthesizes accurate OpenAPI 3.1 cURL commands and dereferences $ref request schemas', () => {
    const doc = buildOpenApiDocument();
    const schemas = doc.components.schemas as unknown as Record<string, OpenApiSchemaObject>;

    const headOp = doc.paths['/api/v1/uploads/{id}'].head as unknown as OpenApiOperation;
    const headCurl = buildCurlSnippet(
      { key: 'HEAD:/api/v1/uploads/{id}', method: 'head', path: '/api/v1/uploads/{id}', operation: headOp },
      'ec_live_$SECRET`id`"key\\1',
      '/',
      { schemas, runtimeOrigin: 'https://console.example.com' }
    );
    expect(headCurl).toMatch(/^curl -I "https:\/\/console\.example\.com\/api\/v1\/uploads\/id_01J9EXAMPLE"/);
    expect(headCurl).not.toContain('-X HEAD');
    expect(headCurl).toContain('Authorization: Bearer ec_live_\\$SECRET\\`id\\`\\"key\\\\1');

    const rotateOp = doc.paths['/api/v1/webhooks/secrets/rotate'].post as unknown as OpenApiOperation;
    const rotateSection = render(RequestBodySection, {
      content: rotateOp.requestBody!.content!,
      schemas,
    });
    expect(
      phrasesMissing(visibleText(rotateSection), ['endpointId', 'apiKeyId', 'graceSeconds'])
    ).toEqual([]);

    const rotateCurl = buildCurlSnippet(
      { key: 'POST:/api/v1/webhooks/secrets/rotate', method: 'post', path: '/api/v1/webhooks/secrets/rotate', operation: rotateOp },
      '',
      '/',
      { schemas }
    );
    expect(rotateCurl).toContain('"endpointId":"ep_01J9EXAMPLE"');
    expect(rotateCurl).toContain('"graceSeconds":86400');
    expect(rotateCurl).not.toContain('apiKeyId');

    const resolvedByUriId = dereferenceSchema(
      { $ref: 'https://easyconvert.local/schemas/conversion-options.json' },
      schemas
    );
    expect(resolvedByUriId?.type).toBe('object');
    expect(resolvedByUriId?.properties?.quality).toBeDefined();
    const falseColorProp = dereferenceSchema(resolvedByUriId?.properties?.falseColorSuppression, schemas);
    expect(formatSchemaType(falseColorProp, 'object')).toBe('boolean | number');
    expect(primarySchemaType(falseColorProp)).toBe('boolean');

    const resolvedOneOf = dereferenceSchema(
      { oneOf: [{ $ref: '#/components/schemas/IdempotencyKeyHeader' }, { type: 'number' }] },
      schemas
    );
    expect(resolvedOneOf?.oneOf?.[0]?.type).toBe('string');
    expect(formatSchemaType(resolvedOneOf, 'object')).toBe('string | number');
    expect(primarySchemaType(resolvedOneOf)).toBe('string');

    const resolvedAnyOf = dereferenceSchema(
      { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'string' }] },
      schemas
    );
    expect(formatSchemaType(resolvedAnyOf, 'object')).toBe('string | number');

    const unionBodyDom = render(RequestBodySection, {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: { threshold: { oneOf: [{ type: 'string' }, { type: 'number' }] } },
          },
        },
      },
      schemas,
    });
    expect(visibleText(unionBodyDom)).toContain('[string | number]');
    expect(visibleText(unionBodyDom)).not.toContain('[object]');

    const resolvedPdfaProblem = dereferenceSchema(
      { $ref: '#/components/schemas/PdfaValidationProblem' },
      schemas
    );
    expect(resolvedPdfaProblem?.type).toBe('object');
    expect(resolvedPdfaProblem?.properties?.status).toBeDefined();
    expect(resolvedPdfaProblem?.properties?.detail).toBeDefined();
    expect(resolvedPdfaProblem?.properties?.profile).toBeDefined();
    expect(resolvedPdfaProblem?.properties?.failedRules).toBeDefined();
    expect(resolvedPdfaProblem?.required).toEqual(
      expect.arrayContaining(['type', 'title', 'status', 'detail', 'instance', 'profile', 'failedRules'])
    );

    const patchKeyOp = doc.paths['/api/keys/{id}'].patch as unknown as OpenApiOperation;
    const patchKeyCurl = buildCurlSnippet(
      { key: 'PATCH:/api/keys/{id}', method: 'patch', path: '/api/keys/{id}', operation: patchKeyOp },
      '',
      '/',
      { schemas }
    );
    const patchDataStart = patchKeyCurl.indexOf("-d '");
    expect(patchDataStart).toBeGreaterThan(-1);
    const patchDataEnd = patchKeyCurl.indexOf("'", patchDataStart + 4);
    const patchPayload = JSON.parse(patchKeyCurl.slice(patchDataStart + 4, patchDataEnd)) as Record<string, unknown>;
    expect(Object.keys(patchPayload)).toEqual(['name']);

    const patchCidrCurl = buildCurlSnippet(
      {
        key: 'PATCH:/api/keys/{id}:cidr',
        method: 'patch',
        path: '/api/keys/{id}',
        operation: {
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { allowedIps: { type: 'array', items: { type: 'string' } }, expiresAt: { type: 'number' } },
                },
              },
            },
          },
        },
      },
      '',
      '/',
      { schemas }
    );
    expect(patchCidrCurl).toContain('"allowedIps":["203.0.113.0/24"]');
    expect(patchCidrCurl).not.toContain('expiresAt');

    const jobsOp = doc.paths['/api/v1/jobs'].post as unknown as OpenApiOperation;
    const jobsJsonCurl = buildCurlSnippet(
      {
        key: 'POST:/api/v1/jobs',
        method: 'post',
        path: '/api/v1/jobs',
        operation: {
          ...jobsOp,
          requestBody: { required: true, content: { 'application/json': jobsOp.requestBody!.content!['application/json'] } },
        },
      },
      '',
      '/',
      { schemas }
    );
    expect(jobsJsonCurl).toContain('"uploadId":"upl_01J9EXAMPLE"');
    expect(jobsJsonCurl).toContain('"targetFormat":"pdf"');

    const sessionSecurity = [{ SessionCookie: [] }];
    const sessionMeOp = doc.paths['/api/auth/me'].get as unknown as OpenApiOperation;
    const sessionCurl = buildCurlSnippet(
      { key: 'GET:/api/auth/me', method: 'get', path: '/api/auth/me', operation: sessionMeOp },
      'ec_live_ignored',
      '/',
      { schemas }
    );
    expect(sessionCurl).toContain('-b "easyconvert_session=YOUR_SESSION_COOKIE"');
    expect(sessionCurl).not.toContain('Authorization: Bearer');
    expect(sessionCurl).not.toContain('-H "Origin:');

    const sessionKeysGetCurl = buildCurlSnippet(
      { key: 'GET:/api/v1/account/keys', method: 'get', path: '/api/v1/account/keys', operation: { security: sessionSecurity } },
      '',
      '/',
      { schemas }
    );
    expect(sessionKeysGetCurl).toContain('-b "easyconvert_session=YOUR_SESSION_COOKIE"');
    expect(sessionKeysGetCurl).not.toContain('-H "Origin:');

    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      const mutatingSessionCurl = buildCurlSnippet(
        {
          key: `${method.toUpperCase()}:/api/v1/account/keys/{id}`,
          method,
          path: method === 'post' ? '/api/v1/webhooks/secrets/rotate' : '/api/v1/account/keys/{id}',
          operation: { security: sessionSecurity },
        },
        '',
        'https://console.example.com/v1',
        { schemas }
      );
      expect(mutatingSessionCurl).toContain('-b "easyconvert_session=YOUR_SESSION_COOKIE"');
      expect(mutatingSessionCurl).toContain('-H "Origin: https://console.example.com"');
    }

    const scopesCurl = buildCurlSnippet(
      {
        key: 'POST:/api/keys',
        method: 'post',
        path: '/api/keys',
        operation: {
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['name', 'scopes'],
                  properties: { name: { type: 'string' }, scopes: { type: 'array', items: { type: 'string' } } },
                },
              },
            },
          },
        },
      },
      '',
      'https://api.easyconvert.com',
      { schemas }
    );
    expect(scopesCurl).toContain('"convert:read"');
    expect(scopesCurl).not.toContain('jobs:read');
    expect(scopesCurl).not.toContain('jobs:write');

    const inspectOp = doc.paths['/api/v1/archives/inspect'].post as unknown as OpenApiOperation;
    const inspectCurl = buildCurlSnippet(
      { key: 'POST:/api/v1/archives/inspect', method: 'post', path: '/api/v1/archives/inspect', operation: inspectOp },
      '',
      '/',
      { schemas }
    );
    expect(inspectCurl).toContain('-F "file=@archive.zip"');
    expect(inspectCurl).not.toContain('targetFormat=pdf');

    const convertOp = doc.paths['/api/v1/convert'].post as unknown as OpenApiOperation;
    const convertCurl = buildCurlSnippet(
      { key: 'POST:/api/v1/convert', method: 'post', path: '/api/v1/convert', operation: convertOp },
      '',
      '/',
      { schemas }
    );
    expect(convertCurl).toContain('-F "file=@sample.docx"');
    expect(convertCurl).toContain('-F "targetFormat=pdf"');

    const partOp = doc.paths['/api/v1/uploads/direct/part'].put as unknown as OpenApiOperation;
    const partCurl = buildCurlSnippet(
      { key: 'PUT:/api/v1/uploads/direct/part', method: 'put', path: '/api/v1/uploads/direct/part', operation: partOp },
      '',
      '/',
      { schemas }
    );
    expect(partCurl).toContain(
      '"https://api.easyconvert.com/api/v1/uploads/direct/part?uploadId=upl_01J9EXAMPLE&partNumber=1"'
    );

    const completeOp = doc.paths['/api/v1/uploads/direct/complete'].post as unknown as OpenApiOperation;
    const completeCurl = buildCurlSnippet(
      { key: 'POST:/api/v1/uploads/direct/complete', method: 'post', path: '/api/v1/uploads/direct/complete', operation: completeOp },
      '',
      '/',
      { schemas }
    );
    expect(completeCurl).toContain('"parts":[{"partNumber":1,"etag":"etag_01J9EXAMPLE"}]');

    const credsOp = doc.paths['/api/v1/storage/credentials'].post as unknown as OpenApiOperation;
    const credsCurl = buildCurlSnippet(
      { key: 'POST:/api/v1/storage/credentials', method: 'post', path: '/api/v1/storage/credentials', operation: credsOp },
      '',
      '/',
      { schemas }
    );
    expect(credsCurl).toContain('"providerType":"s3"');
    expect(credsCurl).toContain('"bucket":"my-conversions-bucket"');

    const intOrStr: OpenApiSchemaObject = { oneOf: [{ type: 'integer', minimum: 0 }, { type: 'string' }] };
    const filterUnion: OpenApiSchemaObject = {
      oneOf: [{ type: 'object', required: ['mode'], properties: { mode: { const: 'strict' }, tag: { type: 'string' } } }, { type: 'string' }],
    };
    const unionBodySchema: OpenApiSchemaObject = {
      oneOf: [
        { type: 'object', required: ['filter', 'offset'], properties: { filter: filterUnion, offset: intOrStr } },
        { type: 'object', required: ['fallback'], properties: { fallback: { const: 'other' } } },
      ],
    };
    const unionCurl = buildCurlSnippet(
      {
        key: 'POST:/api/v1/union-check',
        method: 'post',
        path: '/api/v1/union-check',
        operation: {
          parameters: [{ name: 'offset', in: 'query', required: true, schema: intOrStr }],
          requestBody: { content: { 'application/json': { schema: unionBodySchema } } },
        },
      },
      '',
      'https://api.easyconvert.com'
    );
    expect(unionCurl).toContain('?offset=0"');
    expect(unionCurl).toContain('\'{"filter":{"mode":"strict"},"offset":0}\'');
    expect(unionCurl).not.toContain('{"targetFormat":"pdf"}');
    expect(unionCurl).not.toContain('"filter":{}');
  });

  it('unwraps OpenAPI 3.0 and 3.1 nullable, factored object/string, and multi-step nested unions', () => {
    const nullableInt: OpenApiSchemaObject = {
      anyOf: [{ type: 'null' }, { type: 'integer', minimum: 0 }],
    };
    const arrayNullTypeInt: OpenApiSchemaObject = {
      anyOf: [{ type: ['null'] }, { type: 'integer', minimum: 4 }],
    };
    const constNullInt: OpenApiSchemaObject = {
      anyOf: [{ const: null }, { type: 'integer', minimum: 7 }],
    };
    expect(primarySchemaType(nullableInt)).toBe('integer');
    expect(primarySchemaType(arrayNullTypeInt)).toBe('integer');
    expect(primarySchemaType(constNullInt)).toBe('integer');

    const factoredStringUnion: OpenApiSchemaObject = {
      type: 'string',
      oneOf: [{ const: 'strict' }, { const: 'loose' }],
    };
    expect(primarySchemaType(factoredStringUnion)).toBe('string');
    expect(unwrapPrimarySchema(factoredStringUnion)).toMatchObject({
      type: 'string',
      const: 'strict',
    });

    const factoredObjectUnion: OpenApiSchemaObject = {
      type: 'object',
      required: ['version'],
      properties: {
        version: { type: 'integer', const: 2 },
      },
      oneOf: [
        {
          required: ['mode'],
          properties: {
            mode: factoredStringUnion,
            limit: nullableInt,
          },
        },
        {
          required: ['fallback'],
          properties: {
            fallback: { const: 'legacy' },
          },
        },
      ],
    };
    expect(primarySchemaType(factoredObjectUnion)).toBe('object');

    const nestedDefaultSchema: OpenApiSchemaObject = {
      anyOf: [
        { type: 'null' },
        {
          default: 'balanced',
          oneOf: [{ type: 'string' }, { type: 'number' }],
        },
      ],
    };
    const nestedExampleOverridesInnerDefault: OpenApiSchemaObject = {
      example: 'ultra',
      oneOf: [
        {
          default: 'balanced',
          anyOf: [{ type: 'string' }],
        },
      ],
    };
    expect(unwrapPrimarySchema(nestedDefaultSchema)).toMatchObject({
      type: 'string',
      default: 'balanced',
    });
    expect(unwrapPrimarySchema(nestedExampleOverridesInnerDefault)).toMatchObject({
      type: 'string',
      example: 'ultra',
      default: 'balanced',
    });

    const jsonUnionCurl = buildCurlSnippet(
      {
        key: 'POST:/api/v1/factored-union',
        method: 'post',
        path: '/api/v1/factored-union',
        operation: {
          parameters: [
            { name: 'offset', in: 'query', required: true, schema: nullableInt },
            { name: 'policy', in: 'query', required: true, schema: factoredStringUnion },
            { name: 'profile', in: 'query', required: true, schema: nestedDefaultSchema },
          ],
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  oneOf: [
                    {
                      required: ['mode', 'offset', 'profile', 'preset'],
                      properties: {
                        mode: factoredStringUnion,
                        offset: nullableInt,
                        profile: nestedDefaultSchema,
                        preset: nestedExampleOverridesInnerDefault,
                      },
                    },
                    {
                      required: ['fallback'],
                      properties: { fallback: { const: 'other' } },
                    },
                  ],
                },
              },
            },
          },
        },
      },
      '',
      'https://api.easyconvert.com'
    );
    expect(jsonUnionCurl).toContain('?offset=0&policy=strict&profile=balanced"');
    expect(jsonUnionCurl).toContain(
      '\'{"mode":"strict","offset":0,"profile":"balanced","preset":"ultra"}\''
    );
    expect(jsonUnionCurl).not.toContain('{"targetFormat":"pdf"}');

    const mergedObjectCurl = buildCurlSnippet(
      {
        key: 'POST:/api/v1/merged-object-union',
        method: 'post',
        path: '/api/v1/merged-object-union',
        operation: {
          requestBody: {
            content: {
              'application/json': {
                schema: factoredObjectUnion,
              },
            },
          },
        },
      },
      '',
      'https://api.easyconvert.com'
    );
    expect(mergedObjectCurl).toContain('\'{"version":2,"mode":"strict"}\'');

    const multipartUnionCurl = buildCurlSnippet(
      {
        key: 'POST:/api/v1/convert-union',
        method: 'post',
        path: '/api/v1/convert-union',
        operation: {
          requestBody: {
            content: {
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  required: ['file'],
                  properties: {
                    file: { type: 'string', format: 'binary' },
                  },
                  oneOf: [
                    {
                      required: ['mode'],
                      properties: {
                        mode: { const: 'strict' },
                      },
                    },
                    {
                      required: ['mode'],
                      properties: {
                        mode: { const: 'loose' },
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      },
      '',
      'https://api.easyconvert.com'
    );
    expect(multipartUnionCurl).toContain('-F "file=@sample.docx"');
    expect(multipartUnionCurl).toContain('-F "mode=strict"');
    expect(multipartUnionCurl).not.toContain('targetFormat=pdf');

    const outerNullWrapped: OpenApiSchemaObject = {
      default: null,
      example: null,
      const: null,
      enum: [null],
      anyOf: [
        { type: 'null' },
        { type: 'string', default: 'balanced', example: 'turbo' },
      ],
    };
    expect(unwrapPrimarySchema(outerNullWrapped)).toMatchObject({
      type: 'string',
      default: 'balanced',
      example: 'turbo',
    });
    expect(unwrapPrimarySchema(outerNullWrapped)?.const).toBeUndefined();
    expect(unwrapPrimarySchema(outerNullWrapped)?.enum).toBeUndefined();

    const enumNullInt: OpenApiSchemaObject = {
      oneOf: [{ enum: [null] }, { type: 'integer', minimum: 5 }],
    };
    expect(primarySchemaType(enumNullInt)).toBe('integer');
    expect(unwrapPrimarySchema(enumNullInt)).toMatchObject({ type: 'integer', minimum: 5 });

    const nullTypeWithProps: OpenApiSchemaObject = {
      type: ['null'],
      properties: { a: { type: 'string' } },
    };
    expect(primarySchemaType(nullTypeWithProps)).toBe('object');

    const nullLiteralsCurl = buildCurlSnippet(
      {
        key: 'POST:/api/v1/null-literals-check',
        method: 'post',
        path: '/api/v1/null-literals-check',
        operation: {
          parameters: [{ name: 'minCount', in: 'query', required: true, schema: enumNullInt }],
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['preset', 'count', 'nested'],
                  properties: {
                    preset: outerNullWrapped,
                    count: enumNullInt,
                    nested: { ...nullTypeWithProps, required: ['a'] },
                  },
                },
              },
            },
          },
        },
      },
      '',
      'https://api.easyconvert.com'
    );
    expect(nullLiteralsCurl).toContain('?minCount=5"');
    expect(nullLiteralsCurl).toContain('\'{"preset":"turbo","count":5,"nested":{"a":"sample"}}\'');
  });
});
