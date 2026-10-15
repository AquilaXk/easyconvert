import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { ConversionFailedError, PayloadLimitError } from '../types';
import { crc32 } from './archive';
import { loadFontCoverageIndex, toDrawableText, type PdfFontFace } from './pdf-fonts';
import { TextMeter } from './text-wrap';
import {
  XPS_FONT_SIZE,
  XPS_MAX_PAGES,
  XPS_PAGE_HEIGHT,
  XPS_PAGE_WIDTH,
  layoutXpsParagraphs,
  type XpsTextLine,
  type XpsTextRun,
} from './xps-text-layout';

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
/** Chunks dropped from the picture: the old density, and EXIF whose own resolution would contradict the new one. */
const REPLACED_PNG_CHUNKS: ReadonlySet<string> = new Set(['pHYs', 'eXIf']);
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
 * another density means; at 96 dpi its viewbox is its pixel size everywhere. An eXIf chunk is dropped, since the
 * resolution it carries would contradict the new one. The image data is not touched.
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
    if (!REPLACED_PNG_CHUNKS.has(type)) parts.push(png.subarray(pos, end));
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

const OBFUSCATED_FONT_BYTES = 32;
const GUID_BYTES = 16;
const FONT_CONTENT_TYPE = 'application/vnd.ms-package.obfuscated-opentype';
const REQUIRED_RESOURCE_RELATIONSHIP = 'http://schemas.microsoft.com/xps/2005/06/required-resource';
const PICTURE_LEFT = 48;
const PICTURE_TOP = 90;
const PICTURE_WIDTH = 697;
const PICTURE_HEIGHT = 980;
const DEFAULT_TEXT_COLOR = '#1F2340';
const DEFAULT_ELEMENT_COLOR = '#4D536B';
const DEFAULT_ELEMENT_SIZE = 10.5;
const DEFAULT_ELEMENT_LEFT = 48;
const ELEMENT_LINE_ADVANCE = 20;
const ELEMENT_FIRST_BASELINE = 105;

/** Hex digits in a GUID (128 bits). */
const GUID_HEX_DIGITS = 32;

/** The GUID that names a font part: derived from the font bytes, so equal fonts share one part. */
function fontGuid(face: PdfFontFace): string {
  // Only the first 128 bits of the digest are used: the GUID is an identifier, not a security control.
  const hex = createHash('sha256').update(face.data).digest('hex').slice(0, GUID_HEX_DIGITS).toUpperCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** ECMA-388 font obfuscation: the first 32 bytes are XORed with the GUID digits of the part name, read from the end. */
export function obfuscateFont(font: Buffer, guid: string): Buffer {
  const key = Buffer.from(guid.replace(/-/g, ''), 'hex').reverse();
  if (key.length !== GUID_BYTES) throw new ConversionFailedError(`Invalid font GUID ${guid}`);
  const out = Buffer.from(font);
  for (let i = 0; i < Math.min(OBFUSCATED_FONT_BYTES, out.length); i++) out[i] ^= key[i % GUID_BYTES];
  return out;
}

interface OutputPage {
  lines: XpsTextLine[];
  elements: XpsPageElement[];
  image?: NonNullable<XpsPageInput['image']>;
}

/** One Glyphs element per font run; the font part is registered for the page and the package. */
class GlyphWriter {
  readonly fonts = new Map<string, { face: PdfFontFace; part: string }>();
  /** Each face is hashed once: its bytes are megabytes, and every text run asks for its URI. */
  private readonly guids = new Map<PdfFontFace, string>();

  constructor(private readonly zip: JSZip) {}

  fontUri(face: PdfFontFace): string {
    let guid = this.guids.get(face);
    if (guid === undefined) {
      guid = fontGuid(face);
      this.guids.set(face, guid);
    }
    const part = `Resources/Fonts/${guid}.odttf`;
    if (!this.fonts.has(part)) {
      this.fonts.set(part, { face, part });
      this.zip.file(part, obfuscateFont(face.data, guid), { compression: 'STORE' }); // megabytes of font data compress only slightly (15.5 to 19.5 MB for CJK) and cost seconds to deflate
    }
    // A font collection is addressed by the index of the face inside it.
    return `/${part}${face.collectionFace ? `#${face.faceIndex}` : ''}`;
  }

  glyphs(runs: readonly XpsTextRun[], y: number, size: number, fill: string, used: Set<string>): string[] {
    return runs.map((run) => {
      const uri = this.fontUri(run.face);
      used.add(uri.split('#')[0].slice(1));
      return `  <Glyphs Fill="${fill}" FontUri="${uri}" FontRenderingEmSize="${size}" StyleSimulations="None" OriginX="${Number(run.x.toFixed(2))}" OriginY="${Number(y.toFixed(2))}" UnicodeString="${escapeXml(run.text)}" />`;
    });
  }
}

/**
 * Builds an OpenXPS / ECMA-388 package with complete OPC structure:
 * - [Content_Types].xml and _rels/.rels, with the document title in docProps/core.xml
 * - FixedDocumentSequence.fdseq and Documents/1/FixedDocument.fdoc
 * - Documents/1/Pages/{n}.fpage with Glyphs that name an embedded (obfuscated) font, and image resources
 *
 * Text lines wrap at the page margins by the advance widths of the fonts that draw them and continue on as many
 * pages as they need; nothing is drawn that is not content (the title is metadata only). An image needs its
 * pixel size, and a package without any content is refused.
 */
export async function buildOpenXpsPackage(
  pages: XpsPageInput[],
  docTitle: string = 'Document'
): Promise<Buffer> {
  const zip = new JSZip();
  await loadFontCoverageIndex();
  const outputPages: OutputPage[] = [];
  for (const page of pages) {
    if (page.image && page.image.buffer.length > 0) {
      outputPages.push({ lines: [], elements: [], image: page.image });
    }
    if (page.lines && page.lines.length > 0) {
      for (const lines of await layoutXpsParagraphs(page.lines)) {
        if (lines.length > 0) outputPages.push({ lines, elements: [] });
      }
    }
    if (page.elements && page.elements.some((el) => el.text)) {
      outputPages.push({ lines: [], elements: page.elements.filter((el) => el.text) });
    }
  }
  if (outputPages.length === 0) {
    throw new ConversionFailedError('The XPS package has no content to draw.');
  }
  if (outputPages.length > XPS_MAX_PAGES) {
    throw new PayloadLimitError(`The XPS package needs ${outputPages.length} pages, more than the limit of ${XPS_MAX_PAGES}.`);
  }

  // 1. [Content_Types].xml
  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="fdseq" ContentType="application/vnd.ms-package.xps-fixeddocumentsequence+xml"/>
  <Default Extension="fdoc" ContentType="application/vnd.ms-package.xps-fixeddocument+xml"/>
  <Default Extension="fpage" ContentType="application/vnd.ms-package.xps-fixedpage+xml"/>
  <Default Extension="odttf" ContentType="${FONT_CONTENT_TYPE}"/>
  <Default Extension="png" ContentType="image/png"/>
  <Default Extension="jpeg" ContentType="image/jpeg"/>
  <Default Extension="jpg" ContentType="image/jpeg"/>
  <Default Extension="webp" ContentType="image/webp"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`;
  zip.file('[Content_Types].xml', contentTypesXml);

  // 2. _rels/.rels and the core properties that carry the title
  const packageRelsXml = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.microsoft.com/xps/2005/06/fixedrepresentation" Target="/FixedDocumentSequence.fdseq"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="/docProps/core.xml"/>
</Relationships>`;
  zip.file('_rels/.rels', packageRelsXml);
  zip.file(
    'docProps/core.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${escapeXml(docTitle)}</dc:title></cp:coreProperties>`
  );

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
  const pageContentEntries = outputPages
    .map((_, idx) => `  <PageContent Source="Pages/${idx + 1}.fpage"/>`)
    .join('\n');
  const fdocXml = `<?xml version="1.0" encoding="UTF-8"?>
<FixedDocument xmlns="http://schemas.microsoft.com/xps/2005/06">
${pageContentEntries}
</FixedDocument>`;
  zip.file('Documents/1/FixedDocument.fdoc', fdocXml);

  // 6. Documents/1/_rels/FixedDocument.fdoc.rels
  const fdocRelsEntries = outputPages
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
  const writer = new GlyphWriter(zip);
  for (let idx = 0; idx < outputPages.length; idx++) {
    const pageNum = idx + 1;
    const page = outputPages[idx];
    const glyphsXmlChunks: string[] = [];
    const usedFonts = new Set<string>();
    const relationships: string[] = [];

    for (const line of page.lines) {
      glyphsXmlChunks.push(...writer.glyphs(line.runs, line.y, XPS_FONT_SIZE, DEFAULT_TEXT_COLOR, usedFonts));
    }

    // Structured elements if any
    let currentY = ELEMENT_FIRST_BASELINE;
    for (const el of page.elements) {
      const meter = new TextMeter();
      const x = el.x !== undefined ? el.x : DEFAULT_ELEMENT_LEFT;
      const y = el.y !== undefined ? el.y : currentY;
      const size = el.fontSize || DEFAULT_ELEMENT_SIZE;
      glyphsXmlChunks.push(...writer.glyphs(meter.place(toDrawableText(el.text ?? ''), x, size), y, size, el.fontColor || DEFAULT_ELEMENT_COLOR, usedFonts));
      currentY = Math.max(currentY, y + ELEMENT_LINE_ADVANCE);
    }

    // Embedded image if any
    let imageXml = '';
    if (page.image) {
      assertImageSize(page.image, pageNum);
      const imgExt = page.image.format === 'jpeg' ? 'jpg' : page.image.format;
      const imgPath = `Documents/1/Resources/Images/image${pageNum}.${imgExt}`;
      zip.file(imgPath, page.image.buffer);
      relationships.push(`  <Relationship Id="rImg1" Type="${REQUIRED_RESOURCE_RELATIONSHIP}" Target="/${imgPath}"/>`);

      const imgW = viewboxSize(page.image.width, page.image.dpiX);
      const imgH = viewboxSize(page.image.height, page.image.dpiY);
      imageXml = `  <Path Data="M ${PICTURE_LEFT},${PICTURE_TOP} L ${PICTURE_LEFT + PICTURE_WIDTH},${PICTURE_TOP} L ${PICTURE_LEFT + PICTURE_WIDTH},${PICTURE_TOP + PICTURE_HEIGHT} L ${PICTURE_LEFT},${PICTURE_TOP + PICTURE_HEIGHT} Z">
    <Path.Fill>
      <ImageBrush ImageSource="/${imgPath}" Viewbox="0,0,${imgW},${imgH}" ViewboxUnits="Absolute" Viewport="${PICTURE_LEFT},${PICTURE_TOP},${PICTURE_WIDTH},${PICTURE_HEIGHT}" ViewportUnits="Absolute"/>
    </Path.Fill>
  </Path>`;
    }
    [...usedFonts].forEach((part, fontIdx) => {
      relationships.push(`  <Relationship Id="rFont${fontIdx + 1}" Type="${REQUIRED_RESOURCE_RELATIONSHIP}" Target="/${part}"/>`);
    });
    if (relationships.length > 0) {
      zip.file(
        `Documents/1/Pages/_rels/${pageNum}.fpage.rels`,
        `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${relationships.join('\n')}
</Relationships>`
      );
    }

    const fpageXml = `<?xml version="1.0" encoding="UTF-8"?>
<FixedPage Width="${XPS_PAGE_WIDTH}" Height="${XPS_PAGE_HEIGHT}" xml:lang="en-US" xmlns="http://schemas.microsoft.com/xps/2005/06">
${imageXml ? imageXml + '\n' : ''}${glyphsXmlChunks.join('\n')}
</FixedPage>`;
    zip.file(`Documents/1/Pages/${pageNum}.fpage`, fpageXml);
  }

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
