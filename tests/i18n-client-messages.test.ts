import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { PAGE_NAMESPACES, type ClientMessagesPage } from '../src/i18n/client-messages';
import { parseSource } from './helpers/ts-source';

/**
 * Each page hands its client components only the message namespaces they read (`PAGE_NAMESPACES`). This walks the
 * imports of each page's view with the TypeScript parser and collects the namespaces of every `useTranslations` call it
 * reaches, so a row that misses a namespace (a component would show raw keys) or carries an unused one (bytes on every
 * page view) fails here.
 */

const ROOT = path.resolve(__dirname, '..');
const VIEWS: Record<Exclude<ClientMessagesPage, 'layout'>, string> = {
  home: 'src/components/pages/HomePageView.tsx',
  converter: 'src/components/pages/ConverterPageView.tsx',
  auth: 'src/components/pages/AuthPageView.tsx',
  dashboard: 'src/components/pages/DashboardPageView.tsx',
  apiDocs: 'src/components/pages/ApiDocsPageView.tsx',
  status: 'src/components/pages/StatusPageView.tsx',
  unitConverter: 'src/components/pages/UnitConverterPageView.tsx',
};

function resolveImport(fromFile: string, specifier: string): string | undefined {
  let base: string;
  if (specifier.startsWith('@/')) base = path.join(ROOT, 'src', specifier.slice(2));
  else if (specifier.startsWith('.')) base = path.resolve(path.dirname(fromFile), specifier);
  else return undefined;
  return ['.tsx', '.ts', '/index.tsx', '/index.ts'].map((ext) => base + ext).find((candidate) => fs.existsSync(candidate));
}

function namespacesReadBy(view: string): Set<string> {
  const namespaces = new Set<string>();
  const seen = new Set<string>();
  const visitFile = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const sf = parseSource(file);
    const visit = (node: ts.Node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const target = resolveImport(file, node.moduleSpecifier.text);
        if (target) visitFile(target);
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'useTranslations') {
        const [namespace] = node.arguments;
        if (namespace && ts.isStringLiteral(namespace)) namespaces.add(namespace.text.split('.')[0]);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  };
  visitFile(path.join(ROOT, view));
  return namespaces;
}

describe('each page carries the messages its components read, and no others', () => {
  for (const [page, view] of Object.entries(VIEWS) as Array<[keyof typeof VIEWS, string]>) {
    it(`${page}: ${view}`, () => {
      const provided = new Set<string>(PAGE_NAMESPACES[page]);
      const read = namespacesReadBy(view);
      expect([...read].filter((namespace) => !provided.has(namespace)).sort(), 'read but not provided').toEqual([]);
      expect([...provided].filter((namespace) => !read.has(namespace)).sort(), 'provided but never read').toEqual([]);
    });
  }
});
