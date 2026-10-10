import JSZip from 'jszip';
import { readZipEntryText } from './zip-entry-reader';
import { ConversionOptions, ConversionResult, CorruptStreamError } from '../types';
import { assertWellFormedXml } from './xml-wellformed';
import { HwpDocument, HwpParagraph, HwpTable, buildHwpCompoundFile, legacyHwpModel, parseHwpDocument, convertHwpDocument } from './hwp';

function escapeXml(str?: string | null): string {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Checks whether the given buffer is a KS X 6101 HWPX Open Packaging Convention ZIP container.
 */
export async function isHwpxContainer(buffer: Buffer): Promise<boolean> {
  if (buffer.length < 30) return false;
  // Check ZIP local file header signature 0x04034b50 ('PK\x03\x04')
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b || buffer[2] !== 0x03 || buffer[3] !== 0x04) {
    return false;
  }
  try {
    const zip = await JSZip.loadAsync(buffer);
    const mimeFile = zip.file('mimetype');
    if (mimeFile) {
      const mime = (await readZipEntryText(mimeFile)).trim();
      if (mime === 'application/hwp+zip') return true;
    }
    const hasSection = Object.keys(zip.files).some((name) => /(?:Contents\/)?section\d*\.xml$/i.test(name));
    const hasVersion = Boolean(zip.file('version.xml') || zip.file('Contents/version.xml'));
    const hasHpf = Boolean(zip.file('Contents/content.hpf') || zip.file('content.hpf'));
    const containerFile = zip.file('META-INF/container.xml');
    let hasHwpxContainerXml = false;
    if (containerFile) {
      const cXml = await readZipEntryText(containerFile);
      hasHwpxContainerXml = cXml.includes('content.hpf') || cXml.includes('application/hwp+zip');
    }
    return (hasSection && (hasVersion || hasHpf)) || hasHpf || hasHwpxContainerXml;
  } catch {
    return false;
  }
}

/**
 * Parses an authentic KS X 6101 HWPX container into the standard HWP AST.
 * Handles Contents/section0.xml, Contents/header.xml, version.xml, and content.hpf.
 */
export async function parseHwpxDocument(inputBuffer: Buffer): Promise<HwpDocument> {
  if (!inputBuffer || inputBuffer.length < 30) {
    throw new CorruptStreamError('Invalid HWPX package: File buffer is too small or empty.');
  }

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(inputBuffer);
  } catch (err: any) {
    throw new CorruptStreamError(`Invalid HWPX package: Not a valid ZIP archive (${err?.message || 'load error'}).`);
  }

  // 1. Version Detection
  let version = '1.0.0.0';
  const versionFile = zip.file('version.xml') || zip.file('Contents/version.xml');
  if (versionFile) {
    const versionXml = await readZipEntryText(versionFile);
    const verMatch = versionXml.match(/version="([^"]+)"/i);
    if (verMatch) {
      version = verMatch[1];
    }
  }

  // 2. Metadata Detection (content.hpf or header.xml)
  let title: string | undefined;
  let author: string | undefined;
  let date: string | undefined;

  const hpfFile = zip.file('Contents/content.hpf') || zip.file('content.hpf');
  if (hpfFile) {
    const hpfXml = await readZipEntryText(hpfFile);
    const titleMatch = hpfXml.match(/<(?:dc:|opf:)?title[^>]*>([\s\S]*?)<\/(?:dc:|opf:)?title>/i);
    if (titleMatch) title = titleMatch[1].trim();

    const creatorMatch = hpfXml.match(/<(?:dc:|opf:)?creator[^>]*>([\s\S]*?)<\/(?:dc:|opf:)?creator>/i);
    if (creatorMatch) author = creatorMatch[1].trim();

    const dateMatch = hpfXml.match(/<(?:dc:|opf:)?date[^>]*>([\s\S]*?)<\/(?:dc:|opf:)?date>/i);
    if (dateMatch) date = dateMatch[1].trim();
  }

  // 3. Section / BodyText Extraction
  const sectionFiles = Object.keys(zip.files)
    .filter((name) => /(?:Contents\/)?section\d+\.xml$/i.test(name))
    .sort((a, b) => {
      const numA = parseInt(a.replace(/\D/g, ''), 10) || 0;
      const numB = parseInt(b.replace(/\D/g, ''), 10) || 0;
      return numA - numB;
    });

  if (sectionFiles.length === 0) {
    // Check fallback for any xml containing <hp:p> or <hp:t> or <p>
    for (const name of Object.keys(zip.files)) {
      if (name.endsWith('.xml') && !name.includes('header') && !name.includes('version') && !name.includes('container') && !name.includes('[Content_Types]')) {
        sectionFiles.push(name);
      }
    }
  }

  if (sectionFiles.length === 0) {
    throw new CorruptStreamError('Invalid HWPX package: Missing KS X 6101 Section body XML.');
  }

  const paragraphs: HwpParagraph[] = [];
  const tables: HwpTable[] = [];

  for (const sFile of sectionFiles) {
    const secXml = await readZipEntryText(zip.files[sFile]);
    assertWellFormedXml(sFile, secXml, 'HWPX');

    // Extract tables (<hp:tbl> ... </hp:tbl>)
    const tblRegex = /<(?:hp:)?tbl\b[\s\S]*?<\/(?:hp:)?tbl>/gi;
    let tMatch: RegExpExecArray | null;
    while ((tMatch = tblRegex.exec(secXml)) !== null) {
      const tblXml = tMatch[0];
      const rows: string[][] = [];

      const trRegex = /<(?:hp:)?tr\b[\s\S]*?<\/(?:hp:)?tr>/gi;
      let trMatch: RegExpExecArray | null;
      while ((trMatch = trRegex.exec(tblXml)) !== null) {
        const trXml = trMatch[0];
        const cells: string[] = [];

        const tcRegex = /<(?:hp:)?tc\b[\s\S]*?<\/(?:hp:)?tc>/gi;
        let tcMatch: RegExpExecArray | null;
        while ((tcMatch = tcRegex.exec(trXml)) !== null) {
          const tcXml = tcMatch[0];
          // Extract text runs inside cell
          const tTags = tcXml.match(/<(?:hp:)?t\b[^>]*>([\s\S]*?)<\/(?:hp:)?t>/gi) || [];
          const cellText = tTags
            .map((t) => t.replace(/<[^>]+>/g, '').trim())
            .filter(Boolean)
            .join(' ');
          cells.push(cellText);
        }

        if (cells.length > 0) {
          rows.push(cells);
        }
      }

      if (rows.length > 0) {
        const colCount = Math.max(...rows.map((r) => r.length), 1);
        tables.push({
          rowCount: rows.length,
          colCount,
          rows,
        });
      }
    }

    // Extract document-level paragraphs (<hp:p> ... </hp:p>)
    // Strip table blocks first to avoid capturing nested table cell paragraphs
    const secXmlWithoutTables = secXml.replace(/<(?:hp:)?tbl\b[\s\S]*?<\/(?:hp:)?tbl>/gi, '');
    const pRegex = /<(?:hp:)?p\b([^>]*?)>([\s\S]*?)<\/(?:hp:)?p>/gi;
    let pMatch: RegExpExecArray | null;
    while ((pMatch = pRegex.exec(secXmlWithoutTables)) !== null) {
      const pAttrs = pMatch[1];
      const pBody = pMatch[2];

      // Avoid double-counting table cell paragraphs if they are nested
      // But if there are standalone paragraphs, capture them
      const isHeadingAttr = /styleID="1"|heading="true"/i.test(pAttrs);

      const tTags = pBody.match(/<(?:hp:)?t\b[^>]*>([\s\S]*?)<\/(?:hp:)?t>/gi) || [];
      const text = tTags
        .map((t) => t.replace(/<[^>]+>/g, '').trim())
        .filter(Boolean)
        .join(' ');

      if (text) {
        const isHeading = isHeadingAttr || (paragraphs.length === 0 && text.length < 80);
        const isBold = /bold="true"|<(?:hp:)?bold/i.test(pBody) || isHeading;
        const isItalic = /italic="true"|<(?:hp:)?italic/i.test(pBody);

        paragraphs.push({
          text,
          isHeading,
          isBold,
          isItalic,
        });
      }
    }
  }

  if (!title && paragraphs.length > 0) {
    title = paragraphs[0].text.slice(0, 80);
  }

  return {
    version,
    isCompressed: false,
    isEncrypted: false,
    isDistributed: false,
    paragraphs,
    tables,
    model: legacyHwpModel(paragraphs, tables),
    metadata: {
      title,
      author,
      creator: author,
      date,
    },
  };
}

/**
 * Builds an authentic KS X 6101 HWPX standard container package.
 * Generates valid OPC archive with Contents/section0.xml, header.xml, version.xml, and content.hpf.
 */
export async function buildHwpxContainer(doc: {
  paragraphs: Array<string | { text: string; isHeading?: boolean; isBold?: boolean; isItalic?: boolean }>;
  tables?: Array<{ rows: string[][] } | string[][]>;
  metadata?: { title?: string; author?: string; date?: string };
  title?: string;
  creator?: string;
  version?: string;
}): Promise<Buffer> {
  const zip = new JSZip();

  const paragraphs = (doc.paragraphs || []).map((p) =>
    typeof p === 'string' ? { text: p, isHeading: false } : p
  );
  const tables = (doc.tables || []).map((tbl) =>
    Array.isArray(tbl) ? { rows: tbl } : tbl
  );

  // 1. mimetype (Stored without compression per OPC / KS X 6101)
  zip.file('mimetype', 'application/hwp+zip', { compression: 'STORE' });

  // 2. [Content_Types].xml
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="hpf" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Default Extension="jpeg" ContentType="image/jpeg"/>
  <Default Extension="jpg" ContentType="image/jpeg"/>
</Types>`
  );

  // 3. META-INF/container.xml
  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<ocf:container xmlns:ocf="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
  <ocf:rootfiles>
    <ocf:rootfile full-path="Contents/content.hpf" media-type="application/hwp+zip"/>
  </ocf:rootfiles>
</ocf:container>`
  );

  // 4. version.xml
  const appVersion = doc.version || '1.0.0.0';
  zip.file(
    'version.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<hh:version xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" version="${escapeXml(appVersion)}" targetApplication="WordProcessor" appVersion="11.0.0.0"/>`
  );

  // 5. Contents/content.hpf
  const title = doc.metadata?.title || doc.title || paragraphs[0]?.text || 'Hangul Document';
  const creator = doc.metadata?.author || doc.creator || 'EasyConvert Engine';
  const date = doc.metadata?.date || new Date().toISOString();

  zip.file(
    'Contents/content.hpf',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="hwpx-uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>${escapeXml(title)}</dc:title>
    <dc:creator>${escapeXml(creator)}</dc:creator>
    <dc:date>${escapeXml(date)}</dc:date>
    <dc:language>ko</dc:language>
  </metadata>
  <manifest>
    <item id="header" href="header.xml" media-type="application/xml"/>
    <item id="section0" href="section0.xml" media-type="application/xml"/>
  </manifest>
  <spine>
    <itemref idref="section0"/>
  </spine>
</package>`
  );

  // 6. Contents/header.xml
  zip.file(
    'Contents/header.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<hh:head xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" version="${escapeXml(appVersion)}">
  <hh:beginNum page="1" footnote="1" endnote="1" pic="1" tbl="1" equation="1"/>
  <hh:refList>
    <hh:fontfaces itemCnt="1">
      <hh:fontface lang="hangul" fontCnt="1">
        <hh:font id="0" face="Malgun Gothic" type="ttf"/>
      </hh:fontface>
    </hh:fontfaces>
  </hh:refList>
</hh:head>`
  );

  // 7. Contents/section0.xml (Body with KS X 6101 XML structure)
  let sectionXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<hp:sec xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" xmlns:hp10="http://www.hancom.co.kr/hwpml/2016/paragraph">
`;

  // Write paragraphs
  paragraphs.forEach((p, idx) => {
    const styleID = p.isHeading ? 1 : 0;
    sectionXml += `  <hp:p id="${idx}" styleID="${styleID}">
    <hp:run>
      <hp:t>${escapeXml(p.text)}</hp:t>
    </hp:run>
  </hp:p>
`;
  });

  // Write tables if present
  if (tables && tables.length > 0) {
    tables.forEach((tbl, tIdx) => {
      const rowCount = tbl.rows.length;
      const colCount = tbl.rows[0]?.length || 1;
      sectionXml += `  <hp:p id="tbl_p_${tIdx}">
    <hp:run>
      <hp:tbl id="tbl_${tIdx}" rowCnt="${rowCount}" colCnt="${colCount}">
`;
      tbl.rows.forEach((row, rIdx) => {
        sectionXml += `        <hp:tr id="tr_${tIdx}_${rIdx}">
`;
        row.forEach((cell, cIdx) => {
          sectionXml += `          <hp:tc id="tc_${tIdx}_${rIdx}_${cIdx}">
            <hp:subList>
              <hp:p>
                <hp:run>
                  <hp:t>${escapeXml(cell)}</hp:t>
                </hp:run>
              </hp:p>
            </hp:subList>
          </hp:tc>
`;
        });
        sectionXml += `        </hp:tr>
`;
      });
      sectionXml += `      </hp:tbl>
    </hp:run>
  </hp:p>
`;
    });
  }

  sectionXml += `</hp:sec>`;

  zip.file('Contents/section0.xml', sectionXml);

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/**
 * Bidirectional conversion: HWPX to HWP 5.0 CFBF binary.
 */
export async function hwpxToHwp(hwpxBuffer: Buffer): Promise<Buffer> {
  const doc = await parseHwpxDocument(hwpxBuffer);
  return buildHwpCompoundFile({
    paragraphs: doc.paragraphs,
    tables: doc.tables,
  });
}

/**
 * Bidirectional conversion: HWP 5.0 CFBF binary to HWPX standard container.
 */
export async function hwpToHwpx(hwpBuffer: Buffer): Promise<Buffer> {
  const doc = parseHwpDocument(hwpBuffer);
  return buildHwpxContainer(doc);
}

/**
 * Converts HWPX document to clean Markdown text.
 */
export async function hwpxToMarkdown(hwpxBuffer: Buffer): Promise<string> {
  const doc = await parseHwpxDocument(hwpxBuffer);
  let md = '';
  if (doc.metadata?.title) {
    md += `# ${doc.metadata.title}\n\n`;
  }
  doc.paragraphs.forEach((p) => {
    if (p.isHeading) {
      md += `## ${p.text}\n\n`;
    } else {
      md += `${p.text}\n\n`;
    }
  });
  doc.tables.forEach((t) => {
    if (t.rows.length > 0) {
      md += '| ' + t.rows[0].join(' | ') + ' |\n';
      md += '| ' + t.rows[0].map(() => '---').join(' | ') + ' |\n';
      t.rows.slice(1).forEach((r) => {
        md += '| ' + r.join(' | ') + ' |\n';
      });
      md += '\n';
    }
  });
  return md.trim();
}

/**
 * Converts Markdown text to HWPX standard container.
 */
export async function markdownToHwpx(mdText: string, title?: string): Promise<Buffer> {
  const lines = mdText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const paragraphs: Array<{ text: string; isHeading?: boolean }> = [];
  const tables: Array<{ rows: string[][] }> = [];
  let currentTableRows: string[][] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      if (trimmed.includes('---')) continue; // Header separator
      const cells = trimmed
        .slice(1, -1)
        .split('|')
        .map((c) => c.trim());
      currentTableRows.push(cells);
    } else {
      if (currentTableRows.length > 0) {
        tables.push({ rows: currentTableRows });
        currentTableRows = [];
      }
      const isHeading = trimmed.startsWith('#');
      const cleanText = trimmed.replace(/^#+\s*/, '');
      if (cleanText) {
        paragraphs.push({ text: cleanText, isHeading });
      }
    }
  }

  if (currentTableRows.length > 0) {
    tables.push({ rows: currentTableRows });
  }

  return buildHwpxContainer({
    paragraphs: paragraphs.length > 0 ? paragraphs : [{ text: 'Hangul Document', isHeading: true }],
    tables,
    metadata: { title },
  });
}

/**
 * Converts HWPX document to plain text.
 */
export async function hwpxToPlainText(hwpxBuffer: Buffer): Promise<string> {
  const doc = await parseHwpxDocument(hwpxBuffer);
  const parts: string[] = doc.paragraphs.map((p) => p.text);
  doc.tables.forEach((t) => {
    parts.push(t.rows.map((r) => r.join('\t')).join('\n'));
  });
  return parts.join('\n\n');
}

/**
 * Universal HWPX Converter: converts HWPX to PDF, DOCX, ODT, HTML, TXT, MD, RTF, HWP, or raster images.
 */
export async function convertHwpx(
  inputBuffer: Buffer,
  targetFormat: string,
  options: ConversionOptions = {},
  baseName: string = 'document'
): Promise<ConversionResult> {
  const tgt = targetFormat.toLowerCase();

  // Target: HWPX (identity echo)
  if (tgt === 'hwpx') {
    return {
      buffer: inputBuffer,
      mimeType: 'application/hwp+zip',
      filename: `${baseName}.hwpx`,
      size: inputBuffer.length,
    };
  }

  // Target: HWP 5.0 CFBF binary
  if (tgt === 'hwp') {
    const hwpBuf = await hwpxToHwp(inputBuffer);
    return {
      buffer: hwpBuf,
      mimeType: 'application/x-hwp',
      filename: `${baseName}.hwp`,
      size: hwpBuf.length,
    };
  }

  // Target: Markdown
  if (tgt === 'md' || tgt === 'markdown') {
    const md = await hwpxToMarkdown(inputBuffer);
    const buffer = Buffer.from(md, 'utf-8');
    return {
      buffer,
      mimeType: 'text/markdown',
      filename: `${baseName}.md`,
      size: buffer.length,
    };
  }

  // Parse HWPX into shared HwpDocument AST and delegate to convertHwpDocument
  const doc = await parseHwpxDocument(inputBuffer);
  return convertHwpDocument(doc, tgt, options, baseName);
}
