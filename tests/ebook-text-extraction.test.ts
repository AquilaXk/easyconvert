import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { convertFile } from '../src/lib/conversions';
import { generateFb2FromText } from '../src/lib/conversions/office';
import { ConversionFailedError } from '../src/lib/types';
import { EncryptedOfficeDocumentError } from '../src/lib/conversions/office/legacy-office-errors';
import { readMobiText } from '../src/lib/conversions/office/mobi-reader';
import { pmlToText } from '../src/lib/conversions/office/pml-reader';
import { htmlToText } from '../src/lib/conversions/office/html-text';
import { oracleTest } from './helpers/oracle-test';
import { requireOracleTool } from './helpers/differential-oracle';
import { buildMobi, KNOWN_PALMDOC_VECTOR, palmDocCompress } from './helpers/mobi-builder';
import { flatOdt, normalizeWhitespace, sofficeConvert, xmlEscape } from './helpers/soffice-office';

/**
 * Ebook and OpenDocument readers extract the book's own text. The expected values come from the text the
 * fixtures are authored from, from xmllint (an independent XML parser) reading the same XHTML or FictionBook
 * files, from iconv for legacy encodings, from LibreOffice's own text export of the same ODT, and from hand
 * derived PalmDOC and PML vectors. No fixture comes from the writers under test.
 */

const NATIVE_TIMEOUT_MS = 120_000;

async function textOf(file: Buffer, src: string): Promise<string> {
  return (await convertFile(file, src, 'txt', {}, `book.${src}`)).buffer.toString('utf-8');
}

function paragraphsOf(text: string): string[] {
  return text.split(/\n\n+/).map((p) => p.trim()).filter((p) => p !== '');
}

/** The text nodes of every p, h1-h3 and li of an XHTML or FictionBook file, in document order, as xmllint reads them. */
function xmllintParagraphs(xml: Buffer, names: readonly string[]): string[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xmllint-oracle-'));
  try {
    const file = path.join(dir, 'doc.xml');
    fs.writeFileSync(file, xml);
    const tool = requireOracleTool('xmllint');
    const selection = `(//*[${names.map((n) => `local-name()="${n}"`).join(' or ')}])`;
    const count = Number(execFileSync(tool, ['--xpath', `count${selection}`, file], { encoding: 'utf-8' }));
    const out: string[] = [];
    for (let n = 1; n <= count; n += 1) {
      out.push(normalizeWhitespace(execFileSync(tool, ['--xpath', `string(${selection}[${n}])`, file], { encoding: 'utf-8' })));
    }
    return out.filter((p) => p !== '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// EPUB
// ---------------------------------------------------------------------------

interface EpubChapter {
  path: string;
  xhtml: string | Buffer;
  mediaType?: string;
  properties?: string;
}

interface EpubFixture {
  /** Content documents in the order the zip stores them (a different order from the spine). */
  chapters: EpubChapter[];
  spine: string[];
  nonLinear?: string[];
  packagePath?: string;
  encryption?: string;
  extraFiles?: Record<string, string>;
}

async function buildEpub(fixture: EpubFixture): Promise<Buffer> {
  const packagePath = fixture.packagePath ?? 'OEBPS/content.opf';
  const dir = packagePath.includes('/') ? packagePath.slice(0, packagePath.lastIndexOf('/') + 1) : '';
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="${packagePath}" media-type="application/oebps-package+xml"/></rootfiles></container>`);
  const manifestItems = fixture.chapters
    .map((c, i) => `<item id="c${i}" href="${encodeURI(c.path.slice(dir.length))}" media-type="${c.mediaType ?? 'application/xhtml+xml'}"${c.properties ? ` properties="${c.properties}"` : ''}/>`)
    .join('');
  const idOf = (chapterPath: string) => `c${fixture.chapters.findIndex((c) => c.path === chapterPath)}`;
  const itemrefs = [
    ...fixture.spine.map((p) => `<itemref idref="${idOf(p)}"/>`),
    ...(fixture.nonLinear ?? []).map((p) => `<itemref idref="${idOf(p)}" linear="no"/>`),
  ].join('');
  zip.file(packagePath, `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><manifest>${manifestItems}<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/></manifest><spine toc="ncx">${itemrefs}</spine></package>`);
  zip.file(`${dir}toc.ncx`, '<ncx><navMap><navPoint><navLabel><text>NCX LABEL MUST NOT APPEAR</text></navLabel></navPoint></navMap></ncx>');
  for (const chapter of fixture.chapters) zip.file(chapter.path, chapter.xhtml);
  if (fixture.encryption) zip.file('META-INF/encryption.xml', fixture.encryption);
  for (const [name, content] of Object.entries(fixture.extraFiles ?? {})) zip.file(name, content);
  return zip.generateAsync({ type: 'nodebuffer' });
}

const xhtml = (body: string, head = '') => `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>HEAD TITLE MUST NOT APPEAR</title>${head}</head><body>${body}</body></html>`;

describe('EPUB text follows the package spine', () => {
  const chapterOne = xhtml('<h1>Chapter One</h1><p>First paragraph &amp; “quoted” — dash.</p><p>Second&#160;paragraph with <em>emphasis</em> and a break.</p>', '<style>p { color: red }</style><script>var HIDDEN = 1;</script>');
  const chapterTwo = xhtml('<h2>Chapter Two</h2><p>Korean 한국어 and accented café.</p><ul><li>item one</li><li>item two</li></ul>');
  const chapterThree = xhtml('<p>Third chapter lives in a sub folder.</p>');
  const navigation = xhtml('<nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops"><ol><li>NAVIGATION ENTRY MUST NOT APPEAR</li></ol></nav>');
  const notes = xhtml('<p>Non linear footnote chapter.</p>');

  async function fixtureBook(): Promise<Buffer> {
    return buildEpub({
      // The zip stores chapter two first and the navigation document in the middle; the spine says one, two, three.
      chapters: [
        { path: 'OEBPS/text/two.xhtml', xhtml: chapterTwo },
        { path: 'OEBPS/nav.xhtml', xhtml: navigation, properties: 'nav' },
        { path: 'OEBPS/one.xhtml', xhtml: chapterOne },
        { path: 'OEBPS/text/sub/three file.xhtml', xhtml: chapterThree },
        { path: 'OEBPS/notes.xhtml', xhtml: notes },
      ],
      spine: ['OEBPS/nav.xhtml', 'OEBPS/one.xhtml', 'OEBPS/text/two.xhtml', 'OEBPS/text/sub/three file.xhtml'],
      nonLinear: ['OEBPS/notes.xhtml'],
    });
  }

  oracleTest('epub -> txt is the body text of each chapter in spine order, as xmllint reads it', ['xmllint'], async () => {
    const text = await textOf(await fixtureBook(), 'epub');
    const names = ['h1', 'h2', 'p', 'li'];
    const expected = [chapterOne, chapterTwo, chapterThree, notes].flatMap((doc) => xmllintParagraphs(Buffer.from(doc, 'utf-8'), names));
    expect(paragraphsOf(text).flatMap((p) => p.split('\n')).map(normalizeWhitespace)).toEqual(expected.flatMap((p) => p.split('\n')).map(normalizeWhitespace));
    for (const absent of ['HEAD TITLE', 'HIDDEN', 'color: red', 'NAVIGATION ENTRY', 'NCX LABEL']) expect(text).not.toContain(absent);
  }, NATIVE_TIMEOUT_MS);

  it('keeps entities and non-ASCII text exactly, chapter by chapter', async () => {
    expect(paragraphsOf(await textOf(await fixtureBook(), 'epub'))).toEqual([
      'Chapter One',
      'First paragraph & “quoted” — dash.',
      'Second\u00a0paragraph with emphasis and a break.',
      'Chapter Two',
      'Korean 한국어 and accented café.',
      'item one',
      'item two',
      'Third chapter lives in a sub folder.',
      'Non linear footnote chapter.',
    ]);
  });

  it('keeps a line break as a line break and drops scripts, styles and the head', () => {
    expect(htmlToText('<html><head><title>T</title></head><body><p>one<br/>two</p><script>x()</script><style>p{}</style><div>three</div></body></html>')).toBe('one\ntwo\n\nthree');
  });

  it('reads a UTF-8 byte order mark and a UTF-16 chapter', async () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xhtml('<p>UTF sixteen text</p>'), 'utf16le')]);
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(xhtml('<p>Byte order mark text</p>'), 'utf-8')]);
    const book = await buildEpub({
      chapters: [{ path: 'OEBPS/a.xhtml', xhtml: bom }, { path: 'OEBPS/b.xhtml', xhtml: utf16 }],
      spine: ['OEBPS/a.xhtml', 'OEBPS/b.xhtml'],
    });
    expect(paragraphsOf(await textOf(book, 'epub'))).toEqual(['Byte order mark text', 'UTF sixteen text']);
  });

  it('resolves the package document wherever container.xml puts it', async () => {
    const book = await buildEpub({ chapters: [{ path: 'book/pkg/ch.xhtml', xhtml: xhtml('<p>deep package</p>') }], spine: ['book/pkg/ch.xhtml'], packagePath: 'book/pkg/package.opf' });
    expect(await textOf(book, 'epub')).toBe('deep package');
  });

  it('refuses a DRM-protected chapter with the 422 encrypted-document error, and reads a book that only obfuscates fonts', async () => {
    const encrypted = (algorithm: string, uri: string) =>
      `<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#"><enc:EncryptedData><enc:EncryptionMethod Algorithm="${algorithm}"/><enc:CipherData><enc:CipherReference URI="${uri}"/></enc:CipherData></enc:EncryptedData></encryption>`;
    const chapters = [{ path: 'OEBPS/ch.xhtml', xhtml: xhtml('<p>secret</p>') }];
    const drm = await buildEpub({ chapters, spine: ['OEBPS/ch.xhtml'], encryption: encrypted('http://www.w3.org/2001/04/xmlenc#aes128-cbc', 'OEBPS/ch.xhtml') });
    const run = convertFile(drm, 'epub', 'txt', {}, 'drm.epub');
    await expect(run).rejects.toBeInstanceOf(EncryptedOfficeDocumentError);
    await expect(run).rejects.toMatchObject({ status: 422 });
    const fonts = await buildEpub({ chapters, spine: ['OEBPS/ch.xhtml'], encryption: encrypted('http://www.idpf.org/2008/embedding', 'OEBPS/font.otf') });
    expect(await textOf(fonts, 'epub')).toBe('secret');
  });

  it.each([
    ['a file that is not a ZIP package', Buffer.from('not a zip'), /not a valid ZIP package/],
    ['a package without container.xml', null, /has no META-INF\/container\.xml/],
  ])('refuses %s with a typed 400 error', async (_name, bytes, message) => {
    const input = bytes ?? (await (async () => {
      const zip = new JSZip();
      zip.file('mimetype', 'application/epub+zip');
      return zip.generateAsync({ type: 'nodebuffer' });
    })());
    const run = convertFile(input, 'epub', 'txt', {}, 'bad.epub');
    await expect(run).rejects.toBeInstanceOf(ConversionFailedError);
    await expect(run).rejects.toThrow(message);
  });

  it('refuses a spine that names a missing document, a spine id the manifest lacks, a path above the package, and a book without text', async () => {
    const missing = await buildEpub({ chapters: [{ path: 'OEBPS/ch.xhtml', xhtml: xhtml('<p>x</p>') }], spine: ['OEBPS/ch.xhtml'] });
    const zip = await JSZip.loadAsync(missing);
    zip.remove('OEBPS/ch.xhtml');
    await expect(convertFile(await zip.generateAsync({ type: 'nodebuffer' }), 'epub', 'txt', {}, 'm.epub')).rejects.toThrow(/names "OEBPS\/ch\.xhtml", which is not in the package/);

    const dangling = await JSZip.loadAsync(missing);
    dangling.file('OEBPS/content.opf', (await dangling.file('OEBPS/content.opf')!.async('string')).replace('idref="c0"', 'idref="nope"'));
    await expect(convertFile(await dangling.generateAsync({ type: 'nodebuffer' }), 'epub', 'txt', {}, 'd.epub')).rejects.toThrow(/names "nope", which the manifest does not list/);

    const escape = await JSZip.loadAsync(missing);
    escape.file('OEBPS/content.opf', (await escape.file('OEBPS/content.opf')!.async('string')).replace('href="ch.xhtml"', 'href="../../../etc/passwd"'));
    await expect(convertFile(await escape.generateAsync({ type: 'nodebuffer' }), 'epub', 'txt', {}, 'e.epub')).rejects.toThrow(/points outside the package/);

    const empty = await buildEpub({ chapters: [{ path: 'OEBPS/ch.xhtml', xhtml: xhtml('<p>   </p>') }], spine: ['OEBPS/ch.xhtml'] });
    await expect(convertFile(empty, 'epub', 'pdf', {}, 'empty.epub')).rejects.toThrow('The EPUB holds no text.');
    await expect(convertFile(empty, 'epub', 'html', {}, 'empty.epub')).rejects.toThrow('The EPUB holds no text.');
  });
});

// ---------------------------------------------------------------------------
// FB2
// ---------------------------------------------------------------------------

describe('FB2 text is the text of the body sections', () => {
  const fb2 = (encoding: string, body: string) =>
    `<?xml version="1.0" encoding="${encoding}"?><FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0"><description><title-info><book-title>Title Of Book</book-title><author><first-name>Ann</first-name><last-name>Writer</last-name></author><annotation><p>ANNOTATION MUST NOT APPEAR</p></annotation></title-info></description>${body}<binary id="cover" content-type="image/png">iVBORw0KGgo=</binary></FictionBook>`;
  const story =
    '<body><title><p>Part One</p></title><section><title><p>Section Title</p></title><epigraph><p>An epigraph line.</p><text-author>Epigraph Author</text-author></epigraph><p>First paragraph &amp; more.</p><empty-line/><poem><stanza><v>Poem line one</v><v>Poem line two</v></stanza></poem><subtitle>A subtitle</subtitle><cite><p>Quoted text.</p></cite></section></body>' +
    '<body name="notes"><section><title><p>Notes</p></title><p>Note body text.</p></section></body>';

  oracleTest('fb2 -> txt keeps body paragraphs, poem lines, subtitles and notes in order, and drops the description', ['xmllint'], async () => {
    const xml = Buffer.from(fb2('utf-8', story), 'utf-8');
    const text = await textOf(xml, 'fb2');
    const bodies = xmllintParagraphs(xml, ['p', 'v', 'subtitle', 'text-author']).filter((p) => p !== 'ANNOTATION MUST NOT APPEAR');
    expect(paragraphsOf(text)).toEqual(bodies);
    expect(text).not.toContain('ANNOTATION');
    expect(paragraphsOf(text)).toContain('Poem line two');
  }, NATIVE_TIMEOUT_MS);

  oracleTest('windows-1251 FB2 is decoded with its declared encoding (bytes written by iconv)', ['iconv'], async () => {
    const russian = fb2('windows-1251', '<body><section><p>Привет, мир! Это текст.</p></section></body>');
    const bytes = execFileSync(requireOracleTool('iconv'), ['-f', 'UTF-8', '-t', 'CP1251'], { input: russian });
    expect(bytes.includes(Buffer.from('Привет', 'utf-8'))).toBe(false);
    expect(await textOf(bytes, 'fb2')).toBe('Привет, мир! Это текст.');
  });

  it.each([
    ['not a FictionBook', '<html><body><p>x</p></body></html>', /not a FictionBook document with a body/],
    ['a book without body text', fb2('utf-8', '<body><section></section></body>'), /The FB2 book holds no text\./],
    ['an unknown encoding', fb2('x-nonexistent-9', '<body><p>x</p></body>'), /declares the encoding "x-nonexistent-9"/],
  ])('refuses %s with a typed 400 error', async (_name, xml, message) => {
    const run = convertFile(Buffer.from(xml, 'utf-8'), 'fb2', 'txt', {}, 'bad.fb2');
    await expect(run).rejects.toBeInstanceOf(ConversionFailedError);
    await expect(run).rejects.toThrow(message);
  });
});

// ---------------------------------------------------------------------------
// ODT
// ---------------------------------------------------------------------------

describe('ODT text is the paragraphs and headings of the document', () => {
  const PARAGRAPHS = ['First paragraph', 'Café 한국어 日本語', 'Third “paragraph” — dash'];

  oracleTest('odt -> txt equals the LibreOffice text export of the same file', ['soffice'], async () => {
    const odt = sofficeConvert(flatOdt(PARAGRAPHS), 'fodt', 'odt', 'odt');
    const reference = sofficeConvert(odt, 'odt', 'txt:Text (encoded):UTF8', 'txt').toString('utf-8');
    expect(paragraphsOf(await textOf(odt, 'odt'))).toEqual(paragraphsOf(reference.replace(/\r?\n/g, '\n\n')));
    expect(paragraphsOf(await textOf(odt, 'odt'))).toEqual(PARAGRAPHS);
  }, NATIVE_TIMEOUT_MS);

  oracleTest('spaces, tabs, line breaks, headings and table cells are read like LibreOffice reads them', ['soffice'], async () => {
    const flat = Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?><office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" office:version="1.2" office:mimetype="application/vnd.oasis.opendocument.text"><office:body><office:text>' +
        '<text:h text:outline-level="1">Heading one</text:h>' +
        `<text:p>Gap<text:s text:c="4"/>here<text:tab/>tabbed<text:line-break/>second line ${xmlEscape('<&>')}</text:p>` +
        '<table:table table:name="T"><table:table-column table:number-columns-repeated="2"/><table:table-row><table:table-cell office:value-type="string"><text:p>cell A</text:p></table:table-cell><table:table-cell office:value-type="string"><text:p>cell B</text:p></table:table-cell></table:table-row></table:table>' +
        '<text:p>After table</text:p></office:text></office:body></office:document>',
      'utf-8'
    );
    const odt = sofficeConvert(flat, 'fodt', 'odt', 'odt');
    const reference = normalizeWhitespace(sofficeConvert(odt, 'odt', 'txt:Text (encoded):UTF8', 'txt').toString('utf-8'));
    const ours = normalizeWhitespace(await textOf(odt, 'odt'));
    expect(ours).toBe(reference);
    expect(await textOf(odt, 'odt')).toContain('Gap    here\ttabbed\nsecond line <&>');
  }, NATIVE_TIMEOUT_MS);

  it('refuses a file that is not an OpenDocument text package, one without text, and a password protected one, with typed errors', async () => {
    await expect(convertFile(Buffer.from('plain text, not a zip'), 'odt', 'txt', {}, 'bad.odt')).rejects.toThrow(/not a valid ZIP package/);

    const wrong = new JSZip();
    wrong.file('mimetype', 'application/vnd.oasis.opendocument.spreadsheet', { compression: 'STORE' });
    wrong.file('content.xml', '<office:document-content/>');
    await expect(convertFile(await wrong.generateAsync({ type: 'nodebuffer' }), 'odt', 'txt', {}, 'wrong.odt')).rejects.toThrow(/not an OpenDocument text document/);

    const empty = new JSZip();
    empty.file('mimetype', 'application/vnd.oasis.opendocument.text', { compression: 'STORE' });
    empty.file('content.xml', '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"><office:body><office:text/></office:body></office:document-content>');
    await expect(convertFile(await empty.generateAsync({ type: 'nodebuffer' }), 'odt', 'txt', {}, 'empty.odt')).rejects.toThrow('The ODT file holds no text.');

    const locked = new JSZip();
    locked.file('mimetype', 'application/vnd.oasis.opendocument.text', { compression: 'STORE' });
    locked.file('content.xml', 'ciphertext');
    locked.file('META-INF/manifest.xml', '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"><manifest:encryption-data manifest:checksum-type="SHA1/1K"/></manifest:file-entry></manifest:manifest>');
    const run = convertFile(await locked.generateAsync({ type: 'nodebuffer' }), 'odt', 'txt', {}, 'locked.odt');
    await expect(run).rejects.toBeInstanceOf(EncryptedOfficeDocumentError);
    await expect(run).rejects.toMatchObject({ status: 422 });
  });
});

// ---------------------------------------------------------------------------
// MOBI
// ---------------------------------------------------------------------------

describe('MOBI text is decompressed from the PalmDB records', () => {
  const HTML = '<html><head><title>NOT TEXT</title></head><body><h1>Title</h1><p>First &quot;paragraph&quot; and a caf\u00e9.</p><p>Second<br/>line</p><mbp:pagebreak/><p>Third &amp; last</p></body></html>';
  const EXPECTED = ['Title', 'First "paragraph" and a café.', 'Second\nline', 'Third & last'];

  it('decodes the hand-derived PalmDOC vector', () => {
    const book = buildMobi({ textRecords: [KNOWN_PALMDOC_VECTOR.compressed], compression: 2, encoding: 1252, textLength: KNOWN_PALMDOC_VECTOR.text.length });
    expect(readMobiText(book)).toBe(KNOWN_PALMDOC_VECTOR.text);
  });

  it('reads Windows-1252 text in uncompressed records, with the euro sign and curly quotes', () => {
    const html = '<p>caf\u00e9 \u20ac 5 \u201cquoted\u201d</p>';
    const bytes = execFileSync(requireOracleTool('iconv'), ['-f', 'UTF-8', '-t', 'CP1252'], { input: html });
    const book = buildMobi({ textRecords: [bytes], compression: 1, encoding: 1252, textLength: bytes.length });
    expect(readMobiText(book)).toBe('café € 5 “quoted”');
  });

  it('reads UTF-8 text compressed over several records, with trailing entries that are not text', () => {
    const full = Buffer.from(HTML.repeat(120).replace(/caf\u00e9/g, 'caf\u00e9 한국어'), 'utf-8');
    const pieces: Buffer[] = [];
    for (let at = 0; at < full.length; at += 4096) pieces.push(full.subarray(at, at + 4096));
    // Flag bit 1: every record ends in one trailing entry (two data bytes and a length byte of 3); bit 0 is not set.
    const trailing = Buffer.from([0xde, 0xad, 0x83]);
    const records = pieces.map((piece) => Buffer.concat([palmDocCompress(piece), trailing]));
    const book = buildMobi({ textRecords: records, compression: 2, encoding: 65001, extraFlags: 2, textLength: full.length });
    const expected = paragraphsOf(htmlToText(full.toString('utf-8')));
    expect(paragraphsOf(readMobiText(book))).toEqual(expected);
    expect(readMobiText(book)).toContain('café 한국어');
    expect(readMobiText(book)).not.toContain('NOT TEXT');
  });

  it('keeps paragraphs, line breaks and page breaks of the markup', () => {
    const text = Buffer.from(HTML, 'utf-8');
    const book = buildMobi({ textRecords: [palmDocCompress(text)], compression: 2, encoding: 65001, textLength: text.length });
    expect(paragraphsOf(readMobiText(book))).toEqual(EXPECTED);
  });

  it('reads a plain PalmDOC book as text, not markup', () => {
    const text = Buffer.from('1 < 2 and <b> stays text', 'latin1');
    const book = buildMobi({ textRecords: [text], compression: 1, encoding: 1252, textLength: text.length, plainPalmDoc: true });
    expect(readMobiText(book)).toBe('1 < 2 and <b> stays text');
  });

  it('is what mobi -> txt answers', async () => {
    const text = Buffer.from(HTML, 'utf-8');
    const book = buildMobi({ textRecords: [palmDocCompress(text)], compression: 2, encoding: 65001, textLength: text.length });
    expect(paragraphsOf(await textOf(book, 'mobi'))).toEqual(EXPECTED);
    expect(paragraphsOf(await textOf(book, 'azw3'))).toEqual(EXPECTED);
  });

  it('refuses DRM with the 422 error, Huffman compression, and damaged books with typed 400 errors', async () => {
    const text = Buffer.from(HTML, 'utf-8');
    const base = { textRecords: [palmDocCompress(text)], compression: 2 as const, encoding: 65001, textLength: text.length };
    expect(() => readMobiText(buildMobi({ ...base, encryption: 2 }))).toThrow(EncryptedOfficeDocumentError);
    expect(() => readMobiText(buildMobi({ ...base, compression: 17480 }))).toThrow(/Huffman \(HUFF\/CDIC\) compression/);
    expect(() => readMobiText(buildMobi({ ...base, encoding: 936 }))).toThrow(/text encoding 936/);
    expect(() => readMobiText(Buffer.alloc(40))).toThrow(/shorter than a PalmDB header/);
    const wrongType = buildMobi(base);
    wrongType.write('NOPE', 60, 'latin1');
    expect(() => readMobiText(wrongType)).toThrow(/not those of an e-book/);
    const badReference = buildMobi({ ...base, textRecords: [Buffer.from([0x80, 0x31])] });
    expect(() => readMobiText(badReference)).toThrow(/points before the start of the record/);
    const noText = Buffer.from('<html><body></body></html>', 'utf-8');
    expect(() => readMobiText(buildMobi({ ...base, textRecords: [palmDocCompress(noText)] }))).toThrow('The e-book holds no text.');
    await expect(convertFile(Buffer.from('plain text pretending to be mobi'.padEnd(200)), 'mobi', 'txt', {}, 'fake.mobi')).rejects.toBeInstanceOf(ConversionFailedError);
  });
});

// ---------------------------------------------------------------------------
// PML, HTMLZ, TXTZ and the readers that fail closed
// ---------------------------------------------------------------------------

describe('other e-book containers', () => {
  it('reads PML by the reference: page breaks, character codes, invisible text and quoted arguments', () => {
    const pml = '\\x\\B Chapter\\x\\n\n\\c\\i\\u Centered \\a233t\\U00e9\\U20ac\\c\\v hidden comment \\v\nVisible \\\\ text\\p\n\\T="10%"Indented \\q="#note"link\\q.\\w="50%"\n\\Fn="fn1"foot\\Fn\\Sp up\\Sp \\C0="Index title"\\Sd="s1"side\\Sd';
    expect(pmlToText(pml)).toBe('Chapter\n\nCentered été€\n\nVisible \\ text\n\nIndented link.\n\nfoot up side');
  });

  it('refuses a PML command outside the reference with a typed error', () => {
    expect(() => pmlToText('text \\Z oops')).toThrow(/command \\Z at character 5/);
    expect(() => pmlToText('text \\T="10%')).toThrow(/never closed/);
  });

  it('reads pml, htmlz, txtz and the single-file oeb package through their converters', async () => {
    expect(await textOf(Buffer.from('Plain \\a233\\p second', 'latin1'), 'pml')).toBe('Plain é\n\nsecond');

    const htmlz = new JSZip();
    htmlz.file('index.html', '<html><head><style>x{}</style></head><body><p>HTMLZ body</p></body></html>');
    htmlz.file('images/cover.png', 'png');
    expect(await textOf(await htmlz.generateAsync({ type: 'nodebuffer' }), 'htmlz')).toBe('HTMLZ body');

    const txtz = new JSZip();
    txtz.file('index.txt', 'TXTZ text\nsecond line');
    expect(await textOf(await txtz.generateAsync({ type: 'nodebuffer' }), 'txtz')).toBe('TXTZ text\nsecond line');

    const oeb = '<?xml version="1.0"?><package><text>\n<![CDATA[\nOEB package text\n]]>\n  </text></package>';
    const epub = await JSZip.loadAsync((await convertFile(Buffer.from(oeb), 'oeb', 'epub', {}, 'book.oeb')).buffer);
    const chapters = await Promise.all(Object.keys(epub.files).filter((n) => /\.xhtml$/.test(n)).map((n) => epub.files[n].async('string')));
    expect(chapters.join(' ')).toContain('OEB package text');
  });

  it.each([
    ['azw4', Buffer.from('anything'), /Print Replica book keeps its pages as a PDF/],
    ['pml', Buffer.from('\\p  \n'), /The PML book holds no text/],
    ['oeb', Buffer.from('<package/>'), /holds no text: its content documents are separate files/],
  ])('%s without readable text is a typed 400 error', async (src, bytes, message) => {
    const run = convertFile(bytes, src, src === 'oeb' ? 'epub' : 'txt', {}, `book.${src}`);
    await expect(run).rejects.toBeInstanceOf(ConversionFailedError);
    await expect(run).rejects.toThrow(message);
  });

  it('refuses an lwp or pub file without text instead of inventing a document', async () => {
    const run = convertFile(Buffer.from('   \n'), 'lwp', 'docx', {}, 'blank.lwp');
    await expect(run).rejects.toBeInstanceOf(ConversionFailedError);
    await expect(run).rejects.toThrow('The .lwp file holds no text.');
  });
});

describe('presentations and writers no longer invent text', () => {
  it('refuses an ODP that is not a package, has no content, or has no slides', async () => {
    await expect(convertFile(Buffer.from('not a zip'), 'odp', 'txt', {}, 'bad.odp')).rejects.toThrow(/not a valid ZIP package/);
    const noContent = new JSZip();
    noContent.file('mimetype', 'application/vnd.oasis.opendocument.presentation');
    await expect(convertFile(await noContent.generateAsync({ type: 'nodebuffer' }), 'odp', 'txt', {}, 'nc.odp')).rejects.toThrow('The ODP file has no content.xml.');
    const noSlides = new JSZip();
    noSlides.file('content.xml', '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"><office:body><office:presentation/></office:body></office:document-content>');
    await expect(convertFile(await noSlides.generateAsync({ type: 'nodebuffer' }), 'odp', 'txt', {}, 'ns.odp')).rejects.toThrow('The ODP file has no slides.');
  });

  it('refuses to write slides or an FB2 book from no text', async () => {
    await expect(convertFile(Buffer.from('   '), 'txt', 'pptx', {}, 'empty.txt')).rejects.toThrow('There is no text to put on slides.');
    expect(() => generateFb2FromText('  \n ', 'Empty')).toThrow('There is no text to write as an FB2 book.');
  });
});
