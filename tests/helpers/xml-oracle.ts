import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { requireOracleTool } from './differential-oracle';

/**
 * XML oracles backed by the reference `xmllint` binary: well-formedness, XPath queries and
 * schema validation. Nothing here uses the code under test to read the documents.
 */

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'alto');
const ALTO_SCHEMA = path.join(FIXTURE_DIR, 'alto-4-4.xsd');
const XLINK_SCHEMA = path.join(FIXTURE_DIR, 'xlink.xsd');
/** The URL alto-4-4.xsd imports the XLink schema from; it no longer resolves, so a catalog redirects it. */
const XLINK_SCHEMA_URL = 'http://www.loc.gov/standards/xlink/xlink.xsd'; // NOSONAR S5332: catalog key that must equal the XSD's import string; never fetched (xmllint --nonet)
const XMLLINT_TIMEOUT_MS = 60_000;
const XMLLINT_MAX_BUFFER_BYTES = 256 * 1024 * 1024;

let catalogPath: string | null = null;

function altoCatalog(): string {
  if (catalogPath && fs.existsSync(catalogPath)) return catalogPath;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alto-catalog-'));
  catalogPath = path.join(dir, 'catalog.xml');
  fs.writeFileSync(
    catalogPath,
    `<?xml version="1.0"?>\n<catalog xmlns="urn:oasis:names:tc:entity:xmlns:xml:catalog">\n` +
      `  <system systemId="${XLINK_SCHEMA_URL}" uri="${pathToFileURL(XLINK_SCHEMA).href}"/>\n</catalog>\n`
  );
  return catalogPath;
}

export interface XmllintResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function runXmllint(args: string[], xml: string, env: NodeJS.ProcessEnv = process.env): XmllintResult {
  const tool = requireOracleTool('xmllint');
  const run = spawnSync(tool, ['--nonet', ...args, '-'], {
    input: xml,
    encoding: 'utf-8',
    timeout: XMLLINT_TIMEOUT_MS,
    maxBuffer: XMLLINT_MAX_BUFFER_BYTES,
    env,
  });
  if (run.error) throw run.error;
  if (run.status === null) throw new Error(`xmllint was terminated by signal ${run.signal}`);
  return { ok: run.status === 0, stdout: run.stdout, stderr: run.stderr };
}

/** Whether `xmllint --noout` accepts the document as well-formed XML (no DTD or schema checks). */
export function xmlWellFormed(xml: string): XmllintResult {
  return runXmllint(['--noout'], xml);
}

/** Validates against the vendored ALTO 4.4 schema. */
export function validateAlto44(xml: string): XmllintResult {
  return runXmllint(['--noout', '--schema', ALTO_SCHEMA], xml, { ...process.env, XML_CATALOG_FILES: altoCatalog() });
}

/** Evaluates an XPath expression and returns xmllint's raw text output. */
export function xpathText(xml: string, expression: string): string {
  const result = runXmllint(['--xpath', expression], xml);
  if (!result.ok) throw new Error(`xmllint xpath failed for ${expression}: ${result.stderr}`);
  return result.stdout;
}

/** The string value of an XPath expression such as `string(//x)`; xmllint adds one trailing line feed. */
export function xpathString(xml: string, expression: string): string {
  const out = xpathText(xml, expression);
  return out.endsWith('\n') ? out.slice(0, -1) : out;
}

export function xpathCount(xml: string, expression: string): number {
  return Number.parseInt(xpathText(xml, `count(${expression})`), 10);
}

const ATTRIBUTE_LINE = /^\s*[\w:-]+="(.*)"$/;

/** Decodes xmllint's attribute serialization: numeric references first, `&amp;` last. */
function unescapeAttribute(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Values of the attributes an XPath attribute expression selects, in document order. */
export function xpathAttributes(xml: string, expression: string): string[] {
  const out = xpathText(xml, expression);
  const values: string[] = [];
  for (const line of out.split('\n')) {
    if (line.trim() === '') continue;
    const match = ATTRIBUTE_LINE.exec(line);
    if (!match) throw new Error(`Unexpected xmllint attribute output: ${line}`);
    values.push(unescapeAttribute(match[1]));
  }
  return values;
}
