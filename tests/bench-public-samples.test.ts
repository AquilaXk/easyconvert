import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { companionOf, CorpusError, ensureSample, readRemoteManifest, type RemoteSample, resetVerifiedSamples, validateRemoteManifest } from '../bench/corpora';
import { picturesOfFb2, textOfFb2 } from '../bench/families/ebook';
import { truthWordsOf, wordRecallOf } from '../bench/families/document-public';
import { htmlText, markdownText, rtfText, sourceText } from '../bench/office-words';

/**
 * What the further families add to the sample system of phase 1: a file that belongs to a sample (a companion), the manifest of
 * the eight families, and the readers that give the office documents, books and drawings their truth. The files themselves are
 * fetched by the benchmark and not here.
 */

const MANIFEST = readRemoteManifest();
const FAMILIES = ['document', 'pdf-ops', 'ebook', 'font', 'cad', 'raw', 'vector', 'data'];
const MIN_CLASSES_PER_FAMILY = 4;
const base = { schemaVersion: 1, sets: { s: { title: 'a set', terms: 'https://example.com/terms' } } };
const sample = (overrides: Partial<RemoteSample> = {}): RemoteSample => ({
  id: 'x.svg',
  family: 'vector',
  class: 'shapes',
  set: 's',
  description: 'a sample',
  origin: { kind: 'file', url: 'https://example.com/x.svg' },
  bytes: 3,
  sha256: createHash('sha256').update('abc').digest('hex'),
  licence: 'MIT',
  meta: {},
  companions: [{ role: 'truth', origin: { kind: 'file', url: 'https://example.com/x.png' }, bytes: 3, sha256: createHash('sha256').update('png').digest('hex') }],
  ...overrides,
});

describe('the samples of the further families', () => {
  it('span at least four content classes in every family', () => {
    for (const family of FAMILIES) {
      const classes = new Set(MANIFEST.samples.filter((item) => item.family === family).map((item) => item.class));
      expect(classes.size, family).toBeGreaterThanOrEqual(MIN_CLASSES_PER_FAMILY);
    }
  });

  it('keep the files of the real-world corpus under the digests that corpus pins', () => {
    const realworld = new Map((JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'bench', 'realworld', 'manifest.json'), 'utf8')) as { files: Array<{ origin: unknown; sha256: string; size: number }> }).files.map((file) => [JSON.stringify(file.origin), file] as const));
    const shared = MANIFEST.samples.filter((item) => realworld.has(JSON.stringify(item.origin)));
    expect(shared.length).toBeGreaterThan(30);
    for (const item of shared) {
      const file = realworld.get(JSON.stringify(item.origin));
      expect(item.sha256, item.id).toBe(file?.sha256);
      expect(item.bytes, item.id).toBe(file?.size);
    }
  });
});

describe('the companion of a sample', () => {
  let cache: string;
  beforeEach(() => {
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'public-companion-'));
    resetVerifiedSamples();
  });
  afterEach(() => {
    fs.rmSync(cache, { recursive: true, force: true });
  });

  it('is validated like a sample: a unique role, a digest, a size and an https address', () => {
    expect(() => validateRemoteManifest({ ...base, samples: [sample()] })).not.toThrow();
    const companion = sample().companions?.[0] as NonNullable<RemoteSample['companions']>[number];
    expect(() => validateRemoteManifest({ ...base, samples: [sample({ companions: [companion, companion] })] })).toThrow(/companion roles/);
    expect(() => validateRemoteManifest({ ...base, samples: [sample({ companions: [{ ...companion, sha256: 'ABC' }] })] })).toThrow(CorpusError);
    expect(() => validateRemoteManifest({ ...base, samples: [sample({ companions: [{ ...companion, origin: { kind: 'file', url: 'http://example.com/x.png' } }] })] })).toThrow(/https/);
  });

  it('is fetched into the cache of its family under its own digest, and fails closed on other bytes', async () => {
    const file = companionOf(sample(), 'truth');
    expect(file.id).toBe('x.svg.truth');
    const stored = await ensureSample(file, { cacheDir: cache, download: async () => Buffer.from('png') });
    expect(stored).toBe(path.join(cache, 'vector', file.sha256));
    expect(fs.readFileSync(stored, 'utf8')).toBe('png');
    resetVerifiedSamples();
    fs.rmSync(path.join(cache, 'vector'), { recursive: true });
    await expect(ensureSample(file, { cacheDir: cache, download: async () => Buffer.from('pnx') })).rejects.toThrow(/does not measure other bytes/);
    expect(fs.existsSync(path.join(cache, 'vector'))).toBe(false);
  });

  it('is refused when the sample has none under that role', () => {
    expect(() => companionOf(sample(), 'text')).toThrow(/has no text companion/);
  });
});

describe('the text of an RTF document', () => {
  it('resolves escapes, Unicode with its fallback characters, code-page bytes and paragraph ends', () => {
    const rtf = String.raw`{\rtf1\ansi\ansicpg1252\deff0{\fonttbl{\f0 Arial;}}{\colortbl;\red0\green0\blue0;}{\*\generator Hidden;}\pard Caf\'e9 \u21644?\uc1 \u-10179?\u-8704? done\par second {\b bold} \{brace\}\par}`;
    const lines = rtfText(Buffer.from(rtf, 'latin1')).split('\n').map((line) => line.trim()).filter(Boolean);
    expect(lines).toEqual(['Café 和\u{1F600} done', 'second bold {brace}']);
  });

  it('decodes the bytes of a double-byte code page', () => {
    const shiftJis = Buffer.concat([Buffer.from(String.raw`{\rtf1\ansi\ansicpg932 `, 'latin1'), Buffer.from(String.raw`\'93\'fa\'96\'7b`, 'latin1'), Buffer.from('}', 'latin1')]);
    expect(rtfText(shiftJis).trim()).toBe('日本');
  });

  it('refuses a file that is no RTF', () => {
    expect(() => rtfText(Buffer.from('plain text'))).toThrow(/RTF header/);
  });
});

describe('the text of HTML, Markdown, FictionBook and OOXML packages', () => {
  it('leaves out scripts, styles, the head and comments of an HTML page, and decodes its entities', () => {
    const text = htmlText(Buffer.from('<html><head><title>No</title><style>p{}</style></head><body><!-- no --><script>var no;</script><p>Fish &amp; chips &#8212; yes</p></body></html>'));
    expect(truthWordsOf(text)).toEqual(['fish', 'chips', 'yes']);
  });

  it('keeps the text of a Markdown link and drops its target', () => {
    expect(truthWordsOf(markdownText(Buffer.from('# Title\n\nSee [the docs](https://example.com/x) and `code`.\n')))).toEqual(['title', 'see', 'the', 'docs', 'and', 'code']);
  });

  it('reads the text of the body elements of a FictionBook file and counts its pictures', () => {
    const xml = '<FictionBook><description><title-info><book-title>Not text</book-title></title-info></description><body><section><p>One &amp; two</p></section></body><body name="notes"><p>Note</p></body><binary id="a" content-type="image/png">AAAA</binary><binary id="b" content-type="image/jpeg">BBBB</binary></FictionBook>';
    expect(truthWordsOf(textOfFb2(xml))).toEqual(['one', 'two', 'note']);
    expect(picturesOfFb2(xml)).toBe(2);
  });

  it('reads a Word package without deleted revisions, fallback copies of shapes, or field codes, and with the text of its charts', async () => {
    const zip = new JSZip();
    zip.file(
      'word/document.xml',
      '<w:document><w:body><w:p><w:r><w:t>kept</w:t></w:r><w:del><w:r><w:delText>deleted</w:delText></w:r></w:del><w:r><w:instrText>FIELDCODE</w:instrText></w:r><mc:AlternateContent><mc:Choice><w:r><w:t>choice</w:t></w:r></mc:Choice><mc:Fallback><w:r><w:t>fallback</w:t></w:r></mc:Fallback></mc:AlternateContent></w:p></w:body></w:document>'
    );
    zip.file('word/footnotes.xml', '<w:footnotes><w:footnote><w:p><w:r><w:t>note</w:t></w:r></w:p></w:footnote></w:footnotes>');
    zip.file('word/charts/chart1.xml', '<c:chartSpace><c:title><a:t>Chart title</a:t></c:title><c:strCache><c:pt><c:v>Category A</c:v></c:pt></c:strCache><c:numCache><c:pt><c:v>1234</c:v></c:pt></c:numCache></c:chartSpace>');
    const file = path.join(os.tmpdir(), `public-samples-${process.pid}.docx`);
    fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));
    try {
      const words = truthWordsOf(await sourceText('docx', file, { server: () => { throw new Error('no server needed'); } }));
      expect(words).toEqual(['kept', 'choice', 'note', 'chart', 'title', 'category', 'a']);
    } finally {
      fs.unlinkSync(file);
    }
  });

  it('reads a workbook as its strings and a deck as the runs of its slides', async () => {
    const sheet = new JSZip();
    sheet.file('xl/sharedStrings.xml', '<sst><si><t>alpha</t></si><si><r><t>be</t></r><r><t>ta</t></r></si></sst>');
    sheet.file('xl/worksheets/sheet1.xml', '<worksheet><sheetData><row><c t="inlineStr"><is><t>gamma</t></is></c><c><v>42</v></c></row></sheetData></worksheet>');
    const deck = new JSZip();
    deck.file('ppt/slides/slide2.xml', '<p:sld><a:t>second</a:t></p:sld>');
    deck.file('ppt/slides/slide10.xml', '<p:sld><a:t>tenth</a:t></p:sld>');
    deck.file('ppt/slides/slide1.xml', '<p:sld><a:t>first</a:t></p:sld>');
    deck.file('ppt/notesSlides/notesSlide1.xml', '<p:notes><a:t>notes</a:t></p:notes>');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'public-samples-ooxml-'));
    try {
      fs.writeFileSync(path.join(dir, 'a.xlsx'), await sheet.generateAsync({ type: 'nodebuffer' }));
      fs.writeFileSync(path.join(dir, 'a.pptx'), await deck.generateAsync({ type: 'nodebuffer' }));
      const none = { server: (): never => { throw new Error('no server needed'); } };
      expect(truthWordsOf(await sourceText('xlsx', path.join(dir, 'a.xlsx'), none))).toEqual(['alpha', 'beta', 'gamma']);
      expect(truthWordsOf(await sourceText('pptx', path.join(dir, 'a.pptx'), none))).toEqual(['first', 'second', 'tenth']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the word recall of the public documents', () => {
  it('counts each occurrence once and every CJK character as a word of its own', () => {
    const truth = truthWordsOf('the cat the 猫と犬');
    expect(truth).toEqual(['the', 'cat', 'the', '猫', 'と', '犬']);
    expect(wordRecallOf(truth, 'the cat 猫 犬')).toBeCloseTo(4 / 6, 10);
    expect(wordRecallOf(truth, 'The CAT the\n猫\nと犬')).toBe(1);
    expect(wordRecallOf(truth, '')).toBe(0);
  });
});
