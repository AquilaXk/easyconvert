import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import {
  parseCfbf,
  isCfbfContainer,
  parseHwpDocument,
  buildHwpCompoundFile,
  convertHwp,
  decodeHwpText,
  HWP_TAGS,
} from '../src/lib/conversions/hwp';
import { convertFile } from '../src/lib/conversions/index';

describe('HWP 5.0 OLE CFBF Container & Record Parser', () => {
  it('detects CFBF container signature and parses directory and sector chains', () => {
    const compound = buildHwpCompoundFile({
      paragraphs: [{ text: '문서 제목', isHeading: true }, { text: '첫 번째 본문 단락입니다.' }],
      compressed: false,
    });

    expect(isCfbfContainer(compound)).toBe(true);

    const cfbf = parseCfbf(compound);
    expect(cfbf.sectorSize).toBe(512);
    expect(cfbf.miniSectorSize).toBe(64);
    expect(cfbf.directoryEntries.length).toBeGreaterThanOrEqual(4);

    const streamNames = Array.from(cfbf.streams.keys());
    expect(streamNames).toContain('FileHeader');
    expect(streamNames).toContain('DocInfo');
    expect(streamNames).toContain('Section0');

    const fileHeader = cfbf.streams.get('FileHeader')!;
    expect(fileHeader.toString('utf8', 0, 17)).toBe('HWP Document File');
  });

  it('correctly parses HWP 5.0 records with compressed streams and extracts text & tables', () => {
    const testParagraphs = [
      { text: '대한민국 헌법 전문' },
      { text: '유구한 역사와 전통에 빛나는 우리 대한국민은 3·1운동으로 건립된 대한민국임시정부의 법통과 불의에 항거한 4·19민주이념을 계승하고' },
    ];
    const testTables = [
      {
        rows: [
          ['구분', '항목', '금액'],
          ['수입', '급여', '3,500,000'],
          ['지출', '식비', '800,000'],
        ],
      },
    ];

    const hwpBuffer = buildHwpCompoundFile({
      paragraphs: testParagraphs,
      tables: testTables,
      compressed: true,
    });

    const doc = parseHwpDocument(hwpBuffer);
    expect(doc.version).toBe('5.0.3.0');
    expect(doc.isCompressed).toBe(true);
    expect(doc.paragraphs.length).toBeGreaterThanOrEqual(2);
    expect(doc.paragraphs[0].text).toContain('대한민국 헌법 전문');
    expect(doc.paragraphs[1].text).toContain('유구한 역사와 전통');

    expect(doc.tables.length).toBe(1);
    expect(doc.tables[0].rowCount).toBe(3);
    expect(doc.tables[0].colCount).toBe(3);
    expect(doc.tables[0].rows[0]).toEqual(['구분', '항목', '금액']);
    expect(doc.tables[0].rows[1]).toEqual(['수입', '급여', '3,500,000']);
  });

  it('filters inline control codes in decodeHwpText while preserving standard whitespace', () => {
    // UTF-16LE buffer with inline control characters (0x000B, 0x0010) and standard tab (0x0009)
    const rawCodes = [
      0x0048, 0x0065, 0x006c, 0x006c, 0x006f, // "Hello"
      0x000b, // inline control (should be filtered)
      0x0009, // tab (should be preserved)
      0x0057, 0x006f, 0x0072, 0x006c, 0x0064, // "World"
      0x0010, // inline control (should be filtered)
      0x000a, // newline (should be preserved)
    ];

    const buf = Buffer.alloc(rawCodes.length * 2);
    rawCodes.forEach((code, idx) => buf.writeUInt16LE(code, idx * 2));

    const decoded = decodeHwpText(buf);
    expect(decoded).toBe('Hello\tWorld\n');
  });

  it('converts HWP to structured PDF preserving paragraph layout and table grids', async () => {
    const hwpBuffer = buildHwpCompoundFile({
      paragraphs: [
        { text: '연간 사업 보고서' },
        { text: '본 보고서는 2026 회계연도 실적을 요약한 공식 문서입니다.' },
      ],
      tables: [
        {
          rows: [
            ['분기', '매출액', '영업이익'],
            ['1Q', '120억', '25억'],
            ['2Q', '145억', '32억'],
          ],
        },
      ],
      compressed: true,
    });

    const result = await convertFile(hwpBuffer, 'hwp', 'pdf', {}, 'report.hwp');
    expect(result.mimeType).toBe('application/pdf');
    expect(result.filename).toBe('report.pdf');
    expect(result.buffer.subarray(0, 4).toString('ascii')).toBe('%PDF');
    expect(result.buffer.length).toBeGreaterThan(1000);
  });

  it('converts HWP to authentic OpenXML DOCX containing structured tables', async () => {
    const hwpBuffer = buildHwpCompoundFile({
      paragraphs: [{ text: '계약서 요약' }],
      tables: [
        {
          rows: [
            ['당사자', '성명', '서명'],
            ['갑', '홍길동', '(인)'],
            ['을', '이순신', '(인)'],
          ],
        },
      ],
      compressed: true,
    });

    const result = await convertFile(hwpBuffer, 'hwp', 'docx', {}, 'contract.hwp');
    expect(result.mimeType).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(result.filename).toBe('contract.docx');

    // Verify DOCX ZIP package structure
    const zip = await JSZip.loadAsync(result.buffer);
    expect(zip.file('[Content_Types].xml')).not.toBeNull();
    expect(zip.file('word/document.xml')).not.toBeNull();

    const docXml = await zip.file('word/document.xml')!.async('text');
    expect(docXml).toContain('<w:tbl>');
    expect(docXml).toContain('계약서 요약');
    expect(docXml).toContain('홍길동');
    expect(docXml).toContain('이순신');
  });

  it('converts HWP to clean HTML with structured table elements', async () => {
    const hwpBuffer = buildHwpCompoundFile({
      paragraphs: [{ text: '웹 보고서' }, { text: 'HTML 변환 테스트 단락입니다.' }],
      tables: [
        {
          rows: [
            ['번호', '이름'],
            ['1', '김철수'],
          ],
        },
      ],
      compressed: false,
    });

    const result = await convertHwp(hwpBuffer, 'html', {}, 'test.hwp');
    expect(result.mimeType).toBe('text/html');
    const html = result.buffer.toString('utf-8');
    expect(html).toContain('<h2>웹 보고서</h2>');
    expect(html).toContain('<p>HTML 변환 테스트 단락입니다.</p>');
    expect(html).toContain('<table>');
    expect(html).toContain('<th>번호</th>');
    expect(html).toContain('<td>김철수</td>');
  });

  it('converts HWP to authentic ODT zip package containing content.xml', async () => {
    const hwpBuffer = buildHwpCompoundFile({
      paragraphs: [{ text: 'ODT 변환 시험' }, { text: '한글 워드프로세서 문서의 ODT 변환 검증' }],
      tables: [{ rows: [['항목', '값'], ['CPU', 'M3']] }],
      compressed: true,
    });

    const result = await convertFile(hwpBuffer, 'hwp', 'odt', {}, 'test_doc.hwp');
    expect(result.mimeType).toBe('application/vnd.oasis.opendocument.text');
    expect(result.filename).toBe('test_doc.odt');

    const zip = await JSZip.loadAsync(result.buffer);
    expect(zip.file('mimetype')).not.toBeNull();
    expect(zip.file('content.xml')).not.toBeNull();

    const contentXml = await zip.file('content.xml')!.async('text');
    expect(contentXml).toContain('ODT 변환 시험');
    expect(contentXml).toContain('CPU');
  });

  it('converts HWP to crisp raster images (PNG, JPG) without disguised PDFs', async () => {
    const hwpBuffer = buildHwpCompoundFile({
      paragraphs: [{ text: '이미지 렌더링 시험' }],
      tables: [{ rows: [['열1', '열2']] }],
      compressed: false,
    });

    const resPng = await convertFile(hwpBuffer, 'hwp', 'png', {}, 'visual.hwp');
    expect(resPng.mimeType).toBe('image/png');
    expect(resPng.filename).toBe('visual.png');
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    expect(resPng.buffer.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    const resJpg = await convertFile(hwpBuffer, 'hwp', 'jpg', {}, 'visual.hwp');
    expect(resJpg.mimeType).toBe('image/jpeg');
    expect(resJpg.filename).toBe('visual.jpg');
    // JPEG SOI: FF D8
    expect(resJpg.buffer[0]).toBe(0xff);
    expect(resJpg.buffer[1]).toBe(0xd8);
  });

  it('converts HWP to DOC and XPS containers', async () => {
    const hwpBuffer = buildHwpCompoundFile({
      paragraphs: [{ text: '문서 변환' }],
      compressed: false,
    });

    const resDoc = await convertFile(hwpBuffer, 'hwp', 'doc', {}, 'word.hwp');
    expect(resDoc.mimeType).toBe('application/msword');
    expect(resDoc.filename).toBe('word.doc');
    expect(resDoc.buffer.toString('utf-8')).toContain('{\\rtf1');

    const resXps = await convertFile(hwpBuffer, 'hwp', 'xps', {}, 'fixed.hwp');
    expect(resXps.mimeType).toBe('application/oxps');
    expect(resXps.filename).toBe('fixed.xps');
    const zip = await JSZip.loadAsync(resXps.buffer);
    expect(zip.file('[Content_Types].xml')).not.toBeNull();
  });

  it('handles non-CFBF plaintext input gracefully via fail-safe fallback', async () => {
    const rawPlaintext = Buffer.from('일반 텍스트 형식의 한글 문서 내용입니다.', 'utf-8');
    const result = await convertFile(rawPlaintext, 'hwp', 'pdf', {}, 'plain.hwp');

    expect(result.mimeType).toBe('application/pdf');
    expect(result.buffer.subarray(0, 4).toString('ascii')).toBe('%PDF');
  });

  it('safely decodes massive UTF-16LE text streams (150,000+ chars) without call stack overflow', () => {
    const charCount = 150000;
    const buf = Buffer.alloc(charCount * 2);
    for (let i = 0; i < charCount; i++) {
      buf.writeUInt16LE(0xac00 + (i % 100), i * 2); // Korean syllables
    }

    const decoded = decodeHwpText(buf);
    expect(decoded.length).toBe(charCount);
    expect(decoded.charCodeAt(0)).toBe(0xac00);
  });

  it('supports HWP 5.0 extended record sizes (>= 4095 bytes) using 0xFFF prefix', () => {
    const longText = '대한민국 '.repeat(1500); // approx 7500 chars = 15000 UTF-16 bytes
    const compound = buildHwpCompoundFile({
      paragraphs: [{ text: longText }],
      compressed: false,
    });

    const doc = parseHwpDocument(compound);
    expect(doc.paragraphs.length).toBeGreaterThanOrEqual(1);
    expect(doc.paragraphs[0].text).toContain('대한민국');
    expect(doc.paragraphs[0].text.length).toBeGreaterThan(6000);
  });

  it('supports multi-sector FAT allocation for large HWP documents (> 124 sectors) without RangeError', () => {
    // Generate text that yields > 150 sectors
    const largeParagraphs = [];
    for (let p = 0; p < 120; p++) {
      largeParagraphs.push({ text: `단락 ${p}: ` + '본문 내용 데이터 검증 라인입니다. '.repeat(50) });
    }

    const compound = buildHwpCompoundFile({
      paragraphs: largeParagraphs,
      compressed: false,
    });

    expect(compound.length).toBeGreaterThan(70000); // > 64KB, requires multi-sector FAT
    const doc = parseHwpDocument(compound);
    expect(doc.paragraphs.length).toBeGreaterThanOrEqual(120);
    expect(doc.paragraphs[119].text).toContain('단락 119');
  });

  it('fails closed when encountering encrypted/password-protected HWP files', () => {
    // Build a compound file and flip the encrypted bit in FileHeader
    const compound = buildHwpCompoundFile({
      paragraphs: [{ text: '비밀 문서' }],
      compressed: false,
    });

    // FileHeader is at sector 1 (offset 512 + 512 = 1024), flags at offset 36 in FileHeader
    const encCompound = Buffer.from(compound);
    // Find 'HWP Document File' in buffer
    const fhIdx = encCompound.indexOf(Buffer.from('HWP Document File'));
    expect(fhIdx).toBeGreaterThan(0);
    // Flags at offset + 36: bit 1 is encrypted
    encCompound.writeUInt32LE(0x02, fhIdx + 36);

    expect(() => parseHwpDocument(encCompound)).toThrow(/Encrypted HWP documents with password protection cannot be converted/);
  });

  it('converts markdown documents with tables directly to authentic HWP 5.0 compound files', async () => {
    const md = `# 분기 실적 보고
대한민국 소프트웨어 산업의 성장과 혁신 보고서입니다.

| 부서 | 담당자 | 목표달성률 |
| --- | --- | --- |
| 연구개발 | 홍길동 | 110% |
| 품질관리 | 이순신 | 100% |

지속적인 기술 개발을 통해 글로벌 경쟁력을 확보하겠습니다.`;

    const result = await convertFile(Buffer.from(md, 'utf-8'), 'md', 'hwp', {}, 'quarterly.md');
    expect(result.mimeType).toBe('application/x-hwp');
    expect(result.filename).toBe('quarterly.hwp');
    expect(isCfbfContainer(result.buffer)).toBe(true);

    // Verify round-trip parsing of the generated HWP file
    const doc = parseHwpDocument(result.buffer);
    expect(doc.version).toBe('5.0.3.0');
    expect(doc.paragraphs.length).toBeGreaterThanOrEqual(2);
    expect(doc.paragraphs[0].text).toContain('분기 실적 보고');
    expect(doc.tables.length).toBe(1);
    expect(doc.tables[0].rowCount).toBe(3);
    expect(doc.tables[0].rows[0]).toEqual(['부서', '담당자', '목표달성률']);
    expect(doc.tables[0].rows[1]).toEqual(['연구개발', '홍길동', '110%']);
  });
});
