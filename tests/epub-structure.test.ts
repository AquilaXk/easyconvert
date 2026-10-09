import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { convertFile } from '../src/lib/conversions';
import { documentToEpub, EPUB_WRITER_MAX_CHAPTERS } from '../src/lib/conversions/document-model/epub';
import { readEpubModel } from '../src/lib/conversions/source-model';
import { blankDocument } from '../src/lib/conversions/document-model/build';
import type { Block, DocumentModel } from '../src/lib/conversions/document-model/model';
import { textRun } from '../src/lib/conversions/document-model/support';
import { ConversionFailedError, EncryptedOfficeDocumentError, PayloadLimitError, UnsupportedOptionError } from '../src/lib/types';
import { oracleTest } from './helpers/oracle-test';
import { runEpubcheck } from './helpers/epubcheck';
import { xmlWellFormed, xpathCount, xpathString } from './helpers/xml-oracle';
import { pythonModuleAvailable, runPythonHelper } from './helpers/python-oracle';
import { requireOracleTool } from './helpers/differential-oracle';
import { skipUnless } from './helpers/strict-skip';
import { expectNoHang } from './helpers/timing';
import { zipEntryBytes, zipEntryText } from './helpers/zip-entry';
import { structureOfHtml } from '../bench/structure-metrics';
import { execFileSync } from 'node:child_process';
import { fixtureBytes } from './helpers/document-fixtures';

/**
 * EPUB output is a navigable, accessible EPUB 3.3 book, and EPUB input is read with its structure. Oracles: W3C
 * EPUBCheck, XPath over the package parts with xmllint, ebooklib (an independent EPUB reader and writer) and a WHATWG
 * HTML parser. Expected structure is written out by hand from the sources below.
 */

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const MARKDOWN = [
  '# Alpha',
  '',
  'Opening text with [a link](https://example.org/a) and **strong** words.',
  '',
  '## Alpha one',
  '',
  'First subsection text.',
  '',
  '## Alpha two',
  '',
  '| name | value |',
  '| --- | --- |',
  '| x | 1 |',
  '',
  '# Beta',
  '',
  `![A tiny square](data:image/png;base64,${PNG_1X1})`,
  '',
  '## Beta one',
  '',
  '- item one',
  '- item two',
  '',
  '# Gamma',
  '',
  'Closing text.',
  '',
  '## Gamma one',
  '',
  'Last text.',
  '',
].join('\n');

async function convertMarkdown(options: Record<string, unknown> = {}): Promise<Buffer> {
  return (await convertFile(Buffer.from(MARKDOWN), 'md', 'epub', options, 'handbook.md')).buffer;
}

const NAV_ENTRIES = ['Alpha', 'Alpha one', 'Alpha two', 'Beta', 'Beta one', 'Gamma', 'Gamma one'];

describe('Markdown to EPUB', () => {
  it('writes one content document per h1 and h2 section and a navigation entry for every heading', async () => {
    const zip = await JSZip.loadAsync(await convertMarkdown());
    const chapters = Object.keys(zip.files).filter((name) => /^OEBPS\/chapter\d+\.xhtml$/.test(name));
    expect(chapters).toHaveLength(7);

    const nav = await zipEntryText(zip, 'OEBPS/nav.xhtml');
    expect(xmlWellFormed(nav).ok).toBe(true);
    const toc = "//*[local-name()='nav' and @*[local-name()='type']='toc']";
    expect(xpathCount(nav, `${toc}//*[local-name()='a']`)).toBe(7);
    const labels = Array.from({ length: 7 }, (_, index) => xpathString(nav, `string((${toc}//*[local-name()='a'])[${index + 1}])`));
    expect(labels).toEqual(NAV_ENTRIES);
    // h2 entries are nested under their h1 entry.
    expect(xpathCount(nav, `${toc}/*[local-name()='ol']/*[local-name()='li']`)).toBe(3);
    expect(xpathCount(nav, `${toc}/*[local-name()='ol']/*[local-name()='li']/*[local-name()='ol']/*[local-name()='li']`)).toBe(4);

    const ncx = await zipEntryText(zip, 'OEBPS/toc.ncx');
    expect(xpathCount(ncx, "//*[local-name()='navPoint']")).toBe(7);
    expect(xpathString(ncx, "string(//*[local-name()='head']/*[local-name()='meta'][@name='dtb:depth']/@content)")).toBe('2');
  });

  it('sets the language on the package and on every content document, from the source or the option', async () => {
    const english = await JSZip.loadAsync(await convertMarkdown({ language: 'en-us' }));
    const opf = await zipEntryText(english, 'OEBPS/content.opf');
    expect(xpathString(opf, "string(//*[local-name()='language'])")).toBe('en-US');
    expect(xpathString(opf, "string(/*[local-name()='package']/@*[local-name()='lang'])")).toBe('en-US');
    for (const name of Object.keys(english.files).filter((entry) => /\.xhtml$/.test(entry))) {
      const document = await zipEntryText(english, name);
      expect(xpathString(document, "string(/*[local-name()='html']/@*[local-name()='lang'])"), name).toBe('en-US');
    }
  });

  it('refuses a language that is not a BCP 47 tag', async () => {
    const failure = await convertMarkdown({ language: 'blue-ish' }).then(() => undefined, (err: unknown) => err);
    expect(failure).toBeInstanceOf(UnsupportedOptionError);
    expect((failure as Error).message).toBe('The language option "blue-ish" is not a BCP 47 language tag.');
  });

  it('recognises Korean text and records the language as undetermined only when nothing says', async () => {
    const korean = await convertFile(Buffer.from('# 제목\n\n한글로 쓰인 문서의 본문입니다. 이 문장은 언어를 판별하기에 충분합니다.\n'), 'md', 'epub', {}, 'ko.md');
    const koreanOpf = await zipEntryText(await JSZip.loadAsync(korean.buffer), 'OEBPS/content.opf');
    expect(xpathString(koreanOpf, "string(//*[local-name()='language'])")).toBe('ko');
    const unknown = await convertFile(Buffer.from('# T\n\nxyz abc\n'), 'md', 'epub', {}, 'x.md');
    const unknownOpf = await zipEntryText(await JSZip.loadAsync(unknown.buffer), 'OEBPS/content.opf');
    expect(xpathString(unknownOpf, "string(//*[local-name()='language'])")).toBe('und');
  });

  it('declares accessibility metadata that the content supports', async () => {
    const zip = await JSZip.loadAsync(await convertMarkdown());
    const opf = await zipEntryText(zip, 'OEBPS/content.opf');
    const values = (property: string): string[] => {
      const count = xpathCount(opf, `//*[local-name()='meta'][@property='${property}']`);
      return Array.from({ length: count }, (_, index) => xpathString(opf, `string((//*[local-name()='meta'][@property='${property}'])[${index + 1}])`));
    };
    expect(values('schema:accessMode')).toEqual(['textual', 'visual']);
    expect(values('schema:accessModeSufficient')).toEqual(['textual']);
    expect(values('schema:accessibilityFeature')).toEqual(['tableOfContents', 'readingOrder', 'structuralNavigation', 'alternativeText']);
    expect(values('schema:accessibilityHazard')).toEqual(['none']);
    expect(values('schema:accessibilitySummary')[0]).toBe(
      'This publication has a table of contents and a linear reading order. Its sections are marked with headings. Every image has a text alternative.'
    );
  });

  it('does not claim text alternatives for images that lack one', async () => {
    const source = `# Only\n\ntext\n\n![](data:image/png;base64,${PNG_1X1})\n`;
    const zip = await JSZip.loadAsync((await convertFile(Buffer.from(source), 'md', 'epub', {}, 'x.md')).buffer);
    const opf = await zipEntryText(zip, 'OEBPS/content.opf');
    expect(xpathCount(opf, "//*[local-name()='meta'][@property='schema:accessibilityFeature'][.='alternativeText']")).toBe(0);
    expect(xpathString(opf, "string(//*[local-name()='meta'][@property='schema:accessModeSufficient'])")).toBe('textual,visual');
  });

  it('keeps links, emphasis, lists, tables and the picture bytes in the content documents', async () => {
    const zip = await JSZip.loadAsync(await convertMarkdown());
    const first = structureOfHtml(await zipEntryText(zip, 'OEBPS/chapter1.xhtml'));
    expect(first.headings).toEqual(['1|Alpha']);
    const table = structureOfHtml(await zipEntryText(zip, 'OEBPS/chapter3.xhtml'));
    expect(table.tableCells).toEqual(['name|1|1', 'value|1|1', 'x|1|1', '1|1|1']);
    const beta = await zipEntryText(zip, 'OEBPS/chapter4.xhtml');
    expect([...beta.matchAll(/<img src="([^"]+)" alt="([^"]*)"/g)].map((match) => [match[1], match[2]])).toEqual([['images/image1.png', 'A tiny square']]);
    const list = structureOfHtml(await zipEntryText(zip, 'OEBPS/chapter5.xhtml'));
    expect(list.listItems).toEqual(['0|ul|item one', '0|ul|item two']);
    const image = await zipEntryBytes(zip, 'OEBPS/images/image1.png');
    expect(image.equals(Buffer.from(PNG_1X1, 'base64'))).toBe(true);
    const chapter1 = await zipEntryText(zip, 'OEBPS/chapter1.xhtml');
    expect(chapter1.match(/<a href="https:\/\/example\.org\/a">a link<\/a>/g)).toHaveLength(1);
    expect(chapter1.match(/<strong>strong<\/strong>/g)).toHaveLength(1);
  });

  oracleTest('passes EPUBCheck with no errors and no warnings', ['epubcheck'], async () => {
    const report = runEpubcheck(await convertMarkdown());
    expect(report.messages.map((message) => `${message.severity} ${message.ID} ${message.message}`)).toEqual([]);
    expect([report.fatals, report.errors, report.warnings]).toEqual([0, 0, 0]);
  }, 240_000);

  oracleTest('is read by ebooklib with the same title, language, chapters, images and table of contents', ['python3'], async () => {
    if (!pythonModuleAvailable('ebooklib')) throw Object.assign(new Error('ebooklib is not installed'), { isOracleSkip: true });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epub-oracle-'));
    try {
      const file = path.join(dir, 'book.epub');
      fs.writeFileSync(file, await convertFile(Buffer.from(MARKDOWN), 'md', 'epub', { language: 'en' }, 'handbook.md').then((result) => result.buffer));
      const facts = runPythonHelper<{ language: string; documents: string[]; images: string[]; spine: string[]; toc: string[] }>('epub_facts.py', [file]);
      expect(facts.language).toBe('en');
      expect(facts.spine.filter((name) => name.startsWith('chapter'))).toEqual(Array.from({ length: 7 }, (_, index) => `chapter${index + 1}.xhtml`));
      expect(facts.images).toEqual(['images/image1.png']);
      expect(facts.toc).toEqual(NAV_ENTRIES);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('writer limits and degenerate documents', () => {
  const heading = (level: number, text: string): Block => ({ type: 'heading', level, runs: [textRun(text)], rtl: false });
  const paragraph = (text: string): Block => ({ type: 'paragraph', runs: [textRun(text)], rtl: false, align: 'left' });
  const documentOf = (blocks: Block[], title?: string): DocumentModel => ({ ...blankDocument([{ columns: 1, blocks }]), title });

  it('refuses a document without content', async () => {
    const failure = await documentToEpub(documentOf([]), { title: 'x' }).then(() => undefined, (err: unknown) => err);
    expect(failure).toBeInstanceOf(ConversionFailedError);
    expect((failure as Error).message).toBe('The document has no content to put in an EPUB.');
  });

  it('refuses a book that would hold more content documents than the limit, without hanging', async () => {
    const blocks: Block[] = [];
    for (let index = 0; index <= EPUB_WRITER_MAX_CHAPTERS; index += 1) blocks.push(heading(1, `h${index}`), paragraph('p'));
    const failure = await expectNoHang('chapter limit', () => documentToEpub(documentOf(blocks), { title: 'x' }).then(() => undefined, (err: unknown) => err));
    expect(failure).toBeInstanceOf(PayloadLimitError);
    expect((failure as Error).message).toBe(`The book would have more than ${EPUB_WRITER_MAX_CHAPTERS} content documents.`);
  });

  it('a heading that directly follows its parent heading stays in the same content document', async () => {
    const model = documentOf([heading(1, 'Part'), heading(2, 'Chapter'), paragraph('text')]);
    const zip = await JSZip.loadAsync(await documentToEpub(model, { title: 'x', language: 'en' }));
    expect(Object.keys(zip.files).filter((name) => /chapter\d+\.xhtml$/.test(name))).toEqual(['OEBPS/chapter1.xhtml']);
    const nav = await zipEntryText(zip, 'OEBPS/nav.xhtml');
    expect(xpathCount(nav, "//*[local-name()='a']")).toBe(2);
  });

  it('a document with no headings has one navigation entry named after the title', async () => {
    const model = documentOf([paragraph('only text')], 'Plain Title');
    const zip = await JSZip.loadAsync(await documentToEpub(model, { title: 'x' }));
    const nav = await zipEntryText(zip, 'OEBPS/nav.xhtml');
    expect(xpathString(nav, "string(//*[local-name()='a'])")).toBe('Plain Title');
  });
});

describe('EPUB input is read with its structure', () => {
  async function authoredBook(): Promise<Buffer | undefined> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epub-author-'));
    try {
      const picture = path.join(dir, 'pic.png');
      const docx = await JSZip.loadAsync(fixtureBytes('rich-structure.docx'));
      fs.writeFileSync(picture, await zipEntryBytes(docx, 'word/media/diagram.png'));
      const book = path.join(dir, 'book.epub');
      execFileSync(requireOracleTool('python3'), ['-I', path.join(__dirname, 'helpers', 'python', 'author_epub.py'), book, picture]);
      return fs.readFileSync(book);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  describe.skipIf(skipUnless('ebooklib', pythonModuleAvailable('ebooklib')))('a book written by ebooklib', () => {
    it('reads headings, nested lists, the link, the table and the picture into the model', async () => {
      const book = (await authoredBook()) as Buffer;
      const model = await readEpubModel(book);
      expect(model.title).toBe('Authored Handbook');
      expect(model.author).toBe('Fixture Author');
      expect(model.language).toBe('en');
      const html = (await convertFile(book, 'epub', 'html', {}, 'book.epub')).buffer.toString('utf-8');
      const structure = structureOfHtml(html);
      expect(structure.headings).toEqual(['1|Opening', '1|Data', '2|Table']);
      expect(structure.listItems).toEqual(['0|ol|First step', '1|ul|Detail one', '1|ul|Detail two', '0|ol|Second step']);
      expect(structure.tableCells).toEqual(['Name|1|1', 'Values|2|1', 'Alpha|1|2', '1|1|1', '2|1|1', '3|1|1', '4|1|1']);
      expect(structure.images).toHaveLength(1);
      expect(html.match(/<a href="https:\/\/example\.org\/a">a link<\/a>/g)).toHaveLength(1);
      expect(html.match(/<strong>strong<\/strong>/g)).toHaveLength(1);
      expect(html.match(/<em>emphasis<\/em>/g)).toHaveLength(1);
      expect(html.match(/<h1>Authored Handbook<\/h1>/g)).toBeNull();
    });

    it('writes the model read from an EPUB back as an EPUB with the same navigation and author', async () => {
      const book = (await authoredBook()) as Buffer;
      const model = await readEpubModel(book);
      const rewritten = await documentToEpub(model, { title: 'Authored Handbook' });
      const zip = await JSZip.loadAsync(rewritten);
      const nav = await zipEntryText(zip, 'OEBPS/nav.xhtml');
      const toc = "//*[local-name()='nav' and @*[local-name()='type']='toc']";
      expect(xpathCount(nav, `${toc}//*[local-name()='a']`)).toBe(3);
      expect(xpathString(await zipEntryText(zip, 'OEBPS/content.opf'), "string(//*[local-name()='creator'])")).toBe('Fixture Author');
    });
  });
});

describe('malformed EPUB containers fail closed', () => {
  async function container(parts: Record<string, string>): Promise<Buffer> {
    const zip = new JSZip();
    zip.file('mimetype', 'application/epub+zip');
    for (const [name, data] of Object.entries(parts)) zip.file(name, data);
    return zip.generateAsync({ type: 'nodebuffer' });
  }
  const CONTAINER = '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>';
  const opf = (manifest: string, spine: string): string =>
    `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>t</dc:title></metadata><manifest>${manifest}</manifest><spine>${spine}</spine></package>`;

  async function failure(parts: Record<string, string>): Promise<Error> {
    const err = await readEpubModel(await container(parts)).then(() => undefined, (error: unknown) => error);
    return err as Error;
  }

  it('a package without META-INF/container.xml', async () => {
    const err = await failure({ 'OEBPS/content.opf': opf('', '') });
    expect(err).toBeInstanceOf(ConversionFailedError);
    expect(err.message).toBe('The EPUB has no META-INF/container.xml, so its package document cannot be found.');
  });

  it('a package document that is not well-formed XML', async () => {
    const err = await failure({ 'META-INF/container.xml': CONTAINER, 'OEBPS/content.opf': '<package><manifest></package>' });
    expect(err.message).toMatch(/OEBPS\/content\.opf is not well-formed XML/);
  });

  it('a spine item that the manifest does not list', async () => {
    const err = await failure({ 'META-INF/container.xml': CONTAINER, 'OEBPS/content.opf': opf('<item id="a" href="a.xhtml" media-type="application/xhtml+xml"/>', '<itemref idref="b"/>') });
    expect(err.message).toBe('The EPUB spine names "b", which the manifest does not list.');
  });

  it('a manifest href that climbs out of the package', async () => {
    const err = await failure({
      'META-INF/container.xml': CONTAINER,
      'OEBPS/content.opf': opf('<item id="a" href="../../etc/passwd" media-type="application/xhtml+xml"/>', '<itemref idref="a"/>'),
    });
    expect(err.message).toBe('The package reference "../../etc/passwd" points outside the package.');
  });

  it('an empty spine', async () => {
    const err = await failure({ 'META-INF/container.xml': CONTAINER, 'OEBPS/content.opf': opf('', '') });
    expect(err.message).toBe('The EPUB package document has an empty spine.');
  });

  it('a content document encrypted with a method other than font obfuscation', async () => {
    const err = await failure({
      'META-INF/container.xml': CONTAINER,
      'META-INF/encryption.xml':
        '<?xml version="1.0"?><encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#"><enc:EncryptedData><enc:EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/><enc:CipherData><enc:CipherReference URI="OEBPS/a.xhtml"/></enc:CipherData></enc:EncryptedData></encryption>',
      'OEBPS/content.opf': opf('<item id="a" href="a.xhtml" media-type="application/xhtml+xml"/>', '<itemref idref="a"/>'),
      'OEBPS/a.xhtml': '<html><body><p>secret</p></body></html>',
    });
    expect(err).toBeInstanceOf(EncryptedOfficeDocumentError);
    expect(err.message).toBe('The EPUB content is protected by DRM, so its text cannot be read.');
  });

  it('a spine longer than the limit is refused without being walked', async () => {
    const items = Array.from({ length: 10_001 }, (_, index) => `<itemref idref="i${index}"/>`).join('');
    const err = await expectNoHang('long spine', () => failure({ 'META-INF/container.xml': CONTAINER, 'OEBPS/content.opf': opf('', items) }));
    expect(err).toBeInstanceOf(PayloadLimitError);
    expect(err.message).toBe('The EPUB spine lists more than 10000 content documents.');
  });
});
