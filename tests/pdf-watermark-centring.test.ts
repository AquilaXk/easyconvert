import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterAll, describe, expect, it } from 'vitest';
import { measureInk, parsePgm } from '../bench/pdf-ink';
import { defaultResolver } from '../bench/tools';
import { applyPdfWatermark } from '../src/lib/conversions/pdf-postprocess/watermark';
import { skipUnless } from './helpers/strict-skip';

/**
 * A centred watermark is centred where it is seen: the bounding box of its ink, measured on pages rendered by Poppler
 * (the stamped page minus the blank page), lies at the page centre within the glyph side bearings, whatever the text
 * and the angle. The measure is the one the benchmark uses (bench/pdf-ink.ts).
 */

const pdftoppm = defaultResolver()('pdftoppm');
const work = mkdtempSync(path.join(tmpdir(), 'watermark-centring-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const DPI = 144;
const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
/** Side bearings of the first and last glyph shift the bounding box of the ink by about a point along the text. */
const TOLERANCE_POINTS = 2;

async function blankPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  await doc.embedFont(StandardFonts.Helvetica);
  return Buffer.from(await doc.save());
}

function render(pdf: Buffer, name: string): ReturnType<typeof parsePgm> {
  const input = path.join(work, `${name}.pdf`);
  writeFileSync(input, pdf);
  execFileSync(pdftoppm as string, ['-r', String(DPI), '-gray', input, path.join(work, name)]);
  const file = readdirSync(work).find((entry) => entry.startsWith(`${name}-`) && entry.endsWith('.pgm')) as string;
  return parsePgm(readFileSync(path.join(work, file)));
}

describe.skipIf(skipUnless('pdftoppm', pdftoppm !== null))('the centre of a standard-font text watermark', () => {
  it.each([
    ['capitals at the default angle', 'CONFIDENTIAL', -45],
    ['capitals, level', 'DRAFT COPY', 0],
    ['capitals, steep', 'DRAFT COPY', 60],
    ['letters with descenders', 'Quality gypsy', -45],
    ['letters with descenders, level', 'Quality gypsy', 0],
    ['mixed case without descenders', 'Internal Use', 30],
  ])('is the centre of its ink: %s', async (_name, text, rotation) => {
    const blank = await blankPdf();
    const stamped = await applyPdfWatermark(blank, { text, fontSize: 48, rotation, opacity: 1, fontColor: '#000000', position: 'center' });
    const ink = measureInk(render(stamped, `stamped-${rotation}-${text.length}`), render(blank, `blank-${rotation}-${text.length}`), DPI, rotation);
    expect(ink.inkPixels).toBeGreaterThan(1000);
    expect(Math.abs(ink.centreAcross), `across the text, ${ink.centreAcross.toFixed(2)} pt`).toBeLessThanOrEqual(TOLERANCE_POINTS);
    expect(Math.abs(ink.centreAlong), `along the text, ${ink.centreAlong.toFixed(2)} pt`).toBeLessThanOrEqual(TOLERANCE_POINTS);
  });
});
