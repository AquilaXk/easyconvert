import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import { convertFile } from '../src/lib/conversions';
import { readDocxModel } from '../src/lib/conversions/docx-model';
import { blankDocument } from '../src/lib/conversions/document-model/build';
import type { DocumentModel, ParagraphBlock } from '../src/lib/conversions/document-model/model';
import { documentToPdf } from '../src/lib/conversions/document-model/pdf';
import { oracleTest } from './helpers/oracle-test';
import { requireOracleTool } from './helpers/differential-oracle';
import { fixtureBytes, richStructureImageHashes, sha256 } from './helpers/document-fixtures';

/**
 * docx to pdf through the in-process writer keeps list numbers, pictures and the page structure. Oracles are Poppler
 * (pdftotext, pdfimages, pdfinfo) and the LibreOffice rendering of the same file.
 */

const RICH = fixtureBytes('rich-structure.docx');

function runPdftotext(pdf: Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-pdf-'));
  try {
    const file = path.join(dir, 'out.pdf');
    fs.writeFileSync(file, pdf);
    return execFileSync(requireOracleTool('pdftotext'), ['-layout', '-enc', 'UTF-8', file, '-'], { encoding: 'utf-8' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('docx to pdf keeps list numbers, pictures and page breaks', () => {
  oracleTest('list markers appear in order in the pdftotext output', ['pdftotext'], async () => {
    const pdf = (await convertFile(RICH, 'docx', 'pdf', {}, 'rich-structure.docx')).buffer;
    const text = runPdftotext(pdf);
    const expected = [
      /1\.\s+Inspect pumps/,
      /2\.\s+Check valves/,
      /a\.\s+Isolate line/,
      /b\.\s+Drain line/,
      /i\.\s+Record level/,
      /3\.\s+Close out/,
      /1\.\s+Restart item one/,
      /2\.\s+Restart item two/,
      /III\)\s+Roman list from three/,
      /IV\)\s+Second roman item/,
    ];
    let from = 0;
    for (const pattern of expected) {
      const match = pattern.exec(text.slice(from));
      expect(match, `${pattern} after offset ${from}`).not.toBeNull();
      from += (match as RegExpExecArray).index + (match as RegExpExecArray)[0].length;
    }
  });

  oracleTest('the source JPEG is embedded unchanged (pdfimages -j)', ['pdfimages'], async () => {
    const pdf = (await convertFile(RICH, 'docx', 'pdf', {}, 'rich-structure.docx')).buffer;
    const { jpegBytes } = await richStructureImageHashes();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-img-'));
    try {
      fs.writeFileSync(path.join(dir, 'out.pdf'), pdf);
      execFileSync(requireOracleTool('pdfimages'), ['-j', path.join(dir, 'out.pdf'), path.join(dir, 'img')]);
      const extracted = fs.readdirSync(dir).filter((name) => name.endsWith('.jpg'));
      expect(extracted.map((name) => sha256(fs.readFileSync(path.join(dir, name))))).toContain(sha256(jpegBytes));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  oracleTest('the page count equals the LibreOffice rendering, whose last page holds the last text and the endnote', ['pdfinfo', 'pdftotext', 'soffice'], async () => {
    const pdf = (await convertFile(RICH, 'docx', 'pdf', {}, 'rich-structure.docx')).buffer;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-pages-'));
    try {
      fs.writeFileSync(path.join(dir, 'ours.pdf'), pdf);
      fs.writeFileSync(path.join(dir, 'rich-structure.docx'), RICH);
      execFileSync(requireOracleTool('soffice'), ['--headless', `-env:UserInstallation=file://${dir}/profile`, '--convert-to', 'pdf', '--outdir', path.join(dir, 'ref'), path.join(dir, 'rich-structure.docx')], { stdio: 'ignore', timeout: 120_000 });
      const pages = (file: string): number => Number(/Pages:\s+(\d+)/.exec(execFileSync(requireOracleTool('pdfinfo'), [file], { encoding: 'utf-8' }))?.[1]);
      const referencePdf = path.join(dir, 'ref', 'rich-structure.pdf');
      const lastPage = pages(referencePdf);
      const lastPageText = execFileSync(requireOracleTool('pdftotext'), ['-f', String(lastPage), '-l', String(lastPage), referencePdf, '-'], { encoding: 'utf-8' });
      // LibreOffice 26.8 sets the endnote of a DOCX after the last text of the document, on the page that text ends on (24.2 started a page
      // for it), and so does the in-process renderer (entry 464).
      expect(lastPageText).toContain('Second section text.');
      expect(lastPageText).toContain('Calibration certificates are on file.');
      expect(pages(path.join(dir, 'ours.pdf'))).toBe(lastPage);
      const ourLastPage = execFileSync(requireOracleTool('pdftotext'), ['-f', String(lastPage), '-l', String(lastPage), path.join(dir, 'ours.pdf'), '-'], { encoding: 'utf-8' });
      expect(ourLastPage).toMatch(/Second section text\.[\s\S]*Calibration certificates are on file\./);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});


function paragraphOf(text: string): ParagraphBlock {
  return { type: 'paragraph', runs: [{ text, bold: false, italic: false, monospace: false }], rtl: false, align: 'left' };
}

function noteModel(continuous: boolean): DocumentModel {
  const model = blankDocument([{ columns: 1, blocks: [paragraphOf('Body text.')] }]);
  model.endnotes = [{ id: 1, label: '1', blocks: [paragraphOf('Endnote text.')] }];
  if (continuous) model.continuousEndnotes = true;
  return model;
}

describe('endnotes follow the source (entry 464)', () => {
  it('a DOCX model sets its endnotes after the last text, any other model starts a page for them', async () => {
    const pageCount = async (continuous: boolean): Promise<number> => (await PDFDocument.load(await documentToPdf(noteModel(continuous), {}, 'notes'))).getPageCount();
    expect(await pageCount(true)).toBe(1);
    expect(await pageCount(false)).toBe(2);
  });

  it('the DOCX reader marks its endnotes as continuous', async () => {
    const { model } = await readDocxModel(await JSZip.loadAsync(RICH));
    expect(model.endnotes).toHaveLength(1);
    expect(model.continuousEndnotes).toBe(true);
  });
});
