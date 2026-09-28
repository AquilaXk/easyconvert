import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import {
  parseBiff8Workbook,
  decodeRk,
  buildOpenXpsPackage,
  convertFile,
} from '../src/lib/conversions';
import { ConversionFailedError } from '../src/lib/types';

function createRecord(id: number, data: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt16LE(id, 0);
  header.writeUInt16LE(data.length, 2);
  return Buffer.concat([header, data]);
}

function buildTestBiff8Stream(): Buffer {
  const records: Buffer[] = [];

  // 1. BOF (0x0809)
  const bofData = Buffer.alloc(8);
  bofData.writeUInt16LE(0x0600, 0); // BIFF8
  bofData.writeUInt16LE(0x0005, 2); // Workbook globals
  bofData.writeUInt16LE(0x0dbb, 4); // Build
  bofData.writeUInt16LE(0x07cc, 6); // Year
  records.push(createRecord(0x0809, bofData));

  // 2. SST (0x00FC) - Shared String Table
  // Strings: "Product", "Revenue"
  const str1 = Buffer.from('Product', 'latin1');
  const str2 = Buffer.from('Revenue', 'latin1');
  const sstPayload = Buffer.alloc(8 + 3 + str1.length + 3 + str2.length);
  sstPayload.writeUInt32LE(2, 0); // Total strings
  sstPayload.writeUInt32LE(2, 4); // Unique strings

  let off = 8;
  // Str 1: charCount=7, flags=0
  sstPayload.writeUInt16LE(7, off);
  sstPayload.writeUInt8(0, off + 2);
  str1.copy(sstPayload, off + 3);
  off += 3 + str1.length;

  // Str 2: charCount=7, flags=0
  sstPayload.writeUInt16LE(7, off);
  sstPayload.writeUInt8(0, off + 2);
  str2.copy(sstPayload, off + 3);

  records.push(createRecord(0x00fc, sstPayload));

  // 3. Worksheet BOF (0x0809)
  const wsBof = Buffer.alloc(8);
  wsBof.writeUInt16LE(0x0600, 0);
  wsBof.writeUInt16LE(0x0010, 2); // Worksheet
  records.push(createRecord(0x0809, wsBof));

  // 4. LABELSST (0x00FD): Row 0, Col 0 -> "Product" (sstIdx=0)
  const label1 = Buffer.alloc(10);
  label1.writeUInt16LE(0, 0); // row
  label1.writeUInt16LE(0, 2); // col
  label1.writeUInt16LE(0, 4); // xf
  label1.writeUInt32LE(0, 6); // sst index 0
  records.push(createRecord(0x00fd, label1));

  // 5. LABELSST (0x00FD): Row 0, Col 1 -> "Revenue" (sstIdx=1)
  const label2 = Buffer.alloc(10);
  label2.writeUInt16LE(0, 0); // row
  label2.writeUInt16LE(1, 2); // col
  label2.writeUInt16LE(0, 4); // xf
  label2.writeUInt32LE(1, 6); // sst index 1
  records.push(createRecord(0x00fd, label2));

  // 6. LABEL (0x0204): Row 1, Col 0 -> direct string "Widget A"
  const wStr = Buffer.from('Widget A', 'latin1');
  const dirLabel = Buffer.alloc(9 + wStr.length);
  dirLabel.writeUInt16LE(1, 0); // row 1
  dirLabel.writeUInt16LE(0, 2); // col 0
  dirLabel.writeUInt16LE(0, 4); // xf
  dirLabel.writeUInt16LE(wStr.length, 6); // len
  dirLabel.writeUInt8(0, 8); // flags = 8-bit
  wStr.copy(dirLabel, 9);
  records.push(createRecord(0x0204, dirLabel));

  // 7. RK (0x027E): Row 1, Col 1 -> 1500 (integer)
  const rkRec = Buffer.alloc(10);
  rkRec.writeUInt16LE(1, 0); // row 1
  rkRec.writeUInt16LE(1, 2); // col 1
  rkRec.writeUInt16LE(0, 4); // xf
  rkRec.writeUInt32LE((1500 << 2) | 2, 6); // 1500 as integer RK
  records.push(createRecord(0x027e, rkRec));

  // 8. MULRK (0x00BD): Row 2, Col 0..1 -> 250, 375.5
  // 4 bytes header (row 2, colFirst 0), 2 entries (6 bytes each), 2 bytes colLast (1)
  const mulrkRec = Buffer.alloc(4 + 12 + 2);
  mulrkRec.writeUInt16LE(2, 0); // row 2
  mulrkRec.writeUInt16LE(0, 2); // colFirst = 0
  // entry 0: xf=0, rk = 250
  mulrkRec.writeUInt16LE(0, 4);
  mulrkRec.writeUInt32LE((250 << 2) | 2, 6);
  // entry 1: xf=0, rk = 37550 / 100 = 375.50
  mulrkRec.writeUInt16LE(0, 10);
  mulrkRec.writeUInt32LE((37550 << 2) | 3, 12); // integer div 100
  mulrkRec.writeUInt16LE(1, 16); // colLast = 1
  records.push(createRecord(0x00bd, mulrkRec));

  // 9. NUMBER (0x0203): Row 3, Col 1 -> 99.99 IEEE double
  const numRec = Buffer.alloc(14);
  numRec.writeUInt16LE(3, 0); // row 3
  numRec.writeUInt16LE(1, 2); // col 1
  numRec.writeUInt16LE(0, 4); // xf
  numRec.writeDoubleLE(99.99, 6);
  records.push(createRecord(0x0203, numRec));

  // 10. EOF (0x000A)
  records.push(createRecord(0x000a, Buffer.alloc(0)));

  return Buffer.concat(records);
}

describe('Phase 3: BIFF8 XLS Authentic Parsing & Fail-Closed Spec Compliance', () => {
  it('correctly decodes RK compressed numbers for integers, floats, and /100 values', () => {
    // 30-bit integer
    expect(decodeRk((42 << 2) | 2)).toBe(42);
    expect(decodeRk((-15 << 2) | 2)).toBe(-15);

    // 30-bit integer divided by 100
    expect(decodeRk((12500 << 2) | 3)).toBe(125);
    expect(decodeRk((1250 << 2) | 3)).toBe(12.5);

    // Float with top 30 bits
    const fBuf = Buffer.alloc(8);
    fBuf.writeDoubleLE(2.5, 0);
    const top30 = fBuf.readUInt32LE(4) & ~3;
    expect(decodeRk(top30)).toBe(2.5);
  });

  it('parses authentic BIFF8 workbook stream records into clean structured rows', () => {
    const stream = buildTestBiff8Stream();
    const rows = parseBiff8Workbook(stream);

    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows[0]).toEqual(['Product', 'Revenue']);
    expect(rows[1]).toEqual(['Widget A', '1500']);
    expect(rows[2][0]).toBe('250');
    expect(rows[2][1]).toBe('375.5');
    expect(rows[3][1]).toBe('99.99');
  });

  it('converts authentic raw BIFF8 stream to CSV without synthetic placeholder rows', async () => {
    const stream = buildTestBiff8Stream();
    const result = await convertFile(stream, 'xls', 'csv', {}, 'financials.xls');

    expect(result.mimeType).toBe('text/csv');
    const csvContent = result.buffer.toString('utf-8');
    expect(csvContent).toContain('Product,Revenue');
    expect(csvContent).toContain('Widget A,1500');
    expect(csvContent).toContain('250,375.5');
    expect(csvContent).not.toContain('XLS spreadsheet content');
    expect(csvContent).not.toContain('Data');
  });

  it('fails closed with ConversionFailedError on empty or non-spreadsheet XLS payload', async () => {
    const emptyBuf = Buffer.alloc(0);
    await expect(convertFile(emptyBuf, 'xls', 'csv', {}, 'corrupt.xls')).rejects.toThrow(
      /Conversion payload is empty/
    );

    const randomJunk = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
    await expect(convertFile(randomJunk, 'xls', 'csv', {}, 'garbage.xls')).rejects.toThrow(
      ConversionFailedError
    );
  });
});

describe('Phase 3: Office CJK Unicode Rendering without Mojibake', () => {
  it('renders CJK Korean, Japanese, and Chinese characters in spreadsheet PDF export', async () => {
    const csvWithCjk = [
      '항목,수량,가격',
      '사과,10,15000',
      'リンゴ (Apple),5,8000',
      '苹果 (China),20,30000',
    ].join('\n');

    const csvBuffer = Buffer.from(csvWithCjk, 'utf-8');
    const result = await convertFile(csvBuffer, 'csv', 'pdf', {}, 'cjk-inventory.csv');

    expect(result.mimeType).toBe('application/pdf');
    expect(result.buffer.length).toBeGreaterThan(500);
    expect(result.buffer.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  });

  it('renders CJK text safely in generic ebook and text PDF export without WinAnsi error', async () => {
    const textContent = `
제목: 다국어 전자책 테스트
저자: 홍길동 & 山田太郎 & 李白
내용:
한국어 본문 텍스트입니다. 한글 자모 및 완성형 유니코드 렌더링 검증.
日本語のテキストです。ひらがな、カタカナ、漢字の描画検証。
简体中文和繁體中文测试。
    `.trim();

    const txtBuffer = Buffer.from(textContent, 'utf-8');
    const result = await convertFile(txtBuffer, 'txt', 'pdf', {}, 'ebook-cjk.txt');

    expect(result.mimeType).toBe('application/pdf');
    expect(result.buffer.length).toBeGreaterThan(500);
    expect(result.buffer.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  });
});

describe('Phase 3: OpenXPS / ECMA-388 Compliant OPC Package Structure', () => {
  it('generates fully compliant OpenXPS package with OPC descriptors from text', async () => {
    const textBuf = Buffer.from('Chapter 1\nIntroduction to High-Fidelity OpenXPS Engine\nSection 1.1', 'utf-8');
    const result = await convertFile(textBuf, 'txt', 'xps', {}, 'spec-document.txt');

    expect(result.mimeType).toBe('application/oxps');
    expect(result.filename).toBe('spec-document.xps');

    const zip = await JSZip.loadAsync(result.buffer);

    // 1. [Content_Types].xml
    expect(zip.file('[Content_Types].xml')).not.toBeNull();
    const ctXml = await zip.file('[Content_Types].xml')!.async('string');
    expect(ctXml).toContain('application/vnd.ms-package.xps-fixeddocumentsequence+xml');
    expect(ctXml).toContain('application/vnd.ms-package.xps-fixeddocument+xml');
    expect(ctXml).toContain('application/vnd.ms-package.xps-fixedpage+xml');

    // 2. _rels/.rels
    expect(zip.file('_rels/.rels')).not.toBeNull();
    const pkgRels = await zip.file('_rels/.rels')!.async('string');
    expect(pkgRels).toContain('Target="/FixedDocumentSequence.fdseq"');

    // 3. FixedDocumentSequence.fdseq
    expect(zip.file('FixedDocumentSequence.fdseq')).not.toBeNull();
    const fdseq = await zip.file('FixedDocumentSequence.fdseq')!.async('string');
    expect(fdseq).toContain('Source="/Documents/1/FixedDocument.fdoc"');

    // 4. Documents/1/FixedDocument.fdoc
    expect(zip.file('Documents/1/FixedDocument.fdoc')).not.toBeNull();
    const fdoc = await zip.file('Documents/1/FixedDocument.fdoc')!.async('string');
    expect(fdoc).toContain('Source="Pages/1.fpage"');

    // 5. Documents/1/Pages/1.fpage
    expect(zip.file('Documents/1/Pages/1.fpage')).not.toBeNull();
    const fpage = await zip.file('Documents/1/Pages/1.fpage')!.async('string');
    expect(fpage).toContain('<FixedPage');
    expect(fpage).toContain('<Glyphs');
    expect(fpage).toContain('Introduction to High-Fidelity');
  });

  it('embeds image resources and relationships when converting image to XPS', async () => {
    // 1x1 Red PNG
    const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const pngBuf = Buffer.from(pngBase64, 'base64');

    const result = await convertFile(pngBuf, 'png', 'xps', {}, 'photo.png');
    expect(result.mimeType).toBe('application/oxps');

    const zip = await JSZip.loadAsync(result.buffer);

    // Verify embedded image and page relationships
    expect(zip.file('Documents/1/Resources/Images/image1.png')).not.toBeNull();
    expect(zip.file('Documents/1/Pages/_rels/1.fpage.rels')).not.toBeNull();

    const relsXml = await zip.file('Documents/1/Pages/_rels/1.fpage.rels')!.async('string');
    expect(relsXml).toContain('Target="/Documents/1/Resources/Images/image1.png"');

    const fpageXml = await zip.file('Documents/1/Pages/1.fpage')!.async('string');
    expect(fpageXml).toContain('<ImageBrush ImageSource="/Documents/1/Resources/Images/image1.png"');
  });
});
