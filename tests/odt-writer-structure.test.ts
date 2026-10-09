import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { convertFile } from '../src/lib/conversions';
import { oracleTest } from './helpers/oracle-test';
import { xmlWellFormed, xpathCount, xpathString } from './helpers/xml-oracle';
import { sofficeConvert } from './helpers/soffice-convert';
import { fixtureBytes, richStructureImageHashes, richStructureTruth, sha256 } from './helpers/document-fixtures';
import { zipEntryBytes, zipEntryText } from './helpers/zip-entry';
import { scoreStructure, structureOfHtml } from '../bench/structure-metrics';

/**
 * DOCX to ODT keeps tables (merged cells included), lists, headings, pictures and notes. Oracles: xmllint XPath over
 * the ODF parts, and LibreOffice reading the result.
 */

const RICH = fixtureBytes('rich-structure.docx');
const o = (name: string): string => `*[local-name()='${name}']`;

async function richOdt(): Promise<Buffer> {
  return (await convertFile(RICH, 'docx', 'odt', {}, 'rich-structure.docx')).buffer;
}

describe('docx to odt', () => {
  it('writes a well-formed ODF package whose first entry is the stored mimetype', async () => {
    const odt = await richOdt();
    const zip = await JSZip.loadAsync(odt);
    expect(Object.keys(zip.files)[0]).toBe('mimetype');
    expect(await zipEntryText(zip, 'mimetype')).toBe('application/vnd.oasis.opendocument.text');
    for (const part of ['content.xml', 'styles.xml', 'meta.xml', 'META-INF/manifest.xml']) {
      expect(xmlWellFormed(await zipEntryText(zip, part)).ok, part).toBe(true);
    }
  });

  it('keeps headings, the table with its merged cells, lists, notes and the hyperlink', async () => {
    const zip = await JSZip.loadAsync(await richOdt());
    const content = await zipEntryText(zip, 'content.xml');
    expect(xpathCount(content, `//${o('h')}`)).toBe(6);
    expect(xpathString(content, `string(//${o('h')}[1]/@*[local-name()='outline-level'])`)).toBe('1');
    expect(xpathCount(content, `//${o('table')}`)).toBe(1);
    expect(xpathCount(content, `//${o('table-row')}`)).toBe(4);
    expect(xpathCount(content, `//${o('table-cell')}[@*[local-name()='number-columns-spanned']='2']`)).toBe(1);
    expect(xpathCount(content, `//${o('table-cell')}[@*[local-name()='number-rows-spanned']='2']`)).toBe(1);
    expect(xpathCount(content, `//${o('covered-table-cell')}`)).toBe(2);
    expect(xpathCount(content, `//${o('list-item')}`)).toBe(13);
    expect(xpathCount(content, `//${o('note')}[@*[local-name()='note-class']='footnote']`)).toBe(1);
    expect(xpathCount(content, `//${o('note')}[@*[local-name()='note-class']='endnote']`)).toBe(1);
    expect(xpathString(content, `string(//${o('a')}/@*[local-name()='href'])`)).toBe('https://example.org/portal');
  });

  it('carries the pictures with their original bytes', async () => {
    const zip = await JSZip.loadAsync(await richOdt());
    const hashes = await richStructureImageHashes();
    expect([sha256(await zipEntryBytes(zip, 'Pictures/image1.jpg')), sha256(await zipEntryBytes(zip, 'Pictures/image2.png'))]).toEqual([hashes.jpeg, hashes.png]);
    const manifest = await zipEntryText(zip, 'META-INF/manifest.xml');
    expect(xpathCount(manifest, `//${o('file-entry')}[starts-with(@*[local-name()='full-path'],'Pictures/')]`)).toBe(2);
  });

  oracleTest('LibreOffice reads the document with every heading, list item, table cell, picture and note', ['soffice'], async () => {
    const truth = await richStructureTruth();
    const structure = sofficeConvert(await richOdt(), 'result.odt', 'html', (output) => structureOfHtml(output.read().toString('utf-8'), (src) => output.sibling(src)));
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

describe('other sources to odt', () => {
  it('Markdown becomes headings, a numbered list and a table, not paragraphs of raw text', async () => {
    const source = '# Title\n\n1. one\n2. two\n\n| a | b |\n| - | - |\n| 1 | 2 |\n';
    const zip = await JSZip.loadAsync((await convertFile(Buffer.from(source), 'md', 'odt', {}, 'doc.md')).buffer);
    const content = await zipEntryText(zip, 'content.xml');
    expect(xpathCount(content, `//${o('h')}`)).toBe(1);
    expect(xpathCount(content, `//${o('list-item')}`)).toBe(2);
    expect(xpathCount(content, `//${o('table-cell')}`)).toBe(4);
    expect(xpathString(content, `string(//${o('h')})`)).toBe('Title');
  });
});
