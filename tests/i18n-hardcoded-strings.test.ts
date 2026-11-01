import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { parseSource } from './helpers/ts-source';

/**
 * No user-visible English is left in the interface source: every visible string comes from the messages, so each offered
 * language shows its own. The scan reads the source with the TypeScript parser and flags text a visitor would read (JSX
 * text, text attributes, string children) and string literals that read as prose anywhere in the interface code.
 */

const ROOT = path.resolve(__dirname, '..');
const UI_ROOTS = ['src/app', 'src/components', 'src/hooks'];
/**
 * Library files whose text the interface shows: the converter page copy, the viewer's plan, byte sizes, and the failure
 * the queue words. The conversion path behind the queue (client-converter.ts and the edge pipelines) hands the queue a
 * `ConversionFailure`, a code and the server's answer, so the type keeps its error messages out of the interface.
 */
const UI_LIB_FILES = [
  'src/lib/conversion-failure.ts',
  'src/lib/format-bytes.ts',
  'src/lib/slug-parser.ts',
  'src/lib/slug-info-pages.ts',
  'src/lib/viewer-plan.ts',
];
const TEXT_ATTRIBUTES = new Set(['aria-label', 'aria-description', 'title', 'placeholder', 'alt', 'label']);
const HAS_LETTER = /[A-Za-z]/;
/** Two or more words that start with a capital, or a sentence: how copy reads, unlike class lists, ids and code. */
const PROSE = /^[A-Z][a-z]+(?:[ -][A-Za-z0-9&'(),.:/%+]+){2,}|^[A-Z][^.]*\s[^.]*\.$/;
/** Object properties a component shows as a message or a label: there one or two capitalised words (`'Failed'`) are copy. */
const MESSAGE_PROPERTIES = new Set(['error', 'message', 'label', 'title', 'placeholder', 'detail']);
const SHORT_COPY = /^[A-Z][a-z]+(?: [A-Za-z]+)?[.!]?$/;
/** What a template's substitutions read as when its text is tested as prose: a lowercase word, never a capital. */
const SUBSTITUTION = 'x';

/** Strings that are not copy, with why. Brand and product names read the same in every language. */
const ALLOWED_TEXT = new Set([
  'EasyConvert', // brand
  'English', // language names are written in their own language (LanguageSwitcher)
  'cURL', 'Node.js', 'Python', // SDK names on the integration guide tabs
  'Content-Type:', // an HTTP header name in the request body table
  '00:00 UTC', // the quota reset time, a clock reading
  'ms', // the unit after a probe's latency
]);

/**
 * An error's message is for logs and API callers: the interface words a failure by its code (src/lib/conversion-failure.ts)
 * and never shows the message, which tests/i18n-queue-errors.test.ts checks on the rendered queue. `serverRefusal` takes
 * the message an error has when the server gave no sentence.
 */
const ERROR_MESSAGE_CALLS = new Set(['serverRefusal']);
const ERROR_CLASS = /(?:Error|Exception)$/;

/** Elements whose text is code a visitor copies, not copy. */
const CODE_ELEMENTS = new Set(['code', 'pre', 'kbd', 'samp']);

/** Object properties whose values are names or configuration, not copy: format standards keep their own names. */
const NON_COPY_PROPERTIES = new Set(['fullName', 'developer', 'mimeType', 'adjustFontFallback']);

/** A link, an address, an HTTP request line or an HTML entity reads the same in every language. */
const LANGUAGE_NEUTRAL = /^(?:https?:\/\/\S+|\S+@\S+\.\w+|(?:GET|POST|PUT|PATCH|DELETE) \S+|(?:&\w+;\s*)+)$/;

/** Files whose prose-like literals are code samples or API payloads, shown as code, not copy. */
const CODE_SAMPLE_FILES = new Set([
  'src/components/api-docs/curl-builder.ts', // request bodies of the generated cURL commands
]);

function isErrorMessage(n: ts.Node): boolean {
  if (ts.isNewExpression(n)) return ERROR_CLASS.test(n.expression.getText());
  return ts.isCallExpression(n) && ERROR_MESSAGE_CALLS.has(n.expression.getText());
}

function isMessageProperty(node: ts.Node): boolean {
  if (!ts.isPropertyAssignment(node.parent) || node.parent.initializer !== node) return false;
  const name = node.parent.name.getText().replace(/^['"]|['"]$/g, '');
  return MESSAGE_PROPERTIES.has(name) || name.startsWith('aria');
}

function templateText(node: ts.TemplateExpression): string {
  return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(SUBSTITUTION);
}

function uiFiles(): string[] {
  const files: string[] = [];
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (path.relative(ROOT, full) !== path.join('src', 'app', 'api')) visit(full);
      } else if (/\.(tsx?|jsx?)$/.test(entry.name)) {
        files.push(full);
      }
    }
  };
  for (const root of UI_ROOTS) visit(path.join(ROOT, root));
  return [...files, ...UI_LIB_FILES.map((file) => path.join(ROOT, file))];
}

function isInside(node: ts.Node, test: (n: ts.Node) => boolean): boolean {
  for (let current = node.parent; current; current = current.parent) if (test(current)) return true;
  return false;
}

function isConsoleCall(n: ts.Node): boolean {
  return ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.expression.getText() === 'console';
}

function isInsideCodeElement(node: ts.Node): boolean {
  return isInside(node, (n) => ts.isJsxElement(n) && CODE_ELEMENTS.has(n.openingElement.tagName.getText()));
}

function isNonCopyProperty(node: ts.Node): boolean {
  return ts.isPropertyAssignment(node.parent) && NON_COPY_PROPERTIES.has(node.parent.name.getText());
}

function isNonTextAttributeValue(node: ts.Node): boolean {
  const attribute = node.parent && ts.isJsxAttribute(node.parent) ? node.parent : undefined;
  return attribute !== undefined && !TEXT_ATTRIBUTES.has(attribute.name.getText());
}

interface Finding {
  file: string;
  line: number;
  text: string;
}

function scan(file: string): Finding[] {
  const sf = parseSource(file);
  const relative = path.relative(ROOT, file);
  const findings: Finding[] = [];
  const report = (node: ts.Node, text: string) => {
    const trimmed = text.replace(/\s+/g, ' ').trim();
    if (!HAS_LETTER.test(trimmed) || ALLOWED_TEXT.has(trimmed) || LANGUAGE_NEUTRAL.test(trimmed)) return;
    findings.push({ file: relative, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text: trimmed });
  };

  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node) && !isInsideCodeElement(node)) report(node, node.text);
    if (ts.isJsxAttribute(node) && TEXT_ATTRIBUTES.has(node.name.getText()) && node.initializer) {
      const init = node.initializer;
      if (ts.isStringLiteral(init)) report(init, init.text);
      if (ts.isJsxExpression(init) && init.expression && ts.isTemplateExpression(init.expression)) {
        report(init, templateText(init.expression));
      }
    }
    if (ts.isJsxExpression(node) && node.parent && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
      const expr = node.expression;
      if (expr && (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr))) report(expr, expr.text);
    }
    const literal = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : undefined;
    const attributeTemplate = ts.isTemplateExpression(node) && ts.isJsxExpression(node.parent) && ts.isJsxAttribute(node.parent.parent);
    const text = literal ?? (ts.isTemplateExpression(node) && !attributeTemplate ? templateText(node) : undefined);
    if (
      text !== undefined &&
      !CODE_SAMPLE_FILES.has(relative) &&
      (PROSE.test(text) || (literal !== undefined && SHORT_COPY.test(literal) && isMessageProperty(node))) &&
      !ts.isImportDeclaration(node.parent) &&
      !ts.isExportDeclaration(node.parent) &&
      !(ts.isPropertyAssignment(node.parent) && node.parent.name === node) &&
      !isNonTextAttributeValue(node) &&
      !isNonCopyProperty(node) &&
      !isInside(node, isConsoleCall) &&
      !isInside(node, isErrorMessage)
    ) {
      report(node, text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}

describe('the interface source holds no user-visible English', () => {
  it('reads every visible string from the messages', () => {
    const findings = uiFiles().flatMap(scan).map((f) => `${f.file}:${f.line} ${JSON.stringify(f.text)}`);
    expect(findings).toEqual([]);
  });

  it('flags the kinds of copy it is meant to catch', () => {
    const sample = path.join(ROOT, 'tests', 'fixtures', 'i18n-scanner-sample.tsx');
    expect(scan(sample).map((f) => f.text)).toEqual([
      'Converting queued files now...',
      'Failed to load the file list.',
      'Failed',
      'Upload',
      'File size exceeds the x limit.',
      'Visible heading',
      'Close dialog',
      'Search formats',
      'Copied',
      'Remove file x',
    ]);
  });
});
