import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { convertFile } from '../src/lib/conversions';
import { oracleTest } from './helpers/oracle-test';
import { extractTextWithExternalPdftotext } from './helpers/differential-oracle';

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

async function buildPptx(paragraphs: string[], extraShapes = ''): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>');
  zip.file('ppt/presentation.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation ${NS}><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>`);
  zip.file('ppt/_rels/presentation.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>');
  zip.file(
    'ppt/slides/slide1.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld ${NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Text"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="457200"/><a:ext cx="8229600" cy="1143000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs.map((p) => `<a:p>${p}</a:p>`).join('')}</p:txBody></p:sp>${extraShapes}</p:spTree></p:cSld></p:sld>`
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

const run = (text: string, props = ''): string => `<a:r><a:rPr lang="en-US">${props}</a:rPr><a:t>${text}</a:t></a:r>`;

const symbolRun = (text: string, typeface: string): string => run(text, `<a:latin typeface="Arial"/><a:sym typeface="${typeface}"/>`);

async function convert(paragraphs: string[], target: string, extraShapes = ''): Promise<{ text: string; warnings: unknown }> {
  const result = await convertFile(await buildPptx(paragraphs, extraShapes), 'pptx', target, {}, 'deck.pptx');
  return { text: result.buffer.toString('utf-8'), warnings: result.metadata?.warnings };
}

describe('PowerPoint symbol-font runs', () => {
  it('maps a private-use character to what the symbol typeface of its run draws, whatever form the character has in the XML', async () => {
    // Symbol 0x61 is alpha, Wingdings 0xFC a check mark and 0xA7 a small black square; the character is a hex reference, a decimal reference or the character itself.
    const { text, warnings } = await convert(
      [symbolRun('&#xF061;', 'Symbol') + run(' ok ') + symbolRun('&#61692;', 'Wingdings') + run(' ') + symbolRun('', 'Wingdings')],
      'txt'
    );
    expect(text).toBe('--- Slide 1 ---\nα\nok\n✓\n▪');
    expect(warnings).toBeUndefined();
  });

  it('uses the typeface of a run that names no symbol typeface, then its complex-script typeface', async () => {
    const { text } = await convert([run('&#xF0FC;', '<a:latin typeface="Wingdings"/>') + run('&#xF0FC;', '<a:cs typeface="Wingdings"/>')], 'txt');
    expect(text).toBe('--- Slide 1 ---\n✓\n✓');
  });

  it('lets the symbol typeface decide over the Latin one', async () => {
    const { text } = await convert([run('&#xF061;', '<a:latin typeface="Wingdings"/><a:sym typeface="Symbol"/>')], 'txt');
    expect(text).toBe('--- Slide 1 ---\nα');
  });

  it('leaves a private-use character in another range and the text of a run with no symbol character alone', async () => {
    const { text, warnings } = await convert([symbolRun('Plain é text', 'Wingdings') + run('&#xF061;&#x2022;', '<a:latin typeface="Symbol"/>')], 'txt');
    expect(text).toBe('--- Slide 1 ---\nPlain é text\nα•');
    expect(warnings).toBeUndefined();
  });

  it('writes a mapped character that XML reserves as text, in HTML and in text', async () => {
    // Symbol 0x26 is the ampersand and 0x3C the less-than sign.
    const paragraphs = [symbolRun('&#xF026;&#xF03C;', 'Symbol')];
    expect((await convert(paragraphs, 'txt')).text).toBe('--- Slide 1 ---\n&<');
    expect((await convert(paragraphs, 'html')).text).toContain('&amp;&lt;');
  });

  it('replaces a character with no counterpart by U+FFFD and reports it once per font and code', async () => {
    const { text, warnings } = await convert(
      [symbolRun('&#xF073;&#xF073;', 'Mathematica1') + symbolRun('&#xF0FF;', 'Wingdings') + run('&#xF0FC;', '<a:latin typeface="Arial"/>') + run('&#xF0FC;')],
      'txt'
    );
    expect(text).toBe('--- Slide 1 ---\n��\n�\n�\n�');
    expect(warnings).toEqual([
      'Replaced U+F073 of the font "Mathematica1" with U+FFFD: no Unicode counterpart is known.',
      'Replaced U+F0FF of the font "Wingdings" with U+FFFD: no Unicode counterpart is known.',
      'Replaced U+F0FC of the font "Arial" with U+FFFD: no Unicode counterpart is known.',
      'Replaced U+F0FC with U+FFFD: no Unicode counterpart is known.',
    ]);
  });

  it('maps the symbol characters of a table cell and of a grouped shape, which the page drawing reads from the same XML', async () => {
    const cell = `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p>${symbolRun('&#xF0FC;', 'Wingdings')}</a:p></a:txBody><a:tcPr/></a:tc>`;
    const table = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="3" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="457200" y="2000000"/><a:ext cx="4000000" cy="400000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblGrid><a:gridCol w="4000000"/></a:tblGrid><a:tr h="400000">${cell}</a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
    const group = `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="4" name="Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="5" name="In group"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="3000000"/><a:ext cx="2000000" cy="400000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p>${symbolRun('&#xF061;', 'Symbol')}</a:p></p:txBody></p:sp></p:grpSp>`;
    for (const target of ['txt', 'html']) {
      const { text, warnings } = await convert([run('Head')], target, table + group);
      expect(text, target).toContain('✓');
      expect(text, target).toContain('α');
      expect(text, target).not.toMatch(/[-]/);
      expect(warnings, target).toBeUndefined();
    }
  });

  oracleTest('writes the mapped characters into a PDF and shows U+FFFD, with a report, for one no font maps', ['pdftotext'], async () => {
    const pdfText = (pdf: Buffer): string => (extractTextWithExternalPdftotext(pdf) ?? '').replace(/\s+/g, ' ').trim();
    const mapped = await convertFile(await buildPptx([run('Gain ') + symbolRun('&#xF061;', 'Symbol')]), 'pptx', 'pdf', {}, 'deck.pptx');
    expect(pdfText(mapped.buffer)).toBe('Gain α');
    expect(mapped.metadata?.warnings).toBeUndefined();
    const unknown = await convertFile(await buildPptx([run('Sum ') + symbolRun('&#xF073;', 'Mathematica1')]), 'pptx', 'pdf', {}, 'deck.pptx');
    expect(pdfText(unknown.buffer)).toBe('Sum �');
    expect(unknown.metadata?.warnings).toEqual(['Replaced U+F073 of the font "Mathematica1" with U+FFFD: no Unicode counterpart is known.']);
  });
});
