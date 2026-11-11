import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';
import { GET as getOpenApiSpec } from '../src/app/api/openapi.json/route';
import { ConversionOptionsSchema, SERVER_ONLY_OPTION_KEYS } from '../src/lib/api/contracts';
import { validateOrProblem } from '../src/lib/api/contracts/validate';

/**
 * The options contract of the public conversion routes: the schema names the options of `ConversionOptions` and no option that nothing
 * reads, and the OpenAPI document of POST /api/v1/convert names what the route reads.
 */

const ROOT = path.resolve(__dirname, '..');

/** The keys of the `ConversionOptions` interface, read from its declaration. */
function conversionOptionsKeys(): string[] {
  const file = path.join(ROOT, 'src', 'lib', 'types.ts');
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf-8'), ts.ScriptTarget.Latest, true);
  const keys: string[] = [];
  source.forEachChild((node) => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === 'ConversionOptions') {
      for (const member of node.members) if (member.name) keys.push(member.name.getText(source));
    }
  });
  return keys;
}

const schemaProperties = (): string[] => Object.keys((ConversionOptionsSchema as { properties: Record<string, unknown> }).properties);
const names = (result: ReturnType<typeof validateOrProblem>): Array<{ name: string; reason: string }> =>
  (result.problem?.invalidParams as Array<{ name: string; reason: string }> | undefined) ?? [];

/** Control keys of a job that the routes drop from a request's options instead of refusing them (`stripEngineControls`, tests/job-deadline-sync-routes.test.ts). */
const DROPPED_CONTROL_KEYS = ['timeoutMs', 'signal'];

describe('the options schema', () => {
  it('names only options of ConversionOptions, and every option of it that a request may set', () => {
    const interfaceKeys = conversionOptionsKeys();
    expect(interfaceKeys.length).toBeGreaterThan(100);
    const serverOnly: readonly string[] = SERVER_ONLY_OPTION_KEYS;
    expect(schemaProperties().filter((key) => !interfaceKeys.includes(key))).toEqual([]);
    expect(interfaceKeys.filter((key) => !schemaProperties().includes(key) && !serverOnly.includes(key) && !DROPPED_CONTROL_KEYS.includes(key))).toEqual([]);
    expect(schemaProperties().filter((key) => serverOnly.includes(key) || DROPPED_CONTROL_KEYS.includes(key))).toEqual([]);
  });

  it('does not offer dimensions, which no engine reads: a size is width and height', () => {
    expect(schemaProperties()).not.toContain('dimensions');
    expect(schemaProperties()).toEqual(expect.arrayContaining(['width', 'height', 'fit']));
    const registryText = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'registry.ts'), 'utf-8');
    expect(registryText).not.toMatch(/\bdimensions\s*:/);
  });

  it('still accepts a key it does not name and leaves it alone, as the CAD option removal and the explicit-list decision of the policy record decided', () => {
    const result = validateOrProblem(ConversionOptionsSchema, { quality: 80, dimensions: '800x600' });
    expect(result.ok).toBe(true);
  });

  it.each(['outputPath', 'inputBuffer', 'disableNativeEngine', 'zeroHeap'])('refuses %s once, as an option only server code sets', (key) => {
    const result = validateOrProblem(ConversionOptionsSchema, { [key]: 'x' });
    expect(result.ok).toBe(false);
    expect(names(result)).toEqual([{ name: key, reason: 'server_only_option' }]);
  });
});

describe('POST /api/v1/convert in the OpenAPI document', () => {
  let post: { parameters: Array<{ name: string; in: string; schema?: unknown; $ref?: string }>; requestBody: { content: Record<string, { schema: { properties: Record<string, unknown>; required: string[] } }> } };
  beforeAll(async () => {
    const spec = await (await getOpenApiSpec()).json();
    post = spec.paths['/api/v1/convert'].post;
  });

  it('documents the webhook fields the route reads from the form', () => {
    const route = fs.readFileSync(path.join(ROOT, 'src', 'app', 'api', 'v1', 'convert', 'route.ts'), 'utf-8');
    const textFields = [...(/const TEXT_FIELDS = \[([^\]]*)\]/.exec(route)?.[1] ?? '').matchAll(/'(\w+)'/g)].map((match) => match[1]);
    expect(textFields).toEqual(['sourceFormat', 'options', 'webhookUrl', 'webhookSecret']);
    const properties = post.requestBody.content['multipart/form-data'].schema.properties;
    for (const field of textFields) expect(Object.keys(properties), field).toContain(field);
    expect(post.requestBody.content['multipart/form-data'].schema.required).toEqual(['file', 'targetFormat']);
  });

  it('documents the Prefer header and the raw query parameter the route reads', () => {
    const prefer = post.parameters.find((parameter) => parameter.name === 'Prefer');
    expect(prefer).toMatchObject({ in: 'header', schema: { type: 'string' } });
    const raw = post.parameters.find((parameter) => parameter.name === 'raw');
    expect(raw).toMatchObject({ in: 'query', schema: { type: 'boolean' } });
    const route = fs.readFileSync(path.join(ROOT, 'src', 'app', 'api', 'v1', 'convert', 'route.ts'), 'utf-8');
    expect(route).toContain("req.headers.get('prefer')");
    expect(route).toContain("includes('respond-async')");
    expect(route).toContain("searchParams.get('raw') === 'true'");
  });
});
