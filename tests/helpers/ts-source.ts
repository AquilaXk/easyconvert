import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/**
 * Structural reading of a TypeScript or TSX source file with the TypeScript compiler's own parser (independent of
 * the code under test). It answers questions about what a module does that cannot be observed in a server-side
 * render, such as which event name a component listens for or where an argument comes from, without grepping text.
 */

export function parseSource(file: string): ts.SourceFile {
  return ts.createSourceFile(file, fs.readFileSync(file, 'utf-8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function calleeNameOf(callee: ts.Expression): string | null {
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

/** Source text of the arguments of every call to a function or method named `name`, in source order. */
export function callArguments(sf: ts.SourceFile, name: string): string[][] {
  const calls: string[][] = [];
  walk(sf, (n) => {
    if (!ts.isCallExpression(n)) return;
    if (calleeNameOf(n.expression) === name) calls.push(n.arguments.map((a) => a.getText(sf)));
  });
  return calls;
}

/** The string literal values passed as the first argument of calls to `name` (event names, storage keys, ...). */
export function firstStringArguments(sf: ts.SourceFile, name: string): string[] {
  const values: string[] = [];
  walk(sf, (n) => {
    if (!ts.isCallExpression(n) && !ts.isNewExpression(n)) return;
    let first: ts.Expression | undefined = n.arguments?.[0];
    while (first && (ts.isAsExpression(first) || ts.isParenthesizedExpression(first))) first = first.expression;
    if (calleeNameOf(n.expression) === name && first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))) {
      values.push(first.text);
    }
  });
  return values;
}

/** Source text of every `const|let name = <initializer>` declaration of `name`, in source order. */
export function initializersOf(sf: ts.SourceFile, name: string): string[] {
  const initializers: string[] = [];
  walk(sf, (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer) {
      initializers.push(n.initializer.getText(sf));
    }
  });
  return initializers;
}

export interface ModuleGraph {
  /** Absolute paths of every source file reachable through value imports from the entry, entry included. */
  files: string[];
  /** Module specifiers that name a package or a Node built-in (not a path into the source tree), sorted. */
  externalSpecifiers: string[];
}

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '/index.ts', '/index.tsx'];

function resolveSourceFile(specifier: string, importer: string, srcRoot: string): string | null {
  const base = specifier.startsWith('@/') ? path.join(srcRoot, specifier.slice(2)) : path.resolve(path.dirname(importer), specifier);
  for (const extension of SOURCE_EXTENSIONS) {
    if (fs.existsSync(base + extension) && fs.statSync(base + extension).isFile()) return base + extension;
  }
  return null;
}

/** Module specifiers a file pulls in at run time: import and re-export declarations, import() and require(). */
export function runtimeImportSpecifiers(sf: ts.SourceFile): string[] {
  const specifiers: string[] = [];
  walk(sf, (n) => {
    if (ts.isImportDeclaration(n) && !n.importClause?.isTypeOnly && ts.isStringLiteral(n.moduleSpecifier)) {
      specifiers.push(n.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(n) && !n.isTypeOnly && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      specifiers.push(n.moduleSpecifier.text);
    } else if (ts.isCallExpression(n) && n.arguments.length > 0 && ts.isStringLiteral(n.arguments[0])) {
      const isDynamicImport = n.expression.kind === ts.SyntaxKind.ImportKeyword;
      if (isDynamicImport || (ts.isIdentifier(n.expression) && n.expression.text === 'require')) specifiers.push(n.arguments[0].text);
    }
  });
  return specifiers;
}

/**
 * Follows the run-time imports of `entry` through the source tree (`@/` maps to `srcRoot`) and returns the files
 * reached and the packages and built-ins they import. An import that looks like a path but resolves to no file
 * throws, so a graph is never silently smaller than the real one.
 */
export function collectModuleGraph(entry: string, srcRoot: string): ModuleGraph {
  const files = new Set<string>();
  const external = new Set<string>();
  const queue = [path.resolve(entry)];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (files.has(file)) continue;
    files.add(file);
    for (const specifier of runtimeImportSpecifiers(parseSource(file))) {
      const isPath = specifier.startsWith('.') || specifier.startsWith('@/');
      if (!isPath) {
        external.add(specifier);
        continue;
      }
      const resolved = resolveSourceFile(specifier, file, srcRoot);
      if (!resolved) throw new Error(`${file} imports "${specifier}", which resolves to no source file`);
      queue.push(resolved);
    }
  }
  return { files: [...files].sort((a, b) => a.localeCompare(b)), externalSpecifiers: [...external].sort((a, b) => a.localeCompare(b)) };
}

/** Every identifier in the file spelled `name`, as `line:column` positions, so a use can be located. */
export function identifierUses(sf: ts.SourceFile, name: string): string[] {
  const uses: string[] = [];
  walk(sf, (n) => {
    if (ts.isIdentifier(n) && n.text === name) {
      const { line, character } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
      uses.push(`${line + 1}:${character + 1}`);
    }
  });
  return uses;
}
