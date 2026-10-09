import { describe, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { convertFile } from '../src/lib/conversions';
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

  oracleTest('the page count equals the LibreOffice rendering', ['pdfinfo', 'soffice'], async () => {
    const pdf = (await convertFile(RICH, 'docx', 'pdf', {}, 'rich-structure.docx')).buffer;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-pages-'));
    try {
      fs.writeFileSync(path.join(dir, 'ours.pdf'), pdf);
      fs.writeFileSync(path.join(dir, 'rich-structure.docx'), RICH);
      execFileSync(requireOracleTool('soffice'), ['--headless', `-env:UserInstallation=file://${dir}/profile`, '--convert-to', 'pdf', '--outdir', path.join(dir, 'ref'), path.join(dir, 'rich-structure.docx')], { stdio: 'ignore', timeout: 120_000 });
      const pages = (file: string): number => Number(/Pages:\s+(\d+)/.exec(execFileSync(requireOracleTool('pdfinfo'), [file], { encoding: 'utf-8' }))?.[1]);
      expect(pages(path.join(dir, 'ours.pdf'))).toBe(pages(path.join(dir, 'ref', 'rich-structure.pdf')));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);
});

