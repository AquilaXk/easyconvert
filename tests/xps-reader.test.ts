import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { convertFile } from '../src/lib/conversions';
import { buildOpenXpsPackage } from '../src/lib/conversions/openxps';
import { readXpsPages } from '../src/lib/conversions/office/xps-reader';
import { ConversionFailedError } from '../src/lib/types';
import { requireRealworldSample } from './helpers/realworld-sample';
import { pythonModuleAvailable, runPythonHelper } from './helpers/python-oracle';
import { skipUnless } from './helpers/strict-skip';

/**
 * XPS and OpenXPS sources. Until #783 the bytes of the package were read as text and the answer was refused as "not a
 * .txt file". The text is read from the glyph runs of the fixed pages; the oracle is MuPDF (PyMuPDF), an independent XPS
 * reader, on three real files of the Apache Tika test documents (a Word print, a PowerPoint print and a file with
 * right-to-left text, hyperlinks and an embedded PDF name).
 */

const mupdfMissing = skipUnless('PyMuPDF', pythonModuleAvailable('pymupdf') || pythonModuleAvailable('fitz'));
const MIN_WORD_LENGTH = 3;
const CONVERSION_TIMEOUT_MS = 120_000;
const SAMPLES = ['tika-test_text.xps', 'tika-testppt.xps', 'tika-testxps_various.xps'] as const;

function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= MIN_WORD_LENGTH);
}

function mupdfWords(xps: Buffer): Set<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xps-oracle-'));
  try {
    const file = path.join(dir, 'in.xps');
    fs.writeFileSync(file, xps);
    return new Set(wordsOf(runPythonHelper<string[]>('xps_text.py', [file]).join(' ')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(mupdfMissing)('XPS text of real files against MuPDF', () => {
  for (const id of SAMPLES) {
    it(
      `${id} converts to text and HTML with the words MuPDF reads`,
      async (ctx) => {
        const { bytes: xps } = await requireRealworldSample(ctx, id);
        const reference = mupdfWords(xps);
        expect(reference.size).toBeGreaterThan(0);
        for (const target of ['txt', 'html'] as const) {
          const result = await dispatchConversion(xps, 'xps', target, {}, id);
          const markup = result.buffer.toString('utf-8');
          const text = target === 'html' ? markup.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>') : markup;
          const have = new Set(wordsOf(text));
          expect({ target, missing: [...reference].filter((word) => !have.has(word)) }).toEqual({ target, missing: [] });
        }
      },
      CONVERSION_TIMEOUT_MS
    );
  }
});

describe('XPS reader', () => {
  it('reads back the lines that the OpenXPS writer drew', async () => {
    const lines = ['Quarterly report', 'Revenue grew by 4 percent.', 'See the appendix for the method.'];
    const xps = await buildOpenXpsPackage([{ title: 'Report', lines }], 'Report');
    const pages = await readXpsPages(xps);
    expect(pages.join('\n').split('\n')).toEqual(lines);
  });

  it('converts through the shared entry point to the same text', async () => {
    const lines = ['First line of text', 'Second line of text'];
    const xps = await buildOpenXpsPackage([{ title: 'Doc', lines }], 'Doc');
    const result = await convertFile(xps, 'xps', 'txt', {}, 'doc.xps');
    expect(result.buffer.toString('utf-8')).toBe(lines.join('\n'));
  });

  it('answers a ZIP package with no fixed document sequence with a typed error naming the format', async () => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
    zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>');
    const notXps = await zip.generateAsync({ type: 'nodebuffer' });
    await expect(readXpsPages(notXps)).rejects.toBeInstanceOf(ConversionFailedError);
    await expect(readXpsPages(notXps)).rejects.toThrow(/not an XPS document/);
  });

  it('answers bytes that are not a ZIP package with a typed error', async () => {
    await expect(readXpsPages(Buffer.from('not a package at all'))).rejects.toThrow('The XPS file is not a valid ZIP package.');
  });
});
