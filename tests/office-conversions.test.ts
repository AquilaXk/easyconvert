import { describe, it, expect } from 'vitest';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import JSZip from 'jszip';
import PDFDocument from 'pdfkit';
import { convertFile } from '../src/lib/conversions/index';
import { getFullDocxCellText } from '../src/lib/conversions/office';
import { zipEntryText } from './helpers/zip-entry';

/** ECMA-376 Part 2 / Open Packaging Conventions content types of the main parts. */
const CT_DOCX_MAIN = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
const CT_PPTX_MAIN = 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml';
const CT_PPTX_SLIDE = 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml';
const CT_XLSX_MAIN = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml';
const CT_XLSX_SHEET = 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml';
const override = (partName: string, contentType: string) => `<Override PartName="${partName}" ContentType="${contentType}"/>`;

describe('Office & Ebook Conversion Engine (DOCX, XLSX, PPTX, EPUB, MOBI, FB2, ODP)', () => {
  it('converts Markdown to a genuine OpenXML DOCX archive', async () => {
    const md = '# Title of Document\n\nThis is a paragraph with **bold** text and *italic* accents.';
    const buf = Buffer.from(md, 'utf-8');

    const result = await convertFile(buf, 'md', 'docx', {}, 'report.md');
    expect(result.mimeType).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );
    expect(result.filename).toBe('report.docx');

    // Verify it is a valid ZIP containing word/document.xml
    const zip = await JSZip.loadAsync(result.buffer);
    expect(await zipEntryText(zip, '[Content_Types].xml')).toContain(override('/word/document.xml', CT_DOCX_MAIN));

    const docXml = await zipEntryText(zip, 'word/document.xml');
    expect(docXml).toContain('Title of Document');
  });

  it('converts Markdown table to DOCX preserving OpenXML table structure (<w:tbl>)', async () => {
    const md = `# Quarterly Data

| Metric | Target | Actual |
| --- | --- | --- |
| Conversions | 1000 | 1240 |
| Uptime | 99.9% | 100% |

Summary after table.`;

    const result = await convertFile(Buffer.from(md, 'utf-8'), 'md', 'docx', { preserveTables: true }, 'metrics.md');
    expect(result.mimeType).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');

    const zip = await JSZip.loadAsync(result.buffer);
    const docXml = await zip.file('word/document.xml')!.async('text');

    // Must contain OpenXML table elements
    expect(docXml).toContain('<w:tbl>');
    expect(docXml).toContain('<w:tr>');
    expect(docXml).toContain('<w:tc>');
    expect(docXml).toContain('Conversions');
    expect(docXml).toContain('1240');
  });

  it('converts DOCX to PDF with layout preservation', async () => {
    // Generate valid DOCX first
    const md = '# Executive Summary\n\nQ3 conversion throughput increased by 45%.';
    const docxResult = await convertFile(Buffer.from(md, 'utf-8'), 'md', 'docx', {}, 'exec.md');

    // Convert DOCX to PDF
    const pdfResult = await convertFile(docxResult.buffer, 'docx', 'pdf', {}, 'exec.docx');
    expect(pdfResult.mimeType).toBe('application/pdf');
    expect(pdfResult.filename).toBe('exec.pdf');
    expect(pdfResult.buffer.toString('ascii', 0, 4)).toBe('%PDF');
  });

  it('converts DOCX to HTML with semantic tags', async () => {
    const md = '## Key Findings\n\nImportant note for all stakeholders.';
    const docxResult = await convertFile(Buffer.from(md, 'utf-8'), 'md', 'docx', {}, 'notes.md');

    const htmlResult = await convertFile(docxResult.buffer, 'docx', 'html', {}, 'notes.docx');
    expect(htmlResult.mimeType).toBe('text/html');
    const htmlText = htmlResult.buffer.toString('utf-8');
    expect(htmlText).toContain('<h2>');
    expect(htmlText).toContain('Key Findings');
  });

  it('converts Markdown to a genuine OpenXML PPTX presentation archive', async () => {
    const md = `# EasyConvert Product Overview
- Real-time in-memory streaming
- Zero external cloud storage footprint
- 200+ formats supported across 9 domains

---

# Architecture Highlights
- Single source of truth design
- Ephemeral processing with instantaneous cleanup
- High-density UX without AI slop`;

    const result = await convertFile(Buffer.from(md, 'utf-8'), 'md', 'pptx', {}, 'deck.md');
    expect(result.mimeType).toBe(
      'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    );
    expect(result.filename).toBe('deck.pptx');

    const zip = await JSZip.loadAsync(result.buffer);
    const contentTypes = await zipEntryText(zip, '[Content_Types].xml');
    expect(contentTypes).toContain(override('/ppt/presentation.xml', CT_PPTX_MAIN));
    expect(contentTypes).toContain(override('/ppt/slides/slide1.xml', CT_PPTX_SLIDE));
    expect(await zipEntryText(zip, 'ppt/presentation.xml')).toContain('<p:sldId ');

    const slide1Xml = await zipEntryText(zip, 'ppt/slides/slide1.xml');
    expect(slide1Xml).toContain('Product Overview');
    expect(slide1Xml).toContain('5C6BC0'); // Signature lavender color
  });

  it('converts PPTX to visual HTML slide deck', async () => {
    const md = `# Road Ahead\n- Step 1: Verification\n- Step 2: Delivery`;
    const pptxResult = await convertFile(Buffer.from(md, 'utf-8'), 'md', 'pptx', {}, 'road.md');

    const htmlResult = await convertFile(pptxResult.buffer, 'pptx', 'html', {}, 'road.pptx');
    expect(htmlResult.mimeType).toBe('text/html');
    const html = htmlResult.buffer.toString('utf-8');
    expect(html).toContain('Road Ahead');
    expect(html).toContain('Step 1: Verification');
    expect(html).toContain('Slide 1');
  });

  it('converts OpenDocument Presentation (ODP) to PDF and TXT', async () => {
    // Generate valid ODP zip with content.xml
    const zip = new JSZip();
    zip.file(
      'content.xml',
      `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">
  <office:body>
    <office:presentation>
      <draw:page draw:name="page1">
        <draw:frame>
          <text:p>OpenDocument Presentation Slide</text:p>
          <text:p>Bullet point from ODP slide</text:p>
        </draw:frame>
      </draw:page>
    </office:presentation>
  </office:body>
</office:document-content>`
    );
    const odpBuf = await zip.generateAsync({ type: 'nodebuffer' });

    const txtResult = await convertFile(odpBuf, 'odp', 'txt', {}, 'slides.odp');
    expect(txtResult.mimeType).toBe('text/plain');
    expect(txtResult.buffer.toString('utf-8')).toContain('OpenDocument Presentation Slide');

    const pdfResult = await convertFile(odpBuf, 'odp', 'pdf', {}, 'slides.odp');
    expect(pdfResult.mimeType).toBe('application/pdf');
    expect(pdfResult.buffer.toString('ascii', 0, 4)).toBe('%PDF');
  });

  it('converts CSV to a genuine OpenXML XLSX spreadsheet archive', async () => {
    const csv = 'Product,Price,Quantity\nWidget A,19.99,10\nWidget B,29.99,5';
    const buf = Buffer.from(csv, 'utf-8');

    const result = await convertFile(buf, 'csv', 'xlsx', {}, 'inventory.csv');
    expect(result.mimeType).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    expect(result.filename).toBe('inventory.xlsx');

    // Verify OpenXML spreadsheet contents
    const zip = await JSZip.loadAsync(result.buffer);
    const contentTypes = await zipEntryText(zip, '[Content_Types].xml');
    expect(contentTypes).toContain(override('/xl/workbook.xml', CT_XLSX_MAIN));
    expect(contentTypes).toContain(override('/xl/worksheets/sheet1.xml', CT_XLSX_SHEET));
    expect(await zipEntryText(zip, 'xl/workbook.xml')).toContain('<sheet ');

    const sheetXml = await zipEntryText(zip, 'xl/worksheets/sheet1.xml');
    expect(sheetXml).toContain('Widget A');
  });

  it('converts XLSX to XML structured document', async () => {
    const csv = 'Item,Cost\nLaptop,1200\nMouse,25';
    const xlsxResult = await convertFile(Buffer.from(csv, 'utf-8'), 'csv', 'xlsx', {}, 'goods.csv');

    const xmlResult = await convertFile(xlsxResult.buffer, 'xlsx', 'xml', {}, 'goods.xlsx');
    expect(xmlResult.mimeType).toBe('application/xml');
    const xml = xmlResult.buffer.toString('utf-8');
    expect(xml).toContain('<worksheet');
    expect(xml).toContain('<Item>Laptop</Item>');
    expect(xml).toContain('<Cost>1200</Cost>');
  });

  it('converts XLSX to JSON structured records', async () => {
    const csv = 'Name,Age,Role\nAlice,30,Developer\nBob,35,Designer';
    const xlsxResult = await convertFile(Buffer.from(csv, 'utf-8'), 'csv', 'xlsx', {}, 'team.csv');

    const jsonResult = await convertFile(xlsxResult.buffer, 'xlsx', 'json', {}, 'team.xlsx');
    expect(jsonResult.mimeType).toBe('application/json');
    const parsed = JSON.parse(jsonResult.buffer.toString('utf-8'));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(2);
    expect(parsed[0].Name).toBe('Alice');
    expect(parsed[1].Role).toBe('Designer');
  });

  it('converts text to a valid IDPF EPUB electronic book container', async () => {
    const text = '# Chapter One: The Beginning\n\nIt was a dark and stormy night.';
    const buf = Buffer.from(text, 'utf-8');

    const result = await convertFile(buf, 'md', 'epub', {}, 'novel.md');
    expect(result.mimeType).toBe('application/epub+zip');
    expect(result.filename).toBe('novel.epub');

    const zip = await JSZip.loadAsync(result.buffer);
    // OCF 3.0: the first entry is the stored "mimetype" file holding exactly the media type, and the container
    // file points at the package document.
    expect(await zipEntryText(zip, 'mimetype')).toBe('application/epub+zip');
    expect(await zipEntryText(zip, 'META-INF/container.xml')).toContain(
      '<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>'
    );
    expect(await zipEntryText(zip, 'OEBPS/content.opf')).toContain('href="chapter1.xhtml"');

    const chapterHtml = await zipEntryText(zip, 'OEBPS/chapter1.xhtml');
    expect(chapterHtml).toContain('The Beginning');
  });

  it('converts EPUB to HTML with chapter text preserved', async () => {
    const text = '# Chapter Two\n\nThe story continues smoothly.';
    const epubResult = await convertFile(Buffer.from(text, 'utf-8'), 'md', 'epub', {}, 'book.md');

    const htmlResult = await convertFile(epubResult.buffer, 'epub', 'html', {}, 'book.epub');
    expect(htmlResult.mimeType).toBe('text/html');
    const html = htmlResult.buffer.toString('utf-8');
    expect(html).toContain('The story continues smoothly');
  });

  it('converts FictionBook 2 (FB2) to PDF and TXT', async () => {
    const fb2Xml = `<?xml version="1.0" encoding="utf-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0">
  <description>
    <title-info>
      <book-title>Sci-Fi Odyssey</book-title>
    </title-info>
  </description>
  <body>
    <section>
      <p>In deep space, humanity discovered a transmission.</p>
      <p>The signal was repeating every 42 seconds.</p>
    </section>
  </body>
</FictionBook>`;

    const txtResult = await convertFile(Buffer.from(fb2Xml, 'utf-8'), 'fb2', 'txt', {}, 'odyssey.fb2');
    expect(txtResult.mimeType).toBe('text/plain');
    expect(txtResult.buffer.toString('utf-8')).toContain('In deep space, humanity discovered a transmission');

    const pdfResult = await convertFile(Buffer.from(fb2Xml, 'utf-8'), 'fb2', 'pdf', {}, 'odyssey.fb2');
    expect(pdfResult.mimeType).toBe('application/pdf');
    expect(pdfResult.buffer.toString('ascii', 0, 4)).toBe('%PDF');
  });

  it('extracts real text from PDF when converting PDF to DOCX (not raw PDF stream)', async () => {
    // Generate valid PDF with clear text
    const chunks: Buffer[] = [];
    const doc = new PDFDocument();
    doc.on('data', (c) => chunks.push(c));
    const p = new Promise<Buffer>((resolve) => {
      doc.on('end', () => resolve(Buffer.concat(chunks)));
    });
    doc.fontSize(16).text('Important Legal Agreement 2026');
    doc.fontSize(12).text('All parties agree to zero-retention conditions.');
    doc.end();
    const pdfBuffer = await p;

    // Convert PDF to DOCX
    const docxResult = await convertFile(pdfBuffer, 'pdf', 'docx', {}, 'agreement.pdf');
    expect(docxResult.mimeType).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );

    const zip = await JSZip.loadAsync(docxResult.buffer);
    const docXml = await zip.file('word/document.xml')!.async('text');

    // The DOCX must contain the extracted text, not raw PDF header '%PDF-'
    expect(docXml).toContain('Important Legal Agreement');
    expect(docXml).not.toContain('%PDF-1.');
  });

  it('converts RTF to plain text by stripping control words', async () => {
    const rtf = '{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Courier;}}\\viewkind4\\uc1\\pard\\f0\\fs20 Hello from \\b RTF \\b0 document!\\par}';
    const result = await convertFile(Buffer.from(rtf, 'utf-8'), 'rtf', 'txt', {}, 'sample.rtf');
    expect(result.mimeType).toBe('text/plain');
    const text = result.buffer.toString('utf-8');
    expect(text).toContain('Hello from RTF document!');
    expect(text).not.toContain('Courier;');
    expect(text).not.toContain('\\rtf1');
  });

  it('converts ODT to TXT by parsing OpenDocument content.xml', async () => {
    const zip = new JSZip();
    zip.file(
      'content.xml',
      `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">
  <office:body>
    <office:text>
      <text:h text:outline-level="1">OpenDocument Heading</text:h>
      <text:p>First paragraph of ODT document.</text:p>
    </office:text>
  </office:body>
</office:document-content>`
    );
    const odtBuf = await zip.generateAsync({ type: 'nodebuffer' });

    const result = await convertFile(odtBuf, 'odt', 'txt', {}, 'report.odt');
    expect(result.mimeType).toBe('text/plain');
    expect(result.buffer.toString('utf-8')).toContain('OpenDocument Heading');
    expect(result.buffer.toString('utf-8')).toContain('First paragraph of ODT document.');
  });

  it('renders nested tables inside DOCX cells during PDF conversion without dropping content', async () => {
    // 1. Build a synthetic DOCX package with an outer table containing a nested table in a cell
    const zip = new JSZip();
    zip.file(
      '[Content_Types].xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`
    );
    zip.file(
      '_rels/.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
    );
    const docXmlWithNestedTable = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Document with Nested Table</w:t></w:r></w:p>
    <w:tbl>
      <w:tr>
        <w:tc>
          <w:p><w:r><w:t>Outer Column 1</w:t></w:r></w:p>
        </w:tc>
        <w:tc>
          <w:p><w:r><w:t>Outer Column 2 Header</w:t></w:r></w:p>
          <w:tbl>
            <w:tr>
              <w:tc><w:p><w:r><w:t>Nested Cell Alpha</w:t></w:r></w:p></w:tc>
              <w:tc><w:p><w:r><w:t>Nested Cell Beta</w:t></w:r></w:p></w:tc>
            </w:tr>
          </w:tbl>
        </w:tc>
      </w:tr>
    </w:tbl>
  </w:body>
</w:document>`;
    zip.file('word/document.xml', docXmlWithNestedTable);
    const docxBuf = await zip.generateAsync({ type: 'nodebuffer' });

    // 2. Convert DOCX to PDF
    const pdfResult = await convertFile(docxBuf, 'docx', 'pdf', {}, 'nested_table.docx');
    expect(pdfResult.mimeType).toBe('application/pdf');
    expect(pdfResult.buffer.length).toBeGreaterThan(500);

    // Verify PDF header
    const binary = pdfResult.buffer.toString('binary');
    expect(binary.startsWith('%PDF-')).toBe(true);

    // Extract text from PDF using authentic pdfjs-dist oracle
    const loadingTask = pdfjs.getDocument({ data: new Uint8Array(pdfResult.buffer) });
    const pdfDoc = await loadingTask.promise;
    const page = await pdfDoc.getPage(1);
    const textContent = await page.getTextContent();
    const extractedStr = textContent.items
      .map((item: any) => ('str' in item ? item.str : ''))
      .filter(Boolean)
      .join(' ');

    expect(extractedStr).toContain('Outer Column 1');
    expect(extractedStr).toContain('Outer Column 2 Header');
    expect(extractedStr).toContain('Nested Cell Alpha');
    expect(extractedStr).toContain('Nested Cell Beta');

    // Also verify getFullDocxCellText directly
    const testCell = {
      text: 'Parent Cell',
      nestedTable: {
        rows: [
          ['Sub 1', 'Sub 2'],
          ['Sub 3', 'Sub 4'],
        ],
      },
    };
    const fullText = getFullDocxCellText(testCell);
    expect(fullText).toContain('Parent Cell');
    expect(fullText).toContain('Sub 1 | Sub 2');
    expect(fullText).toContain('Sub 3 | Sub 4');
  });

  it('renders multiple nested tables in a cell and gracefully bounds deep recursion', async () => {
    // 1. Synthetic DOCX with two sibling nested tables inside one cell
    const zip = new JSZip();
    zip.file(
      '[Content_Types].xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`
    );
    zip.file(
      '_rels/.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
    );
    const docXmlWithMultiNested = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:tbl>
      <w:tr>
        <w:tc>
          <w:p><w:r><w:t>Parent Container</w:t></w:r></w:p>
          <w:tbl>
            <w:tr>
              <w:tc><w:p><w:r><w:t>SubTable1 Item</w:t></w:r></w:p></w:tc>
            </w:tr>
          </w:tbl>
          <w:tbl>
            <w:tr>
              <w:tc><w:p><w:r><w:t>SubTable2 Item</w:t></w:r></w:p></w:tc>
            </w:tr>
          </w:tbl>
        </w:tc>
      </w:tr>
    </w:tbl>
  </w:body>
</w:document>`;
    zip.file('word/document.xml', docXmlWithMultiNested);
    const docxBuf = await zip.generateAsync({ type: 'nodebuffer' });

    const pdfResult = await convertFile(docxBuf, 'docx', 'pdf', {}, 'multi_nested.docx');
    expect(pdfResult.mimeType).toBe('application/pdf');

    const loadingTask = pdfjs.getDocument({ data: new Uint8Array(pdfResult.buffer) });
    const pdfDoc = await loadingTask.promise;
    const page = await pdfDoc.getPage(1);
    const textContent = await page.getTextContent();
    const extractedStr = textContent.items
      .map((item: any) => ('str' in item ? item.str : ''))
      .filter(Boolean)
      .join(' ');

    expect(extractedStr).toContain('Parent Container');
    expect(extractedStr).toContain('SubTable1 Item');
    expect(extractedStr).toContain('SubTable2 Item');

    // 2. Deep recursive nesting test: 20 levels deep does not throw RangeError: Maximum call stack size exceeded
    let nestedXml = '<w:p><w:r><w:t>Deep Leaf</w:t></w:r></w:p>';
    for (let i = 0; i < 20; i++) {
      nestedXml = `<w:tbl><w:tr><w:tc>${nestedXml}</w:tc></w:tr></w:tbl>`;
    }
    const deepDocXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${nestedXml}</w:body>
</w:document>`;
    zip.file('word/document.xml', deepDocXml);
    const deepBuf = await zip.generateAsync({ type: 'nodebuffer' });
    // Should complete cleanly without stack overflow
    await expect(convertFile(deepBuf, 'docx', 'pdf', {}, 'deep.docx')).resolves.toBeDefined();
  });
});
