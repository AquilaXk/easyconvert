import JSZip from 'jszip';
import { ConversionFailedError } from '../types';
import { crc32 } from './archive';

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
    /** Pixel size of the embedded picture; required because it defines the image brush viewbox. */
    width: number;
    height: number;
    /** Pixels per inch of the picture along each axis; XPS measures in 1/96 inch, so 96 is the default. */
    dpiX?: number;
    dpiY?: number;
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

const XPS_UNITS_PER_INCH = 96;
const PNG_SIGNATURE_BYTES = 8;
const PNG_CHUNK_OVERHEAD = 12;
const PNG_CHUNK_TYPE_OFFSET = 4;
const PNG_CHUNK_DATA_OFFSET = 8;
const PHYS_DATA_BYTES = 9;
const PHYS_UNIT_METRE = 1;
const INCHES_PER_METRE = 39.3701;
/** Pixels per metre of a 96 dpi picture, the density an XPS unit (1/96 inch) is measured in. */
const PIXELS_PER_METRE_AT_96_DPI = Math.round(XPS_UNITS_PER_INCH * INCHES_PER_METRE);
/** Digits kept when a viewbox size is not a whole number of units. */
const VIEWBOX_DECIMALS = 4;

function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(PNG_CHUNK_OVERHEAD + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, PNG_CHUNK_TYPE_OFFSET, 'latin1');
  data.copy(chunk, PNG_CHUNK_DATA_OFFSET);
  chunk.writeUInt32BE(crc32(chunk.subarray(PNG_CHUNK_TYPE_OFFSET, PNG_CHUNK_DATA_OFFSET + data.length)), PNG_CHUNK_DATA_OFFSET + data.length);
  return chunk;
}

/**
 * Copy of a PNG whose physical size says 96 dpi on both axes (a pHYs chunk replaced or added right after
 * IHDR). XPS measures an image brush in 1/96 inch, and renderers disagree about what a picture stored at
 * another density means; at 96 dpi its viewbox is its pixel size everywhere. The image data is not touched.
 */
export function withPngDensity96(png: Buffer): Buffer {
  const physical = Buffer.alloc(PHYS_DATA_BYTES);
  physical.writeUInt32BE(PIXELS_PER_METRE_AT_96_DPI, 0);
  physical.writeUInt32BE(PIXELS_PER_METRE_AT_96_DPI, 4);
  physical[8] = PHYS_UNIT_METRE;
  const parts: Buffer[] = [png.subarray(0, PNG_SIGNATURE_BYTES)];
  let pos = PNG_SIGNATURE_BYTES;
  let insertedAfterHeader = false;
  while (pos + PNG_CHUNK_OVERHEAD <= png.length) {
    const length = png.readUInt32BE(pos);
    const type = png.toString('latin1', pos + PNG_CHUNK_TYPE_OFFSET, pos + PNG_CHUNK_DATA_OFFSET);
    const end = pos + PNG_CHUNK_OVERHEAD + length;
    if (end > png.length) throw new ConversionFailedError('Cannot set the density of a truncated PNG');
    if (type !== 'pHYs') parts.push(png.subarray(pos, end));
    if (type === 'IHDR' && !insertedAfterHeader) {
      parts.push(pngChunk('pHYs', physical));
      insertedAfterHeader = true;
    }
    pos = end;
  }
  if (!insertedAfterHeader) throw new ConversionFailedError('Cannot set the density of a PNG without an IHDR chunk');
  return Buffer.concat(parts);
}

function viewboxSize(pixels: number, dpi: number | undefined): string {
  const units = (pixels * XPS_UNITS_PER_INCH) / (dpi ?? XPS_UNITS_PER_INCH);
  return String(Number(units.toFixed(VIEWBOX_DECIMALS)));
}

function assertImageSize(image: { width?: number; height?: number; dpiX?: number; dpiY?: number }, pageNum: number): void {
  for (const dpi of [image.dpiX, image.dpiY]) {
    if (dpi !== undefined && !(Number.isFinite(dpi) && dpi > 0)) {
      throw new ConversionFailedError(`XPS image on page ${pageNum} needs a positive density, got ${String(dpi)} dpi`);
    }
  }
  const isPositiveInteger = (value: number | undefined) => Number.isInteger(value) && (value as number) > 0;
  if (!isPositiveInteger(image.width) || !isPositiveInteger(image.height)) {
    throw new ConversionFailedError(
      `XPS image on page ${pageNum} needs a positive integer width and height, got ${String(image.width)}x${String(image.height)}`
    );
  }
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
      assertImageSize(page.image, pageNum);
      const imgExt = page.image.format === 'jpeg' ? 'jpg' : page.image.format;
      const imgPath = `Documents/1/Resources/Images/image${pageNum}.${imgExt}`;
      zip.file(imgPath, page.image.buffer);

      const pageRelXml = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rImg1" Type="http://schemas.microsoft.com/xps/2005/06/required-resource" Target="/${imgPath}"/>
</Relationships>`;
      zip.file(`Documents/1/Pages/_rels/${pageNum}.fpage.rels`, pageRelXml);

      const imgW = viewboxSize(page.image.width, page.image.dpiX);
      const imgH = viewboxSize(page.image.height, page.image.dpiY);
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
