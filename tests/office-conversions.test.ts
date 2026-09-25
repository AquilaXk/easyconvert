import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import PDFDocument from 'pdfkit';
import { convertFile } from '../src/lib/conversions/index';

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
    expect(zip.file('word/document.xml')).toBeDefined();
    expect(zip.file('[Content_Types].xml')).toBeDefined();

    const docXml = await zip.file('word/document.xml')!.async('text');
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
    expect(zip.file('[Content_Types].xml')).toBeDefined();
    expect(zip.file('ppt/presentation.xml')).toBeDefined();
    expect(zip.file('ppt/slides/slide1.xml')).toBeDefined();

    const slide1Xml = await zip.file('ppt/slides/slide1.xml')!.async('text');
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
    expect(zip.file('xl/workbook.xml')).toBeDefined();
    expect(zip.file('xl/worksheets/sheet1.xml')).toBeDefined();

    const sheetXml = await zip.file('xl/worksheets/sheet1.xml')!.async('text');
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
    expect(zip.file('mimetype')).toBeDefined();
    expect(zip.file('META-INF/container.xml')).toBeDefined();
    expect(zip.file('OEBPS/content.opf')).toBeDefined();
    expect(zip.file('OEBPS/chapter1.xhtml')).toBeDefined();

    const chapterHtml = await zip.file('OEBPS/chapter1.xhtml')!.async('text');
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
});
