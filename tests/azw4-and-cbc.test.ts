import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import sharp from 'sharp';
import { convertFile } from '../src/lib/conversions';
import { ConversionFailedError } from '../src/lib/types';
import { EncryptedOfficeDocumentError } from '../src/lib/conversions/office/legacy-office-errors';
import { readMobiText } from '../src/lib/conversions/office/mobi-reader';
import { oracleTest } from './helpers/oracle-test';
import { extractTextWithExternalPdftotext, requireOracleTool } from './helpers/differential-oracle';
import { buildMobi, buildMobiFromBytes } from './helpers/mobi-builder';
import { buildStoredRar4 } from './helpers/rar4-stored';
import { mopStream, textPdf } from './helpers/print-replica-builder';
import { flatOdt, normalizeWhitespace, sofficeConvert } from './helpers/soffice-office';

/**
 * AZW4 (Print Replica) books carry a PDF in their PalmDB text records, and a CBC is a ZIP of comic volumes. Both
 * are read for every advertised target. The expected values come from the PDFs and page images the fixtures are
 * built from, read back by pdfinfo, pdftotext, pdfimages and tesseract (separate tools), never from the readers.
 */

const NATIVE_TIMEOUT_MS = 180_000;
const OCR_TIMEOUT_MS = 240_000;
const TARGETS = ['pdf', 'rtf', 'txt', 'azw3', 'epub', 'lrf', 'mobi', 'oeb', 'pdb'] as const;

function pdfInfoPages(pdf: Buffer): number {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azw4-pdfinfo-'));
  try {
    fs.writeFileSync(path.join(dir, 'in.pdf'), pdf);
    return Number(/Pages:\s+(\d+)/.exec(execFileSync(requireOracleTool('pdfinfo'), [path.join(dir, 'in.pdf')], { encoding: 'utf-8' }))?.[1]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// AZW4
// ---------------------------------------------------------------------------

describe('AZW4 Print Replica books', () => {
  const PAGES = ['Print Replica page one', 'Print Replica page two'];

  oracleTest('azw4 -> pdf is the embedded PDF itself, read through the %MOP table of compressed records', ['pdfinfo', 'pdftotext'], async () => {
    const pdf = await textPdf(PAGES);
    const book = buildMobiFromBytes(mopStream([pdf]), { compress: true });
    const result = await convertFile(book, 'azw4', 'pdf', {}, 'replica.azw4');
    expect(result.filename).toBe('replica.pdf');
    expect(result.buffer.equals(pdf)).toBe(true);
    expect(pdfInfoPages(result.buffer)).toBe(PAGES.length);
    expect(normalizeWhitespace(extractTextWithExternalPdftotext(result.buffer) ?? '')).toBe(PAGES.join(' '));
  }, NATIVE_TIMEOUT_MS);

  oracleTest('a PDF made by LibreOffice is found by its signature among other bytes', ['soffice', 'pdftotext', 'pdfinfo'], async () => {
    const lines = ['LibreOffice made paragraph', 'Café 한국어'];
    const pdf = sofficeConvert(flatOdt(lines), 'fodt', 'pdf', 'pdf');
    const raw = Buffer.concat([Buffer.from('replica header bytes '), pdf, Buffer.from('\ntrailing record data')]);
    const result = await convertFile(buildMobiFromBytes(raw, { compress: false }), 'azw4', 'pdf', {}, 'replica.azw4');
    expect(result.buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pdfInfoPages(result.buffer)).toBe(1);
    expect(normalizeWhitespace(extractTextWithExternalPdftotext(result.buffer) ?? '')).toBe(normalizeWhitespace(extractTextWithExternalPdftotext(pdf) ?? ''));
  }, NATIVE_TIMEOUT_MS);

  oracleTest('two embedded PDFs are joined in file order', ['pdfinfo', 'pdftotext'], async () => {
    const first = await textPdf(['First volume']);
    const second = await textPdf(['Second volume a', 'Second volume b']);
    const result = await convertFile(buildMobiFromBytes(mopStream([first, second]), { compress: false }), 'azw4', 'pdf', {}, 'two.azw4');
    expect(pdfInfoPages(result.buffer)).toBe(3);
    expect(normalizeWhitespace(extractTextWithExternalPdftotext(result.buffer) ?? '')).toBe('First volume Second volume a Second volume b');
  }, NATIVE_TIMEOUT_MS);

  for (const target of TARGETS.filter((t) => t !== 'pdf')) {
    oracleTest(`azw4 -> ${target} carries the text of the embedded PDF`, ['pdftotext'], async () => {
      const pdf = await textPdf(PAGES);
      const result = await convertFile(buildMobiFromBytes(mopStream([pdf]), { compress: true }), 'azw4', target, {}, 'replica.azw4');
      expect(result.filename).toBe(`replica.${target}`);
      const expected = extractTextWithExternalPdftotext(pdf) ?? '';
      const text = await readConverted(result.buffer, target);
      expect(normalizeWhitespace(text)).toContain(PAGES[0]);
      expect(normalizeWhitespace(text)).toContain(PAGES[1]);
      expect(normalizeWhitespace(expected)).toBe(PAGES.join(' '));
    }, NATIVE_TIMEOUT_MS);
  }

  oracleTest('a PDF with only a short line per page still gives its text, without OCR', ['pdftotext'], async () => {
    const pdf = await textPdf(['Probe heading', 'First probe paragraph']);
    const result = await convertFile(buildMobiFromBytes(mopStream([pdf]), { compress: false }), 'azw4', 'txt', {}, 'short.azw4');
    expect(normalizeWhitespace(result.buffer.toString('utf-8'))).toBe(normalizeWhitespace(extractTextWithExternalPdftotext(pdf) ?? ''));
    expect(normalizeWhitespace(result.buffer.toString('utf-8'))).toBe('Probe heading First probe paragraph');
  }, NATIVE_TIMEOUT_MS);

  it('refuses a book without a readable PDF, a damaged PDF, and DRM, with typed errors', async () => {
    const withoutPdf = buildMobiFromBytes(Buffer.from('<html><body>just markup</body></html>'), { compress: false });
    await expect(convertFile(withoutPdf, 'azw4', 'txt', {}, 'x.azw4')).rejects.toThrow(/holds no readable PDF/);
    const damaged = buildMobiFromBytes(Buffer.from('%PDF-1.4\nthis is not a pdf body\n%%EOF\n'), { compress: false });
    await expect(convertFile(damaged, 'azw4', 'pdf', {}, 'x.azw4')).rejects.toBeInstanceOf(ConversionFailedError);
    await expect(convertFile(Buffer.from('plain text pretending to be azw4'.padEnd(120)), 'azw4', 'txt', {}, 'x.azw4')).rejects.toThrow(/not a readable MOBI file/);
    const drm = buildMobi({ textRecords: [Buffer.from('x')], compression: 1, encoding: 65001, textLength: 1, encryption: 2 });
    await expect(convertFile(drm, 'azw4', 'pdf', {}, 'x.azw4')).rejects.toBeInstanceOf(EncryptedOfficeDocumentError);
  });

  oracleTest('an encrypted embedded PDF is the 422 encrypted-document error', ['qpdf'], async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azw4-qpdf-'));
    try {
      fs.writeFileSync(path.join(dir, 'in.pdf'), await textPdf(['secret']));
      execFileSync(requireOracleTool('qpdf'), ['--encrypt', 'user', 'owner', '256', '--', path.join(dir, 'in.pdf'), path.join(dir, 'out.pdf')]);
      const book = buildMobiFromBytes(mopStream([fs.readFileSync(path.join(dir, 'out.pdf'))]), { compress: false });
      const run = convertFile(book, 'azw4', 'pdf', {}, 'locked.azw4');
      await expect(run).rejects.toBeInstanceOf(EncryptedOfficeDocumentError);
      await expect(run).rejects.toMatchObject({ status: 422 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** The text a converted file holds, read the way each container defines it. */
async function readConverted(buffer: Buffer, target: string): Promise<string> {
  if (target === 'txt') return buffer.toString('utf-8');
  if (target === 'epub') {
    const zip = await JSZip.loadAsync(buffer);
    const parts = await Promise.all(Object.keys(zip.files).filter((n) => /\.xhtml$/.test(n)).map((n) => zip.files[n].async('string')));
    return parts.join(' ').replace(/<[^>]+>/g, ' ');
  }
  if (target === 'mobi' || target === 'azw3' || target === 'pdb') return readMobiText(buffer);
  return buffer.toString('latin1').replace(/\\[a-z]+\d* ?/g, ' ');
}

// ---------------------------------------------------------------------------
// CBC
// ---------------------------------------------------------------------------

/** A page image whose width tells it apart, with a word written on it for OCR. */
async function comicPage(word: string, width: number): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="320"><rect width="100%" height="100%" fill="white"/><text x="20" y="200" font-family="DejaVu Sans, Arial, sans-serif" font-size="96" font-weight="bold" fill="black">${word}</text></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function cbz(pages: Record<string, Buffer>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, data] of Object.entries(pages)) zip.file(name, data);
  return zip.generateAsync({ type: 'nodebuffer' });
}

/** Pixel widths of the images of a PDF in page order, as `pdfimages -list` prints them. */
function pdfImageWidths(pdf: Buffer): number[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbc-pdfimages-'));
  try {
    fs.writeFileSync(path.join(dir, 'in.pdf'), pdf);
    const listing = execFileSync(requireOracleTool('pdfimages'), ['-list', path.join(dir, 'in.pdf')], { encoding: 'utf-8' });
    // An image with an alpha channel is listed twice, as `image` and as its `smask`; only the pictures are pages.
    return listing
      .split('\n')
      .slice(2)
      .map((l) => l.trim().split(/\s+/))
      .filter((columns) => columns[2] === 'image')
      .map((columns) => Number(columns[3]));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('CBC comic collections', () => {
  async function collection(listing: string | null, volumes: Record<string, Buffer>): Promise<Buffer> {
    const zip = new JSZip();
    if (listing !== null) zip.file('comics.txt', listing);
    for (const [name, data] of Object.entries(volumes)) zip.file(name, data);
    return zip.generateAsync({ type: 'nodebuffer' });
  }

  oracleTest('cbc -> pdf binds the volumes in the order comics.txt declares, every page of each', ['pdfimages', 'pdfinfo'], async () => {
    const a = await cbz({ 'p1.png': await comicPage('ALPHA', 410), 'p2.png': await comicPage('ALPHA', 420) });
    const b = await cbz({ 'p1.png': await comicPage('BRAVO', 510), 'p2.png': await comicPage('BRAVO', 520) });
    const book = await collection('b.cbz:Second volume\na.cbz:First volume\n', { 'a.cbz': a, 'b.cbz': b });
    const result = await convertFile(book, 'cbc', 'pdf', {}, 'series.cbc');
    expect(result.filename).toBe('series.pdf');
    expect(pdfInfoPages(result.buffer)).toBe(4);
    expect(pdfImageWidths(result.buffer)).toEqual([510, 520, 410, 420]);
  }, NATIVE_TIMEOUT_MS);

  oracleTest('without a listing the volumes and pages follow natural name order', ['pdfimages'], async () => {
    const volume = async (width: number) => cbz({ 'page10.png': await comicPage('X', width + 2), 'page2.png': await comicPage('X', width + 1) });
    const book = await collection(null, { 'vol10.cbz': await volume(1000), 'vol2.cbz': await volume(200), 'Vol1.cbz': await volume(100) });
    expect(pdfImageWidths((await convertFile(book, 'cbc', 'pdf', {}, 'n.cbc')).buffer)).toEqual([101, 102, 201, 202, 1001, 1002]);
  }, NATIVE_TIMEOUT_MS);

  oracleTest('CBR and CB7 volumes are unpacked and bound with the CBZ ones', ['pdfimages', '7z'], async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cbc-cb7-'));
    try {
      fs.writeFileSync(path.join(dir, 'page.png'), await comicPage('SEVEN', 330));
      execFileSync(requireOracleTool('7z'), ['a', '-t7z', path.join(dir, 'v.cb7'), path.join(dir, 'page.png')], { stdio: 'ignore' });
      const book = await collection('1.cbz:a\n2.cbr:b\n3.cb7:c\n', {
        '1.cbz': await cbz({ 'p.png': await comicPage('ONE', 310) }),
        '2.cbr': buildStoredRar4([{ name: 'p.png', data: await comicPage('TWO', 320) }]),
        '3.cb7': fs.readFileSync(path.join(dir, 'v.cb7')),
      });
      expect(pdfImageWidths((await convertFile(book, 'cbc', 'pdf', {}, 'mix.cbc')).buffer)).toEqual([310, 320, 330]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, NATIVE_TIMEOUT_MS);

  oracleTest('cbc -> txt reads the lettering of the pages with OCR, in page order', ['tesseract', 'pdfimages'], async () => {
    const book = await collection('a.cbz:A\nb.cbz:B\n', {
      'a.cbz': await cbz({ 'p.png': await comicPage('HELLO', 700) }),
      'b.cbz': await cbz({ 'p.png': await comicPage('WORLD', 700) }),
    });
    const text = (await convertFile(book, 'cbc', 'txt', {}, 'ocr.cbc')).buffer.toString('utf-8').toUpperCase();
    expect(text.indexOf('HELLO')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('WORLD')).toBeGreaterThan(text.indexOf('HELLO'));
  }, OCR_TIMEOUT_MS);

  oracleTest('pages with no lettering give the PDF converter\'s typed error for the text targets, like any scanned PDF', ['tesseract'], async () => {
    const blank = await sharp({ create: { width: 600, height: 400, channels: 3, background: 'white' } }).png().toBuffer();
    const book = await collection(null, { 'v.cbz': await cbz({ 'p.png': blank }) });
    for (const target of ['txt', 'epub'] as const) {
      const run = convertFile(book, 'cbc', target, {}, 'blank.cbc');
      await expect(run).rejects.toBeInstanceOf(ConversionFailedError);
      await expect(run).rejects.toThrow(/PDF OCR failed: Optical character recognition failed to detect readable text/);
    }
  }, OCR_TIMEOUT_MS);

  it('refuses a file that is not a collection, one without volumes, a listing that names a missing volume, and a damaged volume', async () => {
    await expect(convertFile(Buffer.from('not a zip'), 'cbc', 'pdf', {}, 'x.cbc')).rejects.toThrow(/not a valid ZIP package/);
    await expect(convertFile(await collection('x', {}), 'cbc', 'pdf', {}, 'x.cbc')).rejects.toThrow(/holds no comic volumes/);
    const volume = await cbz({ 'p.png': await comicPage('X', 300) });
    await expect(convertFile(await collection('gone.cbz:Missing\n', { 'v.cbz': volume }), 'cbc', 'pdf', {}, 'x.cbc')).rejects.toThrow(/names "gone\.cbz", which is not in the archive/);
    const run = convertFile(await collection(null, { 'bad.cbz': Buffer.from('not a zip') }), 'cbc', 'pdf', {}, 'x.cbc');
    await expect(run).rejects.toBeInstanceOf(ConversionFailedError);
    await expect(run).rejects.toThrow(/CBC volume bad\.cbz/);
    const noPages = await cbz({ 'readme.txt': Buffer.from('no pictures') });
    await expect(convertFile(await collection(null, { 'v.cbz': noPages }), 'cbc', 'pdf', {}, 'x.cbc')).rejects.toThrow(/holds no page images/);
  });
});
