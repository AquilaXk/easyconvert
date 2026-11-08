import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/**
 * Reads the error classes under src/ with the TypeScript compiler API and returns, per HTTP status, the refusal codes the convert
 * routes answer with (src/lib/types.ts `typedFailureOf`): the status a class declares (itself or by a class it extends), and
 * without one 503 under `EngineMissingError` and 400 for every other class that declares a refusal code. Nothing here comes
 * from the OpenAPI builder, so a new error class or a changed status moves this table and not the document.
 */

const SRC_ROOT = path.resolve(__dirname, '../../src');
const MISSING_TOOL_BASE = 'EngineMissingError';
const MISSING_TOOL_STATUS = 503;
const DEFAULT_REFUSAL_STATUS = 400;

interface ClassFacts {
  parent?: string;
  code?: string;
  status?: number | string;
}

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, found);
    else if (/\.tsx?$/.test(entry.name)) found.push(full);
  }
  return found;
}

function isStringOrNumber(node: ts.Expression): node is ts.StringLiteral | ts.NumericLiteral {
  return ts.isStringLiteral(node) || ts.isNumericLiteral(node);
}

/** The initializer of a property, without the `as const`/`satisfies` wrapper a literal may carry. */
function literalOf(node: ts.Expression | undefined): number | string | undefined {
  if (!node) return undefined;
  if (isStringOrNumber(node)) return ts.isNumericLiteral(node) ? Number(node.text) : node.text;
  if (ts.isIdentifier(node)) return node.text;
  return undefined;
}

function propertyName(member: ts.ClassElement): string | undefined {
  return ts.isPropertyDeclaration(member) && ts.isIdentifier(member.name) ? member.name.text : undefined;
}

function collect(): { classes: Map<string, ClassFacts>; numbers: Map<string, number> } {
  const classes = new Map<string, ClassFacts>();
  const numbers = new Map<string, number>();
  for (const file of sourceFiles(SRC_ROOT)) {
    const text = fs.readFileSync(file, 'utf8');
    if (!/refusalCode|status|class /.test(text)) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    for (const statement of source.statements) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          const value = literalOf(declaration.initializer);
          if (ts.isIdentifier(declaration.name) && typeof value === 'number') numbers.set(declaration.name.text, value);
        }
      } else if (ts.isClassDeclaration(statement) && statement.name) {
        const facts: ClassFacts = {};
        const heritage = statement.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword);
        const parent = heritage?.types[0]?.expression;
        if (parent && ts.isIdentifier(parent)) facts.parent = parent.text;
        for (const member of statement.members) {
          const name = propertyName(member);
          const initializer = (member as ts.PropertyDeclaration).initializer;
          if (name === 'refusalCode') facts.code = literalOf(initializer) as string | undefined;
          if (name === 'status') facts.status = literalOf(initializer);
        }
        classes.set(statement.name.text, facts);
      }
    }
  }
  return { classes, numbers };
}

/** HTTP status to the refusal codes of the typed failures answered with it, sorted. */
export function typedFailureCodesByStatus(): Map<number, string[]> {
  const { classes, numbers } = collect();
  const byStatus = new Map<number, Set<string>>();
  for (const name of classes.keys()) {
    let code: string | undefined;
    let status: number | string | undefined;
    let missingTool = name === MISSING_TOOL_BASE;
    for (let facts = classes.get(name); facts; facts = facts.parent ? classes.get(facts.parent) : undefined) {
      code ??= facts.code;
      status ??= facts.status;
      missingTool ||= facts.parent === MISSING_TOOL_BASE;
    }
    if (code === undefined) continue;
    const declared = typeof status === 'string' ? numbers.get(status) : status;
    const resolved = declared ?? (missingTool ? MISSING_TOOL_STATUS : DEFAULT_REFUSAL_STATUS);
    if (!byStatus.has(resolved)) byStatus.set(resolved, new Set());
    byStatus.get(resolved)!.add(code);
  }
  return new Map([...byStatus].map(([status, codes]) => [status, [...codes].sort()]));
}
