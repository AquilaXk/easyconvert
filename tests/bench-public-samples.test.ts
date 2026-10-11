import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PublicClassRows } from '../bench/public-classes';
import {
  CLASS_CASE_PREFIX,
  ensurePublicSample,
  isPublicCase,
  PUBLIC_FAMILIES,
  PublicDigestError,
  PublicFetchError,
  type PublicSample,
  publicFile,
  readPublicManifest,
  resetVerifiedPublicSamples,
  validatePublicManifest,
} from '../bench/public-samples';
import { corpusTier, PUBLIC_QUICK_CASES, PUBLIC_SPEED_SAMPLES, publicCaseScope } from '../bench/public-scope';
import { markdownText, htmlText, rtfText, sourceText } from '../bench/office-words';
import { textOfFb2, picturesOfFb2 } from '../bench/families/ebook';
import { truthWordsOf, wordRecallOf } from '../bench/families/document-public';
import { measuredRow } from '../bench/rows';
import { SPEC } from '../bench/rows';

/**
 * The public sample sets of the document, PDF, ebook, font, CAD, RAW, vector and data families: the manifest that pins them,
 * the fetcher that fails closed on a digest, the scope rules that keep a pull request quick, the per-class aggregation and the
 * readers that give the office documents their truth. The files themselves are fetched by the benchmark and not here.
 */

const MANIFEST = readPublicManifest();
const PROVENANCE = fs.readFileSync(path.join(__dirname, '..', 'bench', 'corpus', 'PROVENANCE.md'), 'utf8');
const MIN_SAMPLES_PER_FAMILY = 10;
const MIN_CLASSES_PER_FAMILY = 4;
/** The most public cases a family adds to the pull request run. */
const MAX_QUICK_CASES_PER_FAMILY = 5;

const sample = (overrides: Partial<PublicSample> = {}): PublicSample => ({
  id: 'x.bin',
  family: 'font',
  class: 'truetype',
  set: 's',
  description: 'a sample',
  origin: { kind: 'file', url: 'https://example.com/x.bin' },
  bytes: 3,
  sha256: createHash('sha256').update('abc').digest('hex'),
  licence: 'MIT',
  meta: {},
  ...overrides,
});

describe('the manifest of the public samples', () => {
  it('lists at least ten samples in every family, spanning at least four content classes', () => {
    for (const family of PUBLIC_FAMILIES) {
      const samples = MANIFEST.samples.filter((item) => item.family === family);
      expect(samples.length, `${family} samples`).toBeGreaterThanOrEqual(MIN_SAMPLES_PER_FAMILY);
      expect(new Set(samples.map((item) => item.class)).size, `${family} classes`).toBeGreaterThanOrEqual(MIN_CLASSES_PER_FAMILY);
    }
  });

  it('records the licence of every sample on its row in bench/corpus/PROVENANCE.md', () => {
    for (const item of MANIFEST.samples) {
      const row = PROVENANCE.split('\n').find((line) => line.startsWith(`| \`${item.id}\` |`));
      expect(row, `${item.id} has a row`).toBeDefined();
      expect(row as string, `${item.id} names its licence`).toContain(item.licence);
      expect(row as string, `${item.id} names its set`).toContain(`\`${item.set}\``);
    }
  });

  it('pins every sample and companion to an https address, a size and a SHA-256, with a terms page for every set', () => {
    for (const item of MANIFEST.samples) {
      expect(item.sha256, item.id).toMatch(/^[0-9a-f]{64}$/);
      expect(item.bytes, item.id).toBeGreaterThan(0);
      for (const companion of item.companions ?? []) expect(companion.sha256, `${item.id} ${companion.role}`).toMatch(/^[0-9a-f]{64}$/);
    }
    for (const [name, set] of Object.entries(MANIFEST.sets)) expect(set.terms, name).toMatch(/^https:\/\//);
    expect(new Set(MANIFEST.samples.map((item) => item.set))).toEqual(new Set(Object.keys(MANIFEST.sets)));
  });

  it('keeps the files of the real-world corpus under the digests that corpus pins', () => {
    const realworld = new Map((JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'bench', 'realworld', 'manifest.json'), 'utf8')) as { files: Array<{ origin: unknown; sha256: string; size: number }> }).files.map((file) => [JSON.stringify(file.origin), file] as const));
    const shared = MANIFEST.samples.filter((item) => realworld.has(JSON.stringify(item.origin)));
    expect(shared.length).toBeGreaterThan(30);
    for (const item of shared) {
      const file = realworld.get(JSON.stringify(item.origin));
      expect(item.sha256, item.id).toBe(file?.sha256);
      expect(item.bytes, item.id).toBe(file?.size);
    }
  });

  it('refuses a manifest with a missing licence, a bad digest, a duplicate id or an unknown set', () => {
    const base = { schemaVersion: 1, sets: { s: { title: 'a set', terms: 'https://example.com/terms' } } };
    expect(() => validatePublicManifest({ ...base, samples: [sample()] })).not.toThrow();
    expect(() => validatePublicManifest({ ...base, samples: [sample({ licence: '' })] })).toThrow(/licence is missing/);
    expect(() => validatePublicManifest({ ...base, samples: [sample({ sha256: 'ABC' })] })).toThrow(/sha256/);
    expect(() => validatePublicManifest({ ...base, samples: [sample(), sample()] })).toThrow(/duplicate/);
    expect(() => validatePublicManifest({ ...base, samples: [sample({ set: 'other' })] })).toThrow(/unknown set/);
    expect(() => validatePublicManifest({ ...base, samples: [sample({ id: 'a->b' })] })).toThrow(/safe file name/);
    expect(() => validatePublicManifest({ ...base, samples: [sample({ origin: { kind: 'file', url: 'http://example.com/x' } })] })).toThrow(/https/);
  });
});

describe('the fetcher', () => {
  let cache: string;
  beforeEach(() => {
    cache = fs.mkdtempSync(path.join(os.tmpdir(), 'public-samples-'));
    resetVerifiedPublicSamples();
  });
  afterEach(() => {
    fs.rmSync(cache, { recursive: true, force: true });
  });

  it('stores a file whose digest matches, once, and reads it from the cache after that', async () => {
    let calls = 0;
    const download = async (): Promise<Buffer> => {
      calls++;
      return Buffer.from('abc');
    };
    const first = await ensurePublicSample(sample(), { cacheDir: cache, download });
    expect(fs.readFileSync(first, 'utf8')).toBe('abc');
    expect(first).toBe(path.join(cache, 'font', sample().sha256));
    resetVerifiedPublicSamples();
    await ensurePublicSample(sample(), { cacheDir: cache, download });
    expect(calls).toBe(1);
  });

  it('fails closed on other bytes and stores nothing', async () => {
    await expect(ensurePublicSample(sample(), { cacheDir: cache, download: async () => Buffer.from('abd') })).rejects.toBeInstanceOf(PublicDigestError);
    expect(fs.existsSync(path.join(cache, 'font'))).toBe(false);
  });

  it('fetches again when the cached file no longer matches the digest', async () => {
    const target = path.join(cache, 'font', sample().sha256);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'damaged');
    const file = await ensurePublicSample(sample(), { cacheDir: cache, download: async () => Buffer.from('abc') });
    expect(fs.readFileSync(file, 'utf8')).toBe('abc');
  });

  it('answers a host that does not deliver with no file when the run is not strict, and with the failure when it is', async () => {
    const failing = async (): Promise<Buffer> => {
      throw new PublicFetchError('no route to host');
    };
    const logs: string[] = [];
    const lenient = { strict: false, log: (message: string) => void logs.push(message) };
    expect(await publicFile(lenient, sample(), { cacheDir: cache, download: failing })).toBeNull();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('x.bin is not available');
    resetVerifiedPublicSamples();
    await expect(publicFile({ strict: true, log: () => undefined }, sample(), { cacheDir: cache, download: failing })).rejects.toBeInstanceOf(PublicFetchError);
  });

  it('never answers a digest mismatch with a skipped sample, strict or not', async () => {
    const wrong = async (): Promise<Buffer> => Buffer.from('abd');
    const failure = publicFile({ strict: false, log: () => undefined }, sample(), { cacheDir: cache, download: wrong });
    await expect(failure).rejects.toBeInstanceOf(PublicDigestError);
    await expect(failure).rejects.toThrow(`fetched 3 bytes with SHA-256 ${createHash('sha256').update('abd').digest('hex')}; the manifest pins 3 bytes with ${sample().sha256}`);
    expect(fs.existsSync(path.join(cache, 'font'))).toBe(false);
  });
});

describe('the scope of the public cases', () => {
  const first = MANIFEST.samples[0];

  it('recognises a public case by the id of its sample, and a class row by its prefix', () => {
    expect(isPublicCase(`${first.id}->pdf`)).toBe(true);
    expect(isPublicCase(`${first.id}.woff2->ttf`)).toBe(true);
    expect(isPublicCase(`${CLASS_CASE_PREFIX}tagged->extract`)).toBe(true);
    expect(isPublicCase('plate-basic.dxf->svg')).toBe(false);
    expect(isPublicCase('shapes.svg->png')).toBe(false);
  });

  it('measures only the named cases under --quick, all of them in a full run and none in the pull request speed tier', () => {
    const [family, [named]] = Object.entries(PUBLIC_QUICK_CASES)[0];
    const other = MANIFEST.samples.find((item) => item.family === family && !named.startsWith(item.id));
    expect(publicCaseScope(true, family, named)).toBe(true);
    expect(publicCaseScope(true, family, `${(other as PublicSample).id}->x`)).toBe(false);
    expect(publicCaseScope(true, family, `${CLASS_CASE_PREFIX}tagged->x`)).toBe(false);
    expect(publicCaseScope(false, family, named)).toBe(true);
    expect(publicCaseScope(true, 'image', 'photo-a.jpg->webp')).toBeNull();
    expect(corpusTier({})).toBe('full');
    expect(corpusTier({ BENCH_CORPUS_TIER: 'pr' })).toBe('pr');
    expect(() => corpusTier({ BENCH_CORPUS_TIER: 'half' })).toThrow(/must be "pr" or "full"/);
  });

  it('names for every family at least one quick case and at most five, each of a sample of that family', () => {
    for (const family of PUBLIC_FAMILIES) {
      const cases = PUBLIC_QUICK_CASES[family] ?? [];
      expect(cases.length, `${family} quick cases`).toBeGreaterThanOrEqual(1);
      expect(cases.length, `${family} quick cases`).toBeLessThanOrEqual(MAX_QUICK_CASES_PER_FAMILY);
      for (const name of cases) {
        const owner = MANIFEST.samples.find((item) => name.startsWith(`${item.id}->`) || name.startsWith(`${item.id}.`));
        expect(owner?.family, name).toBe(family);
      }
    }
  });

  it('names only quick cases that the baseline records, and gives every public speed row of the timed samples a recorded ratio', () => {
    const baseline = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'bench', 'baseline.json'), 'utf8')) as { entries: Record<string, { ratio: number | null }> };
    const ids = Object.keys(baseline.entries);
    for (const [family, cases] of Object.entries(PUBLIC_QUICK_CASES)) {
      for (const name of cases) expect(ids.some((id) => id.startsWith(`${family}/${name}/`)), `${family}/${name}`).toBe(true);
    }
    for (const [family, samples] of Object.entries(PUBLIC_SPEED_SAMPLES)) {
      for (const id of samples) {
        const recorded = ids.filter((entry) => entry.startsWith(`${family}/${id}-`) || entry.startsWith(`${family}/${id}.`)).filter((entry) => entry.endsWith('/throughput') && baseline.entries[entry].ratio !== null);
        expect(recorded.length, `${family}/${id}`).toBeGreaterThan(0);
      }
    }
  });

  it('times only samples of the manifest', () => {
    for (const [family, ids] of Object.entries(PUBLIC_SPEED_SAMPLES)) {
      for (const id of ids) expect(MANIFEST.samples.find((item) => item.id === id)?.family, id).toBe(family);
    }
  });
});

describe('the per-class rows', () => {
  const row = (ours: number, reference: number): ReturnType<typeof measuredRow> => measuredRow('data', 'x', SPEC.cellMismatches, ours, reference, 'ref');

  it('are the unweighted mean over the samples of the class, and a weighted mean where a metric asks for it', () => {
    const classes = new PublicClassRows();
    classes.expect('wide', '->csv', ['cell_mismatches']);
    classes.expect('wide', '->csv', ['cell_mismatches']);
    classes.add('wide', '->csv', SPEC.cellMismatches, 4, 0);
    classes.add('wide', '->csv', SPEC.cellMismatches, 0, 0);
    classes.expect('wide', '->parquet', ['compression_ratio']);
    classes.expect('wide', '->parquet', ['compression_ratio']);
    classes.add('wide', '->parquet', SPEC.ratio, 0.5, 0.4, 100);
    classes.add('wide', '->parquet', SPEC.ratio, 0.25, 0.2, 300);
    const rows = classes.rows('data', () => 'ref');
    const byId = Object.fromEntries(rows.map((item) => [item.id, item]));
    expect(byId['data/class-wide->csv/cell_mismatches'].ours).toBe(2);
    expect(byId['data/class-wide->parquet/compression_ratio'].ours).toBeCloseTo((0.5 * 100 + 0.25 * 300) / 400, 10);
    expect(byId['data/class-wide->parquet/compression_ratio'].reference).toBeCloseTo((0.4 * 100 + 0.2 * 300) / 400, 10);
  });

  it('exist only when every planned sample of the class was measured', () => {
    const classes = new PublicClassRows();
    classes.expect('tall', '->json', ['cell_mismatches']);
    classes.expect('tall', '->json', ['cell_mismatches']);
    classes.add('tall', '->json', SPEC.cellMismatches, 1, 1);
    expect(classes.rows('data', () => 'ref')).toEqual([]);
  });

  it('take a sample under the part of its case name after its id, so that sub-cases stay apart', () => {
    const classes = new PublicClassRows();
    classes.expectCases('rtl', [
      { suffix: '->epub', metric: 'cell_mismatches' },
      { suffix: '->epub:images', metric: 'cell_mismatches' },
    ]);
    classes.addCases('rtl', 'b.epub', [{ ...row(9, 9), case: 'b.epub->epub' }, { ...row(3, 3), case: 'b.epub->epub:images' }]);
    const rows = classes.rows('data', () => 'ref');
    expect(Object.fromEntries(rows.map((item) => [item.case, item.ours]))).toEqual({ 'class-rtl->epub': 9, 'class-rtl->epub:images': 3 });
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
