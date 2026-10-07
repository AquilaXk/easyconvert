import fs from 'node:fs';
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
