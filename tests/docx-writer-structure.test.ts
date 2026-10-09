import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { convertFile } from '../src/lib/conversions';
import { readDocxModel } from '../src/lib/conversions/docx-model';
import { writeDocx } from '../src/lib/conversions/docx-writer';
import { writeEpub } from '../src/lib/conversions/epub-writer';
import { PayloadLimitError, UnsupportedOptionError } from '../src/lib/types';
import { oracleTest } from './helpers/oracle-test';
import { xmlWellFormed, xpathCount, xpathString } from './helpers/xml-oracle';
import { pythonModuleAvailable, runPythonHelper } from './helpers/python-oracle';
import { skipUnless } from './helpers/strict-skip';
import { sofficeConvert } from './helpers/soffice-convert';
import { characterErrorRatePercent } from './helpers/ocr-cer';
import { fixtureBytes, richStructureImageHashes, richStructureTruth, sha256 } from './helpers/document-fixtures';
import { zipEntryBytes, zipEntryText } from './helpers/zip-entry';
import { scoreStructure, structureOfHtml } from '../bench/structure-metrics';

/**
 * DOCX output is written from the block model: real styles, numbering, tables with merged cells, hyperlinks through
 * relationships, pictures in word/media and notes parts. Oracles: python-docx (an independent Word reader), xmllint
 * XPath over the package parts, and LibreOffice, which reads the output and converts it to text and HTML.
 */

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const MARKDOWN = [
  '# Report',
  '',
  'Intro with [a link](https://example.org/a), **bold** and *italic* words.',
  '',
  '## Steps',
  '',
  '1. first step',
  '2. second step',
  '   - detail',
  '',
  '| name | value |',
  '| --- | --- |',
  '| x | 1 |',
  '| y | 2 |',
  '',
  `![A tiny square](data:image/png;base64,${PNG_1X1})`,
  '',
  '> a quotation',
  '',
].join('\n');

/** XPath step for an element or attribute by local name, whatever its prefix. */
const w = (name: string): string => `*[local-name()='${name}']`;
const partXml = async (zip: JSZip, name: string): Promise<string> => zipEntryText(zip, name);

async function markdownDocx(): Promise<Buffer> {
  return (await convertFile(Buffer.from(MARKDOWN), 'md', 'docx', {}, 'report.md')).buffer;
}

interface DocxFacts {
  headings: { style: string; text: string }[];
  tables: string[][][];
  inlineShapes: number;
  text: string[];
}

describe('Markdown to DOCX', () => {
  it('writes styles, a numbered list, a table, a hyperlink relationship and the picture bytes', async () => {
    const zip = await JSZip.loadAsync(await markdownDocx());
    for (const name of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/numbering.xml', 'word/settings.xml', 'word/_rels/document.xml.rels', 'docProps/core.xml']) {
      expect(xmlWellFormed(await partXml(zip, name)).ok, name).toBe(true);
    }
    const document = await partXml(zip, 'word/document.xml');
    expect(xpathCount(document, `//${w('tbl')}`)).toBe(1);
    expect(xpathCount(document, `//${w('tbl')}/${w('tr')}`)).toBe(3);
    expect(xpathString(document, `string(//${w('p')}[${w('pPr')}/${w('pStyle')}/@${w('val')}='Heading1'][1])`)).toBe('Report');
    expect(xpathCount(document, `//${w('p')}[${w('pPr')}/${w('pStyle')}[@${w('val')}='Heading2']]`)).toBe(1);
    expect(xpathCount(document, `//${w('p')}/${w('pPr')}/${w('numPr')}`)).toBe(3);
    expect(xpathCount(document, `//${w('hyperlink')}`)).toBe(1);
    expect(xpathCount(document, `//${w('drawing')}`)).toBe(1);

    const relationships = await partXml(zip, 'word/_rels/document.xml.rels');
    expect(xpathString(relationships, "string(//*[local-name()='Relationship'][@TargetMode='External']/@Target)")).toBe('https://example.org/a');
    const media = await zipEntryBytes(zip, 'word/media/image1.png');
    expect(media.equals(Buffer.from(PNG_1X1, 'base64'))).toBe(true);
    const contentTypes = await partXml(zip, '[Content_Types].xml');
    expect(xpathString(contentTypes, "string(//*[local-name()='Default'][@Extension='png']/@ContentType)")).toBe('image/png');

    const numbering = await partXml(zip, 'word/numbering.xml');
    // One numbering instance per list: the numbered list and the nested bullet list.
    expect(xpathCount(numbering, `//${w('num')}`)).toBe(2);
    expect(xpathString(numbering, `string(//${w('abstractNum')}[1]/${w('lvl')}[@${w('ilvl')}='0']/${w('numFmt')}/@${w('val')})`)).toBe('decimal');
  });

  oracleTest('python-docx finds the headings, the table and the picture', ['python3'], async () => {
    if (!pythonModuleAvailable('docx')) throw Object.assign(new Error('python-docx is not installed'), { isOracleSkip: true });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-writer-'));
    try {
      const file = path.join(dir, 'report.docx');
      fs.writeFileSync(file, await markdownDocx());
      const facts = runPythonHelper<DocxFacts>('docx_facts.py', [file]);
      expect(facts.headings.map((heading) => `${heading.style}|${heading.text}`)).toEqual(['Heading 1|Report', 'Heading 2|Steps']);
      expect(facts.tables).toEqual([[['name', 'value'], ['x', '1'], ['y', '2']]]);
      expect(facts.inlineShapes).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  oracleTest('LibreOffice reads the document and returns the same text', ['soffice'], async () => {
    const text = sofficeConvert(await markdownDocx(), 'report.docx', 'txt:Text', (output) => output.read().toString('utf-8'));
    for (const expected of ['Report', 'Intro with a link, bold and italic words.', 'Steps', 'first step', 'second step', 'detail', 'a quotation', 'name', 'value']) {
      expect(text.replace(/\s+/g, ' ')).toContain(expected);
    }
  }, 180_000);
});

describe('EPUB to DOCX', () => {
  it('keeps the heading count, the table and the list of the book', async () => {
    const epub = await convertFile(Buffer.from(MARKDOWN), 'md', 'epub', { language: 'en' }, 'report.md');
    const docx = (await convertFile(epub.buffer, 'epub', 'docx', {}, 'report.epub')).buffer;
    const zip = await JSZip.loadAsync(docx);
    const document = await partXml(zip, 'word/document.xml');
    expect(xpathCount(document, `//${w('p')}[${w('pPr')}/${w('pStyle')}[starts-with(@${w('val')},'Heading')]]`)).toBe(2);
    expect(xpathCount(document, `//${w('tbl')}`)).toBe(1);
    expect(xpathCount(document, `//${w('tc')}`)).toBe(6);
    expect(xpathCount(document, `//${w('p')}/${w('pPr')}/${w('numPr')}`)).toBe(3);
    expect(xpathString(await partXml(zip, 'docProps/core.xml'), "string(//*[local-name()='language'])")).toBe('en');
  });

  oracleTest('a LibreOffice text export of the result differs from the source text by at most 2%', ['soffice'], async () => {
    const epub = await convertFile(Buffer.from(MARKDOWN), 'md', 'epub', { language: 'en' }, 'report.md');
    const docx = (await convertFile(epub.buffer, 'epub', 'docx', {}, 'report.epub')).buffer;
    const exported = sofficeConvert(docx, 'report.docx', 'txt:Text', (output) => output.read().toString('utf-8'));
    const source =
      'Report Intro with a link, bold and italic words. Steps 1. first step 2. second step detail name value x 1 y 2 a quotation';
    expect(characterErrorRatePercent(source, exported)).toBeLessThanOrEqual(2);
  }, 180_000);
});

describe('DOCX round trip through the model', () => {
  it('rich-structure.docx read and written again keeps the structure LibreOffice finds', async () => {
    const { model } = await readDocxModel(await JSZip.loadAsync(fixtureBytes('rich-structure.docx')));
    const written = await writeDocx(model, { title: 'rich-structure' });
    const zip = await JSZip.loadAsync(written);
    const document = await partXml(zip, 'word/document.xml');
    expect(xpathCount(document, `//${w('tbl')}`)).toBe(1);
    expect(xpathCount(document, `//${w('tc')}[${w('tcPr')}/${w('vMerge')}]`)).toBe(2);
    expect(xpathCount(document, `//${w('tc')}[${w('tcPr')}/${w('gridSpan')}[@${w('val')}='2']]`)).toBe(1);
    expect(xpathCount(document, `//${w('footnoteReference')}`)).toBe(1);
    expect(xpathCount(document, `//${w('endnoteReference')}`)).toBe(1);
    expect(xpathCount(await partXml(zip, 'word/footnotes.xml'), `//${w('footnote')}[not(@${w('type')})]`)).toBe(1);
    const hashes = await richStructureImageHashes();
    expect([sha256(await zipEntryBytes(zip, 'word/media/image1.jpg')), sha256(await zipEntryBytes(zip, 'word/media/image2.png'))]).toEqual([hashes.jpeg, hashes.png]);
  });

  oracleTest('LibreOffice reads the written rich-structure document with every heading, list item, table cell, picture and note', ['soffice'], async () => {
    const { model } = await readDocxModel(await JSZip.loadAsync(fixtureBytes('rich-structure.docx')));
    const written = await writeDocx(model, { title: 'rich-structure' });
    const truth = await richStructureTruth();
    const structure = sofficeConvert(written, 'written.docx', 'html', (output) =>
      structureOfHtml(output.read().toString('utf-8'), (src) => output.sibling(src))
    );
    const scores = scoreStructure(truth, structure);
    expect(Object.fromEntries(Object.entries(scores).map(([category, score]) => [category, [score.precision, score.recall]]))).toEqual({
      headings: [1, 1],
      listItems: [1, 1],
      tableCells: [1, 1],
      images: [1, 1],
      notes: [1, 1],
    });
  }, 180_000);
});

describe('limits', () => {
  it('refuses a language that is not a BCP 47 tag', async () => {
    const failure = await writeDocx({ blocks: [{ kind: 'paragraph', inlines: [{ kind: 'text', text: 'x' }] }], footnotes: [], endnotes: [], warnings: [] }, { title: 'x', language: 'blue-ish' }).then(
      () => undefined,
      (err: unknown) => err
    );
    expect(failure).toBeInstanceOf(UnsupportedOptionError);
    expect((failure as Error).message).toBe('The language option "blue-ish" is not a BCP 47 language tag.');
  });

  it('refuses more pictures than the limit', async () => {
    const image = { kind: 'image' as const, image: { data: Buffer.from(PNG_1X1, 'base64'), mime: 'image/png' as const, alt: '' } };
    // Distinct bytes per picture: the writer merges identical ones.
    const inlines = Array.from({ length: 5001 }, (_unused, index) => ({ ...image, image: { ...image.image, data: Buffer.concat([image.image.data, Buffer.from(String(index))]) } }));
    const failure = await writeDocx({ blocks: [{ kind: 'paragraph', inlines }], footnotes: [], endnotes: [], warnings: [] }, { title: 'x' }).then(
      () => undefined,
      (err: unknown) => err
    );
    expect(failure).toBeInstanceOf(PayloadLimitError);
    expect((failure as Error).message).toBe('The document would embed more than 5000 pictures.');
  });

  it('EPUB written from a DOCX model keeps the same heading count', async () => {
    const { model } = await readDocxModel(await JSZip.loadAsync(fixtureBytes('rich-structure.docx')));
    const zip = await JSZip.loadAsync(await writeEpub(model, { title: 'x' }));
    const nav = await zipEntryText(zip, 'OEBPS/nav.xhtml');
    expect(xpathCount(nav, "//*[local-name()='a']")).toBe(6);
  });
});

describe.skipIf(skipUnless('python-docx', pythonModuleAvailable('docx')))('python-docx reads the written round trip', () => {
  it('finds the heading styles of the original document', async () => {
    const { model } = await readDocxModel(await JSZip.loadAsync(fixtureBytes('rich-structure.docx')));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-roundtrip-'));
    try {
      const file = path.join(dir, 'written.docx');
      fs.writeFileSync(file, await writeDocx(model, { title: 'rich-structure' }));
      const facts = runPythonHelper<DocxFacts>('docx_facts.py', [file]);
      expect(facts.headings.map((heading) => heading.text)).toEqual(['Pump Station Handbook', '1 Overview', 'Scope', 'Readings', '2 Images', 'Sub heading by inheritance']);
      expect(facts.inlineShapes).toBe(2);
      expect(facts.tables).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
