import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { convertFile } from '../src/lib/conversions';
import {
  ConversionFailedError,
  DataLimitExceededError,
  DataParseError,
  DataRepresentationError,
} from '../src/lib/types';
import { requireOracleTool } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';

/**
 * XML data conversion against independent oracles: Python's minidom (expat) builds the
 * expected JsonML tree, libxml2's xmllint checks well-formedness, canonical form (C14N 1.0)
 * and the XPath string-value. Hand-written JsonML pins the mapping convention itself.
 */

const FIXTURE_DIR = path.resolve(__dirname, 'fixtures/data-text');

type JsonMl = string | [string, ...unknown[]];

function withTempFile<T>(content: Buffer | string, suffix: string, use: (file: string) => T): T {
  const file = path.join(os.tmpdir(), `xml-oracle-${randomUUID()}${suffix}`);
  writeFileSync(file, content);
  try {
    return use(file);
  } finally {
    rmSync(file, { force: true });
  }
}

/** Runs a CLI oracle and fails on a non-zero exit or any diagnostic on stderr. */
function runOracle(tool: 'xmllint' | 'python3', args: string[]): string {
  const result = spawnSync(requireOracleTool(tool), args, { encoding: 'utf-8' });
  if (result.status !== 0 || result.stderr !== '') {
    throw new Error(`${tool} ${args.join(' ')} failed (${result.status}): ${result.stderr}`);
  }
  return result.stdout;
}

/** JsonML built by Python's minidom: element = [name, {attributes}?, ...children], adjacent text merged. */
const MINIDOM_JSONML = [
  'import json, sys',
  'from xml.dom import minidom, Node',
  'def convert(element):',
  '    out = [element.tagName]',
  '    attrs = element.attributes',
  '    if attrs.length:',
  '        # minidom reports the value of a default-namespace undeclaration (xmlns="") as None.',
  '        out.append({attrs.item(i).name: attrs.item(i).value or "" for i in range(attrs.length)})',
  '    text = []',
  '    for child in element.childNodes:',
  '        if child.nodeType in (Node.TEXT_NODE, Node.CDATA_SECTION_NODE):',
  '            text.append(child.data)',
  '        elif child.nodeType == Node.ELEMENT_NODE:',
  '            if text:',
  '                out.append("".join(text)); text.clear()',
  '            out.append(convert(child))',
  '    if text:',
  '        out.append("".join(text))',
  '    return out',
  'print(json.dumps(convert(minidom.parse(sys.argv[1]).documentElement), ensure_ascii=False))',
].join('\n');

function minidomJsonMl(xml: Buffer | string): JsonMl {
  return withTempFile(xml, '.xml', (file) => JSON.parse(runOracle('python3', ['-c', MINIDOM_JSONML, file])) as JsonMl);
}

function canonicalXml(xml: Buffer | string): string {
  return withTempFile(xml, '.xml', (file) => runOracle('xmllint', ['--c14n', file]));
}

function assertWellFormedXml(xml: Buffer | string): void {
  withTempFile(xml, '.xml', (file) => runOracle('xmllint', ['--noout', file]));
}

/** XPath string-value of the document; xmllint appends one newline to the result. */
function xpathStringValue(xml: Buffer | string): string {
  const out = withTempFile(xml, '.xml', (file) => runOracle('xmllint', ['--xpath', 'string(/)', file]));
  expect(out.endsWith('\n')).toBe(true);
  return out.slice(0, -1);
}

async function xmlToJsonMl(xml: Buffer | string): Promise<JsonMl> {
  const input = Buffer.isBuffer(xml) ? xml : Buffer.from(xml, 'utf-8');
  const result = await convertFile(input, 'xml', 'json', {}, 'data.xml');
  expect(result.mimeType).toBe('application/json');
  return JSON.parse(result.buffer.toString('utf-8')) as JsonMl;
}

async function jsonToXml(value: unknown): Promise<Buffer> {
  const result = await convertFile(Buffer.from(JSON.stringify(value), 'utf-8'), 'json', 'xml', {}, 'data.json');
  expect(result.mimeType).toBe('application/xml');
  return result.buffer;
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected the conversion to be rejected');
}

const CORPUS: Readonly<Record<string, string>> = {
  catalog:
    '<?xml version="1.0"?>\n<catalog version="2.0">\n  <item id="A1" active="true">\n    <name>Widget</name>\n' +
    '    <price currency="EUR">19.99</price>\n  </item>\n  <item id="A2"><name>Gadget &amp; Co</name></item>\n</catalog>\n',
  mixed:
    '<p class="lead">Hello <b>bold <i>and italic</i></b>, then <a href="/x?a=1&amp;b=2">a link</a>.<br/>Tail</p>',
  namespaces:
    '<feed xmlns="http://www.w3.org/2005/Atom" xmlns:m="urn:example:meta"><title type="text">T</title>' +
    '<m:rank m:scale="10">3</m:rank><plain xmlns="">no namespace</plain></feed>',
  entities:
    '<!DOCTYPE note [\n<!ENTITY co "Example &#38;#38; Co">\n<!ENTITY full "&co; Ltd.">\n]>\n' +
    '<note by="&full;">&full; &#x263A; &lt;tag&gt; <![CDATA[a < b && c]]> ]]&gt;</note>',
  whitespace: '<r a="tab&#9;nl&#10;cr&#13;end" b="  spaced  ">line1&#13;\nline2\t<e/><e></e></r>',
  attributeDelimiters: `<link href="a/b>c" title='say "hi"' data-x="1/2"/>`,
  unicode: '<r>emoji 😀, astral 𝄞, CJK 漢字</r>',
  userContent:
    '<root><item><name>Product</name><script>alert(1)</script><desc onclick="evil()">Desc</desc>' +
    '<iframe src="https://example.invalid/"/></item></root>',
};

describe('XML to JSON follows the JsonML convention', () => {
  for (const [name, xml] of Object.entries(CORPUS)) {
    oracleTest(`matches the minidom JsonML tree for ${name}`, ['python3'], async () => {
      expect(await xmlToJsonMl(xml)).toEqual(minidomJsonMl(xml));
    });
  }

  it('keeps element, attribute and child order and decodes references (hand-written JsonML)', async () => {
    expect(await xmlToJsonMl(CORPUS.mixed)).toEqual([
      'p',
      { class: 'lead' },
      'Hello ',
      ['b', 'bold ', ['i', 'and italic']],
      ', then ',
      ['a', { href: '/x?a=1&b=2' }, 'a link'],
      '.',
      ['br'],
      'Tail',
    ]);
    const attributes = (await xmlToJsonMl('<r z="1" a="2" m="3"/>')) as [string, Record<string, string>];
    expect(Object.keys(attributes[1])).toEqual(['z', 'a', 'm']);
  });

  it('reads / and > inside attribute values', async () => {
    expect(await xmlToJsonMl(CORPUS.attributeDelimiters)).toEqual([
      'link',
      { href: 'a/b>c', title: 'say "hi"', 'data-x': '1/2' },
    ]);
  });

  it('expands internal entities, character references and CDATA', async () => {
    expect(await xmlToJsonMl(CORPUS.entities)).toEqual([
      'note',
      { by: 'Example & Co Ltd.' },
      'Example & Co Ltd. ☺ <tag> a < b && c ]]>',
    ]);
  });

  it('keeps user content that an SVG sanitizer would strip', async () => {
    expect(await xmlToJsonMl(CORPUS.userContent)).toEqual([
      'root',
      [
        'item',
        ['name', 'Product'],
        ['script', 'alert(1)'],
        ['desc', { onclick: 'evil()' }, 'Desc'],
        ['iframe', { src: 'https://example.invalid/' }],
      ],
    ]);
  });

  it('keeps namespace declarations and prefixed names', async () => {
    expect(await xmlToJsonMl(CORPUS.namespaces)).toEqual([
      'feed',
      { xmlns: 'http://www.w3.org/2005/Atom', 'xmlns:m': 'urn:example:meta' },
      ['title', { type: 'text' }, 'T'],
      ['m:rank', { 'm:scale': '10' }, '3'],
      ['plain', { xmlns: '' }, 'no namespace'],
    ]);
  });

  for (const encoded of ['japanese.shift_jis.xml', 'japanese.utf16le-bom.xml']) {
    oracleTest(`decodes ${encoded} from its BOM or encoding declaration`, ['python3'], async () => {
      const expected = minidomJsonMl(readFileSync(path.join(FIXTURE_DIR, 'japanese.utf8.xml')));
      expect(await xmlToJsonMl(readFileSync(path.join(FIXTURE_DIR, encoded)))).toEqual(expected);
    });
  }
});

describe('XML round trip through JsonML', () => {
  for (const [name, xml] of Object.entries(CORPUS)) {
    oracleTest(`is canonically identical after XML -> JSON -> XML for ${name}`, ['xmllint'], async () => {
      const output = await jsonToXml(await xmlToJsonMl(xml));
      assertWellFormedXml(output);
      expect(canonicalXml(output)).toBe(canonicalXml(xml));
    });
  }

  oracleTest('re-encodes a Shift_JIS document as canonically identical UTF-8', ['xmllint'], async () => {
    const source = readFileSync(path.join(FIXTURE_DIR, 'japanese.shift_jis.xml'));
    const output = await jsonToXml(await xmlToJsonMl(source));
    expect(output.subarray(0, 38).toString('utf-8')).toBe('<?xml version="1.0" encoding="UTF-8"?>');
    expect(canonicalXml(output)).toBe(canonicalXml(source));
  });
});

describe('XML to text', () => {
  for (const [name, xml] of Object.entries(CORPUS)) {
    oracleTest(`equals the XPath string-value for ${name}`, ['xmllint'], async () => {
      const result = await convertFile(Buffer.from(xml, 'utf-8'), 'xml', 'txt', {}, 'data.xml');
      expect(result.buffer.toString('utf-8')).toBe(xpathStringValue(xml));
    });
  }
});

describe('XML to YAML and CSV', () => {
  oracleTest('writes the JsonML tree as YAML that a YAML 1.1 loader reads back', ['python3'], async () => {
    const result = await convertFile(Buffer.from(CORPUS.catalog, 'utf-8'), 'xml', 'yaml', {}, 'catalog.xml');
    const loaded = withTempFile(result.buffer, '.yaml', (file) =>
      JSON.parse(runOracle('python3', ['-c', 'import json, sys, yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1], encoding="utf-8"))))', file]))
    );
    expect(loaded).toEqual(minidomJsonMl(CORPUS.catalog));
  });

  oracleTest('extracts one record per repeated element with attributes and child text', ['python3'], async () => {
    const xml =
      '<catalog><item id="A1"><name>Widget</name><price currency="EUR">19.99</price></item>' +
      '<item id="A2"><name>=cmd</name><tag>x</tag><tag>y</tag></item></catalog>';
    const result = await convertFile(Buffer.from(xml, 'utf-8'), 'xml', 'csv', {}, 'catalog.xml');
    const rows = withTempFile(result.buffer, '.csv', (file) =>
      JSON.parse(
        runOracle('python3', ['-c', 'import csv, json, sys; print(json.dumps(list(csv.reader(open(sys.argv[1], newline="", encoding="utf-8-sig")))))', file])
      )
    );
    expect(rows).toEqual([
      // Attribute columns use "$" ("@" would trip the formula guard), text columns "#text".
      ['$id', 'name', 'price.$currency', 'price.#text', 'tag'],
      ['A1', 'Widget', 'EUR', '19.99', ''],
      ['A2', "'=cmd", '', '', '["x","y"]'],
    ]);
  });
});

describe('XML input fails closed', () => {
  it('refuses external entities instead of loading them', async () => {
    const xxe = '<!DOCTYPE r [<!ENTITY secret SYSTEM "file:///etc/passwd">]><r>&secret;</r>';
    const err = await rejection(xmlToJsonMl(xxe));
    expect(err).toBeInstanceOf(DataParseError);
    expect(err.message).toMatch(/external entity/i);
    expect(err.message).not.toMatch(/root:/);
  });

  it('stops entity expansion bombs with a typed limit error', async () => {
    const levels = ['<!ENTITY lol0 "lollollollollollollollollollol">'];
    for (let level = 1; level <= 9; level++) {
      levels.push(`<!ENTITY lol${level} "${`&lol${level - 1};`.repeat(10)}">`);
    }
    const bomb = `<!DOCTYPE r [${levels.join('')}]><r>&lol9;</r>`;
    const err = await rejection(xmlToJsonMl(bomb));
    expect(err).toBeInstanceOf(DataLimitExceededError);
    expect(err).toBeInstanceOf(ConversionFailedError);
    expect(err.message).toMatch(/entity expansion/i);
  });

  it('rejects parameter entities and recursive entities', async () => {
    const parameter = await rejection(xmlToJsonMl('<!DOCTYPE r [<!ENTITY % p "x"> %p;]><r/>'));
    expect(parameter).toBeInstanceOf(DataParseError);
    expect(parameter.message).toMatch(/parameter entit/i);

    const recursive = await rejection(xmlToJsonMl('<!DOCTYPE r [<!ENTITY a "&b;"><!ENTITY b "&a;">]><r>&a;</r>'));
    expect(recursive).toBeInstanceOf(DataParseError);
    expect(recursive.message).toMatch(/recursive/i);
  });

  it('reports malformed markup with its line number', async () => {
    const err = await rejection(xmlToJsonMl('<a>\n  <b>\n</a>\n'));
    expect(err).toBeInstanceOf(DataParseError);
    expect((err as DataParseError).line).toBe(3);

    const unbound = await rejection(xmlToJsonMl('<r><q:x/></r>'));
    expect(unbound).toBeInstanceOf(DataParseError);
    expect(unbound.message).toMatch(/prefix/i);
  });
});

describe('JSON to XML', () => {
  oracleTest('writes well-formed XML for arbitrary JSON keys and top-level arrays', ['xmllint'], async () => {
    const value = [{ '1st': 1, 'a b': 'x<y&z', '': true, nested: { list: [1, [2, 3]], none: null } }, 'tail'];
    const output = await jsonToXml(value);
    assertWellFormedXml(output);
    expect(output.toString('utf-8')).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n<root><item><_1st>1</_1st><a_b>x&lt;y&amp;z</a_b><_>true</_>' +
        '<nested><list>1</list><list><item>2</item><item>3</item></list><none/></nested></item><item>tail</item></root>'
    );
  });

  it('rejects characters that XML 1.0 cannot carry', async () => {
    const err = await rejection(jsonToXml({ text: 'bell\u0007' }));
    expect(err).toBeInstanceOf(DataRepresentationError);
    expect(err.message).toMatch(/U\+0007/);
  });
});
