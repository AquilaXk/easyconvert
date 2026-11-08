import { describe, expect, it } from 'vitest';
import { GET as getOpenApiSpec } from '../src/app/api/openapi.json/route';
import { WEB_TOOLS } from '../src/lib/tools/tool-names';

/** The OpenAPI document of the web tool routes (`/api/tools/<tool>`) against the tools the route runs. */

interface Operation {
  'x-internal'?: boolean;
  security: Array<Record<string, unknown>>;
  requestBody: { content: Record<string, { schema: { properties: Record<string, unknown>; required?: string[] } }> };
  responses: Record<string, { content?: Record<string, { schema: { type?: string; format?: string; properties?: Record<string, unknown> } }> }>;
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
    expect(Object.keys(operation.responses).sort()).toEqual(['200', '400', '401', '411', '413', '415', '422', '429', '499', '500', '503', '504']);
  });

  it('answers a listing of the archive as JSON, not as a file', async () => {
    const content = (await operations())['archive-extract'].responses['200'].content ?? {};
    expect(Object.keys(content)).toEqual(['application/json']);
    expect(Object.keys(content['application/json'].schema.properties ?? {})).toEqual(['success', 'entries']);
  });

  it('answers an archive in the media type of each format it can write', async () => {
    const content = (await operations())['archive-create'].responses['200'].content ?? {};
    expect(Object.keys(content).sort()).toEqual(['application/gzip', 'application/x-7z-compressed', 'application/zip']);
  });

  it('names the offline quota store among the answers, as /api/convert does', async () => {
    const offline = await Promise.all(WEB_TOOLS.map(async (tool) => JSON.stringify((await operations())[tool].responses['503'])));
    expect(offline.filter((answer) => answer.includes('problems/service-unavailable') && answer.includes('Retry-After'))).toHaveLength(WEB_TOOLS.length);
  });

  it('names the files, the options and the answer of each tool', async () => {
    const json = JSON.stringify(await operations());
    for (const word of ['too_few_files', 'application/zip', 'application/pdf', 'application/json', 'everyNPages', 'rotation', 'tar.gz', 'one conversion', '8192 characters', 'concurrency slot']) {
      expect(json, word).toContain(word);
    }
  });
});
