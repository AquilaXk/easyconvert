import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/** The slice of the ESLint API used here; `@types/eslint` is not a dependency. */
interface LintMessage {
  ruleId: string | null;
  fatal?: boolean;
  message: string;
  line: number;
  column: number;
}
interface LintResult {
  filePath: string;
  messages: LintMessage[];
}
interface EslintEngine {
  lintFiles(patterns: string[]): Promise<LintResult[]>;
}
const { ESLint } = require('eslint') as { ESLint: new (options: object) => EslintEngine };

/**
 * Code-smell ratchet gate (#774).
 *
 * Runs ESLint programmatically with only the smell rules below (independent of `next lint`) over `src/**\/*.{ts,tsx}` and
 * compares the findings with the committed baseline `.github/code-smell-baseline.json`.
 *
 * A finding is keyed by file + rule + enclosing function name, never by line number, so unrelated edits do not move keys.
 * Each key carries a count and, for metric rules, the highest measured value. The baseline can only shrink: a key that
 * grows (count or value) or appears fails, and a key that shrinks or disappears also fails until `--update` rewrites the
 * baseline in the same change. `--update` never keeps a violation the code no longer has, and it refuses to raise anything
 * unless `--allow-growth` is also passed (reserved for generating the first baseline).
 */

export interface SmellEntry {
  file: string;
  rule: string;
  function: string;
  count: number;
  /** Highest measured value (complexity, depth, parameters, lines) for metric rules. */
  maxValue?: number;
  /** Why a hot path keeps this violation. Optional; preserved by `--update`. */
  reason?: string;
}

export const SMELL_RULES: Record<string, unknown> = {
  complexity: ['error', 30],
  'max-depth': ['error', 5],
  'max-lines-per-function': ['error', { max: 250, skipBlankLines: true, skipComments: true }],
  'max-params': ['error', 6],
  'no-nested-ternary': 'error',
  '@typescript-eslint/no-explicit-any': 'error',
  'max-lines': ['error', { max: 1500 }],
};

const BASELINE_RELATIVE_PATH = path.join('.github', 'code-smell-baseline.json');
const MODULE_LEVEL = '<module>';
const ANONYMOUS = '<anonymous>';
const MEASURED_VALUE = /(\d+)\D+Maximum allowed/;

interface Finding {
  file: string;
  rule: string;
  function: string;
  line: number;
  value?: number;
}

function keyOf(entry: Pick<SmellEntry, 'file' | 'rule' | 'function'>): string {
  return `${entry.file}\u0000${entry.rule}\u0000${entry.function}`;
}

function describeKey(entry: Pick<SmellEntry, 'file' | 'rule' | 'function'>): string {
  return `${entry.file} :: ${entry.function} :: ${entry.rule}`;
}

function isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function functionName(node: ts.FunctionLikeDeclaration): string {
  if (ts.isConstructorDeclaration(node)) return 'constructor';
  if (node.name !== undefined) return node.name.getText();
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) {
    return parent.name.getText();
  }
  return ANONYMOUS;
}

/** The innermost named function around a position; anonymous callbacks resolve to the nearest named ancestor. */
function enclosingFunctionName(sourceFile: ts.SourceFile, position: number): string {
  let innermostNamed = MODULE_LEVEL;
  const visit = (node: ts.Node): void => {
    if (position < node.getFullStart() || position >= node.getEnd()) return;
    if (isFunctionLike(node)) {
      const name = functionName(node);
      if (name !== ANONYMOUS) innermostNamed = name;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return innermostNamed;
}

function lineAndColumnToPosition(sourceFile: ts.SourceFile, line: number, column: number): number {
  return sourceFile.getPositionOfLineAndCharacter(line - 1, column - 1);
}

async function collectFindings(root: string): Promise<Finding[]> {
  const eslint = new ESLint({
    cwd: root,
    useEslintrc: false,
    errorOnUnmatchedPattern: false,
    resolvePluginsRelativeTo: path.resolve(__dirname, '..'),
    overrideConfig: {
      parser: require.resolve('@typescript-eslint/parser'),
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true } },
      plugins: ['@typescript-eslint'],
      noInlineConfig: true,
      rules: SMELL_RULES,
    },
  });
  const results = await eslint.lintFiles(['src/**/*.{ts,tsx}']);
  const findings: Finding[] = [];
  for (const result of results) {
    const file = path.relative(root, result.filePath).split(path.sep).join('/');
    const sourceFile = ts.createSourceFile(result.filePath, fs.readFileSync(result.filePath, 'utf-8'), ts.ScriptTarget.Latest, true);
    for (const message of result.messages) {
      if (message.fatal === true) {
        throw new Error(`${file}:${message.line}: ESLint could not analyse the file: ${message.message}`);
      }
      // Inline directives are ignored on purpose (noInlineConfig), which ESLint reports as rule-less warnings.
      if (message.ruleId === null) continue;
      const measured = MEASURED_VALUE.exec(message.message);
      const isFileRule = message.ruleId === 'max-lines';
      findings.push({
        file,
        rule: message.ruleId,
        function: isFileRule ? MODULE_LEVEL : enclosingFunctionName(sourceFile, lineAndColumnToPosition(sourceFile, message.line, message.column)),
        line: message.line,
        value: measured === null ? undefined : Number(measured[1]),
      });
    }
  }
  return findings;
}

export function aggregate(findings: readonly Finding[]): SmellEntry[] {
  const byKey = new Map<string, SmellEntry>();
  for (const finding of findings) {
    const key = keyOf(finding);
    const entry = byKey.get(key) ?? { file: finding.file, rule: finding.rule, function: finding.function, count: 0 };
    entry.count += 1;
    if (finding.value !== undefined) entry.maxValue = Math.max(entry.maxValue ?? 0, finding.value);
    byKey.set(key, entry);
  }
  return [...byKey.values()].sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
}

function readBaseline(baselinePath: string): SmellEntry[] {
  if (!fs.existsSync(baselinePath)) return [];
  return JSON.parse(fs.readFileSync(baselinePath, 'utf-8')) as SmellEntry[];
}

function describeEntry(entry: SmellEntry): string {
  const measured = entry.maxValue === undefined ? '' : `, worst measured ${entry.maxValue}`;
  return `${describeKey(entry)} (count ${entry.count}${measured})`;
}

export interface Verdict {
  grown: string[];
  shrunk: string[];
}

export function compare(baseline: readonly SmellEntry[], current: readonly SmellEntry[]): Verdict {
  const baselineByKey = new Map(baseline.map((entry) => [keyOf(entry), entry]));
  const currentByKey = new Map(current.map((entry) => [keyOf(entry), entry]));
  const grown: string[] = [];
  const shrunk: string[] = [];
  for (const entry of current) {
    const recorded = baselineByKey.get(keyOf(entry));
    if (recorded === undefined) {
      grown.push(`NEW  ${describeEntry(entry)}`);
    } else if (entry.count > recorded.count || (entry.maxValue ?? 0) > (recorded.maxValue ?? 0)) {
      grown.push(`GREW ${describeEntry(entry)}; baseline has count ${recorded.count}, worst ${recorded.maxValue ?? 'n/a'}`);
    } else if (entry.count < recorded.count || (entry.maxValue ?? 0) < (recorded.maxValue ?? 0)) {
      shrunk.push(`${describeEntry(entry)}; baseline has count ${recorded.count}, worst ${recorded.maxValue ?? 'n/a'}`);
    }
  }
  for (const recorded of baseline) {
    if (!currentByKey.has(keyOf(recorded))) shrunk.push(`GONE ${describeEntry(recorded)}`);
  }
  return { grown, shrunk };
}

function withPreservedReasons(baseline: readonly SmellEntry[], current: readonly SmellEntry[]): SmellEntry[] {
  const reasons = new Map(baseline.filter((entry) => entry.reason !== undefined).map((entry) => [keyOf(entry), entry.reason as string]));
  return current.map((entry) => {
    const reason = reasons.get(keyOf(entry));
    return reason === undefined ? entry : { ...entry, reason };
  });
}

function summarise(entries: readonly SmellEntry[]): string {
  const perRule = new Map<string, number>();
  for (const entry of entries) perRule.set(entry.rule, (perRule.get(entry.rule) ?? 0) + entry.count);
  return [...perRule.entries()].map(([rule, count]) => `${rule}=${count}`).join(' ');
}

interface PairTotals {
  count: number;
  maxValue: number;
}

function totalsByFilePair(entries: readonly SmellEntry[]): Map<string, PairTotals> {
  const totals = new Map<string, PairTotals>();
  for (const entry of entries) {
    const pair = `${entry.file} :: ${entry.rule}`;
    const total = totals.get(pair) ?? { count: 0, maxValue: 0 };
    total.count += entry.count;
    total.maxValue = Math.max(total.maxValue, entry.maxValue ?? 0);
    totals.set(pair, total);
  }
  return totals;
}

/**
 * Compares the baseline of a change with the baseline of its base branch, so `--update --allow-growth` in the change cannot
 * hide a new violation. Totals are summed per file + rule, which lets a renamed function pass; a pair the base lacks, or a
 * higher summed count or worst value, is growth. Returns one message per growth.
 */
export function baselineGrowth(base: readonly SmellEntry[], head: readonly SmellEntry[]): string[] {
  const baseTotals = totalsByFilePair(base);
  const growth: string[] = [];
  for (const [pair, total] of totalsByFilePair(head)) {
    const before = baseTotals.get(pair);
    if (before === undefined) {
      growth.push(`NEW PAIR ${pair} (count ${total.count}, worst ${total.maxValue}); the base branch has none`);
    } else if (total.count > before.count || total.maxValue > before.maxValue) {
      growth.push(`GREW ${pair} (count ${total.count}, worst ${total.maxValue}); base has count ${before.count}, worst ${before.maxValue}`);
    }
  }
  return growth;
}

/** Checks the committed baseline against the base branch's copy; a missing base file (the change that adds the gate) passes. */
export function runBaseCheck(root: string, baseBaselinePath: string): number {
  if (!fs.existsSync(baseBaselinePath)) {
    console.log(`[PASS] The base branch has no ${BASELINE_RELATIVE_PATH} yet; nothing to compare with.`);
    return 0;
  }
  const base = JSON.parse(fs.readFileSync(baseBaselinePath, 'utf-8')) as SmellEntry[];
  const growth = baselineGrowth(base, readBaseline(path.join(root, BASELINE_RELATIVE_PATH)));
  if (growth.length > 0) {
    console.error(`[REJECTED] The baseline grew against the base branch. Fix the smells instead of raising it:\n  ${growth.join('\n  ')}`);
    return 1;
  }
  console.log('[PASS] The baseline does not exceed the base branch baseline.');
  return 0;
}

export interface GuardOptions {
  root: string;
  update: boolean;
  allowGrowth: boolean;
}

/** Returns the process exit code and prints the verdict. */
export async function runCodeSmellGuard(options: GuardOptions): Promise<number> {
  const baselinePath = path.join(options.root, BASELINE_RELATIVE_PATH);
  const baseline = readBaseline(baselinePath);
  const current = aggregate(await collectFindings(options.root));
  const { grown, shrunk } = compare(baseline, current);

  if (options.update) {
    if (grown.length > 0 && !options.allowGrowth) {
      console.error(`[REJECTED] --update never raises the baseline. Fix these first:\n  ${grown.join('\n  ')}`);
      return 1;
    }
    fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
    fs.writeFileSync(baselinePath, JSON.stringify(withPreservedReasons(baseline, current), null, 2) + '\n', 'utf-8');
    console.log(`[OK] Wrote ${current.length} baseline entries to ${path.relative(options.root, baselinePath)} (${summarise(current)})`);
    return 0;
  }

  if (grown.length > 0) {
    console.error(`[REJECTED] ${grown.length} code smell(s) above the baseline. Fix them; do not raise the baseline:\n  ${grown.join('\n  ')}`);
  }
  if (shrunk.length > 0) {
    console.error(
      `[RATCHET] ${shrunk.length} baseline entr${shrunk.length === 1 ? 'y' : 'ies'} improved. Run \`npm run guard:code-smells -- --update\` and commit the smaller baseline:\n  ${shrunk.join('\n  ')}`
    );
  }
  if (grown.length > 0 || shrunk.length > 0) return 1;
  console.log(`[PASS] No code smell above the baseline (${current.length} entries: ${summarise(current)})`);
  return 0;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const args = new Set(argv);
  const root = process.env.GUARD_ROOT ? path.resolve(process.env.GUARD_ROOT) : path.resolve(__dirname, '..');
  const baseFlag = argv.indexOf('--check-base');
  if (baseFlag !== -1) {
    process.exit(runBaseCheck(root, path.resolve(argv[baseFlag + 1] ?? '')));
  }
  runCodeSmellGuard({ root, update: args.has('--update'), allowGrowth: args.has('--allow-growth') }).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error);
      process.exit(2);
    }
  );
}
