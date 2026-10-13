import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { convertFile } from '../src/lib/conversions';
import { requireOracleTool } from './helpers/differential-oracle';
import { oracleTest } from './helpers/oracle-test';

/**
 * DOCX to PDF layout facts that the words of the PDF show: a paragraph after a table or a drawing starts at the margin (and
 * its words stay whole), and a note mark is a separate word beside the text it follows and the note it opens. The expected words
 * are the ones written into the package, never a second conversion.
 */

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const WORD = /[\p{L}\p{N}]+/gu;

async function docx(body: string, extraParts: Record<string, string> = {}): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/></Types>'
  );
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/_rels/document.xml.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/></Relationships>');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document ${W} xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><w:body>${body}</w:body></w:document>`);
  for (const [name, content] of Object.entries(extraParts)) zip.file(name, content);
  return zip.generateAsync({ type: 'nodebuffer' });
}

const paragraph = (text: string): string => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;

function pdfWords(pdf: Buffer): string[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-layout-'));
  try {
    fs.writeFileSync(path.join(dir, 'out.pdf'), pdf);
    const text = execFileSync(requireOracleTool('pdftotext'), ['-enc', 'UTF-8', path.join(dir, 'out.pdf'), '-'], { encoding: 'utf-8' });
    return (text.toLowerCase().match(WORD) ?? []).sort();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const sortedWords = (text: string): string[] => (text.toLowerCase().match(WORD) ?? []).sort();

describe('DOCX with a drawing, to PDF (the reader that draws shapes)', () => {
  // A table of seven narrow columns, then a drawing that is not a picture (which sends the document to the shape-aware reader), then prose.
  const cells = Array.from({ length: 7 }, (_, c) => `<w:tc><w:tcPr><w:tcW w:w="1200" w:type="dxa"/></w:tcPr>${paragraph(`cell${c}`)}</w:tc>`).join('');
  const table = `<w:tbl><w:tblPr><w:tblW w:w="8400" w:type="dxa"/></w:tblPr><w:tblGrid>${'<w:gridCol w:w="1200"/>'.repeat(7)}</w:tblGrid><w:tr>${cells}</w:tr></w:tbl>`;
  const shape = '<w:p><w:r><w:drawing><wp:inline><wp:extent cx="914400" cy="914400"/><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';
  const prose = 'Interdisciplinary researchers reassessed the carcinogenicity of polychlorinated biphenyls and published their conclusions';

  oracleTest('starts the paragraph after a table at the margin: its words are whole and its lines are long', ['pdftotext'], async () => {
    const result = await convertFile(await docx(`${table}${shape}${paragraph(prose)}`), 'docx', 'pdf', {}, 'after-table.docx');
    const expected = sortedWords(`${Array.from({ length: 7 }, (_, c) => `cell${c}`).join(' ')} ${prose}`);
    expect(pdfWords(result.buffer)).toEqual(expected);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-layout-'));
    try {
      fs.writeFileSync(path.join(dir, 'out.pdf'), result.buffer);
      const layout = execFileSync(requireOracleTool('pdftotext'), ['-layout', path.join(dir, 'out.pdf'), '-'], { encoding: 'utf-8' });
      // At the margin the prose takes two lines of a page; in a column as narrow as the last cell it took a dozen.
      expect(layout.split('\n').filter((line) => /carcinogenicity|conclusions/.test(line)).length).toBeLessThanOrEqual(2);
      expect(layout.split('\n').filter((line) => line.trim() !== '' && !/cell/.test(line)).length).toBeLessThanOrEqual(3);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('DOCX notes in PDF', () => {
  const footnotes = `<?xml version="1.0" encoding="UTF-8"?><w:footnotes ${W}><w:footnote w:id="0" w:type="separator"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:id="1"><w:p><w:r><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> </w:t></w:r><w:r><w:t>a</w:t></w:r></w:p></w:footnote><w:footnote w:id="2"><w:p><w:r><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> </w:t></w:r><w:r><w:t>b</w:t></w:r></w:p></w:footnote></w:footnotes>`;
  const cited = (text: string, id: number): string => `<w:p><w:r><w:t>${text}</w:t></w:r><w:r><w:footnoteReference w:id="${id}"/></w:r></w:p>`;

  oracleTest('keeps a note mark apart from the word it follows and the note text apart from its number', ['pdftotext'], async () => {
    const result = await convertFile(await docx(`${cited('1', 1)}${cited('3', 2)}`, { 'word/footnotes.xml': footnotes }), 'docx', 'pdf', {}, 'notes.docx');
    // The body words are 1 and 3, the marks 1 and 2, the notes (with their numbers) "1 a" and "2 b": every one a word of its own.
    expect(pdfWords(result.buffer)).toEqual(['1', '1', '1', '2', '2', '3', 'a', 'b']);
  });
});
