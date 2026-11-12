import { buildHwpCompoundFile } from '../hwp';
import { ConversionFailedError, ConversionOptions } from '../../types';
import JSZip from 'jszip';
import { type DocumentModel } from '../document-model/model';
import { markdownToDocumentModel } from '../source-model';
import { htmlToDocumentModel } from '../html-model';
import { plainTextModel } from '../document-model/plain';
import { documentToEpub } from '../document-model/epub';
import { documentToDocx } from '../document-model/docx';
import { escapeXmlQuoted } from '../../text/escape';

/**
 * Generates authentic HWP 5.0 CFBF compound document from text and markdown tables
 */
export function generateHwpFromText(text: string, title: string): Buffer {
  const lines = text.split(/\r?\n/);
  const paragraphs: { text: string; isHeading?: boolean }[] = [];
  const tables: { rows: string[][] }[] = [];
  let currentTableRows: string[][] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) {
      if (currentTableRows.length > 0) {
        tables.push({ rows: currentTableRows });
        currentTableRows = [];
      }
      continue;
    }

    // Markdown table row
    if (line.startsWith('|') && line.endsWith('|')) {
      const cells = line.split('|').map((c) => c.trim()).slice(1, -1);
      if (cells.every((c) => /^[-:]+$/.test(c))) {
        continue;
      }
      currentTableRows.push(cells);
      continue;
    }

    if (currentTableRows.length > 0) {
      tables.push({ rows: currentTableRows });
      currentTableRows = [];
    }

    // Heading detection
    if (line.startsWith('#')) {
      const headingText = line.replace(/^#+\s*/, '').trim();
      if (headingText) {
        paragraphs.push({ text: headingText, isHeading: true });
      }
    } else {
      paragraphs.push({ text: line, isHeading: paragraphs.length === 0 && line.length < 60 });
    }
  }

  if (currentTableRows.length > 0) {
    tables.push({ rows: currentTableRows });
  }

  if (paragraphs.length === 0) {
    paragraphs.push({ text: title || 'Document', isHeading: true });
  }

  return buildHwpCompoundFile({ paragraphs, tables, compressed: true });
}

/**
 * Generates OpenXML DOCX Zip Archive with Table and Heading preservation
 */
export async function generateDocxFromText(
  text: string,
  sourceType: string,
  options: ConversionOptions,
  title: string
): Promise<Buffer> {
  const zip = new JSZip();

  // [Content_Types].xml
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`
  );

  // _rels/.rels
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
  );

  // Parse lines, markdown headings, and markdown tables
  const lines = text.split(/\r?\n/);
  const elementsXml: string[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i++;
      continue;
    }

    // Check if this line starts a markdown table (| ... |)
    if (trimmed.startsWith('|') && trimmed.endsWith('|') && i + 1 < lines.length && lines[i + 1].trim().startsWith('|')) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('|') && lines[i].trim().endsWith('|')) {
        tableLines.push(lines[i].trim());
        i++;
      }

      if (tableLines.length >= 2) {
        const headerCells = tableLines[0].split('|').slice(1, -1).map((c) => c.trim());
        const dataRows = tableLines.slice(2).map((l) => l.split('|').slice(1, -1).map((c) => c.trim()));

        let tblXml = `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="CCD2FC"/><w:bottom w:val="single" w:sz="4" w:color="CCD2FC"/><w:left w:val="single" w:sz="4" w:color="CCD2FC"/><w:right w:val="single" w:sz="4" w:color="CCD2FC"/><w:insideH w:val="single" w:sz="4" w:color="E1E4EE"/><w:insideV w:val="single" w:sz="4" w:color="E1E4EE"/></w:tblBorders></w:tblPr>`;
        tblXml += `<w:tblGrid>${headerCells.map(() => '<w:gridCol/>').join('')}</w:tblGrid>`;

        // Header Row
        tblXml += `<w:tr>`;
        headerCells.forEach((cell) => {
          tblXml += `<w:tc><w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="F0F2FE"/></w:tcPr><w:p><w:r><w:rPr><w:b/><w:color w:val="1F2340"/></w:rPr><w:t>${escapeXmlQuoted(
            cell
          )}</w:t></w:r></w:p></w:tc>`;
        });
        tblXml += `</w:tr>`;

        // Data Rows
        dataRows.forEach((row) => {
          tblXml += `<w:tr>`;
          row.forEach((cell) => {
            tblXml += `<w:tc><w:p><w:r><w:rPr><w:color w:val="4D536B"/></w:rPr><w:t>${escapeXmlQuoted(
              cell
            )}</w:t></w:r></w:p></w:tc>`;
          });
          tblXml += `</w:tr>`;
        });

        tblXml += `</w:tbl>`;
        elementsXml.push(tblXml);
        continue;
      }
    }

    // Heading 1 (# ...)
    if (trimmed.startsWith('# ')) {
      elementsXml.push(
        `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="32"/><w:color w:val="5C6BC0"/></w:rPr><w:t>${escapeXmlQuoted(
          trimmed.substring(2)
        )}</w:t></w:r></w:p>`
      );
    } else if (trimmed.startsWith('## ')) {
      elementsXml.push(
        `<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="26"/><w:color w:val="5C6BC0"/></w:rPr><w:t>${escapeXmlQuoted(
          trimmed.substring(3)
        )}</w:t></w:r></w:p>`
      );
    } else {
      // Regular paragraph with bold / italic tags
      const hasBold = trimmed.includes('**');
      const hasItalic = trimmed.includes('*') && !hasBold;
      const clean = trimmed.replace(/\*\*/g, '').replace(/\*/g, '');
      elementsXml.push(
        `<w:p><w:r><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/>${
          hasBold ? '<w:b/>' : ''
        }${hasItalic ? '<w:i/>' : ''}<w:color w:val="1F2340"/></w:rPr><w:t>${escapeXmlQuoted(
          clean
        )}</w:t></w:r></w:p>`
      );
    }

    i++;
  }

  // word/document.xml
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
      <w:r><w:rPr><w:b/><w:sz w:val="36"/><w:color w:val="5C6BC0"/></w:rPr><w:t>${escapeXmlQuoted(
        title
      )}</w:t></w:r>
    </w:p>
    ${elementsXml.join('\n')}
    <w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>
  </w:body>
</w:document>`
  );

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/**
 * Generates OpenXML PPTX Presentation Archive
 */
export async function generatePptxFromText(
  text: string,
  sourceType: string,
  options: ConversionOptions,
  title: string
): Promise<Buffer> {
  if (text.trim() === '') throw new ConversionFailedError('There is no text to put on slides.');
  const zip = new JSZip();

  // Split text into slides based on markdown headings, dividers, or paragraph groups
  const slideTexts: { title: string; bullets: string[] }[] = [];
  const rawSections = text.split(/(?:^|\n)(?:---|# Slide \d+|## Slide \d+)/i).filter((s) => s.trim().length > 0);

  if (rawSections.length > 1) {
    rawSections.forEach((sec, idx) => {
      const lines = sec.split(/\r?\n/).filter((l) => l.trim().length > 0);
      const slideTitle = lines[0]?.replace(/^[#\s]+/, '').trim() || `Slide ${idx + 1}`;
      const bullets = lines.slice(1).map((l) => l.replace(/^[-*•\s]+/, '').trim());
      slideTexts.push({ title: slideTitle, bullets });
    });
  } else {
    // Single section: split by lines into logical slides of 4-5 bullet points
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const mainTitle = lines[0]?.replace(/^[#\s]+/, '').trim() || title;
    const bodyLines = lines.slice(1).map((l) => l.replace(/^[-*•\s]+/, '').trim());

    slideTexts.push({
      title: mainTitle,
      bullets: bodyLines.slice(0, 5),
    });

    for (let j = 5; j < bodyLines.length; j += 5) {
      slideTexts.push({
        title: `${mainTitle} (Cont.)`,
        bullets: bodyLines.slice(j, j + 5),
      });
    }
  }


  // [Content_Types].xml
  let contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
`;

  slideTexts.forEach((_, idx) => {
    contentTypesXml += `  <Override PartName="/ppt/slides/slide${idx + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>\n`;
  });
  contentTypesXml += `</Types>`;
  zip.file('[Content_Types].xml', contentTypesXml);

  // _rels/.rels
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`
  );

  // ppt/_rels/presentation.xml.rels
  let presRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
`;
  slideTexts.forEach((_, idx) => {
    presRelsXml += `  <Relationship Id="rId${idx + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${idx + 1}.xml"/>\n`;
  });
  presRelsXml += `</Relationships>`;
  zip.file('ppt/_rels/presentation.xml.rels', presRelsXml);

  // ppt/presentation.xml
  let presXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldIdLst>
`;
  slideTexts.forEach((_, idx) => {
    presXml += `    <p:sldId id="${256 + idx}" r:id="rId${idx + 1}"/>\n`;
  });
  presXml += `  </p:sldIdLst>
  <p:sldSz cx="9144000" cy="5143500"/>
</p:presentation>`;
  zip.file('ppt/presentation.xml', presXml);

  // Individual slides
  slideTexts.forEach((slide, idx) => {
    let bulletsXml = '';
    slide.bullets.forEach((b) => {
      bulletsXml += `
        <a:p>
          <a:pPr lvl="0"/>
          <a:r>
            <a:rPr lang="en-US" sz="1800">
              <a:solidFill><a:srgbClr val="4D536B"/></a:solidFill>
            </a:rPr>
            <a:t>${escapeXmlQuoted(b)}</a:t>
          </a:r>
        </a:p>`;
    });

    const slideXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr>
        <p:cNvPr id="1" name=""/>
        <p:cNvGrpSpPr/>
        <p:nvPr/>
      </p:nvGrpSpPr>
      <p:grpSpPr/>
      <!-- Slide Title Shape -->
      <p:sp>
        <p:nvSpPr>
          <p:cNvPr id="2" name="Title 1"/>
          <p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>
          <p:nvPr><p:ph type="title"/></p:nvPr>
        </p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="685800" y="609600"/><a:ext cx="7772400" cy="1143000"/></a:xfrm>
        </p:spPr>
        <p:txBody>
          <a:bodyPr/>
          <a:lstStyle/>
          <a:p>
            <a:r>
              <a:rPr lang="en-US" sz="3200" b="1">
                <a:solidFill><a:srgbClr val="5C6BC0"/></a:solidFill>
              </a:rPr>
              <a:t>${escapeXmlQuoted(slide.title)}</a:t>
            </a:r>
          </a:p>
        </p:txBody>
      </p:sp>
      <!-- Content Bullets Shape -->
      <p:sp>
        <p:nvSpPr>
          <p:cNvPr id="3" name="Content 2"/>
          <p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>
          <p:nvPr><p:ph idx="1"/></p:nvPr>
        </p:nvSpPr>
        <p:spPr>
          <a:xfrm><a:off x="685800" y="1981200"/><a:ext cx="7772400" cy="2800000"/></a:xfrm>
        </p:spPr>
        <p:txBody>
          <a:bodyPr/>
          <a:lstStyle/>
          ${bulletsXml}
        </p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:sld>`;

    zip.file(`ppt/slides/slide${idx + 1}.xml`, slideXml);
  });

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** Sources whose extracted text is Markdown (headings, lists, tables), read as such when writing an EPUB or DOCX. */
const MARKDOWN_TEXT_SOURCES: ReadonlySet<string> = new Set(['md', 'markdown', 'pdf', 'fb2']);

/** The document model of text extracted from a source: Markdown or HTML where the source produces it, else plain paragraphs. */
export async function modelFromExtractedText(text: string, sourceType: string): Promise<DocumentModel> {
  if (MARKDOWN_TEXT_SOURCES.has(sourceType)) return markdownToDocumentModel(text);
  if (sourceType === 'html' || sourceType === 'htm') return htmlToDocumentModel(text);
  return plainTextModel(text, { lines: 'keep' });
}

/** Writes an EPUB from text extracted from a source, through the block model. */
export async function generateEpubFromText(
  text: string,
  sourceType: string,
  options: ConversionOptions,
  title: string
): Promise<Buffer> {
  return documentToEpub(await modelFromExtractedText(text, sourceType), { title, language: options.language });
}

/** Writes a DOCX from text extracted from a source, through the block model (real styles, numbering and tables). */
export async function generateDocxFromExtractedText(
  text: string,
  sourceType: string,
  options: ConversionOptions,
  title: string
): Promise<Buffer> {
  return documentToDocx(await modelFromExtractedText(text, sourceType), { title, language: options.language });
}

/**
 * Generates valid, semantic FictionBook 2.0 (FB2) electronic book XML
 */
export function generateFb2FromText(
  text: string,
  title: string,
  options: ConversionOptions = {}
): Buffer {
  const lines = text.split(/\r?\n/);
  const sections: { title?: string; paragraphs: string[]; table?: string[][] }[] = [];
  let currentSection: { title?: string; paragraphs: string[]; table?: string[][] } = {
    paragraphs: [],
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i++;
      continue;
    }

    // Markdown Table check
    if (trimmed.startsWith('|') && trimmed.endsWith('|') && i + 1 < lines.length && lines[i + 1].trim().startsWith('|')) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('|') && lines[i].trim().endsWith('|')) {
        tableLines.push(lines[i].trim());
        i++;
      }
      if (tableLines.length >= 2) {
        const rows = tableLines
          .filter((_, idx) => idx !== 1)
          .map((l) => l.split('|').slice(1, -1).map((c) => c.trim()));
        currentSection.table = rows;
        continue;
      }
    }

    // Heading check
    if (trimmed.startsWith('# ') || trimmed.startsWith('## ') || trimmed.startsWith('### ')) {
      const hText = trimmed.replace(/^#+\s*/, '');
      if (currentSection.paragraphs.length > 0 || currentSection.title || currentSection.table) {
        sections.push(currentSection);
      }
      currentSection = { title: hText, paragraphs: [] };
      i++;
      continue;
    }

    currentSection.paragraphs.push(trimmed);
    i++;
  }

  if (currentSection.paragraphs.length > 0 || currentSection.title || currentSection.table) {
    sections.push(currentSection);
  }

  if (sections.length === 0) throw new ConversionFailedError('There is no text to write as an FB2 book.');

  let bodyXml = `    <title><p>${escapeXmlQuoted(title)}</p></title>\n`;
  for (const sec of sections) {
    bodyXml += `    <section>\n`;
    if (sec.title) {
      bodyXml += `      <title><p>${escapeXmlQuoted(sec.title)}</p></title>\n`;
    }
    for (const p of sec.paragraphs) {
      bodyXml += `      <p>${escapeXmlQuoted(p)}</p>\n`;
    }
    if (sec.table && sec.table.length > 0) {
      bodyXml += `      <table>\n`;
      sec.table.forEach((row, rIdx) => {
        bodyXml += `        <tr>\n`;
        const tag = rIdx === 0 ? 'th' : 'td';
        row.forEach((cell) => {
          bodyXml += `          <${tag}>${escapeXmlQuoted(cell)}</${tag}>\n`;
        });
        bodyXml += `        </tr>\n`;
      });
      bodyXml += `      </table>\n`;
    }
    bodyXml += `    </section>\n`;
  }

  const dateStr = new Date().toISOString().split('T')[0];
  const fb2 = `<?xml version="1.0" encoding="utf-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
  <description>
    <title-info>
      <genre>prose</genre>
      <author>
        <first-name>EasyConvert</first-name>
        <last-name>Author</last-name>
      </author>
      <book-title>${escapeXmlQuoted(title)}</book-title>
      <date>${dateStr}</date>
      <lang>en</lang>
    </title-info>
  </description>
  <body>
${bodyXml}  </body>
</FictionBook>`;

  return Buffer.from(fb2, 'utf-8');
}
