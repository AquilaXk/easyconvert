import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { crc32 } from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { InputPixelLimitError } from '../src/lib/conversions/image-input-limits';
import { CorruptStreamError, DecompressionLimitError, PayloadLimitError } from '../src/lib/types';
import { countPagesOfReadablePdf } from '../src/worker/engines';
import { convertXps, type XpsJob } from '../src/worker/xps-render';
import { requireOracleTool } from './helpers/differential-oracle';
import { JPEG_XR_WIDE_70000_BY_1 } from './helpers/jpegxr-samples';
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

  it('refuses a resource dictionary that names itself, which makes the renderer crash', async () => {
    const page = `<FixedPage xmlns="${XPS_NAMESPACE}" Width="816" Height="1056"><FixedPage.Resources><ResourceDictionary Source="/Resources/loop.dict"/></FixedPage.Resources><Path Data="M 96,96 L 480,96 480,288 96,288 Z" Fill="{StaticResource a}"/></FixedPage>`;
    const xps = await documentPackage(1, () => page, { 'Resources/loop.dict': `<ResourceDictionary xmlns="${XPS_NAMESPACE}" Source="/Resources/loop.dict"/>` });
    const error = await refusalOf(dispatchConversion(xps, 'xps', 'pdf', {}, 'loop.xps'));
    expect(error).toMatchObject({ name: 'ConversionFailedError' });
    expect(error.message).toMatch(/GhostXPS (could not draw the|exceeded its output or memory limit on the) \.xps file/);
  }, CONVERSION_TIMEOUT_MS);

  it('refuses a page that is not well-formed XML, before the renderer starts', async () => {
    const xps = await packageOf({ 'FixedDocSeq.fdseq': sequenceOf('/Documents/1/FixedDoc.fdoc'), 'Documents/1/FixedDoc.fdoc': documentOf(pageNames(1)), 'Documents/1/Pages/1.fpage': `<FixedPage xmlns="${XPS_NAMESPACE}" Width="816"` });
    const error = await refusalOf(dispatchConversion(xps, 'xps', 'pdf', {}, 'broken.xps'));
    expect(error).toMatchObject({ name: 'DataParseError' });
    expect(error.message).toMatch(/Documents\/1\/Pages\/1\.fpage is not well-formed XML/);
  }, CONVERSION_TIMEOUT_MS);

  it('refuses a page the renderer cannot read, although the renderer exits with success', async () => {
    const foreignPage = `<FixedPage xmlns="http://example.com/not-xps" Width="816" Height="1056"/>`;
    const xps = await packageOf({ 'FixedDocSeq.fdseq': sequenceOf('/Documents/1/FixedDoc.fdoc'), 'Documents/1/FixedDoc.fdoc': documentOf(pageNames(2)), 'Documents/1/Pages/1.fpage': DRAWN_PAGE, 'Documents/1/Pages/2.fpage': foreignPage });
    const error = await refusalOf(dispatchConversion(xps, 'xps', 'pdf', {}, 'foreign.xps'));
    expect(error).toMatchObject({ name: 'ConversionFailedError' });
    expect(error.message).toMatch(/GhostXPS could not draw the \.xps file/);
  }, CONVERSION_TIMEOUT_MS);
});

/** A page that draws one image, named by its part, as a Word print does for each picture on a page. */
function pageDrawing(imagePart: string): string {
  return `<FixedPage xmlns="${XPS_NAMESPACE}" Width="816" Height="1056"><Path Data="M 0,0 L 100,0 100,100 0,100 Z"><Path.Fill><ImageBrush ImageSource="${imagePart}" Viewbox="0,0,10,10" ViewportUnits="Absolute" Viewport="0,0,100,100"/></Path.Fill></Path></FixedPage>`;
}

/** A package of `count` pages in one document, each page the value of `pageOf(name)`, besides the extra parts. */
async function documentPackage(count: number, pageOf: (name: string) => string, extraParts: Readonly<Record<string, string | Buffer>> = {}): Promise<Buffer> {
  const parts: Record<string, string | Buffer> = { 'FixedDocSeq.fdseq': sequenceOf('/Documents/1/FixedDoc.fdoc'), 'Documents/1/FixedDoc.fdoc': documentOf(pageNames(count)), ...extraParts };
  for (const name of pageNames(count)) parts[`Documents/1/${name}`] = pageOf(name);
  return packageOf(parts);
}

/** The part of a stand-in program's script that finds the file it is asked to write: GhostXPS gets it as `-sOutputFile=<path>`. */
const FIND_OUTPUT_PATH = 'for argument in "$@"; do case "$argument" in -sOutputFile=*) out="${argument#-sOutputFile=}";; esac; done\n';

const BIG_PART = 'Resources/big.jpg';
const BIG_PART_BYTES = 1024 * 1024;
/** What the pages of a document may name of images between them, a page's image counted again on every page: twice the 256 MiB inflate budget of a package. */
const REFERENCED_BYTES_BUDGET = 2 * 256 * 1024 * 1024;
const PAGES_AT_BUDGET = REFERENCED_BYTES_BUDGET / BIG_PART_BYTES;

/** Random bytes that start with a zero, so that no first bytes make them a JPEG, PNG, TIFF or JPEG XR file whose header the pixel budget reads. */
function opaqueBytes(length: number): Buffer {
  const bytes = crypto.randomBytes(length);
  bytes[0] = 0;
  return bytes;
}

describe('XPS documents that the renderer would draw short or decode again for every page', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A program that writes a PDF of `pdfPages` pages, as GhostXPS does, or one of `sparseBytes` zero bytes; it never reads the package. */
  async function standIn(outcome: { pdfPages: number } | { sparseBytes: number }): Promise<string> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xps-render-stand-in-'));
    dirs.push(dir);
    const script = path.join(dir, 'gxps');
    if ('pdfPages' in outcome) {
      const document = await PDFDocument.create();
      for (let page = 0; page < outcome.pdfPages; page += 1) document.addPage([612, 792]);
      fs.writeFileSync(path.join(dir, 'drawn.pdf'), await document.save());
      fs.writeFileSync(script, `#!/bin/sh\n${FIND_OUTPUT_PATH}cp '${path.join(dir, 'drawn.pdf')}' "$out"\n`);
    } else {
      fs.writeFileSync(script, `#!/bin/sh\n${FIND_OUTPUT_PATH}dd if=/dev/null of="$out" bs=1048576 seek=${Math.ceil(outcome.sparseBytes / 1048576)} count=0 2>/dev/null\n`);
    }
    fs.chmodSync(script, 0o755);
    return script;
  }

  /** Draws `xps` with `interpreter`; the sizes of the PDFs that the PDF tools are handed are added to `handedToPageTools`. */
  async function convertWith(interpreter: string, xps: Buffer, tgt: string, handedToPageTools: number[] = []): Promise<Awaited<ReturnType<typeof convertXps>>> {
    const job: XpsJob = {
      input: xps,
      src: 'xps',
      tgt,
      options: {},
      originalFilename: 'stand-in.xps',
      interpreter,
      convertPdfPages: async (pdf) => {
        handedToPageTools.push(pdf.length);
        return null;
      },
      countPdfPages: countPagesOfReadablePdf,
    };
    return convertXps(job);
  }

  it('hands on a PDF with one page for every listed page, and for a part stored under another case than the document names it', async () => {
    const parts: Record<string, string> = { 'FixedDocSeq.fdseq': sequenceOf('/Documents/1/FixedDoc.fdoc'), 'Documents/1/FixedDoc.fdoc': documentOf(pageNames(3)), 'documents/1/pages/1.FPAGE': DRAWN_PAGE, 'Documents/1/Pages/2.fpage': DRAWN_PAGE, 'Documents/1/Pages/3.fpage': DRAWN_PAGE };
    const result = await convertWith(await standIn({ pdfPages: 3 }), await packageOf(parts), 'pdf');
    expect(result?.engineUsed).toBe('native-xps');
  }, CONVERSION_TIMEOUT_MS);

  it('refuses a document that lists a page the package does not hold, before the renderer starts', async () => {
    const parts: Record<string, string> = { 'FixedDocSeq.fdseq': sequenceOf('/Documents/1/FixedDoc.fdoc'), 'Documents/1/FixedDoc.fdoc': documentOf(pageNames(3)), 'Documents/1/Pages/1.fpage': DRAWN_PAGE, 'Documents/1/Pages/3.fpage': DRAWN_PAGE };
    const error = await refusalOf(convertWith('/nonexistent/gxps', await packageOf(parts), 'pdf'));
    expect(error).toBeInstanceOf(CorruptStreamError);
    expect(error.message).toMatch(/lists the fixed page "Documents\/1\/Pages\/2\.fpage", which is not in the package/);
  }, CONVERSION_TIMEOUT_MS);

  it('refuses a PDF with fewer pages than the documents list, whatever the renderer printed', async () => {
    const xps = await documentPackage(3, () => DRAWN_PAGE);
    const error = await refusalOf(convertWith(await standIn({ pdfPages: 2 }), xps, 'pdf'));
    expect(error).toMatchObject({ name: 'ConversionFailedError' });
    expect(error.message).toMatch(/drew 2 of the 3 pages that the \.xps file lists/);
  }, CONVERSION_TIMEOUT_MS);

  it('refuses a short PDF for a page image target too, before the PDF tools see it', async () => {
    const xps = await documentPackage(3, () => DRAWN_PAGE);
    const complete: number[] = [];
    await convertWith(await standIn({ pdfPages: 3 }), xps, 'png', complete);
    expect(complete).toHaveLength(1);
    const short: number[] = [];
    const error = await refusalOf(convertWith(await standIn({ pdfPages: 1 }), xps, 'png', short));
    expect(error.message).toMatch(/drew 1 of the 3 pages/);
    expect(short).toEqual([]);
  }, CONVERSION_TIMEOUT_MS);

  it('refuses a PDF above the size an image target reads into memory, and hands a smaller one on whole', async () => {
    const xps = await documentPackage(1, () => DRAWN_PAGE);
    const error = await refusalOf(convertWith(await standIn({ sparseBytes: 129 * 1024 * 1024 }), xps, 'png'));
    expect(error).toBeInstanceOf(PayloadLimitError);
    expect(error.message).toMatch(/drew 135266304 bytes of PDF from the \.xps file, more than the 134217728 bytes that can be taken further/);
    const handedToPageTools: number[] = [];
    await convertWith(await standIn({ pdfPages: 1 }), xps, 'png', handedToPageTools);
    expect(handedToPageTools).toHaveLength(1);
    expect(handedToPageTools[0]).toBeGreaterThan(0);
  }, CONVERSION_TIMEOUT_MS);

  it(`counts a part again for every page that names it: ${PAGES_AT_BUDGET} pages of one ${BIG_PART_BYTES} byte image are at the budget and one more is over it`, async () => {
    const shared = opaqueBytes(BIG_PART_BYTES);
    const atBudget = await documentPackage(PAGES_AT_BUDGET, () => pageDrawing(`/${BIG_PART}`), { [BIG_PART]: shared });
    const result = await convertWith(await standIn({ pdfPages: PAGES_AT_BUDGET }), atBudget, 'pdf');
    expect(result?.engineUsed).toBe('native-xps');
    const overBudget = await documentPackage(PAGES_AT_BUDGET + 1, () => pageDrawing(`/${BIG_PART}`), { [BIG_PART]: shared });
    const error = await refusalOf(convertWith('/nonexistent/gxps', overBudget, 'pdf'));
    expect(error).toBeInstanceOf(PayloadLimitError);
    expect(error.message).toMatch(new RegExp(`more than ${REFERENCED_BYTES_BUDGET} bytes of images and colour profiles`));
  }, CONVERSION_TIMEOUT_MS * 2);

  it('refuses ten thousand pages that share one large image before the renderer starts', async () => {
    const xps = await documentPackage(10_000, () => pageDrawing(`/${BIG_PART}`), { [BIG_PART]: opaqueBytes(BIG_PART_BYTES) });
    const error = await refusalOf(convertWith('/nonexistent/gxps', xps, 'pdf'));
    expect(error).toBeInstanceOf(PayloadLimitError);
    expect(error.message).toMatch(/pages name more than \d+ bytes of images and colour profiles/);
  }, CONVERSION_TIMEOUT_MS * 2);

  describe('images counted by their pixels as well as their bytes', () => {
    /** What the pages of a document may name of image pixels between them, a page's image counted again on every page: 100 seconds of GhostXPS decoding at 15 million pixels a second. */
    const REFERENCED_PIXELS_BUDGET = 1_500_000_000;
    const MEGAPIXEL_SIDE = 1000;
    const MEGAPIXEL = MEGAPIXEL_SIDE * MEGAPIXEL_SIDE;
    const PAGES_AT_PIXEL_BUDGET = REFERENCED_PIXELS_BUDGET / MEGAPIXEL;

    const MAX_PAGES = 10_000;

    /** A picture of one colour of `side` x `side` pixels: a few kilobytes however many pixels it declares, so that the pages of a document may name it ten thousand times within the byte budget. */
    function flatPicture(side: number, format: 'png' | 'jpeg'): Promise<Buffer> {
      const picture = sharp({ create: { width: side, height: side, channels: 3, background: '#336699' } });
      return (format === 'png' ? picture.png() : picture.jpeg()).toBuffer();
    }

    it(`counts the pixels of an image for every page that names it: ${PAGES_AT_PIXEL_BUDGET} pages of one megapixel picture are at the budget and one more is over it`, async () => {
      const picture = await flatPicture(MEGAPIXEL_SIDE, 'png');
      const atBudget = await documentPackage(PAGES_AT_PIXEL_BUDGET, () => pageDrawing(`/${BIG_PART}`), { [BIG_PART]: picture });
      const result = await convertWith(await standIn({ pdfPages: PAGES_AT_PIXEL_BUDGET }), atBudget, 'pdf');
      expect(result?.engineUsed).toBe('native-xps');
      const overBudget = await documentPackage(PAGES_AT_PIXEL_BUDGET + 1, () => pageDrawing(`/${BIG_PART}`), { [BIG_PART]: picture });
      const error = await refusalOf(convertWith('/nonexistent/gxps', overBudget, 'pdf'));
      expect(error).toBeInstanceOf(PayloadLimitError);
      expect(error.message).toMatch(new RegExp(`more than ${REFERENCED_PIXELS_BUDGET} pixels of images`));
    }, CONVERSION_TIMEOUT_MS * 2);

    it('refuses ten thousand pages that share one smooth 4 megapixel picture of a few kilobytes before the renderer starts', async () => {
      const picture = await flatPicture(2000, 'jpeg');
      expect(picture.length * MAX_PAGES, 'the byte budget lets these pages through').toBeLessThan(REFERENCED_BYTES_BUDGET);
      const xps = await documentPackage(MAX_PAGES, () => pageDrawing(`/${BIG_PART}`), { [BIG_PART]: picture });
      const error = await refusalOf(convertWith('/nonexistent/gxps', xps, 'pdf'));
      expect(error).toBeInstanceOf(PayloadLimitError);
      expect(error.message).toMatch(/pages name more than \d+ pixels of images/);
    }, CONVERSION_TIMEOUT_MS * 2);

    it('refuses one page that names three thousand parts of a megapixel each (many references, one header read for each part)', async () => {
      const picture = await flatPicture(MEGAPIXEL_SIDE, 'png');
      const parts: Record<string, Buffer> = {};
      const brushes: string[] = [];
      for (let index = 0; index < 3000; index += 1) {
        parts[`Resources/p${index}.png`] = picture;
        brushes.push(`<ImageBrush ImageSource="/Resources/p${index}.png" Viewbox="0,0,10,10" ViewportUnits="Absolute" Viewport="0,0,10,10"/>`);
      }
      const page = `<FixedPage xmlns="${XPS_NAMESPACE}" Width="816" Height="1056"><Path Data="M 0,0 L 10,0 10,10 0,10 Z"><Path.Fill>${brushes.join('')}</Path.Fill></Path></FixedPage>`;
      const xps = await documentPackage(1, () => page, parts);
      const error = await refusalOf(convertWith('/nonexistent/gxps', xps, 'pdf'));
      expect(error).toBeInstanceOf(PayloadLimitError);
      expect(error.message).toMatch(new RegExp(`more than ${REFERENCED_PIXELS_BUDGET} pixels of images`));
    }, CONVERSION_TIMEOUT_MS);

    it('refuses an image that declares 60,000 x 60,000 pixels in a few dozen bytes, and a JPEG XR image that declares 4 billion', async () => {
      const header = Buffer.alloc(13);
      header.writeUInt32BE(60_000, 0);
      header.writeUInt32BE(60_000, 4);
      header[8] = 8;
      header[9] = 2;
      const chunk = (type: string, data: Buffer): Buffer => {
        const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
        const length = Buffer.alloc(4);
        length.writeUInt32BE(data.length);
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(crc32(body));
        return Buffer.concat([length, body, crc]);
      };
      const bomb = Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), chunk('IHDR', header), chunk('IDAT', Buffer.from([0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01])), chunk('IEND', Buffer.alloc(0))]);
      const pngError = await refusalOf(convertWith('/nonexistent/gxps', await documentPackage(1, () => pageDrawing(`/${BIG_PART}`), { [BIG_PART]: bomb }), 'pdf'));
      expect(pngError).toBeInstanceOf(InputPixelLimitError);
      expect(pngError.message).toMatch(/declares 60000x60000 pixels \(3600000000 pixels\), over the input limit of 100000000 pixels/);
      const wide = Buffer.from(JPEG_XR_WIDE_70000_BY_1);
      wide.writeUInt32BE(3_999_999_999, wide.indexOf('WMPHOTO') + 12);
      const jxrError = await refusalOf(convertWith('/nonexistent/gxps', await documentPackage(1, () => pageDrawing('/Resources/big.wdp'), { 'Resources/big.wdp': wide }), 'pdf'));
      expect(jxrError).toBeInstanceOf(InputPixelLimitError);
      expect(jxrError.message).toMatch(/declares 4000000000x1 pixels \(4000000000 pixels\), over the input limit of 100000000 pixels/);
    }, CONVERSION_TIMEOUT_MS);

    it('counts a colour profile by its bytes only, however many pages name it', async () => {
      const profile = Buffer.concat([Buffer.alloc(36), Buffer.from('acsp', 'latin1'), Buffer.alloc(1000)]);
      const page = `<FixedPage xmlns="${XPS_NAMESPACE}" Width="816" Height="1056"><Path Data="M 0,0 L 10,0 10,10 0,10 Z" Fill="ContextColor /Resources/profile.icc 1,0.5,0.2"/></FixedPage>`;
      const xps = await documentPackage(2000, () => page, { 'Resources/profile.icc': profile });
      const result = await convertWith(await standIn({ pdfPages: 2000 }), xps, 'pdf');
      expect(result?.engineUsed).toBe('native-xps');
    }, CONVERSION_TIMEOUT_MS);
  });

  it('counts a font once however many pages name it, as the renderer keeps a font after the first page that loads it', async () => {
    const pages = PAGES_AT_BUDGET * 3;
    const page = `<FixedPage xmlns="${XPS_NAMESPACE}" Width="816" Height="1056"><Glyphs FontUri="/Resources/font.ttf" FontRenderingEmSize="20" OriginX="10" OriginY="30" UnicodeString="x" Fill="#FF000000"/></FixedPage>`;
    const xps = await documentPackage(pages, () => page, { 'Resources/font.ttf': opaqueBytes(BIG_PART_BYTES) });
    const result = await convertWith(await standIn({ pdfPages: pages }), xps, 'pdf');
    expect(result?.engineUsed).toBe('native-xps');
  }, CONVERSION_TIMEOUT_MS * 2);

  it('counts the images that a shared resource dictionary names for every page that names the dictionary', async () => {
    const dictionary = `<ResourceDictionary xmlns="${XPS_NAMESPACE}"><ImageBrush x:Key="b" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" ImageSource="/${BIG_PART}"/></ResourceDictionary>`;
    const page = `<FixedPage xmlns="${XPS_NAMESPACE}" Width="816" Height="1056"><FixedPage.Resources><ResourceDictionary Source="/Resources/shared.dict"/></FixedPage.Resources></FixedPage>`;
    const xps = await documentPackage(PAGES_AT_BUDGET + 1, () => page, { 'Resources/shared.dict': dictionary, [BIG_PART]: opaqueBytes(BIG_PART_BYTES) });
    const error = await refusalOf(convertWith('/nonexistent/gxps', xps, 'pdf'));
    expect(error).toBeInstanceOf(PayloadLimitError);
    expect(error.message).toMatch(new RegExp(`more than ${REFERENCED_BYTES_BUDGET} bytes of images and colour profiles`));
  }, CONVERSION_TIMEOUT_MS * 2);

  it('reads a resource dictionary that names itself once and ends', async () => {
    const dictionary = `<ResourceDictionary xmlns="${XPS_NAMESPACE}" Source="/Resources/loop.dict"/>`;
    const page = `<FixedPage xmlns="${XPS_NAMESPACE}" Width="816" Height="1056"><FixedPage.Resources><ResourceDictionary Source="/Resources/loop.dict"/></FixedPage.Resources></FixedPage>`;
    const xps = await documentPackage(2, () => page, { 'Resources/loop.dict': dictionary });
    const result = await convertWith(await standIn({ pdfPages: 2 }), xps, 'pdf');
    expect(result?.engineUsed).toBe('native-xps');
  }, CONVERSION_TIMEOUT_MS);
});
