import { describe, expect, it } from 'vitest';
import { GET as getOpenApiSpec } from '../src/app/api/openapi.json/route';

/**
 * The conversion routes answer a document that decodes past a size limit with HTTP 413
 * (src/app/api/convert/route.ts, batch/route.ts and v1/convert/route.ts), so each operation
 * documents that response with the problem document schema.
 */

const PAYLOAD_TOO_LARGE = '413';
const OPERATIONS: Array<[string, string]> = [
  ['/api/v1/convert', 'post'],
  ['/api/convert', 'post'],
  ['/api/convert/batch', 'post'],
];

describe('413 responses of the conversion routes are documented', () => {
  for (const [route, method] of OPERATIONS) {
    it(`${method.toUpperCase()} ${route} lists 413 as a problem document`, async () => {
      const spec = await (await getOpenApiSpec()).json();
      const response = spec.paths[route][method].responses[PAYLOAD_TOO_LARGE];
      expect(response.description).toMatch(/size limit/);
      expect(Object.keys(response.content)).toContain('application/problem+json');
    });
  }
});
