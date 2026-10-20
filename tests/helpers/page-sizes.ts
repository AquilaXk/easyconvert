import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { requireOracleTool } from './differential-oracle';

/**
 * The size of the pages a converter wrote, read by tools other than the converter: Poppler for a PDF, Ghostscript's bbox device for the ink
 * of a PostScript or EPS page. Each size is [width, height] in points.
 */

export type PageSize = [number, number];

function withTempFile<T>(extension: string, bytes: Buffer, read: (file: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'page-sizes-'));
  try {
    const file = path.join(dir, `input.${extension}`);
    fs.writeFileSync(file, bytes);
    return read(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The size of every page of a PDF, by Poppler. */
export function pdfPageSizes(pdf: Buffer): PageSize[] {
  const text = withTempFile('pdf', pdf, (file) => execFileSync(requireOracleTool('pdfinfo'), ['-f', '1', '-l', '99', file], { encoding: 'utf-8' }));
  return [...text.matchAll(/^Page\s+\d+ size:\s+([\d.]+) x ([\d.]+) pts/gm)].map((match) => [Number(match[1]), Number(match[2])]);
}

/** The box of the ink every page of a PostScript program draws, as [width, height] from the origin, by Ghostscript's bbox device. */
export function postscriptInkSizes(program: Buffer): PageSize[] {
  const run = withTempFile('ps', program, (file) => spawnSync(requireOracleTool('gs'), ['-q', '-dBATCH', '-dNOPAUSE', '-dSAFER', '-sDEVICE=bbox', file], { encoding: 'utf-8' }));
  return [...run.stderr.matchAll(/^%%HiResBoundingBox: ([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+)$/gm)].map((match) => [Number(match[3]) - Number(match[1]), Number(match[4]) - Number(match[2])]);
}
