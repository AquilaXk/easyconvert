import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { illustratorRouteFormat } from '../src/worker/illustrator-route';
import { getOracleToolPath } from './helpers/differential-oracle';
import { decodeRgba } from './helpers/image-pixels';
import { requireRealworldSample } from './helpers/realworld-sample';
import { skipUnless } from './helpers/strict-skip';

/**
 * An Adobe Illustrator file is converted as the format it is written in: a PDF (files saved with PDF compatibility) or a
 * PostScript program (versions 3 to 8), which the signature check accepts for its Illustrator prolog (#783: the PostScript
 * kind was refused, and once accepted was handed to the PDF reader).
 */

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'illustrator-route-'));
afterAll(() => fs.rmSync(workDir, { recursive: true, force: true }));

const POSTSCRIPT = Buffer.from('%!PS-Adobe-3.0 EPSF-3.0\n%%Creator: Adobe Illustrator(R) 8.0\n%%EndComments\n');
const PDF = Buffer.from('%PDF-1.6\n%\xe2\xe3\xcf\xd3\n', 'latin1');

describe('the format an Illustrator file is converted as', () => {
  it('is PostScript for a program and PDF for a PDF', () => {
    expect(illustratorRouteFormat(POSTSCRIPT)).toBe('ps');
    expect(illustratorRouteFormat(PDF)).toBe('pdf');
  });

  it('reads the signature from every form of input: a buffer, a payload with a buffer, a payload with a file', () => {
    const file = path.join(workDir, 'art.ai');
    fs.writeFileSync(file, POSTSCRIPT);
    expect(illustratorRouteFormat({ inputBuffer: POSTSCRIPT })).toBe('ps');
    expect(illustratorRouteFormat({ inputBuffer: PDF })).toBe('pdf');
    expect(illustratorRouteFormat({ inputPath: file })).toBe('ps');
    fs.writeFileSync(file, PDF);
    expect(illustratorRouteFormat({ inputPath: file })).toBe('pdf');
  });

  it('is PDF for input that holds no signature to read', () => {
    expect(illustratorRouteFormat(Buffer.alloc(0))).toBe('pdf');
    expect(illustratorRouteFormat({ inputBuffer: Buffer.from('%!P') })).toBe('pdf');
    expect(illustratorRouteFormat({})).toBe('pdf');
    const empty = path.join(workDir, 'empty.ai');
    fs.writeFileSync(empty, '');
    expect(illustratorRouteFormat({ inputPath: empty })).toBe('pdf');
  });
});

const needsGhostscript = skipUnless('Ghostscript (ps2pdf, pdfinfo)', getOracleToolPath('ps2pdf') !== null && getOracleToolPath('pdfinfo') !== null);

describe.skipIf(needsGhostscript)('a PostScript Illustrator file', () => {
  it('converts to a one-page PDF and to pictures of the page its header states', async (ctx) => {
    const sample = await requireRealworldSample(ctx, 'tika-testai_ps.ai');
    const pdfFile = path.join(workDir, 'art.pdf');
    fs.writeFileSync(pdfFile, (await dispatchConversion(sample.bytes, 'ai', 'pdf', {}, 'art.ai')).buffer);
    const info = execFileSync(getOracleToolPath('pdfinfo') as string, [pdfFile], { encoding: 'utf8' });
    expect(info).toMatch(/Pages:\s+1\b/);
    // `%AI5_ArtSize: 612 792` of the file: a page of 612 x 792 points.
    expect(info).toMatch(/Page size:\s+612 x 792 pts/);
    const aspect = 612 / 792;
    for (const target of ['png', 'jpg']) {
      const picture = await decodeRgba((await dispatchConversion(sample.bytes, 'ai', target, {}, 'art.ai')).buffer);
      expect(picture.width / picture.height).toBeCloseTo(aspect, 1);
    }
  });
});
