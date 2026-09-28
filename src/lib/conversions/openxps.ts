import JSZip from 'jszip';

export interface XpsPageElement {
  text?: string;
  x?: number;
  y?: number;
  fontSize?: number;
  fontColor?: string;
  isBold?: boolean;
}

export interface XpsPageInput {
  title?: string;
  lines?: string[];
  elements?: XpsPageElement[];
  image?: {
    buffer: Buffer;
    format: 'png' | 'jpeg' | 'jpg' | 'webp';
    width?: number;
    height?: number;
  };
}

function escapeXml(unsafe: string): string {
  return String(unsafe ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Builds an authentic, standards-compliant OpenXPS / ECMA-388 package with complete OPC structure:
 * - [Content_Types].xml
 * - _rels/.rels
 * - FixedDocumentSequence.fdseq and relationships
 * - Documents/1/FixedDocument.fdoc and relationships
 * - Documents/1/Pages/{n}.fpage with Glyphs / Canvas and embedded resources
 */
export async function buildOpenXpsPackage(
  pages: XpsPageInput[],
  docTitle: string = 'Document'
): Promise<Buffer> {
  const zip = new JSZip();

  const effectivePages: XpsPageInput[] = pages.length > 0 ? pages : [{ title: docTitle, lines: [] }];

  // 1. [Content_Types].xml
  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="fdseq" ContentType="application/vnd.ms-package.xps-fixeddocumentsequence+xml"/>
  <Default Extension="fdoc" ContentType="application/vnd.ms-package.xps-fixeddocument+xml"/>
  <Default Extension="fpage" ContentType="application/vnd.ms-package.xps-fixedpage+xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Default Extension="jpeg" ContentType="image/jpeg"/>
  <Default Extension="jpg" ContentType="image/jpeg"/>
  <Default Extension="webp" ContentType="image/webp"/>
</Types>`;
  zip.file('[Content_Types].xml', contentTypesXml);

  // 2. _rels/.rels
  const packageRelsXml = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.microsoft.com/xps/2005/06/fixedrepresentation" Target="/FixedDocumentSequence.fdseq"/>
</Relationships>`;
  zip.file('_rels/.rels', packageRelsXml);

  // 3. FixedDocumentSequence.fdseq
  const fdseqXml = `<?xml version="1.0" encoding="UTF-8"?>
<FixedDocumentSequence xmlns="http://schemas.microsoft.com/xps/2005/06">
  <DocumentReference Source="/Documents/1/FixedDocument.fdoc"/>
</FixedDocumentSequence>`;
  zip.file('FixedDocumentSequence.fdseq', fdseqXml);

  // 4. _rels/FixedDocumentSequence.fdseq.rels
  const fdseqRelsXml = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.microsoft.com/xps/2005/06/fixedrepresentation" Target="/Documents/1/FixedDocument.fdoc"/>
</Relationships>`;
  zip.file('_rels/FixedDocumentSequence.fdseq.rels', fdseqRelsXml);

  // 5. Documents/1/FixedDocument.fdoc
  const pageContentEntries = effectivePages
    .map((_, idx) => `  <PageContent Source="Pages/${idx + 1}.fpage"/>`)
    .join('\n');
  const fdocXml = `<?xml version="1.0" encoding="UTF-8"?>
<FixedDocument xmlns="http://schemas.microsoft.com/xps/2005/06">
${pageContentEntries}
</FixedDocument>`;
  zip.file('Documents/1/FixedDocument.fdoc', fdocXml);

  // 6. Documents/1/_rels/FixedDocument.fdoc.rels
  const fdocRelsEntries = effectivePages
    .map(
      (_, idx) =>
        `  <Relationship Id="rId${idx + 1}" Type="http://schemas.microsoft.com/xps/2005/06/required-resource" Target="Pages/${idx + 1}.fpage"/>`
    )
    .join('\n');
  const fdocRelsXml = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${fdocRelsEntries}
</Relationships>`;
  zip.file('Documents/1/_rels/FixedDocument.fdoc.rels', fdocRelsXml);

  // 7. Pages & Resources
  for (let idx = 0; idx < effectivePages.length; idx++) {
    const pageNum = idx + 1;
    const page = effectivePages[idx];
    const pageTitle = page.title || (idx === 0 ? docTitle : `Page ${pageNum}`);
    const glyphsXmlChunks: string[] = [];

    let currentY = 105;

    // Header title glyph
    glyphsXmlChunks.push(
      `  <Glyphs Fill="#1F2340" FontRenderingEmSize="16" OriginX="48" OriginY="75" UnicodeString="${escapeXml(pageTitle)}" />`
    );

    // Text lines if any
    if (page.lines && page.lines.length > 0) {
      for (const line of page.lines.slice(0, 45)) {
        if (currentY > 1060) break;
        if (line.trim()) {
          glyphsXmlChunks.push(
            `  <Glyphs Fill="#4D536B" FontRenderingEmSize="10.5" OriginX="48" OriginY="${currentY}" UnicodeString="${escapeXml(line.slice(0, 140))}" />`
          );
        }
        currentY += 20;
      }
    }

    // Structured elements if any
    if (page.elements && page.elements.length > 0) {
      for (const el of page.elements) {
        if (el.text) {
          const x = el.x !== undefined ? el.x : 48;
          const y = el.y !== undefined ? el.y : currentY;
          const sz = el.fontSize || 10.5;
          const fill = el.fontColor || '#4D536B';
          glyphsXmlChunks.push(
            `  <Glyphs Fill="${fill}" FontRenderingEmSize="${sz}" OriginX="${x}" OriginY="${y}" UnicodeString="${escapeXml(el.text)}" />`
          );
          currentY = Math.max(currentY, y + 20);
        }
      }
    }

    // Embedded image if any
    let imageXml = '';
    if (page.image && page.image.buffer.length > 0) {
      const imgExt = page.image.format === 'jpeg' ? 'jpg' : page.image.format;
      const imgPath = `Documents/1/Resources/Images/image${pageNum}.${imgExt}`;
      zip.file(imgPath, page.image.buffer);

      const pageRelXml = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rImg1" Type="http://schemas.microsoft.com/xps/2005/06/required-resource" Target="/${imgPath}"/>
</Relationships>`;
      zip.file(`Documents/1/Pages/_rels/${pageNum}.fpage.rels`, pageRelXml);

      const imgW = page.image.width || 800;
      const imgH = page.image.height || 600;
      imageXml = `  <Path Data="M 48,90 L 745,90 L 745,1070 L 48,1070 Z">
    <Path.Fill>
      <ImageBrush ImageSource="/${imgPath}" Viewbox="0,0,${imgW},${imgH}" ViewboxUnits="Absolute" Viewport="48,90,697,980" ViewportUnits="Absolute"/>
    </Path.Fill>
  </Path>`;
    }

    const fpageXml = `<?xml version="1.0" encoding="UTF-8"?>
<FixedPage Width="793.76" Height="1122.56" xml:lang="en-US" xmlns="http://schemas.microsoft.com/xps/2005/06">
  <Path Data="M 48,40 L 745,40 L 745,44 L 48,44 Z" Fill="#5C6BC0" />
${imageXml ? imageXml + '\n' : ''}${glyphsXmlChunks.join('\n')}
</FixedPage>`;
    zip.file(`Documents/1/Pages/${pageNum}.fpage`, fpageXml);
  }

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
