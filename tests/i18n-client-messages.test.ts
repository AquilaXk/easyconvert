import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { PAGE_NAMESPACES, clientMessages, type ClientMessagesPage } from '../src/i18n/client-messages';
import { parseSource } from './helpers/ts-source';
import { testMessages } from './helpers/intl-messages';

/**
 * Each page hands its client components only the message namespaces they read (`PAGE_NAMESPACES`). This walks the
 * imports of each page's view with the TypeScript parser and collects the namespaces of every `useTranslations` call a
 * client component makes, so a row that misses a namespace (a component would show raw keys) or carries an unused one
 * (bytes on every page view) fails here.
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
  notFound: 'src/components/pages/NotFoundPageView.tsx',
};

function resolveImport(fromFile: string, specifier: string): string | undefined {
  let base: string;
  if (specifier.startsWith('@/')) base = path.join(ROOT, 'src', specifier.slice(2));
  else if (specifier.startsWith('.')) base = path.resolve(path.dirname(fromFile), specifier);
  else return undefined;
  return ['.tsx', '.ts', '/index.tsx', '/index.ts'].map((ext) => base + ext).find((candidate) => fs.existsSync(candidate));
}

function isClientModule(sf: ts.SourceFile): boolean {
  const [first] = sf.statements;
  return Boolean(first) && ts.isExpressionStatement(first) && ts.isStringLiteral(first.expression) && first.expression.text === 'use client';
}

function isTypeOnly(node: ts.ImportDeclaration | ts.ExportDeclaration): boolean {
  return ts.isImportDeclaration(node) ? Boolean(node.importClause?.isTypeOnly) : node.isTypeOnly;
}

/**
 * The namespaces the client components reached from `view` read. A module is a client component when it says
 * `'use client'` or a client component imports it (Next.js puts every module a client module imports in the client
 * bundle); a server component's `useTranslations` runs on the server with every message, so it needs none handed down.
 */
function namespacesReadBy(view: string): Set<string> {
  const namespaces = new Set<string>();
  const seen = new Set<string>();
  const visitFile = (file: string, importedByClient: boolean) => {
    const sf = parseSource(file);
    const isClient = importedByClient || isClientModule(sf);
    const key = `${file}:${isClient}`;
    if (seen.has(key)) return;
    seen.add(key);
    const visit = (node: ts.Node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        !isTypeOnly(node) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        const target = resolveImport(file, node.moduleSpecifier.text);
        if (target) visitFile(target, isClient);
      }
      if (isClient && ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'useTranslations') {
        const [namespace] = node.arguments;
        if (namespace && ts.isStringLiteral(namespace)) namespaces.add(namespace.text.split('.')[0]);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  };
  visitFile(path.join(ROOT, view), false);
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

describe('a converter page', () => {
  it('carries the format prose of its own formats only, and none for a name every object has', () => {
    const messages = clientMessages(testMessages('en'), 'converter', ['constructor', 'PDF']);
    expect(Object.keys(messages.formatSpecs)).toEqual(['pdf']);
    expect(Object.keys(messages.formatDescriptions)).toEqual(['pdf']);
    expect(JSON.parse(JSON.stringify(messages))).toEqual(messages);
  });
});
