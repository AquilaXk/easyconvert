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
import {
  assertNotSpoofedFile,
  detectFormatFromFilename,
  detectUploadedSourceFormat,
  FileExtensionSpoofError,
} from '../src/lib/registry';
import { buildQueuedFileItem } from '../src/hooks/useClientQueue';
import { planTextPdfRoute, TEXT_PDF_SOURCES } from '../src/worker/text-pdf-route';
import { manToMarkdown, rstToMarkdown } from '../src/lib/conversions/office/markup-text';
import { expectNoHang } from './helpers/timing';
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

function buildTestCfbf(opts?: { malformed?: boolean; streamName?: string }): Buffer {
  // Header (512 bytes) + sector 0 FAT (512) + sector 1 Directory (512) = 1536 bytes
  const total = Buffer.alloc(1536, 0);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(total, 0);
  total.writeUInt16LE(0x003e, 24);
  total.writeUInt16LE(0x0003, 26);
  total.writeUInt16LE(0xfffe, 28);
  total.writeUInt16LE(9, 30); // sectorBytes = 512
  total.writeUInt16LE(6, 32);
  total.writeUInt32LE(1, 44); // 1 FAT sector
  total.writeUInt32LE(1, 48); // first directory sector = 1
  total.writeUInt32LE(0x00001000, 56);
  total.writeUInt32LE(0xfffffffe, 60); // no miniFAT
  total.writeUInt32LE(0xfffffffe, 68); // no DIFAT
  total.writeUInt32LE(0, 76); // DIFAT[0] = sector 0
  for (let i = 1; i < 109; i += 1) total.writeUInt32LE(0xffffffff, 76 + i * 4);
  // FAT sector at offset 512
  total.writeUInt32LE(0xfffffffd, 512); // sector 0 = FAT
  total.writeUInt32LE(0xfffffffe, 516); // sector 1 = ENDOFCHAIN
  for (let i = 2; i < 128; i += 1) total.writeUInt32LE(0xffffffff, 512 + i * 4);
  // Directory sector at offset 1024
  const dirOff = 1024;
  const rootName = Buffer.from('Root Entry\0', 'utf16le');
  rootName.copy(total, dirOff);
  total.writeUInt16LE(rootName.length, dirOff + 64);
  total[dirOff + 66] = opts?.malformed ? 0 : 5; // ROOT_STORAGE or UNALLOCATED
  total.writeUInt32LE(0xffffffff, dirOff + 68);
  total.writeUInt32LE(0xffffffff, dirOff + 72);
  total.writeUInt32LE(opts?.streamName ? 1 : 0xffffffff, dirOff + 76);
  if (opts?.streamName) {
    const sOff = dirOff + 128;
    const sName = Buffer.from(`${opts.streamName}\0`, 'utf16le');
    sName.copy(total, sOff);
    total.writeUInt16LE(sName.length, sOff + 64);
    total[sOff + 66] = 2; // STREAM_OBJECT
    total.writeUInt32LE(0xffffffff, sOff + 68);
    total.writeUInt32LE(0xffffffff, sOff + 72);
    total.writeUInt32LE(0xffffffff, sOff + 76);
  }
  return total;
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
    expect(txt).not.toContain('XHTML Spec');
    expect(txt).not.toContain('<?xml');
    expect(txt).not.toContain('<strong>');

    const md = (await dispatchConversion(xhtml, 'xhtml', 'md', {}, 'spec.xhtml')).buffer.toString('utf-8');
    expect(md).toContain('# Release Checklist');
    expect(md).toContain('**every**');
    expect(md).not.toContain('XHTML Spec');

    const docx = await dispatchConversion(xhtml, 'xhtml', 'docx', {}, 'spec.xhtml');
    const docxModel = await readDocxModel(await openPackage(docx.buffer, 'DOCX'));
    const docxText = documentToText(docxModel.model);
    expect(docxText).toContain('Release Checklist');
    expect(docxText).not.toContain('<?xml');
    expect(docxText).not.toContain('<html');

    const pdf = await dispatchConversion(xhtml, 'xhtml', 'pdf', {}, 'spec.xhtml');
    expect(pdf.buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  }, 30_000);

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

    // Binary CFBF .wks without soffice must pass spoof check and refuse with EngineUnavailableError instead of corrupting text
    const cfbf = buildTestCfbf({ streamName: 'MatOST' });
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
    expect(detectUploadedSourceFormat('backup.tar.bz2')?.id).toBe('tar.bz2');
    expect(detectUploadedSourceFormat('backup.tar.bz2', 'bz2')?.id).toBe('bz2');
    expect(detectUploadedSourceFormat('bundle.tar.zst')?.id).toBe('tar.zst');
    expect(detectUploadedSourceFormat('bundle.tar.gz')?.id).toBe('tar.gz');
    expect(detectUploadedSourceFormat('bundle.tar.xz')?.id).toBe('tar.xz');
    expect(detectUploadedSourceFormat('bundle.tar.7z')?.id).toBe('tar.7z');

    if (typeof File === 'function') {
      const queuedZst = buildQueuedFileItem(new File([Buffer.from('payload')], 'bundle.tar.zst'));
      expect(queuedZst.sourceFormat).toBe('tar.zst');
      const queuedBz2 = buildQueuedFileItem(new File([Buffer.from('payload')], 'backup.tar.bz2'));
      expect(queuedBz2.sourceFormat).toBe('tar.bz2');
    }
  }, 30_000);

  it('passes spoof checks for valid Lotus/CFBF wks, plans xhtml PDF routing via LibreOffice, and handles edge cases in markup/FODT/EML/FoxPro DBF', async () => {
    // 1. WKS spoof gate: Lotus BOF accepted, minimal unclaimed CFBF accepted, spoofed PNG / Excel CFBF / malformed CFBF rejected
    expect(() => assertNotSpoofedFile(buildWk1Sample(), 'wks', 'budget.wks')).not.toThrow();
    expect(() => assertNotSpoofedFile(buildTestCfbf({ streamName: 'MatOST' }), 'wks', 'works.wks')).not.toThrow();
    expect(() => assertNotSpoofedFile(buildTestCfbf({ streamName: 'Workbook' }), 'wks', 'xls-as-wks.wks')).toThrow(
      FileExtensionSpoofError
    );
    expect(() => assertNotSpoofedFile(buildTestCfbf({ malformed: true }), 'wks', 'bad.wks')).toThrow(
      FileExtensionSpoofError
    );
    const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
    expect(() => assertNotSpoofedFile(pngMagic, 'wks', 'fake.wks')).toThrow(FileExtensionSpoofError);

    // 2. XHTML routes through TEXT_PDF_SOURCES / LibreOffice with staged HTML when targeting PDF
    expect(TEXT_PDF_SOURCES.has('xhtml')).toBe(true);
    const xhtmlPlan = await planTextPdfRoute(
      Buffer.from('<html><body><p>Hello</p></body></html>'),
      'xhtml',
      'pdf',
      'page.xhtml'
    );
    expect(xhtmlPlan).not.toBeNull();
    expect(xhtmlPlan?.preferNative).toBe(true);
    expect(xhtmlPlan?.stagedHtml?.toString('utf-8')).toContain('Hello');

    // 3. Hardened markup parsers: no macro/tabular/directive/register leaks & preserved escapes
    const complexTex = Buffer.from(
      [
        '\\documentclass{article}',
        '\\newcommand{\\myvar}[1]{LEAKED_MACRO}',
        '\\setlength{\\parindent}{0pt}',
        '\\begin{document}',
        '\\textcolor{red}{Alert} path \\textbackslash{} tilde \\textasciitilde{}.',
        '\\includegraphics[width=0.5\\textwidth]{photo.png}',
        '\\cite{knuth1984}',
        '\\begin{tabular}{|l|r|}',
        'Alpha & 1 \\\\',
        '\\end{tabular}',
        '\\end{document}',
      ].join('\n'),
      'utf-8'
    );
    const complexTexMd = (await dispatchConversion(complexTex, 'tex', 'md', {}, 'doc.tex')).buffer.toString('utf-8');
    expect(complexTexMd).toContain('Alert path \\ tilde ~.');
    expect(complexTexMd).toContain('Alpha');
    expect(complexTexMd).not.toContain('LEAKED_MACRO');
    expect(complexTexMd).not.toContain('0pt');
    expect(complexTexMd).not.toContain('|l|r|');
    expect(complexTexMd).not.toContain('photo.png');
    expect(complexTexMd).not.toContain('knuth1984');
    expect(complexTexMd).not.toContain('redAlert');

    const complexRst = Buffer.from(
      [
        '.. image:: diagram.png',
        '   :alt: Arch diagram',
        '   :width: 400px',
        '',
        '.. code:: python',
        '   :linenos:',
        '',
        '   print("hi")',
        '',
        'Visible paragraph.',
      ].join('\n'),
      'utf-8'
    );
    const complexRstMd = (await dispatchConversion(complexRst, 'rst', 'md', {}, 'guide.rst')).buffer.toString('utf-8');
    expect(complexRstMd).toContain('```python');
    expect(complexRstMd).toContain('print("hi")');
    expect(complexRstMd).toContain('Visible paragraph.');
    expect(complexRstMd).not.toContain('Arch diagram');
    expect(complexRstMd).not.toContain('400px');
    expect(complexRstMd).not.toContain(':linenos:');

    const complexManRaw = [
      '.TH DEMO 1',
      '.de MYMACRO',
      'macro body leak',
      '..',
      '.nr count 42',
      '.ds name Test',
      '.sp 2',
      '.RS 4',
      '.EX',
      'echo ok',
      '.EE',
      '.RE',
    ].join('\n');
    const complexManMd = manToMarkdown(complexManRaw);
    expect(complexManMd).toContain('echo ok');
    expect(complexManMd).not.toContain('MYMACRO');
    expect(complexManMd).not.toContain('macro body leak');
    expect(complexManMd).not.toContain('count 42');
    expect(complexManMd).not.toContain('name Test');
    expect(complexManMd).not.toMatch(/^\s*(?:2|4)\s*$/m);

    const complexManTxt = (
      await dispatchConversion(Buffer.from(complexManRaw, 'utf-8'), 'man', 'txt', {}, 'demo.1')
    ).buffer.toString('utf-8');
    expect(complexManTxt).toContain('echo ok');
    expect(complexManTxt).not.toContain('macro body leak');
    expect(complexManTxt).not.toContain('count 42');

    // 4. Flat ODF with trailing XML comment after </office:document>
    const fodtWithComment = Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
  office:version="1.2"
  office:mimetype="application/vnd.oasis.opendocument.text">
  <office:body><office:text><text:p>Trailing comment OK</text:p></office:text></office:body>
</office:document>
<!-- trailing generator comment -->`,
      'utf-8'
    );
    const fodtOdt = await dispatchConversion(fodtWithComment, 'fodt', 'odt', { engine: 'easyconvert' }, 'c.fodt');
    expect(await readOdtText(fodtOdt.buffer)).toContain('Trailing comment OK');
    const fodtDocx = await dispatchConversion(fodtWithComment, 'fodt', 'docx', { engine: 'easyconvert' }, 'c.fodt');
    expect(documentToText((await readDocxModel(await openPackage(fodtDocx.buffer, 'DOCX'))).model)).toContain(
      'Trailing comment OK'
    );

    // 5. EML raw Latin-1 header + RFC 5987 filename* + XSS hardening
    const rawEml = Buffer.concat([
      Buffer.from('From: alice@example.com\r\nSubject: Caf', 'ascii'),
      Buffer.from([0xe9]),
      Buffer.from(
        '\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="b1"\r\n\r\n' +
          '--b1\r\nContent-Type: text/html; charset=utf-8\r\n\r\n' +
          '<body><p>Hello https://example.com/onclick=ok</p><a href="https://example.com/onclick=ok">Safe</a><script>alert(1)</script ><svg onload=alert(2)><img/onerror=alert(4) src=x><img title=">" onerror=alert(5) src=y><img src="x"/onerror=alert(9)><a href=javascript:alert(3) formaction=javascript:x>Link</a><a/href="javascript&colon;alert(6)">C</a><a href="java&tab;script:alert(7)">T</a><a href="&#x09;java&NewLine;script&colon;alert(8)">N</a><iframe srcdoc="<script>4</script>"></iframe></body>\r\n' +
          '--b1\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename*=UTF-8\'\'%EC%9D%B4%EB%A0%A5%EC%84%9C.pdf\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0=\r\n' +
          '--b1--\r\n',
        'ascii'
      ),
    ]);
    const sanitizedEmlHtml = (await dispatchConversion(rawEml, 'eml', 'html', {}, 'mail.eml')).buffer.toString('utf-8');
    expect(sanitizedEmlHtml).toContain('Café');
    expect(sanitizedEmlHtml).toContain('이력서.pdf');
    expect(sanitizedEmlHtml).toContain('Hello https://example.com/onclick=ok');
    expect(sanitizedEmlHtml).toContain('href="https://example.com/onclick=ok"');
    expect(sanitizedEmlHtml).not.toContain('alert(');
    expect(sanitizedEmlHtml).not.toContain('<script');
    expect(sanitizedEmlHtml).not.toContain('<svg');
    expect(sanitizedEmlHtml).not.toContain('onerror');
    expect(sanitizedEmlHtml).not.toContain('javascript:');
    expect(sanitizedEmlHtml).not.toContain('&colon;');
    expect(sanitizedEmlHtml).not.toContain('&tab;');
    expect(sanitizedEmlHtml).not.toContain('srcdoc');
    expect(sanitizedEmlHtml).not.toContain('formaction');

    // 6. Visual FoxPro DBF (0x30) binary fields I (Int32LE), B (DoubleLE), Y (Currency)
    const buildVfpDbf = (): Buffer => {
      const headerSize = 32 + 3 * 32 + 1; // 129
      const recordSize = 1 + 4 + 8 + 8; // 21
      const buf = Buffer.alloc(headerSize + recordSize + 1, 0);
      buf[0] = 0x30; // Visual FoxPro
      buf.writeUInt32LE(1, 4);
      buf.writeUInt16LE(headerSize, 8);
      buf.writeUInt16LE(recordSize, 10);
      const writeField = (idx: number, name: string, type: string, len: number) => {
        const off = 32 + idx * 32;
        buf.write(name, off, 'ascii');
        buf[off + 11] = type.charCodeAt(0);
        buf[off + 16] = len;
      };
      writeField(0, 'ID', 'I', 4);
      writeField(1, 'RATE', 'B', 8);
      writeField(2, 'AMT', 'Y', 8);
      buf[128] = 0x0d;
      const rec = headerSize;
      buf[rec] = 0x20;
      buf.writeInt32LE(-42, rec + 1);
      buf.writeDoubleLE(3.125, rec + 5);
      buf.writeBigInt64LE(123456n, rec + 13); // 12.3456
      buf[headerSize + recordSize] = 0x1a;
      return buf;
    };
    const vfpCsv = (await dispatchConversion(buildVfpDbf(), 'dbf', 'csv', { engine: 'easyconvert' }, 'vfp.dbf')).buffer.toString(
      'utf-8'
    );
    expect(vfpCsv).toContain('ID,RATE,AMT');
    expect(vfpCsv).toContain('-42,3.125,12.3456');
  });

  it('hardens EML HTML allowlist sanitizer against comment quotes, RCDATA breakouts, 5-deep split tags, unsafe URIs, and ReDoS', async () => {
    const emlWithBody = (htmlBody: string): Buffer =>
      Buffer.from(
        `From: sec@example.com\r\nSubject: Security Check\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${htmlBody}`,
        'utf-8'
      );

    // 1. Comment + quote breakout + RCDATA breakout + unclosed quote + unsafe URIs + style stripping + CSP
    const payloadHtml = [
      '<!--<img src="--><img src=x onerror=alert(1)>',
      '<textarea><img title="</textarea><img src=x onerror=alert(2)>"></textarea>',
      '<title><img title="</title><img src=x onerror=alert(3)>"></title>',
      '<a href="data:image/svg+xml;base64,PHN2Zy8+">SvgLink</a>',
      '<img src="data:image/svg+xml;base64,PHN2Zy8+">',
      '<img src="data:image/png;base64,iVBORw0KGgo=" alt="ok" width="16" height="16" style="width:1px" onclick="alert(4)" />',
      '<div style="position:fixed;inset:0"><p>StyledBody</p></div>',
      '<a href="https://example.com/docs?a=1&amp;b=2" title="Docs">SafeLink</a>',
    ].join('');
    const resHtml = (await dispatchConversion(emlWithBody(payloadHtml), 'eml', 'html', {}, 'xss.eml')).buffer.toString('utf-8');
    expect(resHtml).toContain(
      '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src http: https: data:; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'">'
    );
    expect(resHtml).not.toContain('<img src=x');
    expect(resHtml).not.toContain('onerror');
    expect(resHtml).not.toContain('alert(');
    expect(resHtml).not.toContain('<textarea');
    expect(resHtml).not.toContain('data:image/svg+xml');
    expect(resHtml).not.toContain('position:fixed');
    expect(resHtml).not.toContain('width:1px');
    expect(resHtml).toContain('<img src="data:image/png;base64,iVBORw0KGgo=" alt="ok" width="16" height="16">');
    expect(resHtml).toContain('<div><p>StyledBody</p></div>');
    expect(resHtml).toContain('<a href="https://example.com/docs?a=1&amp;b=2" rel="noopener noreferrer" title="Docs">SafeLink</a>');

    // 2. Unclosed quote bypass on <a href="javascript:alert(1)>x</a>
    const unclosedQuoteHtml = '<p>Lead</p><a href="javascript:alert(1)>x</a>';
    const unclosedOut = (await dispatchConversion(emlWithBody(unclosedQuoteHtml), 'eml', 'html', {}, 'unclosed.eml')).buffer.toString(
      'utf-8'
    );
    expect(unclosedOut).toContain('<p>Lead</p>');
    expect(unclosedOut).not.toContain('javascript:');
    expect(unclosedOut).not.toContain('alert(');

    // 3. 5-deep split tag reassembly & <ob<meta>ject data="data:text/html;...">
    const splitPayload =
      '<scr<me<me<me<meta>ta>ta>ta>ipt>alert(1)</scr<me<me<me<meta>ta>ta>ta>ipt>' +
      '<ob<meta>ject data="data:text/html;base64,PHNjcmlwdD4="></object>' +
      '<object data="data:text/html;base64,PHNjcmlwdD4=">blocked</object>';
    const splitOut = (await dispatchConversion(emlWithBody(splitPayload), 'eml', 'html', {}, 'split.eml')).buffer.toString('utf-8');
    expect(splitOut).not.toContain('<script');
    expect(splitOut).not.toContain('<object');
    expect(splitOut).not.toContain('<meta>');
    expect(splitOut).not.toContain('blocked');

    // 4. Quoted-printable decoded-byte limit fails cleanly
    const oversizedQpBody = 'A'.repeat(32 * 1024 * 1024 + 64);
    await expect(dispatchConversion(emlWithBody(oversizedQpBody.replace(/^/m, '')), 'eml', 'txt', {}, 'big.eml')).rejects.toThrow(
      ConversionFailedError
    );
    const qpHeaders =
      'From: sec@example.com\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n' +
      oversizedQpBody;
    await expect(dispatchConversion(Buffer.from(qpHeaders, 'utf-8'), 'eml', 'txt', {}, 'big-qp.eml')).rejects.toThrow(
      ConversionFailedError
    );

    // 5. ReDoS linear-time guards (expectNoHang) for >= 50,000 unclosed <script> in EML and backticks/spaces in rstToMarkdown
    const evilScripts = '<script>'.repeat(100_000) + '<p>End</p>';
    const evilScriptOut = (
      await expectNoHang('EML 100k unclosed <script>', () =>
        dispatchConversion(emlWithBody(evilScripts), 'eml', 'html', {}, 'redos.eml')
      )
    ).buffer.toString('utf-8');
    expect(evilScriptOut).not.toContain('<script');

    const evilRst = '`' + ' '.repeat(100_000) + '\n' + '`a<b '.repeat(25_000);
    const rstOut = await expectNoHang('rstToMarkdown 100k backticks and spaces', () => rstToMarkdown(evilRst));
    expect(rstOut.length).toBeGreaterThan(0);

    // 6. Suppressed-container body/title boundaries, HTML5 non-self-closing containers, void embed, and &colon; URI consistency
    const nestedContainerHtml = [
      '<head><template><body><p>Fake</p></body><title>WrongTitle</title></template></head>',
      '<body>',
      '<p>Before</p>',
      '<svg><foreignObject></body></foreignObject></svg>',
      '<iframe></body></iframe>',
      '<template /><img src="https://evil.com/t.png"></template>',
      '<noscript /><img src="https://evil.com/n.png"></noscript>',
      '<iframe /><p>Fallback</p></iframe>',
      '<embed src="https://evil.com/e.swf">',
      '<p>AfterEmbed</p>',
      '<img src="data&colon;image/png;base64,iVBORw0KGgo=">',
      '<a href="https&colon;//example.com?a=1&amp;colon=2&copy=3">EntityLink</a>',
      '</body>',
    ].join('');
    const nestedContainerOut = (
      await dispatchConversion(emlWithBody(nestedContainerHtml), 'eml', 'html', {}, 'containers.eml')
    ).buffer.toString('utf-8');
    expect(nestedContainerOut).toContain('<p>Before</p><p>AfterEmbed</p>');
    expect(nestedContainerOut).not.toContain('Fake');
    expect(nestedContainerOut).not.toContain('Fallback');
    expect(nestedContainerOut).not.toContain('evil.com');
    expect(nestedContainerOut).toContain('<img src="data:image/png;base64,iVBORw0KGgo=">');
    expect(nestedContainerOut).toContain(
      '<a href="https://example.com?a=1&amp;colon=2&amp;copy=3" rel="noopener noreferrer">EntityLink</a>'
    );

    const omittedHeadCloseOut = (
      await dispatchConversion(
        emlWithBody('<head><meta charset=utf-8><p>VisibleWithoutBodyTag</p>'),
        'eml',
        'html',
        {},
        'noheadclose.eml'
      )
    ).buffer.toString('utf-8');
    expect(omittedHeadCloseOut).toContain('<p>VisibleWithoutBodyTag</p>');

    const deepContainers = '<template><iframe>'.repeat(25_000);
    const deepContainersOut = (
      await expectNoHang('EML 50k nested unclosed <template><iframe>', () =>
        dispatchConversion(emlWithBody(deepContainers), 'eml', 'html', {}, 'deep-containers.eml')
      )
    ).buffer.toString('utf-8');
    expect(deepContainersOut).not.toContain('<template');
    expect(deepContainersOut).not.toContain('<iframe');
  });

  it('handles U+0130, quoted attributes, comments, rawtext self-closing, and CSP sanitization across XHTML -> txt/md/html', async () => {
    // 1. U+0130 (İ) case-folding index shift & head stripping
    const turkishXhtml = Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>İstanbul</title></head><body><p>Merhaba Dünya</p></body></html>',
      'utf-8'
    );
    const turkishTxt = (await dispatchConversion(turkishXhtml, 'xhtml', 'txt', {}, 'tr.xhtml')).buffer.toString('utf-8');
    expect(turkishTxt).toBe('Merhaba Dünya');
    const turkishMd = (await dispatchConversion(turkishXhtml, 'xhtml', 'md', {}, 'tr.xhtml')).buffer.toString('utf-8');
    expect(turkishMd).toBe('Merhaba Dünya');
    const turkishHtml = (await dispatchConversion(turkishXhtml, 'xhtml', 'html', {}, 'tr.xhtml')).buffer.toString('utf-8');
    expect(turkishHtml).toContain('<title>İstanbul</title>');
    expect(turkishHtml).toContain('<body><p>Merhaba Dünya</p></body>');

    // 2. Quoted '/>' inside <head data-x="/>">
    const quotedHead = Buffer.from(
      '<html xmlns="http://www.w3.org/1999/xhtml"><head data-x="/>"><title>SecretTitle</title></head><body><p>Visible</p></body></html>',
      'utf-8'
    );
    const quotedTxt = (await dispatchConversion(quotedHead, 'xhtml', 'txt', {}, 'q.xhtml')).buffer.toString('utf-8');
    expect(quotedTxt).toBe('Visible');
    expect(quotedTxt).not.toContain('SecretTitle');
    const quotedMd = (await dispatchConversion(quotedHead, 'xhtml', 'md', {}, 'q.xhtml')).buffer.toString('utf-8');
    expect(quotedMd).toBe('Visible');

    // 3. <!-- <head> --> comment before body must not drop body or leak '-->'
    const commentedXhtml = Buffer.from('<!-- <head> --><body><p>Kept</p></body>', 'utf-8');
    expect((await dispatchConversion(commentedXhtml, 'xhtml', 'txt', {}, 'c.xhtml')).buffer.toString('utf-8')).toBe('Kept');
    expect((await dispatchConversion(commentedXhtml, 'xhtml', 'md', {}, 'c.xhtml')).buffer.toString('utf-8')).toBe('Kept');

    // 4. Unquoted rawtext <script src=https://example.com/>alert(1)</script><p>Safe</p>
    const rawScriptXhtml = Buffer.from('<script src=https://example.com/>alert(1)</script><p>Safe</p>', 'utf-8');
    expect((await dispatchConversion(rawScriptXhtml, 'xhtml', 'txt', {}, 's.xhtml')).buffer.toString('utf-8')).toBe('Safe');
    expect((await dispatchConversion(rawScriptXhtml, 'xhtml', 'md', {}, 's.xhtml')).buffer.toString('utf-8')).toBe('Safe');
    const rawScriptHtml = (await dispatchConversion(rawScriptXhtml, 'xhtml', 'html', {}, 's.xhtml')).buffer.toString('utf-8');
    expect(rawScriptHtml).not.toContain('<script');
    expect(rawScriptHtml).not.toContain('alert(1)');
    expect(rawScriptHtml).toContain('<p>Safe</p>');

    // 5. XHTML self-closing <title /><div /><textarea /> -> valid non-swallowing HTML5 with CSP and stripped script/onerror
    const selfClosingXhtml = Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title /></head><body><title /><div /><textarea /><p onerror="alert(1)">VisibleAfter</p><script>alert(2)</script></body></html>',
      'utf-8'
    );
    const safeXhtmlOut = (await dispatchConversion(selfClosingXhtml, 'xhtml', 'html', {}, 'sc.xhtml')).buffer.toString('utf-8');
    expect(safeXhtmlOut).toContain('<!DOCTYPE html>');
    expect(safeXhtmlOut).toContain('Content-Security-Policy');
    expect(safeXhtmlOut).toContain('<div></div><p>VisibleAfter</p>');
    expect(safeXhtmlOut).not.toContain('<div />');
    expect(safeXhtmlOut).not.toContain('<title />');
    expect(safeXhtmlOut).not.toContain('<textarea');
    expect(safeXhtmlOut).not.toContain('<script');
    expect(safeXhtmlOut).not.toContain('onerror');
    expect(safeXhtmlOut).not.toContain('alert(');

    // 6. <template> inside <head> must not hijack <title> or <body> boundaries
    const headTemplateXhtml = Buffer.from(
      '<html xmlns="http://www.w3.org/1999/xhtml"><head><template><body><p>Fake</p></body><title>Bad</title></template><title>Good</title></head><body><p>Real</p></body></html>',
      'utf-8'
    );
    expect((await dispatchConversion(headTemplateXhtml, 'xhtml', 'txt', {}, 'ht.xhtml')).buffer.toString('utf-8')).toBe('Real');
    expect((await dispatchConversion(headTemplateXhtml, 'xhtml', 'md', {}, 'ht.xhtml')).buffer.toString('utf-8')).toBe('Real');
    const headTemplateHtml = (await dispatchConversion(headTemplateXhtml, 'xhtml', 'html', {}, 'ht.xhtml')).buffer.toString('utf-8');
    expect(headTemplateHtml).toContain('<title>Good</title>');
    expect(headTemplateHtml).toContain('<body><p>Real</p></body>');
    expect(headTemplateHtml).not.toContain('Fake');
  });

  it('hardens Flat ODF leading comment normalization, .cur vs .wks signature distinction, and legacy spreadsheet bounds', async () => {
    // 1. Flat ODF with <!-- <office:document> --> before root and <!-- </office:document> --> after root
    const fodtLeadingComment = Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?>
<!-- <office:document> comment before root -->
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
  office:mimetype="application/vnd.oasis.opendocument.text" office:version="1.2">
  <office:body><office:text><text:p>Leading comment OK</text:p></office:text></office:body>
</office:document>
<!-- </office:document> comment after root -->`,
      'utf-8'
    );
    const odtOut = await dispatchConversion(fodtLeadingComment, 'fodt', 'odt', { engine: 'easyconvert' }, 'lead.fodt');
    expect(await readOdtText(odtOut.buffer)).toContain('Leading comment OK');

    // 2. .cur cursor headers (00 00 02 00 01 00 / 02 00) rejected as .wks, accepted as .cur; real Lotus/Works BOF accepted as .wks
    const curOne = Buffer.alloc(22, 0);
    curOne.writeUInt16LE(0, 0);
    curOne.writeUInt16LE(2, 2); // CURSOR_RESOURCE_TYPE
    curOne.writeUInt16LE(1, 4); // 1 image
    curOne[6] = 16;
    curOne[7] = 16;
    curOne.writeUInt32LE(40, 14);
    curOne.writeUInt32LE(22, 18);
    expect(() => assertNotSpoofedFile(curOne, 'cur', 'arrow.cur')).not.toThrow();
    expect(() => assertNotSpoofedFile(curOne, 'wks', 'arrow.wks')).toThrow(FileExtensionSpoofError);

    const curTwo = Buffer.from(curOne);
    curTwo.writeUInt16LE(2, 4);
    expect(() => assertNotSpoofedFile(curTwo, 'wks', 'two.wks')).toThrow(FileExtensionSpoofError);

    const curEight = Buffer.alloc(6 + 8 * 16 + 4, 0);
    curEight.writeUInt16LE(0, 0);
    curEight.writeUInt16LE(2, 2);
    curEight.writeUInt16LE(8, 4);
    for (let k = 0; k < 8; k += 1) {
      const off = 6 + k * 16;
      curEight.writeUInt32LE(4, off + 8);
      curEight.writeUInt32LE(6 + 8 * 16, off + 12);
    }
    expect(() => assertNotSpoofedFile(curEight, 'wks', 'eight.wks')).toThrow(FileExtensionSpoofError);

    const curEightLargeHeader = Buffer.alloc(65_536, 0);
    curEightLargeHeader.writeUInt16LE(0, 0);
    curEightLargeHeader.writeUInt16LE(2, 2);
    curEightLargeHeader.writeUInt16LE(8, 4);
    for (let k = 0; k < 8; k += 1) {
      const off = 6 + k * 16;
      curEightLargeHeader.writeUInt32LE(16_384, off + 8);
      curEightLargeHeader.writeUInt32LE(6 + 8 * 16 + k * 16_384, off + 12);
    }
    expect(() => assertNotSpoofedFile(curEightLargeHeader, 'wks', 'eight-large.wks')).toThrow(FileExtensionSpoofError);

    const cur1024Header = Buffer.alloc(65_536, 0);
    cur1024Header.writeUInt16LE(0, 0);
    cur1024Header.writeUInt16LE(2, 2);
    cur1024Header.writeUInt16LE(0x0400, 4);
    for (let k = 0; k < 0x0400; k += 1) {
      const off = 6 + k * 16;
      cur1024Header.writeUInt32LE(32, off + 8);
      cur1024Header.writeUInt32LE(6 + 0x0400 * 16 + k * 32, off + 12);
    }
    expect(() => assertNotSpoofedFile(cur1024Header, 'wks', 'many-cur.wks')).toThrow(FileExtensionSpoofError);

    const lotusRev0404 = buildWk1Sample();
    lotusRev0404.writeUInt16LE(0x0404, 4);
    expect(() => assertNotSpoofedFile(lotusRev0404, 'wks', 'r1a.wks')).not.toThrow();

    const lotusRev1000 = buildWk1Sample();
    lotusRev1000.writeUInt16LE(0x1000, 4);
    expect(() => assertNotSpoofedFile(lotusRev1000, 'wks', 'r3.wks')).not.toThrow();

    // 3. PRN / DIF row and materialized-grid bounds fail before full materialization
    const tooManyPrnRows = Buffer.from('1\n'.repeat(1_048_577), 'ascii');
    await expect(dispatchConversion(tooManyPrnRows, 'prn', 'csv', { engine: 'easyconvert' }, 'rows.prn')).rejects.toThrow(
      SheetLimitError
    );

    const wideSparseDif = Buffer.from(
      'TABLE\n0,1\n"T"\nDATA\n0,0\n""\n-1,0\nBOT\n' +
        '0,1\nV\n'.repeat(10_000) +
        '-1,0\nBOT\n0,1\nV\n'.repeat(2_000),
      'ascii'
    );
    await expect(dispatchConversion(wideSparseDif, 'dif', 'csv', { engine: 'easyconvert' }, 'wide.dif')).rejects.toThrow(
      SheetLimitError
    );
  });
});
