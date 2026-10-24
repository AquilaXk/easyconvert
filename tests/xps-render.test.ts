import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import sharp from 'sharp';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { CorruptStreamError, DecompressionLimitError, PayloadLimitError } from '../src/lib/types';
import { requireOracleTool } from './helpers/differential-oracle';
import { pdfinfoPages } from './helpers/encrypted-pdf-fixtures';
import { requireRealworldSample } from './helpers/realworld-sample';
import { skipWithoutTools } from './helpers/strict-skip';

/**
 * XPS and OpenXPS documents drawn by GhostXPS (`gxps` of GhostPDL). The oracle of
 * a PDF is read from the package itself, by a reader written here from ECMA-388 that shares no code with the product: the
 * pages that the fixed documents list, the size of each fixed page, and the characters of the `UnicodeString` of every
 * glyph run, in the order the page draws them. Poppler reads the PDF back (`pdfinfo`, `pdftotext -raw`, which keeps that
 * order). The real files are the three XPS files of the Apache Tika test documents: a Word print whose package uses
 * ZIP64 records, a PowerPoint print, and a page with right-to-left text and hyperlinks.
 */

const haveRenderer = !skipWithoutTools('gxps', 'pdfinfo', 'pdftotext');
const CONVERSION_TIMEOUT_MS = 120_000;
const SAMPLES = ['tika-test_text.xps', 'tika-testppt.xps', 'tika-testxps_various.xps'] as const;
const UTF16LE_BOM = Buffer.from([0xff, 0xfe]);
const UTF16BE_BOM = Buffer.from([0xfe, 0xff]);
const FIXED_REPRESENTATION = /Type="[^"]*\/fixedrepresentation"/i;
/** Points per inch of a PDF page, and the 1/96 inch unit of XPS page sizes. */
const POINTS_PER_INCH = 72;
const XPS_UNITS_PER_INCH = 96;
const MAX_ASPECT_RATIO_DIFFERENCE = 0.01;
/**
 * The initial and medial forms of the Farsi yeh (U+06CC) and the Arabic yeh (U+064A) are one glyph, so a PDF can name
 * only one of the two letters for it; GhostXPS's PDF names the Farsi one. Both are read as the Arabic letter.
 */
const SHARED_GLYPH_LETTERS: ReadonlyMap<string, string> = new Map([['ی', 'ي']]);

interface XpsOracle {
  /** Per fixed page: its size in XPS units and the letters and digits its glyph runs draw. */
  pages: { width: number; height: number; letters: string }[];
}

function decodePart(bytes: Buffer): string {
  if (bytes.subarray(0, 2).equals(UTF16LE_BOM)) return bytes.toString('utf16le', 2);
  if (bytes.subarray(0, 2).equals(UTF16BE_BOM)) return Buffer.from(bytes.subarray(2)).swap16().toString('utf16le');
  return bytes.toString('utf-8').replace(/^﻿/, '');
}

function resolvePart(from: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const segments = from.split('/').slice(0, -1);
  for (const segment of target.split('/')) {
    if (segment === '..') segments.pop();
    else if (segment !== '.') segments.push(segment);
  }
  return segments.join('/');
}

function attribute(tag: string, name: string): string | undefined {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
}

function unescapeXml(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16))).replace(/&amp;/g, '&');
}

/** Letters and digits only, compatibility-normalized and lower case: what both readers agree a page says, whatever its spacing. */
function lettersOf(text: string): string {
  return [...text.normalize('NFKC').toLowerCase()]
    .map((character) => SHARED_GLYPH_LETTERS.get(character) ?? character)
    .filter((character) => /[\p{L}\p{N}]/u.test(character))
    .join('');
}

async function readXpsOracle(xps: Buffer): Promise<XpsOracle> {
  const zip = await JSZip.loadAsync(xps);
  const byName = new Map(Object.keys(zip.files).map((name) => [name.toLowerCase(), name]));
  const read = async (part: string) => decodePart(Buffer.from(await zip.file(byName.get(part.toLowerCase()) ?? part)!.async('uint8array')));
  const relationship = [...(await read('_rels/.rels')).matchAll(/<Relationship\b[^>]*>/g)].find((match) => FIXED_REPRESENTATION.test(match[0]));
  const sequencePart = resolvePart('', attribute(relationship![0], 'Target')!);
  const pages: XpsOracle['pages'] = [];
  for (const document of (await read(sequencePart)).matchAll(/<DocumentReference\b[^>]*>/g)) {
    const documentPart = resolvePart(sequencePart, attribute(document[0], 'Source')!);
    for (const content of (await read(documentPart)).matchAll(/<PageContent\b[^>]*>/g)) {
      const page = await read(resolvePart(documentPart, attribute(content[0], 'Source')!));
      const fixedPage = /<FixedPage\b[^>]*>/.exec(page)![0];
      const runs = [...page.matchAll(/<Glyphs\b[^>]*>/g)].map((glyphs) => unescapeXml(attribute(glyphs[0], 'UnicodeString') ?? '').replace(/^\{\}/, ''));
      pages.push({ width: Number(attribute(fixedPage, 'Width')), height: Number(attribute(fixedPage, 'Height')), letters: lettersOf(runs.join('')) });
    }
  }
  return { pages };
}

/** The text of each page of a PDF in content-stream order (`pdftotext -raw`), as Poppler reads it. */
function pdfPageTexts(pdf: Buffer): string[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xps-render-oracle-'));
  try {
    const file = path.join(dir, 'in.pdf');
    fs.writeFileSync(file, pdf);
    return execFileSync(requireOracleTool('pdftotext'), ['-raw', file, '-'], { encoding: 'utf-8' }).split('\f');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The pages of an image output: the file itself, or the entries of the ZIP that several pages arrive in, in page order. */
async function pageImages(output: Buffer): Promise<Buffer[]> {
  if (output.subarray(0, 2).toString('latin1') !== 'PK') return [output];
  const zip = await JSZip.loadAsync(output);
  return Promise.all(
    Object.keys(zip.files)
      .sort()
      .map(async (name) => Buffer.from(await zip.files[name].async('uint8array')))
  );
}

describe.skipIf(!haveRenderer)('real XPS files drawn by GhostXPS', () => {
  for (const id of SAMPLES) {
    it(
      `${id} becomes a PDF with every fixed page, its size, and the characters of every glyph run in drawing order`,
      async (ctx) => {
        const { bytes } = await requireRealworldSample(ctx, id);
        const oracle = await readXpsOracle(bytes);
        expect(oracle.pages.length).toBeGreaterThan(0);
        const result = await dispatchConversion(bytes, 'xps', 'pdf', {}, id);
        expect(result.engineUsed).toBe('native-xps');
        expect(pdfinfoPages(result.buffer)).toBe(oracle.pages.length);
        const pdfPages = pdfPageTexts(result.buffer).slice(0, oracle.pages.length).map(lettersOf);
        expect(pdfPages).toEqual(oracle.pages.map((page) => page.letters));
      },
      CONVERSION_TIMEOUT_MS
    );

    it(
      `${id} becomes PNG and JPEG page images, one for every fixed page, with the page's aspect ratio`,
      async (ctx) => {
        const { bytes } = await requireRealworldSample(ctx, id);
        const oracle = await readXpsOracle(bytes);
        for (const target of ['png', 'jpg'] as const) {
          const images = await pageImages((await dispatchConversion(bytes, 'xps', target, {}, id)).buffer);
          expect({ target, pages: images.length }).toEqual({ target, pages: oracle.pages.length });
          for (const [index, image] of images.entries()) {
            const metadata = await sharp(image).metadata();
            expect(metadata.format).toBe(target === 'png' ? 'png' : 'jpeg');
            const page = oracle.pages[index];
            expect(Math.abs((metadata.width ?? 0) / (metadata.height ?? 1) - page.width / page.height)).toBeLessThan(MAX_ASPECT_RATIO_DIFFERENCE);
          }
          const { channels } = await sharp(images[0]).stats();
          expect(Math.max(...channels.map((channel) => channel.max - channel.min)), `${target} first page is not one flat colour`).toBeGreaterThan(0);
        }
      },
      CONVERSION_TIMEOUT_MS
    );
  }

  it(
    'writes every other page target of the registry from the drawn pages',
    async (ctx) => {
      const { bytes } = await requireRealworldSample(ctx, 'tika-testppt.xps');
      const signatures: Readonly<Record<string, (output: Buffer) => boolean>> = {
        avif: (output) => output.subarray(4, 12).toString('latin1') === 'ftypavif',
        bmp: (output) => output.subarray(0, 2).toString('latin1') === 'BM',
        eps: (output) => output.toString('latin1').split('\n')[0] === '%!PS-Adobe-3.0 EPSF-3.0',
        gif: (output) => output.subarray(0, 4).toString('latin1') === 'GIF8',
        ico: (output) => output.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0])),
        psd: (output) => output.subarray(0, 4).toString('latin1') === '8BPS',
        ps: (output) => output.toString('latin1').split('\n')[0] === '%!PS-Adobe-3.0',
        svg: (output) => /<svg[^>]+xmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(output.toString('utf-8')),
        tiff: (output) => ['II*\0', 'MM\0*'].includes(output.subarray(0, 4).toString('latin1')),
        webp: (output) => output.subarray(8, 12).toString('latin1') === 'WEBP',
      };
      for (const [target, matches] of Object.entries(signatures)) {
        const result = await dispatchConversion(bytes, 'xps', target, { multiPageOutput: 'first' }, 'tika-testppt.xps');
        expect({ target, matches: matches(result.buffer) }).toEqual({ target, matches: true });
      }
    },
    CONVERSION_TIMEOUT_MS * 2
  );
});

const XPS_NAMESPACE = 'http://schemas.microsoft.com/xps/2005/06';
const ROOT_RELATIONSHIPS =
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.microsoft.com/xps/2005/06/fixedrepresentation" Target="/FixedDocSeq.fdseq"/></Relationships>';
/** A Letter page (8.5 x 11 inches) with one filled rectangle: a page GhostXPS draws without any font. */
const DRAWN_PAGE = `<FixedPage xmlns="${XPS_NAMESPACE}" Width="816" Height="1056"><Path Data="M 96,96 L 480,96 480,288 96,288 Z" Fill="#FF204080"/></FixedPage>`;

/** An XPS package of the given parts besides the root relationships, which point at `/FixedDocSeq.fdseq`. */
async function packageOf(parts: Readonly<Record<string, string | Buffer>>): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  zip.file('_rels/.rels', ROOT_RELATIONSHIPS);
  for (const [name, content] of Object.entries(parts)) zip.file(name, content);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** The error a conversion that must be refused ends in, to read its type and its words. */
async function refusalOf(conversion: Promise<unknown>): Promise<Error> {
  const outcome = await conversion.then(
    () => null,
    (error: unknown) => error
  );
  if (!(outcome instanceof Error)) throw new Error('the conversion was not refused');
  return outcome;
}

function sequenceOf(...documents: string[]): string {
  return `<FixedDocumentSequence xmlns="${XPS_NAMESPACE}">${documents.map((source) => `<DocumentReference Source="${source}"/>`).join('')}</FixedDocumentSequence>`;
}

function documentOf(pages: readonly string[], nestedDocuments: readonly string[] = []): string {
  const references = nestedDocuments.map((source) => `<DocumentReference Source="${source}"/>`).join('');
  return `<FixedDocument xmlns="${XPS_NAMESPACE}">${references}${pages.map((source) => `<PageContent Source="${source}"/>`).join('')}</FixedDocument>`;
}

function pageNames(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `Pages/${index + 1}.fpage`);
}

describe.skipIf(!haveRenderer)('XPS packages that would make the renderer work without bound', () => {
  it('draws a package written from the specification, as the contrast to the refusals below', async () => {
    const xps = await packageOf({ 'FixedDocSeq.fdseq': sequenceOf('/Documents/1/FixedDoc.fdoc'), 'Documents/1/FixedDoc.fdoc': documentOf(pageNames(2)), 'Documents/1/Pages/1.fpage': DRAWN_PAGE, 'Documents/1/Pages/2.fpage': DRAWN_PAGE });
    const result = await dispatchConversion(xps, 'xps', 'pdf', {}, 'drawn.xps');
    expect(pdfinfoPages(result.buffer)).toBe(2);
  }, CONVERSION_TIMEOUT_MS);

  it('draws an OpenXPS (ECMA-388) package as an .oxps source', async () => {
    const namespace = 'http://schemas.openxps.org/oxps/v1.0';
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
    zip.file('_rels/.rels', `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="${namespace}/fixedrepresentation" Target="/FixedDocSeq.fdseq"/></Relationships>`);
    zip.file('FixedDocSeq.fdseq', `<FixedDocumentSequence xmlns="${namespace}"><DocumentReference Source="/Documents/1/FixedDoc.fdoc"/></FixedDocumentSequence>`);
    zip.file('Documents/1/FixedDoc.fdoc', `<FixedDocument xmlns="${namespace}"><PageContent Source="Pages/1.fpage"/></FixedDocument>`);
    zip.file('Documents/1/Pages/1.fpage', DRAWN_PAGE.replace(XPS_NAMESPACE, namespace));
    const result = await dispatchConversion(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), 'oxps', 'pdf', {}, 'drawn.oxps');
    expect(result.engineUsed).toBe('native-xps');
    expect(pdfinfoPages(result.buffer)).toBe(1);
  }, CONVERSION_TIMEOUT_MS);

  it('refuses a part that inflates past the compression ratio of the archive limits (a ZIP bomb)', async () => {
    const xps = await packageOf({
      'FixedDocSeq.fdseq': sequenceOf('/Documents/1/FixedDoc.fdoc'),
      'Documents/1/FixedDoc.fdoc': documentOf(pageNames(1)),
      'Documents/1/Pages/1.fpage': DRAWN_PAGE,
      'Resources/padding.bin': Buffer.alloc(40 * 1024 * 1024),
    });
    const error = await refusalOf(dispatchConversion(xps, 'xps', 'pdf', {}, 'bomb.xps'));
    expect(error).toBeInstanceOf(DecompressionLimitError);
    expect(error.message).toMatch(/compression ratio \(\d+(\.\d+)?:1\) exceeds 100:1 limit/);
  }, CONVERSION_TIMEOUT_MS);

  it('refuses a chain of fixed documents that each name the next, past the document limit', async () => {
    const depth = 1_001;
    const parts: Record<string, string> = { 'FixedDocSeq.fdseq': sequenceOf('/Documents/0.fdoc') };
    for (let level = 0; level < depth; level += 1) parts[`Documents/${level}.fdoc`] = documentOf([], [`${level + 1}.fdoc`]);
    parts[`Documents/${depth}.fdoc`] = documentOf(['Pages/1.fpage']);
    parts['Documents/Pages/1.fpage'] = DRAWN_PAGE;
    const error = await refusalOf(dispatchConversion(await packageOf(parts), 'xps', 'pdf', {}, 'nested.xps'));
    expect(error).toBeInstanceOf(PayloadLimitError);
    expect(error.message).toMatch(/names more than 1000 documents/);
  }, CONVERSION_TIMEOUT_MS);

  it('refuses a fixed document that names the sequence it is part of', async () => {
    const xps = await packageOf({ 'FixedDocSeq.fdseq': sequenceOf('/Documents/1/FixedDoc.fdoc'), 'Documents/1/FixedDoc.fdoc': documentOf(pageNames(1), ['/FixedDocSeq.fdseq']), 'Documents/1/Pages/1.fpage': DRAWN_PAGE });
    const error = await refusalOf(dispatchConversion(xps, 'xps', 'pdf', {}, 'cycle.xps'));
    expect(error).toBeInstanceOf(CorruptStreamError);
    expect(error.message).toMatch(/references the fixed document "FixedDocSeq\.fdseq" more than once/);
  }, CONVERSION_TIMEOUT_MS);

  it('refuses a document of more pages than the page limit before drawing any', async () => {
    const xps = await packageOf({ 'FixedDocSeq.fdseq': sequenceOf('/Documents/1/FixedDoc.fdoc'), 'Documents/1/FixedDoc.fdoc': documentOf(pageNames(10_001)) });
    const error = await refusalOf(dispatchConversion(xps, 'xps', 'pdf', {}, 'pages.xps'));
    expect(error).toBeInstanceOf(PayloadLimitError);
    expect(error.message).toMatch(/more than 10000 pages/);
  }, CONVERSION_TIMEOUT_MS);

  it('refuses page images of more pages than one request renders before drawing any (the pages are not even in the package)', async () => {
    const xps = await packageOf({ 'FixedDocSeq.fdseq': sequenceOf('/Documents/1/FixedDoc.fdoc'), 'Documents/1/FixedDoc.fdoc': documentOf(pageNames(501)) });
    const error = await refusalOf(dispatchConversion(xps, 'xps', 'png', {}, 'long.xps'));
    expect(error).toBeInstanceOf(PayloadLimitError);
    expect(error.message).toMatch(/prints 501 pages; at most 500 are rendered to images/);
  }, CONVERSION_TIMEOUT_MS);

  it('draws the first page of such a document when the request asks for the first page only', async () => {
    const parts: Record<string, string> = { 'FixedDocSeq.fdseq': sequenceOf('/Documents/1/FixedDoc.fdoc'), 'Documents/1/FixedDoc.fdoc': documentOf(pageNames(501)) };
    for (const name of pageNames(501)) parts[`Documents/1/${name}`] = DRAWN_PAGE;
    const first = await dispatchConversion(await packageOf(parts), 'xps', 'png', { multiPageOutput: 'first' }, 'long.xps');
    expect((await pageImages(first.buffer)).length).toBe(1);
  }, CONVERSION_TIMEOUT_MS);

  it('refuses a page the renderer cannot read, although the renderer exits with success', async () => {
    const xps = await packageOf({ 'FixedDocSeq.fdseq': sequenceOf('/Documents/1/FixedDoc.fdoc'), 'Documents/1/FixedDoc.fdoc': documentOf(pageNames(1)), 'Documents/1/Pages/1.fpage': `<FixedPage xmlns="${XPS_NAMESPACE}" Width="816"` });
    await expect(dispatchConversion(xps, 'xps', 'pdf', {}, 'broken.xps')).rejects.toMatchObject({ name: 'ConversionFailedError' });
  }, CONVERSION_TIMEOUT_MS);
});
