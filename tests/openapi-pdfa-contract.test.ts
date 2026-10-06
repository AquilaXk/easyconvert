import { beforeAll, describe, expect, it } from 'vitest';
import { GET as getOpenApiSpec } from '../src/app/api/openapi.json/route';

/**
 * The PDF/A 422 problem and the document options are part of the published contract. The
 * expected names and enum values are written here by hand.
 */

const CONVERT_PATHS = ['/api/v1/convert', '/api/convert', '/api/convert/batch'];
const PDFA_PROBLEM_REF = '#/components/schemas/PdfaValidationProblem';
const DOCUMENT_OPTIONS = ['layout', 'imageDpi', 'jpegQuality', 'pdfa'];

type Json = Record<string, any>;
let spec: Json;

beforeAll(async () => {
  spec = await (await getOpenApiSpec()).json();
});

describe('PDF/A validation problem', () => {
  it('extends the problem details with the requested profile and the failed rule IDs', () => {
    const schema = spec.components.schemas.PdfaValidationProblem;

    expect(schema.allOf).toEqual([{ $ref: '#/components/schemas/ProblemDetails' }, expect.any(Object)]);
    const extension = schema.allOf[1];
    expect(extension.required).toEqual(['profile', 'failedRules']);
    expect(extension.properties.profile.enum).toEqual(['pdfa-1b', 'pdfa-2b', 'pdfa-3b']);
    expect(extension.properties.failedRules).toMatchObject({ type: 'array', items: { type: 'string' } });
  });

  it.each(CONVERT_PATHS)('is documented as a 422 of %s', (route) => {
    const response = spec.paths[route].post.responses['422'];

    expect(response.description).toContain('PDF/A');
    expect(response.description).toContain('failedRules');
    expect(JSON.stringify(response.content['application/problem+json'])).toContain(PDFA_PROBLEM_REF);
  });

  it.each(CONVERT_PATHS)('names veraPDF in the 503 of %s', (route) => {
    expect(spec.paths[route].post.responses['503'].description).toContain('veraPDF');
  });
});

describe('document options in the convert request bodies', () => {
  it.each(CONVERT_PATHS)('lists the document options in the options field of %s', (route) => {
    const body = spec.paths[route].post.requestBody.content['multipart/form-data'].schema;
    const options = body.properties.options.description as string;

    for (const name of DOCUMENT_OPTIONS) {
      expect(options).toContain(name);
    }
  });

  it('keeps the options in the ConversionOptions schema, with their ranges', () => {
    const properties = spec.components.schemas.ConversionOptions.properties;

    expect(properties.layout.type).toBe('boolean');
    expect(properties.imageDpi).toMatchObject({ type: 'integer', minimum: 72, maximum: 1200 });
    expect(properties.jpegQuality).toMatchObject({ type: 'integer', minimum: 1, maximum: 100 });
  });
});
