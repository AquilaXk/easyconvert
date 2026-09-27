import {
  PDFDocument,
  PDFFont,
  PDFPage,
  StandardFonts,
  pushGraphicsState,
  popGraphicsState,
  beginText,
  endText,
  setFontAndSize,
  setTextRenderingMode,
  TextRenderingMode,
  setTextMatrix,
  showText,
  PDFOperator,
  PDFOperatorNames,
  PDFNumber,
  PDFHexString,
  PDFName,
} from 'pdf-lib';
import { ConversionOptions } from '../types';

export interface OcrBBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OcrWord {
  text: string;
  bbox: OcrBBox;
}

export interface OcrLineBlock {
  text: string;
  bbox: OcrBBox;
  words: OcrWord[];
}

export interface OcrResult {
  text: string;
  confidence: number;
  wordCount: number;
  lines: string[];
  lineBlocks?: OcrLineBlock[];
  imageWidth?: number;
  imageHeight?: number;
}

/**
 * Parses raw Tesseract recognition block hierarchy into clean lines and blocks.
 * Shared between server and client edge pipelines.
 */
export function parseTesseractBlocks(blocks: any[] | null | undefined): { lines: string[]; lineBlocks: OcrLineBlock[] } {
  const lines: string[] = [];
  const lineBlocks: OcrLineBlock[] = [];
  if (!blocks || blocks.length === 0) return { lines, lineBlocks };

  for (const block of blocks) {
    if (!block.paragraphs) continue;
    for (const para of block.paragraphs) {
      if (!para.lines) continue;
      for (const line of para.lines) {
        const text = (line.text || '').trim();
        if (!text) continue;
        lines.push(text);

        const words: OcrWord[] = [];
        if (line.words) {
          for (const w of line.words) {
            const wText = (w.text || '').trim();
            if (!wText) continue;
            words.push({
              text: wText,
              bbox: {
                x: w.bbox.x0,
                y: w.bbox.y0,
                width: Math.max(1, w.bbox.x1 - w.bbox.x0),
                height: Math.max(1, w.bbox.y1 - w.bbox.y0),
              },
            });
          }
        }

        lineBlocks.push({
          text,
          bbox: {
            x: line.bbox.x0,
            y: line.bbox.y0,
            width: Math.max(1, line.bbox.x1 - line.bbox.x0),
            height: Math.max(1, line.bbox.y1 - line.bbox.y0),
          },
          words,
        });
      }
    }
  }

  return { lines, lineBlocks };
}

/**
 * Creates an ISO 32000-1 compliant ToUnicode CMap stream.
 * Maps 16-bit character codes (Identity-H) directly to UCS-2 / UTF-16 Unicode values,
 * ensuring that text copied or searched in PDF viewers (Adobe Acrobat, Chrome, Preview, pdftotext)
 * matches the original CJK and Unicode glyphs without garbling.
 */
export function createToUnicodeCMap(): string {
  return `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo <<
  /Registry (Adobe)
  /Ordering (UCS)
  /Supplement 0
>> def
/CMapName /Custom-ToUnicode def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
1 beginbfrange
<0000> <FFFF> <0000>
endbfrange
endcmap
CMapName currentdict /CMap defineresource pop
end
end`;
}

/**
 * Creates an ISO 32000-1 compliant 1-byte WinAnsi ToUnicode CMap stream for StandardFonts.
 */
export function createWinAnsiToUnicodeCMap(): string {
  return `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo <<
  /Registry (Adobe)
  /Ordering (UCS)
  /Supplement 0
>> def
/CMapName /WinAnsi-ToUnicode def
/CMapType 2 def
1 begincodespacerange
<00> <FF>
endcodespacerange
1 beginbfrange
<00> <FF> <0000>
endbfrange
endcmap
CMapName currentdict /CMap defineresource pop
end
end`;
}

export interface UnicodeFontInfo {
  fontName: string;
  fontRef: any;
}

/**
 * Registers an ISO 32000-1 Type 0 (Composite) CIDFont with Identity-H encoding
 * and a 16-bit /ToUnicode CMap stream into the PDFDocument.
 */
export function ensureUnicodeFont(doc: PDFDocument): UnicodeFontInfo {
  if ((doc as any)._unicodeFontInfo) {
    return (doc as any)._unicodeFontInfo;
  }

  const cmap = createToUnicodeCMap();
  const cmapStream = doc.context.flateStream(cmap);
  const cmapRef = doc.context.register(cmapStream);

  const fontDescDict = doc.context.obj({
    Type: 'FontDescriptor',
    FontName: 'EasyConvert-ToUnicode',
    Flags: 4,
    FontBBox: [-1000, -1000, 1000, 1000],
    ItalicAngle: 0,
    Ascent: 1000,
    Descent: -200,
    CapHeight: 800,
    StemV: 80,
  });
  const fontDescRef = doc.context.register(fontDescDict);

  const cidFontDict = doc.context.obj({
    Type: 'Font',
    Subtype: 'CIDFontType2',
    BaseFont: 'EasyConvert-ToUnicode',
    CIDSystemInfo: {
      Registry: 'Adobe',
      Ordering: 'Identity',
      Supplement: 0,
    },
    FontDescriptor: fontDescRef,
    DW: 1000,
    W: [0, 255, 500],
  });
  const cidFontRef = doc.context.register(cidFontDict);

  const type0FontDict = doc.context.obj({
    Type: 'Font',
    Subtype: 'Type0',
    BaseFont: 'EasyConvert-ToUnicode',
    Encoding: 'Identity-H',
    DescendantFonts: [cidFontRef],
    ToUnicode: cmapRef,
  });
  const type0FontRef = doc.context.register(type0FontDict);
  const fontName = 'ECToUnicodeFont';

  const fontInfo = { fontName, fontRef: type0FontRef };
  (doc as any)._unicodeFontInfo = fontInfo;
  return fontInfo;
}

/**
 * Ensures the Type 0 Unicode font is declared in the page's /Resources /Font dictionary,
 * dereferencing indirect object references (PDFRef) common in pre-existing PDF documents.
 */
export function registerFontOnPage(page: PDFPage, fontInfo: UnicodeFontInfo): void {
  let resources: any = page.node.Resources();
  if (!resources) {
    resources = page.doc.context.obj({});
    page.node.set(PDFName.of('Resources'), resources);
  } else {
    const resolved = page.doc.context.lookup(resources);
    if (resolved) {
      resources = resolved;
    }
  }

  const rawFontDict = resources.get(PDFName.of('Font'));
  let fontDict: any;
  if (!rawFontDict) {
    fontDict = page.doc.context.obj({});
    resources.set(PDFName.of('Font'), fontDict);
  } else {
    fontDict = page.doc.context.lookup(rawFontDict);
    if (!fontDict) {
      fontDict = page.doc.context.obj({});
      resources.set(PDFName.of('Font'), fontDict);
    }
  }
  fontDict.set(PDFName.of(fontInfo.fontName), fontInfo.fontRef);
}

/**
 * Injects ISO 32000-1 /ToUnicode CMap stream into standard Type 1 fonts.
 */
export function ensureStandardFontToUnicode(doc: PDFDocument, font: PDFFont): void {
  if ((font as any)._hasToUnicodeCMap) return;
  (font as any)._hasToUnicodeCMap = true;

  const embedder = (font as any).embedder;
  if (embedder && typeof embedder.embedIntoContext === 'function') {
    const origEmbed = embedder.embedIntoContext.bind(embedder);
    embedder.embedIntoContext = (context: any, ref: any) => {
      const resultRef = origEmbed(context, ref);
      const targetRef = resultRef || ref;
      if (targetRef) {
        const fontDict = context.lookup(targetRef) as any;
        if (fontDict && !fontDict.get(PDFName.of('ToUnicode'))) {
          const cmap = createWinAnsiToUnicodeCMap();
          const cmapStream = context.flateStream(cmap);
          const cmapRef = context.register(cmapStream);
          fontDict.set(PDFName.of('ToUnicode'), cmapRef);
        }
      }
      return resultRef;
    };
  }
}

/**
 * Encodes text safely for PDF invisible text layer embedding.
 * Preserves CJK (Korean, Chinese, Japanese) and extended Unicode code points
 * by serializing into UTF-16BE hex string format (BOM FEFF...) conforming to PDF 1.7 spec.
 */
export function safeEncodeText(font: PDFFont, text: string): PDFHexString | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // Check if text contains non-WinAnsi code points (CJK, symbols, Cyrillic, etc.)
  let hasNonWinAnsi = false;
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    if (!((code >= 32 && code <= 126) || (code >= 160 && code <= 255))) {
      hasNonWinAnsi = true;
      break;
    }
  }

  if (hasNonWinAnsi) {
    // PDF standard supports UTF-16BE hex strings with BOM (FEFF...) for Unicode CID text layers
    return PDFHexString.fromText(trimmed);
  }

  try {
    return font.encodeText(trimmed);
  } catch {
    // If standard font encoding throws, fallback to UTF-16BE hex string
    return PDFHexString.fromText(trimmed);
  }
}

function renderTextItem(
  page: PDFPage,
  font: PDFFont,
  text: string,
  bbox: { x: number; y: number; width: number; height: number },
  pageHeight: number,
  scaleX: number,
  scaleY: number
): void {
  const trimmed = text.trim();
  if (!trimmed) return;

  const scaledX = bbox.x * scaleX;
  const scaledY = pageHeight - (bbox.y + bbox.height) * scaleY;
  const scaledWidth = bbox.width * scaleX;
  const scaledHeight = bbox.height * scaleY;

  const fontSize = Math.max(6, Math.min(72, scaledHeight * 0.85));

  // Determine if text contains non-WinAnsi / CJK characters
  let hasNonWinAnsi = false;
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    if (!((code >= 32 && code <= 126) || (code >= 160 && code <= 255))) {
      hasNonWinAnsi = true;
      break;
    }
  }

  // Ensure standard font has ToUnicode CMap
  ensureStandardFontToUnicode(page.doc, font);

  let activeFontName = font.name;
  let encodedText: PDFHexString | null = null;
  let tz = 100;

  if (hasNonWinAnsi) {
    // For CJK and extended Unicode text: use ISO 32000-1 Type 0 CIDFont with ToUnicode CMap
    const unicodeFont = ensureUnicodeFont(page.doc);
    registerFontOnPage(page, unicodeFont);
    activeFontName = unicodeFont.fontName;

    // Encode text with UTF-16BE hex string (BOM FEFF...)
    encodedText = PDFHexString.fromText(trimmed);

    // Approximate character width: CJK glyphs = fontSize (1em = 1000 width), Latin glyphs = 0.5 * fontSize (500 width)
    let estimatedWidth = 0;
    for (let i = 0; i < trimmed.length; i++) {
      const code = trimmed.charCodeAt(i);
      estimatedWidth += code > 255 ? fontSize : fontSize * 0.5;
    }
    const maxAvailableWidth = Math.max(10, page.getSize().width - scaledX - 5);
    const targetWidth = Math.min(scaledWidth, maxAvailableWidth);
    if (estimatedWidth > 0 && targetWidth > 0) {
      tz = Math.max(70, Math.min(130, (targetWidth / estimatedWidth) * 100));
    }
  } else {
    encodedText = safeEncodeText(font, trimmed);
    try {
      const rawWidth = font.widthOfTextAtSize(trimmed, fontSize);
      if (rawWidth > 0 && scaledWidth > 0) {
        const maxAvailableWidth = Math.max(10, page.getSize().width - scaledX - 5);
        const targetWidth = Math.min(scaledWidth, maxAvailableWidth);
        tz = Math.max(70, Math.min(130, (targetWidth / rawWidth) * 100));
      }
    } catch {
      tz = 100;
    }
  }

  if (!encodedText) return;

  page.pushOperators(
    pushGraphicsState(),
    setTextRenderingMode(TextRenderingMode.Invisible), // 3 Tr
    beginText(),
    setFontAndSize(activeFontName, fontSize),
    PDFOperator.of(PDFOperatorNames.SetTextHorizontalScaling, [PDFNumber.of(Math.round(tz))]),
    setTextMatrix(1, 0, 0, 1, scaledX, Math.max(0, scaledY)),
    showText(encodedText),
    endText(),
    popGraphicsState()
  );
}

/**
 * Injects an invisible searchable text layer into a PDF page's /Contents stream.
 * Uses PDF rendering mode 3 (3 Tr = Neither fill nor stroke), horizontal scaling (Tz),
 * and text matrix positioning (Tm) matching Phase 3 specs.
 */
export function injectInvisibleTextLayer(
  page: PDFPage,
  font: PDFFont,
  ocrResult: OcrResult,
  scaleX: number = 1.0,
  scaleY: number = 1.0
): void {
  const { height: pageHeight, width: pageWidth } = page.getSize();
  const blocks = ocrResult.lineBlocks || [];

  if (blocks.length > 0) {
    for (const block of blocks) {
      if (!block.text) continue;

      if (block.words && block.words.length > 0) {
        for (const word of block.words) {
          if (word.text.trim()) {
            renderTextItem(page, font, word.text, word.bbox, pageHeight, scaleX, scaleY);
          }
        }
      } else {
        renderTextItem(page, font, block.text, block.bbox, pageHeight, scaleX, scaleY);
      }
    }
  } else if (ocrResult.lines && ocrResult.lines.length > 0) {
    // Fallback: estimate equidistant text lines
    const lineCount = ocrResult.lines.length;
    const lineHeight = Math.min(24, pageHeight / (lineCount + 2));

    for (let i = 0; i < lineCount; i++) {
      const lineText = ocrResult.lines[i];
      if (!lineText.trim()) continue;

      const y = 40 + i * lineHeight;
      renderTextItem(
        page,
        font,
        lineText,
        { x: 40, y, width: Math.max(10, pageWidth - 80), height: lineHeight },
        pageHeight,
        scaleX,
        scaleY
      );
    }
  }
}

/**
 * Generates an authentic Lossless Sandwich PDF directly from an existing PDF document.
 * Preserves 100% of the original PDF's metadata, objects, vector artwork, annotations,
 * and compression streams while non-destructively injecting transparent text layers.
 */
export async function createLosslessSandwichPdfFromPdf(
  originalPdfBuffer: Buffer,
  pageOcrResults: Map<number, OcrResult>
): Promise<Buffer> {
  const doc = await PDFDocument.load(originalPdfBuffer);
  const font = await doc.embedFont(StandardFonts.Helvetica);

  const numPages = doc.getPageCount();
  for (let i = 0; i < numPages; i++) {
    const pageNum = i + 1;
    const ocrResult = pageOcrResults.get(pageNum);
    if (!ocrResult) continue;

    const page = doc.getPage(i);
    const { width: pageWidth, height: pageHeight } = page.getSize();

    const imgWidth = ocrResult.imageWidth || pageWidth;
    const imgHeight = ocrResult.imageHeight || pageHeight;

    const scaleX = pageWidth / imgWidth;
    const scaleY = pageHeight / imgHeight;

    injectInvisibleTextLayer(page, font, ocrResult, scaleX, scaleY);
  }

  const pdfBytes = await doc.save();
  return Buffer.from(pdfBytes);
}

/**
 * Generates a Lossless Sandwich PDF from a single scanned bitmap image.
 * Uses pdf-lib (zero PDFKit reliance) to embed the visual bitmap at full fidelity
 * and layer invisible searchable text on top with millimetric accuracy.
 */
export async function createLosslessSandwichPdfFromImage(
  scannedImageBuffer: Buffer | Uint8Array,
  ocrResult: OcrResult,
  options: ConversionOptions = {},
  title: string = 'Searchable Document'
): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  doc.setCreator('EasyConvert Lossless Sandwich PDF Engine');

  const font = await doc.embedFont(StandardFonts.Helvetica);

  // Embed image: try PNG or JPG based on magic bytes
  const isJpg =
    scannedImageBuffer.length > 3 &&
    scannedImageBuffer[0] === 0xff &&
    scannedImageBuffer[1] === 0xd8 &&
    scannedImageBuffer[2] === 0xff;

  let embeddedImage;
  if (isJpg) {
    embeddedImage = await doc.embedJpg(scannedImageBuffer);
  } else {
    embeddedImage = await doc.embedPng(scannedImageBuffer);
  }

  const imgWidth = embeddedImage.width || ocrResult.imageWidth || 595.28;
  const imgHeight = embeddedImage.height || ocrResult.imageHeight || 841.89;

  const page = doc.addPage([imgWidth, imgHeight]);
  page.drawImage(embeddedImage, {
    x: 0,
    y: 0,
    width: imgWidth,
    height: imgHeight,
  });

  injectInvisibleTextLayer(page, font, ocrResult, 1.0, 1.0);

  const pdfBytes = await doc.save();
  return Buffer.from(pdfBytes);
}
