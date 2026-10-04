import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { GET as getOpenApiSpec } from '../src/app/api/openapi.json/route';

/**
 * Oracle: the App Router file tree under src/app/api and the HTTP method names each
 * route.ts exports, read with the TypeScript compiler API. Nothing here is derived
 * from the OpenAPI builder under test.
 */

const API_ROOT = path.resolve(__dirname, '../src/app/api');
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

/**
 * Exported handlers that intentionally have no operation of their own, with the reason.
 * Keyed by `<METHOD> <route directory>`.
 */
const UNDOCUMENTED_ALIASES: Record<string, string> = {
  'PUT /api/v1/uploads/[[...id]]': 'only forwards `direct/part` to PUT /api/v1/uploads/direct/part',
};

interface RouteFile {
  routeDir: string;
  methods: string[];
}

function findRouteFiles(dir: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      findRouteFiles(full, found);
    } else if (entry.name === 'route.ts') {
      found.push(full);
    }
  }
  return found;
}

function hasExportModifier(node: ts.Node): boolean {
  return (ts.getModifiers(node as ts.HasModifiers) ?? []).some(
    (m) => m.kind === ts.SyntaxKind.ExportKeyword
  );
}

function readExportedMethods(file: string): string[] {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf-8'), ts.ScriptTarget.Latest, true);
  const names: string[] = [];
  for (const stmt of source.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && hasExportModifier(stmt)) {
      names.push(stmt.name.text);
    } else if (ts.isVariableStatement(stmt) && hasExportModifier(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) names.push(decl.name.text);
      }
    } else if (ts.isExportDeclaration(stmt) && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      for (const spec of stmt.exportClause.elements) names.push(spec.name.text);
    }
  }
  return names.filter((n) => HTTP_METHODS.has(n)).sort();
}

/** Maps an App Router directory to the OpenAPI path templates it serves. */
function toOpenApiPaths(routeDir: string): string[] {
  const optionalCatchAll = routeDir.match(/^(.*)\/\[\[\.\.\.(\w+)\]\]$/);
  if (optionalCatchAll) {
    const [, base, param] = optionalCatchAll;
    return [...toOpenApiPaths(base), `${toOpenApiPaths(base)[0]}/{${param}}`];
  }
  return [routeDir.replace(/\[\.\.\.(\w+)\]/g, '{$1}').replace(/\[(\w+)\]/g, '{$1}')];
}

function loadRoutes(): RouteFile[] {
  return findRouteFiles(API_ROOT)
    .map((file) => ({
      routeDir: ['/api', ...path.dirname(path.relative(API_ROOT, file)).split(path.sep)].join('/'),
      methods: readExportedMethods(file),
    }))
    .sort((a, b) => a.routeDir.localeCompare(b.routeDir));
}

async function loadSpec() {
  const res = await getOpenApiSpec();
  expect(res.status).toBe(200);
  return res.json();
}

function specOperations(spec: any): Set<string> {
  const ops = new Set<string>();
  for (const [p, item] of Object.entries<any>(spec.paths)) {
    for (const method of Object.keys(item)) {
      if (HTTP_METHODS.has(method.toUpperCase())) ops.add(`${method.toUpperCase()} ${p}`);
    }
  }
  return ops;
}

describe('OpenAPI route parity', () => {
  const routes = loadRoutes();

  it('reads exported handlers from route files with known App Router shapes', () => {
    // Fixed points of the oracle itself, checked by hand against the source files.
    const byDir = new Map(routes.map((r) => [r.routeDir, r.methods]));
    expect(byDir.get('/api/v1/jobs/[id]')).toEqual(['DELETE', 'GET']);
    expect(byDir.get('/api/v1/openapi.json')).toEqual(['GET']); // `export { GET } from`
    expect(byDir.get('/api/v1/uploads/[[...id]]')).toEqual(['DELETE', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT']);
    expect(toOpenApiPaths('/api/storage/file/[...key]')).toEqual(['/api/storage/file/{key}']);
    expect(toOpenApiPaths('/api/v1/uploads/[[...id]]')).toEqual(['/api/v1/uploads', '/api/v1/uploads/{id}']);
    for (const route of routes) {
      expect(route.methods.length, `${route.routeDir} exports no HTTP handler`).toBeGreaterThan(0);
    }
  });

  it('documents every exported route handler', async () => {
    const ops = specOperations(await loadSpec());
    const missing: string[] = [];
    for (const route of routes) {
      const candidates = toOpenApiPaths(route.routeDir);
      for (const method of route.methods) {
        if (UNDOCUMENTED_ALIASES[`${method} ${route.routeDir}`]) continue;
        if (!candidates.some((p) => ops.has(`${method} ${p}`))) {
          missing.push(`${method} ${route.routeDir}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('documents no operation that the route tree does not export', async () => {
    const exported = new Set<string>();
    for (const route of routes) {
      for (const p of toOpenApiPaths(route.routeDir)) {
        for (const method of route.methods) exported.add(`${method} ${p}`);
      }
    }
    const phantom = [...specOperations(await loadSpec())].filter((op) => !exported.has(op));
    expect(phantom).toEqual([]);
  });

  it('keeps alias exceptions pointing at exported handlers', () => {
    for (const key of Object.keys(UNDOCUMENTED_ALIASES)) {
      const [method, dir] = key.split(' ');
      expect(routes.find((r) => r.routeDir === dir)?.methods).toContain(method);
    }
  });

  it('gives every operation a unique operationId and declares every path template parameter', async () => {
    const spec = await loadSpec();
    const seen = new Map<string, string>();
    const problems: string[] = [];
    for (const [p, item] of Object.entries<any>(spec.paths)) {
      const templateParams = [...p.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      for (const [method, op] of Object.entries<any>(item)) {
        const label = `${method.toUpperCase()} ${p}`;
        if (typeof op.operationId !== 'string' || op.operationId.length === 0) {
          problems.push(`${label}: missing operationId`);
        } else if (seen.has(op.operationId)) {
          problems.push(`${label}: operationId ${op.operationId} already used by ${seen.get(op.operationId)}`);
        } else {
          seen.set(op.operationId, label);
        }
        const declared = (op.parameters ?? [])
          .filter((param: any) => param.in === 'path')
          .map((param: any) => param.name)
          .sort();
        if (JSON.stringify(declared) !== JSON.stringify(templateParams)) {
          problems.push(`${label}: path parameters ${JSON.stringify(declared)} != template ${JSON.stringify(templateParams)}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('lists every webhook event the platform dispatches, with signature headers', async () => {
    const spec = await loadSpec();
    // Event names passed to dispatch() in src/lib, collected from the source text.
    const dispatched = new Set<string>();
    const srcRoot = path.resolve(__dirname, '../src/lib');
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts')) {
          const text = fs.readFileSync(full, 'utf-8');
          for (const m of text.matchAll(/\.dispatch\(\s*[\w.]+,\s*'([a-z_]+\.[a-z_]+)'/g)) dispatched.add(m[1]);
        }
      }
    };
    walk(srcRoot);
    expect([...dispatched].sort()).toEqual([
      'graph.completed',
      'graph.failed',
      'job.completed',
      'job.failed',
      'key.expiring_soon',
    ]);
    expect(Object.keys(spec.webhooks).sort()).toEqual([...dispatched].sort());
    for (const [event, item] of Object.entries<any>(spec.webhooks)) {
      const headers = item.post.parameters.map((param: any) => param.name);
      expect(headers, event).toEqual(expect.arrayContaining(['Webhook-Id', 'Webhook-Timestamp', 'Webhook-Signature']));
      expect(item.post.requestBody.content['application/json'].schema.properties.event.const).toBe(event);
    }
  });
});
