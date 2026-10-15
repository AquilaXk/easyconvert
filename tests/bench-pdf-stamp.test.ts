import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildStampPdf, type StampSpec } from '../bench/pdf-stamp';
import { defaultResolver } from '../bench/tools';
import { skipUnless } from './helpers/strict-skip';

/**
 * The stamp PDF is the reference side of the watermark row, so it is checked by tools that share no code with it: its
 * cross-reference offsets are read back from the bytes, and qpdf and pdftotext open it.
 */

const SPEC: StampSpec = { text: 'DRAFT COPY', fontSize: 48, rotationDegrees: -45, opacity: 0.3, grey: 0.5, pageWidth: 595.304, pageHeight: 841.89 };
const resolve = defaultResolver();
const qpdf = resolve('qpdf');
const pdftotext = resolve('pdftotext');
const work = mkdtempSync(path.join(tmpdir(), 'bench-pdf-stamp-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe('the stamp PDF', () => {
  it('lists every object at the byte offset the cross-reference table names', () => {
    const text = buildStampPdf(SPEC).toString('latin1');
    const entries = [...text.matchAll(/^(\d{10}) 00000 n $/gm)].map((match) => Number(match[1]));
    expect(entries).toHaveLength(5);
    for (const [index, offset] of entries.entries()) expect(text.slice(offset).startsWith(`${index + 1} 0 obj\n`), `object ${index + 1}`).toBe(true);
    const startxref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(text)?.[1]);
    expect(text.slice(startxref).startsWith('xref\n0 6\n')).toBe(true);
  });

  it('declares the page size, the opacity and the stream length it writes', () => {
    const text = buildStampPdf(SPEC).toString('latin1');
    expect(text).toContain('/MediaBox [0 0 595.3040 841.8900]');
    expect(text).toContain('/ca 0.3000');
    const declared = Number(/\/Length (\d+) >>\nstream\n/.exec(text)?.[1]);
    const stream = /stream\n([\s\S]*?)\nendstream/.exec(text)?.[1] ?? '';
    expect(declared).toBe(Buffer.byteLength(stream, 'latin1'));
  });

  it('centres the rotated ink box: the text matrix moves the origin to where the centre of the box of the capitals is the page centre', () => {
    const matrix = /([-0-9.]+) ([-0-9.]+) ([-0-9.]+) ([-0-9.]+) ([-0-9.]+) ([-0-9.]+) Tm/.exec(buildStampPdf(SPEC).toString('latin1'));
    const [cos, sin, , , x, y] = (matrix ?? []).slice(1).map(Number);
    const width = 6.5 * SPEC.fontSize; // D R A F T space C O P Y: 6500 units of the Helvetica-Bold metrics
    const height = 0.718 * SPEC.fontSize; // the cap height: the stamp text is capitals, so its ink runs from the baseline up to it
    expect(x + (width / 2) * cos - (height / 2) * sin).toBeCloseTo(SPEC.pageWidth / 2, 2);
    expect(y + (width / 2) * sin + (height / 2) * cos).toBeCloseTo(SPEC.pageHeight / 2, 2);
  });

  it('refuses a character whose width it does not know', () => {
    expect(() => buildStampPdf({ ...SPEC, text: 'draft' })).toThrow(RangeError);
  });

  it.skipIf(skipUnless('qpdf', qpdf !== null))('passes qpdf --check', () => {
    const file = path.join(work, 'stamp.pdf');
    writeFileSync(file, buildStampPdf(SPEC));
    const run = spawnSync(qpdf as string, ['--check', file], { encoding: 'utf8' });
    expect(run.status, run.stdout + run.stderr).toBe(0);
  });

  it.skipIf(skipUnless('pdftotext', pdftotext !== null))('shows its text to pdftotext, letters of the rotated string in some order', () => {
    const file = path.join(work, 'stamp-text.pdf');
    writeFileSync(file, buildStampPdf(SPEC));
    const run = spawnSync(pdftotext as string, [file, '-'], { encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect([...run.stdout.replace(/\s/g, '')].sort().join('')).toBe([...'DRAFTCOPY'].sort().join(''));
  });
});
