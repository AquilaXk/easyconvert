import JSZip from 'jszip';
import sharp from 'sharp';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { dispatchConversion } from '../src/lib/conversions/dispatch';
import { readDocxModel } from '../src/lib/conversions/docx-model';
import { documentToText } from '../src/lib/conversions/document-model/text';
import { officeReadingFormat } from '../src/lib/conversions/office/office-suite-sources';
import { generatePptxFromText } from '../src/lib/conversions/office/office-from-text';
import { readOdtText } from '../src/lib/conversions/office/odt-text';
import { openPackage } from '../src/lib/conversions/package-access';
import { extractRowsForOffice } from '../src/lib/conversions/office/sheet-extract';
import { detectFormatFromFilename, detectUploadedSourceFormat } from '../src/lib/registry';
import { InputPixelLimitError } from '../src/lib/conversions/image-input-limits';
import { ConversionFailedError, EngineUnavailableError, SheetLimitError } from '../src/lib/types';

function encodeUintvar(value: number): number[] {
  if (value === 0) return [0];
  const bytes: number[] = [];
  let remaining = value;
  while (remaining > 0) {
    bytes.unshift(remaining & 0x7f);
    remaining >>>= 7;
  }
  for (let i = 0; i < bytes.length - 1; i++) {
    bytes[i] |= 0x80;
  }
  return bytes;
}

function buildWbmp(width: number, height: number, pixels: number[]): Buffer {
  const header = [0x00, 0x00, ...encodeUintvar(width), ...encodeUintvar(height)];
  return Buffer.from([...header, ...pixels]);
}

function buildDbfSample(): Buffer {
  // Header (32 bytes) + 2 field descriptors (64 bytes) + terminator (1 byte) = 97 bytes
  const headerSize = 97;
  const recordSize = 1 + 10 + 5; // deletion flag + NAME(10) + QTY(5)
  const recordCount = 2;
  const buf = Buffer.alloc(headerSize + recordCount * recordSize + 1, 0x20);
  buf[0] = 0x03; // dBASE III without memo
  buf[1] = 26;
  buf[2] = 11;
  buf[3] = 26;
  buf.writeUInt32LE(recordCount, 4);
  buf.writeUInt16LE(headerSize, 8);
  buf.writeUInt16LE(recordSize, 10);

  // Field 1: NAME, C, len 10
  buf.write('NAME', 32, 'ascii');
  buf[32 + 11] = 'C'.charCodeAt(0);
  buf[32 + 16] = 10;

  // Field 2: QTY, N, len 5
  buf.write('QTY', 64, 'ascii');
  buf[64 + 11] = 'N'.charCodeAt(0);
  buf[64 + 16] = 5;

  buf[96] = 0x0d; // Header terminator

  let offset = headerSize;
  const writeRec = (name: string, qty: string) => {
    buf[offset] = 0x20;
    buf.write(name.padEnd(10, ' ').slice(0, 10), offset + 1, 'ascii');
    buf.write(qty.padStart(5, ' ').slice(0, 5), offset + 11, 'ascii');
    offset += recordSize;
  };
  writeRec('Widget', '42');
  writeRec('Gadget', '7');
  buf[offset] = 0x1a; // EOF
  return buf;
}

function buildWk1Sample(): Buffer {
  const parts: Buffer[] = [];
  const rec = (opcode: number, payload: Buffer) => {
    const h = Buffer.alloc(4);
    h.writeUInt16LE(opcode, 0);
    h.writeUInt16LE(payload.length, 2);
    parts.push(h, payload);
  };
  const bof = Buffer.alloc(2);
  bof.writeUInt16LE(0x0406, 0); // 1-2-3 rev
  rec(0x0000, bof);

  const label = (col: number, row: number, text: string) => {
    const b = Buffer.alloc(5 + text.length + 1);
    b[0] = 0xff;
    b.writeUInt16LE(col, 1);
    b.writeUInt16LE(row, 3);
    b[5] = "'".charCodeAt(0);
    b.write(text, 6, 'ascii');
    b[6 + text.length] = 0x00;
    rec(0x000f, b);
  };
  const num = (col: number, row: number, val: number) => {
    const b = Buffer.alloc(13);
    b[0] = 0xff;
    b.writeUInt16LE(col, 1);
    b.writeUInt16LE(row, 3);
    b.writeDoubleLE(val, 5);
    rec(0x000e, b);
  };

  label(0, 0, 'Item');
  label(1, 0, 'Price');
  label(0, 1, 'Coffee');
  num(1, 1, 4.5);
  rec(0x0001, Buffer.alloc(0)); // EOF
  return Buffer.concat(parts);
}

describe('Launch audit: newly supported and repaired conversions', () => {
  it('decodes valid WBMP images (including multi-byte uintvar) and refuses oversized/malformed WBMP', async () => {
    // 8x2: row 0 = 10101010 (0xAA), row 1 = 01010101 (0x55)
    const wbmp = buildWbmp(8, 2, [0xaa, 0x55]);
    const pngRes = await dispatchConversion(wbmp, 'wbmp', 'png', {}, 'icon.wbmp');
    const meta = await sharp(pngRes.buffer).metadata();
    expect(meta.format).toBe('png');
    expect(meta.width).toBe(8);
    expect(meta.height).toBe(2);

    const wideWbmp = buildWbmp(130, 1, new Array(Math.ceil(130 / 8)).fill(0xff));
    const jpgRes = await dispatchConversion(wideWbmp, 'wbmp', 'jpg', {}, 'wide.wbmp');
    const jpgMeta = await sharp(jpgRes.buffer).metadata();
    expect(jpgMeta.format).toBe('jpeg');
    expect(jpgMeta.width).toBe(130);
    expect(jpgMeta.height).toBe(1);

    // Unsupported WBMP type 1
    await expect(dispatchConversion(Buffer.from([0x01, 0x00, 0x08, 0x02, 0xaa, 0x55]), 'wbmp', 'png', {}, 'badtype.wbmp')).rejects.toThrow(
      ConversionFailedError
    );

    // Oversized dimensions exceeding maxInputPixels without allocating gigabytes
    const bomb = buildWbmp(100_000, 100_000, [0x00]);
    await expect(dispatchConversion(bomb, 'wbmp', 'png', {}, 'bomb.wbmp')).rejects.toThrow(InputPixelLimitError);
  });

  it('routes PDFA identically to PDF across txt, html, docx, and pdf targets', async () => {
    const pdfBytes = fs.readFileSync(path.join(__dirname, 'fixtures', 'pdf-text', 'latin.pdf'));
    const txtRes = await dispatchConversion(pdfBytes, 'pdfa', 'txt', {}, 'archive.pdf');
    expect(txtRes.buffer.toString('utf-8')).not.toContain('%PDF-');
    expect(txtRes.buffer.toString('utf-8').length).toBeGreaterThan(20);

    const docxRes = await dispatchConversion(pdfBytes, 'pdfa', 'docx', {}, 'archive.pdf');
    const model = await readDocxModel(await openPackage(docxRes.buffer, 'DOCX'));
    const docText = documentToText(model.model);
    expect(docText).not.toContain('%PDF-');
    expect(docText.length).toBeGreaterThan(20);

    const outPdf = await dispatchConversion(pdfBytes, 'pdfa', 'pdf', {}, 'archive.pdf');
    expect(outPdf.buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('parses XHTML as structured HTML across txt, md, docx, and pdf without leaking XML/HTML tags', async () => {
    const xhtml = Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>XHTML Spec</title></head>
  <body>
    <h1>Release Checklist</h1>
    <p>Verify <strong>every</strong> endpoint carefully.</p>
    <ul><li>API health check</li><li>Worker pool ready</li></ul>
  </body>
</html>`,
      'utf-8'
    );

    const txt = (await dispatchConversion(xhtml, 'xhtml', 'txt', {}, 'spec.xhtml')).buffer.toString('utf-8');
    expect(txt).toContain('Release Checklist');
    expect(txt).toContain('Verify every endpoint carefully.');
    expect(txt).not.toContain('<?xml');
    expect(txt).not.toContain('<strong>');

    const md = (await dispatchConversion(xhtml, 'xhtml', 'md', {}, 'spec.xhtml')).buffer.toString('utf-8');
    expect(md).toContain('# Release Checklist');
    expect(md).toContain('**every**');

    const docx = await dispatchConversion(xhtml, 'xhtml', 'docx', {}, 'spec.xhtml');
    const docxModel = await readDocxModel(await openPackage(docx.buffer, 'DOCX'));
    const docxText = documentToText(docxModel.model);
    expect(docxText).toContain('Release Checklist');
    expect(docxText).not.toContain('<?xml');
    expect(docxText).not.toContain('<html');

    const pdf = await dispatchConversion(xhtml, 'xhtml', 'pdf', {}, 'spec.xhtml');
    expect(pdf.buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('decodes RFC 5322 / MIME EML messages cleanly (headers, QP, base64, multipart) and bounds pathological nesting', async () => {
    const encodedSubject = Buffer.from('월간 정산 보고서 Report', 'utf-8').toString('base64');
    const htmlBodyB64 = Buffer.from('<html><body><h2>Monthly Summary</h2><p>Total: <b>$1,250</b></p><script>alert(1)</script></body></html>', 'utf-8').toString('base64');
    const eml = Buffer.from(
      [
        `From: Sender Name <sender@example.com>`,
        `To: receiver@example.com`,
        `Date: Thu, 26 Nov 2026 10:00:00 +0900`,
        `Subject: =?UTF-8?B?${encodedSubject}?=`,
        `MIME-Version: 1.0`,
        `Content-Type: multipart/mixed; boundary="outer-bound"`,
        ``,
        `--outer-bound`,
        `Content-Type: multipart/alternative; boundary="alt-bound"`,
        ``,
        `--alt-bound`,
        `Content-Type: text/plain; charset=UTF-8`,
        `Content-Transfer-Encoding: quoted-printable`,
        ``,
        `Hello=20World!=0D=0A=ED=95=9C=EA=B8=80 =EB=B3=B8=EB=AC=B8=EC=9E=85=EB=8B=88=\r\n=EB=8B=A4.`,
        `--alt-bound`,
        `Content-Type: text/html; charset=UTF-8`,
        `Content-Transfer-Encoding: base64`,
        ``,
        htmlBodyB64,
        `--alt-bound--`,
        `--outer-bound`,
        `Content-Type: application/pdf; name="invoice.pdf"`,
        `Content-Disposition: attachment; filename="invoice.pdf"`,
        `Content-Transfer-Encoding: base64`,
        ``,
        `JVBERi0xLjQK`,
        `--outer-bound--`,
      ].join('\r\n'),
      'utf-8'
    );

    const txt = (await dispatchConversion(eml, 'eml', 'txt', {}, 'mail.eml')).buffer.toString('utf-8');
    expect(txt).toContain('월간 정산 보고서 Report');
    expect(txt).toContain('sender@example.com');
    expect(txt).toContain('Hello World!');
    expect(txt).toContain('한글 본문입니다.');
    expect(txt).toContain('invoice.pdf');
    expect(txt).not.toContain('Content-Transfer-Encoding');
    expect(txt).not.toContain('--outer-bound');
    expect(txt).not.toContain('JVBERi0xLjQK');

    const html = (await dispatchConversion(eml, 'eml', 'html', {}, 'mail.eml')).buffer.toString('utf-8');
    expect(html).toContain('Monthly Summary');
    expect(html).toContain('$1,250');
    expect(html).not.toContain('<script>');

    const pdf = await dispatchConversion(eml, 'eml', 'pdf', {}, 'mail.eml');
    expect(pdf.buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');

    const docx = await dispatchConversion(eml, 'eml', 'docx', {}, 'mail.eml');
    const docxText = documentToText((await readDocxModel(await openPackage(docx.buffer, 'DOCX'))).model);
    expect(docxText).toContain('한글 본문입니다.');

    // Adversarial deep MIME nesting > 16 levels must fail cleanly
    const depth = 25;
    const nestedParts: string[] = [];
    for (let i = 0; i < depth; i++) {
      nestedParts.push(`Content-Type: multipart/mixed; boundary="b${i}"\r\n\r\n--b${i}`);
    }
    nestedParts.push(`Content-Type: text/plain\r\n\r\ndeep\r\n`);
    for (let i = depth - 1; i >= 0; i--) {
      nestedParts.push(`--b${i}--`);
    }
    await expect(
      dispatchConversion(Buffer.from(nestedParts.join('\r\n'), 'utf-8'), 'eml', 'txt', {}, 'deep.eml')
    ).rejects.toThrow(ConversionFailedError);
  });

  it('converts Flat ODF (FODT, FODS, FODP) in-process and rejects malformed Flat XML', async () => {
    const fodt = Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
  office:mimetype="application/vnd.oasis.opendocument.text" office:version="1.2">
  <office:body><office:text>
    <text:h text:outline-level="1">Flat ODT Title</text:h>
    <text:p>Flat paragraph body.</text:p>
  </office:text></office:body>
</office:document>`,
      'utf-8'
    );
    const odt = await dispatchConversion(fodt, 'fodt', 'odt', { engine: 'easyconvert' }, 'doc.fodt');
    expect(await readOdtText(odt.buffer)).toContain('Flat paragraph body.');
    const fodtDocx = await dispatchConversion(fodt, 'fodt', 'docx', { engine: 'easyconvert' }, 'doc.fodt');
    expect(documentToText((await readDocxModel(await openPackage(fodtDocx.buffer, 'DOCX'))).model)).toContain('Flat ODT Title');
    const fodtPdf = await dispatchConversion(fodt, 'fodt', 'pdf', { engine: 'easyconvert' }, 'doc.fodt');
    expect(fodtPdf.buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');

    const fods = Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
  office:mimetype="application/vnd.oasis.opendocument.spreadsheet" office:version="1.2">
  <office:body><office:spreadsheet><table:table table:name="Sales">
    <table:table-row><table:table-cell><text:p>Region</text:p></table:table-cell><table:table-cell table:number-columns-repeated="2"><text:p>East</text:p></table:table-cell></table:table-row>
    <table:table-row><table:table-cell><text:p>Units</text:p></table:table-cell><table:table-cell><text:p>120</text:p></table:table-cell></table:table-row>
  </table:table></office:spreadsheet></office:body>
</office:document>`,
      'utf-8'
    );
    const csv = (await dispatchConversion(fods, 'fods', 'csv', { engine: 'easyconvert' }, 'sheet.fods')).buffer.toString('utf-8');
    expect(csv).toContain('Region,East,East');
    expect(csv).toContain('Units,120');
    const xlsx = await dispatchConversion(fods, 'fods', 'xlsx', { engine: 'easyconvert' }, 'sheet.fods');
    const rows = await extractRowsForOffice(xlsx.buffer, 'xlsx', {});
    expect(rows[1]).toEqual(['Units', '120']);

    const fodp = Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
  office:mimetype="application/vnd.oasis.opendocument.presentation" office:version="1.2">
  <office:body><office:presentation>
    <draw:page draw:name="Slide1"><draw:frame><draw:text-box><text:p>Quarterly Deck</text:p><text:p>Growth +30%</text:p></draw:text-box></draw:frame></draw:page>
  </office:presentation></office:body>
</office:document>`,
      'utf-8'
    );
    const pptx = await dispatchConversion(fodp, 'fodp', 'pptx', { engine: 'easyconvert' }, 'deck.fodp');
    const pptZip = await JSZip.loadAsync(pptx.buffer);
    const slide1 = await pptZip.file('ppt/slides/slide1.xml')?.async('string');
    expect(slide1).toContain('Quarterly Deck');

    await expect(dispatchConversion(Buffer.from('<not-odf/>', 'utf-8'), 'fodt', 'odt', { engine: 'easyconvert' }, 'bad.fodt')).rejects.toThrow(ConversionFailedError);
  }, 30_000);

  it('decodes DBF, DIF, SYLK, PRN, and WK1 spreadsheets and blocks huge sparse SYLK bombs', async () => {
    const dbfCsv = (await dispatchConversion(buildDbfSample(), 'dbf', 'csv', { engine: 'easyconvert' }, 'items.dbf')).buffer.toString('utf-8');
    expect(dbfCsv).toContain('NAME,QTY');
    expect(dbfCsv).toContain('Widget,42');
    expect(dbfCsv).toContain('Gadget,7');

    const dif = Buffer.from(
      `TABLE\n0,1\n"EXCEL"\nVECTORS\n0,2\n""\nTUPLES\n0,2\n""\nDATA\n0,0\n""\n-1,0\nBOT\n1,0\n"Name"\n1,0\n"Score"\n-1,0\nBOT\n0,100\nV\n0,95.5\nV\n-1,0\nEOD\n`,
      'utf-8'
    );
    const difXlsx = await dispatchConversion(dif, 'dif', 'xlsx', { engine: 'easyconvert' }, 'grades.dif');
    const difRows = await extractRowsForOffice(difXlsx.buffer, 'xlsx', {});
    expect(difRows[0]).toEqual(['Name', 'Score']);
    expect(difRows[1]).toEqual(['100', '95.5']);

    const slk = Buffer.from(`ID;P\nC;Y1;X1;K"City"\nC;Y1;X2;K"Pop"\nC;Y2;X1;K"Seoul"\nC;Y2;X2;K9500000\nE\n`, 'utf-8');
    const slkCsv = (await dispatchConversion(slk, 'slk', 'csv', { engine: 'easyconvert' }, 'cities.slk')).buffer.toString('utf-8');
    expect(slkCsv).toContain('City,Pop');
    expect(slkCsv).toContain('Seoul,9500000');

    const slkBomb = Buffer.from(`ID;P\nC;Y9999999;X9999999;K1\nE\n`, 'utf-8');
    await expect(dispatchConversion(slkBomb, 'slk', 'csv', { engine: 'easyconvert' }, 'bomb.slk')).rejects.toThrow(SheetLimitError);

    const prn = Buffer.from(`Product    Count\nApples        12\nOranges       34\n`, 'utf-8');
    const prnCsv = (await dispatchConversion(prn, 'prn', 'csv', { engine: 'easyconvert' }, 'report.prn')).buffer.toString('utf-8');
    expect(prnCsv).toContain('Product,Count');
    expect(prnCsv).toContain('Apples,12');

    const wk1Csv = (await dispatchConversion(buildWk1Sample(), 'wk1', 'csv', { engine: 'easyconvert' }, 'budget.wk1')).buffer.toString('utf-8');
    expect(wk1Csv).toContain('Item,Price');
    expect(wk1Csv).toContain('Coffee,4.5');

    // Binary CFBF .wks without soffice must refuse with EngineUnavailableError instead of corrupting text
    const cfbf = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00]);
    await expect(dispatchConversion(cfbf, 'wks', 'csv', { engine: 'easyconvert' }, 'works.wks')).rejects.toThrow(EngineUnavailableError);
  }, 30_000);

  it('normalizes presentation/keynotes aliases and cleanly extracts man, rst, tex, and latex markup', async () => {
    expect(officeReadingFormat('presentation')).toBe('pptx');
    expect(officeReadingFormat('keynotes')).toBe('key');

    const samplePptx = await generatePptxFromText('# Title Slide\n- Bullet one', 'md', {}, 'deck');
    const presPdf = await dispatchConversion(samplePptx, 'presentation', 'pdf', {}, 'deck.presentation');
    expect(presPdf.buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');

    const man = Buffer.from(`.TH EASYCONVERT 1 "2026-11-26"\n.SH NAME\neasyconvert \\- fast document converter\n.SH DESCRIPTION\nConverts \\fBmany\\fR formats cleanly.\n`, 'utf-8');
    const manTxt = (await dispatchConversion(man, 'man', 'txt', {}, 'easyconvert.1')).buffer.toString('utf-8');
    expect(manTxt).toContain('NAME');
    expect(manTxt).toContain('easyconvert - fast document converter');
    expect(manTxt).toContain('Converts many formats cleanly.');
    expect(manTxt).not.toContain('.TH');
    expect(manTxt).not.toContain('\\fB');

    const rst = Buffer.from(`System Guide\n============\n\nOverview\n--------\n\nSupports **fast** pipelines:\n\n- Document conversion\n- Archive extraction\n`, 'utf-8');
    const rstHtml = (await dispatchConversion(rst, 'rst', 'html', {}, 'guide.rst')).buffer.toString('utf-8');
    expect(rstHtml).toContain('<h1');
    expect(rstHtml).toContain('System Guide');
    expect(rstHtml).not.toContain('============');

    const tex = Buffer.from(
      `\\documentclass[11pt]{article}\n\\usepackage[utf8]{inputenc}\n\\title{Annual Report}\n\\begin{document}\n\\maketitle\n\\section{Summary}\nRevenue grew by \\textbf{15\\%} in \\emph{2026}.\n\\begin{itemize}\n\\item First item\n\\item Second item\n\\end{itemize}\n\\end{document}\n`,
      'utf-8'
    );
    const texTxt = (await dispatchConversion(tex, 'latex', 'txt', {}, 'report.tex')).buffer.toString('utf-8');
    expect(texTxt).toContain('Annual Report');
    expect(texTxt).toContain('Summary');
    expect(texTxt).toContain('Revenue grew by 15% in 2026.');
    expect(texTxt).toContain('First item');
    expect(texTxt).not.toContain('article');
    expect(texTxt).not.toContain('inputenc');
    expect(texTxt).not.toContain('\\textbf');

    const texMd = (await dispatchConversion(tex, 'tex', 'md', {}, 'report.tex')).buffer.toString('utf-8');
    expect(texMd).toContain('# Annual Report');
    expect(texMd).toContain('## Summary');

    expect(detectFormatFromFilename('backup.tar.bz2')).toBeUndefined();
    expect(['bz2', 'tar.bz2']).toContain(detectUploadedSourceFormat('backup.tar.bz2')?.id);
    expect(detectUploadedSourceFormat('backup.tar.bz2', 'bz2')?.id).toBe('bz2');
  });
});
