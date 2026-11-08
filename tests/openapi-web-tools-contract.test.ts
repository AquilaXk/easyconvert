import { describe, expect, it } from 'vitest';
import { GET as getOpenApiSpec } from '../src/app/api/openapi.json/route';
import { WEB_TOOLS } from '../src/lib/tools/tool-names';

/** The OpenAPI document of the web tool routes (`/api/tools/<tool>`) against the tools the route runs. */

interface Operation {
  'x-internal'?: boolean;
  security: Array<Record<string, unknown>>;
  requestBody: { content: Record<string, { schema: { properties: Record<string, unknown>; required?: string[] } }> };
  responses: Record<string, unknown>;
}

async function operations(): Promise<Record<string, Operation>> {
  const spec = (await (await getOpenApiSpec()).json()) as { paths: Record<string, { post?: Operation }> };
  return Object.fromEntries(WEB_TOOLS.map((tool) => [tool, spec.paths[`/api/tools/${tool}`]?.post as Operation]));
}

describe('the web tool routes in the OpenAPI document', () => {
  it.each(WEB_TOOLS)('documents /api/tools/%s as an internal route that takes files and an anonymous caller', async (tool) => {
    const operation = (await operations())[tool];
    expect(operation, tool).toBeDefined();
    expect(operation['x-internal']).toBe(true);
    expect(operation.security).toContainEqual({});
    const form = operation.requestBody.content['multipart/form-data'].schema;
    expect(Object.keys(form.properties).sort()).toEqual(['files', 'options']);
    expect(form.required).toEqual(['files']);
  });

  it.each(WEB_TOOLS)('lists the answers of /api/tools/%s that the route gives', async (tool) => {
    const operation = (await operations())[tool];
    expect(Object.keys(operation.responses).sort()).toEqual(['200', '400', '401', '404', '411', '413', '415', '422', '429', '499', '500', '504']);
  });

  it('names the files, the options and the answer of each tool', async () => {
    const json = JSON.stringify(await operations());
    for (const word of ['too_few_files', 'application/zip', 'application/pdf', 'application/json', 'everyNPages', 'rotation', 'tar.gz', 'one conversion']) {
      expect(json, word).toContain(word);
    }
  });
});
