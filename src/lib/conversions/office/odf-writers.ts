import { assertSheetsWithinGrid } from '../table-grid';
import JSZip from 'jszip';
import { type OfficeWorksheet } from './types';
import { escapeXml } from './markup-escape';

/**
 * Generates OpenDocument Spreadsheet (ODS) Archive
 */
export async function generateOdsFromData(data: string[][] | OfficeWorksheet[], baseName: string): Promise<Buffer> {
  const sheets: OfficeWorksheet[] = assertSheetsWithinGrid(
    Array.isArray(data) && data.length > 0 && typeof data[0] === 'object' && 'rows' in data[0] ? (data as OfficeWorksheet[]) : [{ name: baseName, rows: (data as string[][]) || [] }]
  );

  const zip = new JSZip();
  zip.file('mimetype', 'application/vnd.oasis.opendocument.spreadsheet', { compression: 'STORE' });
  zip.file(
    'META-INF/manifest.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0">
  <manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/>
  <manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
</manifest:manifest>`
  );

  let tablesXml = '';
  sheets.forEach((sheet) => {
    let rowsXml = '';
    sheet.rows.forEach((row) => {
      rowsXml += '<table:table-row>';
      row.forEach((cell) => {
        rowsXml += `<table:table-cell office:value-type="string"><text:p>${escapeXml(cell)}</text:p></table:table-cell>`;
      });
      rowsXml += '</table:table-row>';
    });
    tablesXml += `
      <table:table table:name="${escapeXml(sheet.name || baseName)}">
        ${rowsXml}
      </table:table>`;
  });

  zip.file(
    'content.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
  office:version="1.2">
  <office:body>
    <office:spreadsheet>
      ${tablesXml}
    </office:spreadsheet>
  </office:body>
</office:document-content>`
  );

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/**
 * Generates OpenDocument Presentation (ODP) Archive
 */
export async function generateOdpFromSlides(
  slides: { number: number; texts: string[] }[],
  title: string
): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/vnd.oasis.opendocument.presentation', { compression: 'STORE' });
  zip.file(
    'META-INF/manifest.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0">
  <manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.presentation"/>
  <manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
</manifest:manifest>`
  );

  let pagesXml = '';
  slides.forEach((s, idx) => {
    pagesXml += `<draw:page draw:name="page${idx + 1}">
      <draw:frame draw:layer="layout" svg:width="25cm" svg:height="15cm" svg:x="1cm" svg:y="1cm">
        <draw:text-box>
          ${s.texts.map((t) => `<text:p>${escapeXml(t)}</text:p>`).join('\n          ')}
        </draw:text-box>
      </draw:frame>
    </draw:page>`;
  });

  zip.file(
    'content.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
  xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"
  office:version="1.2">
  <office:body>
    <office:presentation>
      ${pagesXml}
    </office:presentation>
  </office:body>
</office:document-content>`
  );

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/**
 * Generates OpenDocument Text (ODT) Archive
 */
export async function generateOdtFromText(text: string, title: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/vnd.oasis.opendocument.text', { compression: 'STORE' });
  zip.file(
    'META-INF/manifest.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0">
  <manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/>
  <manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
</manifest:manifest>`
  );

  const paragraphs = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => `<text:p>${escapeXml(l)}</text:p>`)
    .join('\n');

  zip.file(
    'content.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
  office:version="1.2">
  <office:body>
    <office:text>
      <text:h text:outline-level="1">${escapeXml(title)}</text:h>
      ${paragraphs}
    </office:text>
  </office:body>
</office:document-content>`
  );

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
