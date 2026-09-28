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
  PDFArray,
} from 'pdf-lib';
import { ConversionOptions } from '../types';

export interface OcrBBox {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  angle?: number;
  rotationDegrees?: number;
  rotationRadians?: number;
  skewX?: number;
  skewY?: number;
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
                rotation: w.rotation ?? w.angle ?? line.rotation ?? line.angle ?? block.rotation ?? block.angle,
                skewX: w.skewX ?? line.skewX,
                skewY: w.skewY ?? line.skewY,
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
            rotation: line.rotation ?? line.angle ?? block.rotation ?? block.angle,
            skewX: line.skewX ?? block.skewX,
            skewY: line.skewY ?? block.skewY,
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
export function createToUnicodeCMap(
  mappings?: Array<number | [number, number]> | Map<number, number>
): string {
  if (
    !mappings ||
    (Array.isArray(mappings) && mappings.length === 0) ||
    (mappings instanceof Map && mappings.size === 0)
  ) {
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

  const toHex16 = (cp: number): string => (cp & 0xffff).toString(16).padStart(4, '0').toUpperCase();
  const toHex = (cp: number): string => {
    if (cp <= 0xffff) {
      return cp.toString(16).padStart(4, '0').toUpperCase();
    }
    const high = Math.floor((cp - 0x10000) / 0x400) + 0xd800;
    const low = ((cp - 0x10000) % 0x400) + 0xdc00;
    return (
      high.toString(16).padStart(4, '0').toUpperCase() +
      low.toString(16).padStart(4, '0').toUpperCase()
    );
  };

  const entries: string[] = [];
  const pushCMapEntry = (src: number, dst: number): void => {
    if (src <= 0xffff) {
      entries.push(`<${toHex16(src)}> <${toHex(dst)}>`);
    } else {
      const highSrc = Math.floor((src - 0x10000) / 0x400) + 0xd800;
      const lowSrc = ((src - 0x10000) % 0x400) + 0xdc00;
      const highDst = Math.floor((dst - 0x10000) / 0x400) + 0xd800;
      const lowDst = ((dst - 0x10000) % 0x400) + 0xdc00;
      entries.push(`<${toHex16(highSrc)}> <${toHex16(highDst)}>`);
      entries.push(`<${toHex16(lowSrc)}> <${toHex16(lowDst)}>`);
    }
  };

  if (Array.isArray(mappings)) {
    for (const m of mappings) {
      if (typeof m === 'number') {
        pushCMapEntry(m, m);
      } else {
        pushCMapEntry(m[0], m[1]);
      }
    }
  } else if (mappings instanceof Map) {
    for (const [src, dst] of mappings.entries()) {
      pushCMapEntry(src, dst);
    }
  }

  const bfcharBlocks: string[] = [];
  const CHUNK_SIZE = 100;
  for (let i = 0; i < entries.length; i += CHUNK_SIZE) {
    const chunk = entries.slice(i, i + CHUNK_SIZE);
    bfcharBlocks.push(`${chunk.length} beginbfchar\n${chunk.join('\n')}\nendbfchar`);
  }

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
${bfcharBlocks.join('\n')}
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
 * Generates an ISO 32000-1 / OpenType compliant minimal TrueType (SFNT) binary font.
 * Includes all 10 mandatory standard tables (OS/2, cmap, glyf, head, hhea, hmtx, loca, maxp, name, post)
 * with strict 4-byte alignment and checksum calculations, allowing strict PDF viewers
 * to parse embedded /FontFile2 CIDFontType2 glyph streams without missing font errors.
 */
export function buildMinimalTrueTypeFont(): Buffer {
  const calcTableChecksum = (buf: Buffer): number => {
    let sum = 0;
    const n = Math.floor(buf.length / 4);
    for (let i = 0; i < n; i++) {
      sum = (sum + buf.readUInt32BE(i * 4)) >>> 0;
    }
    return sum;
  };

  // 1. Table 'head' (54 bytes)
  const head = Buffer.alloc(54);
  head.writeUInt32BE(0x00010000, 0); // version 1.0
  head.writeUInt32BE(0x00010000, 4); // fontRevision 1.0
  head.writeUInt32BE(0x00000000, 8); // checkSumAdjustment (calculated later)
  head.writeUInt32BE(0x5f0f3cf5, 12); // magicNumber
  head.writeUInt16BE(0x0003, 16); // flags
  head.writeUInt16BE(1000, 18); // unitsPerEm
  head.writeInt16BE(-1000, 36); // xMin
  head.writeInt16BE(-200, 38); // yMin
  head.writeInt16BE(1000, 40); // xMax
  head.writeInt16BE(1000, 42); // yMax
  head.writeUInt16BE(0, 44); // macStyle
  head.writeUInt16BE(6, 46); // lowestRecPPEM
  head.writeInt16BE(2, 48); // fontDirectionHint
  head.writeInt16BE(0, 50); // indexToLocFormat: 0 (16-bit offset / 2)
  head.writeInt16BE(0, 52); // glyphDataFormat: 0

  // 2. Table 'hhea' (36 bytes)
  const hhea = Buffer.alloc(36);
  hhea.writeUInt32BE(0x00010000, 0); // version 1.0
  hhea.writeInt16BE(1000, 4); // ascender
  hhea.writeInt16BE(-200, 6); // descender
  hhea.writeInt16BE(0, 8); // lineGap
  hhea.writeUInt16BE(1000, 10); // advanceWidthMax
  hhea.writeInt16BE(0, 12); // minLeftSideBearing
  hhea.writeInt16BE(0, 14); // minRightSideBearing
  hhea.writeInt16BE(1000, 16); // xMaxExtent
  hhea.writeInt16BE(1, 18); // caretSlopeRise
  hhea.writeInt16BE(0, 20); // caretSlopeRun
  hhea.writeInt16BE(0, 22); // caretOffset
  hhea.writeInt16BE(0, 32); // metricDataFormat
  hhea.writeUInt16BE(1, 34); // numberOfHMetrics

  // 3. Table 'maxp' (32 bytes)
  const maxp = Buffer.alloc(32);
  maxp.writeUInt32BE(0x00010000, 0); // version 1.0
  maxp.writeUInt16BE(1, 4); // numGlyphs = 1 (.notdef)

  // 4. Table 'OS/2' (86 bytes)
  const os2 = Buffer.alloc(86);
  os2.writeUInt16BE(1, 0); // version 1
  os2.writeInt16BE(1000, 2); // xAvgCharWidth
  os2.writeUInt16BE(400, 4); // usWeightClass (Regular)
  os2.writeUInt16BE(5, 6); // usWidthClass (Medium)
  os2.writeUInt16BE(0, 8); // fsType (0 = installable)
  os2.writeInt16BE(650, 10); // ySubscriptXSize
  os2.writeInt16BE(600, 12); // ySubscriptYSize
  os2.writeInt16BE(0, 14); // ySubscriptXOffset
  os2.writeInt16BE(75, 16); // ySubscriptYOffset
  os2.writeInt16BE(650, 18); // ySuperscriptXSize
  os2.writeInt16BE(600, 20); // ySuperscriptYSize
  os2.writeInt16BE(0, 22); // ySuperscriptXOffset
  os2.writeInt16BE(350, 24); // ySuperscriptYOffset
  os2.writeInt16BE(50, 26); // yStrikeoutSize
  os2.writeInt16BE(300, 28); // yStrikeoutPosition
  os2.writeInt16BE(0, 30); // sFamilyClass
  os2.write('ECVT', 58, 4, 'ascii'); // achVendID
  os2.writeUInt16BE(0x0040, 62); // fsSelection (REGULAR)
  os2.writeUInt16BE(0x0020, 64); // usFirstCharIndex
  os2.writeUInt16BE(0xffff, 66); // usLastCharIndex
  os2.writeInt16BE(1000, 68); // sTypoAscender
  os2.writeInt16BE(-200, 70); // sTypoDescender
  os2.writeInt16BE(0, 72); // sTypoLineGap
  os2.writeUInt16BE(1000, 74); // usWinAscent
  os2.writeUInt16BE(200, 76); // usWinDescent

  // 5. Table 'hmtx' (4 bytes)
  const hmtx = Buffer.alloc(4);
  hmtx.writeUInt16BE(1000, 0); // advanceWidth = 1000
  hmtx.writeInt16BE(0, 2); // leftSideBearing = 0

  // 6. Table 'loca' (4 bytes)
  const loca = Buffer.alloc(4);
  loca.writeUInt16BE(0, 0); // glyph 0 offset: 0 / 2 = 0
  loca.writeUInt16BE(5, 2); // glyph 1 offset: 10 / 2 = 5

  // 7. Table 'glyf' (10 bytes -> padded to 12)
  const glyf = Buffer.alloc(10);
  glyf.writeInt16BE(0, 0); // numberOfContours: 0 (empty .notdef glyph)
  glyf.writeInt16BE(0, 2); // xMin
  glyf.writeInt16BE(0, 4); // yMin
  glyf.writeInt16BE(0, 6); // xMax
  glyf.writeInt16BE(0, 8); // yMax

  // 8. Table 'name'
  const nameStrings = [
    'EasyConvert-ToUnicode', // 1: Family
    'Regular', // 2: Subfamily
    'EasyConvert-ToUnicode', // 3: Unique ID
    'EasyConvert-ToUnicode', // 4: Full Name
    'EasyConvert-ToUnicode', // 6: PostScript Name
  ];
  const nameIds = [1, 2, 3, 4, 6];
  const stringBuffers = nameStrings.map((s) => {
    const b = Buffer.alloc(s.length * 2);
    for (let j = 0; j < s.length; j++) {
      b.writeUInt16BE(s.codePointAt(j) ?? 0, j * 2);
    }
    return b;
  });
  const stringHeaderSize = 6 + nameIds.length * 12;
  const stringDataTotal = stringBuffers.reduce((acc, b) => acc + b.length, 0);

  const name = Buffer.alloc(stringHeaderSize + stringDataTotal);
  name.writeUInt16BE(0, 0); // format 0
  name.writeUInt16BE(nameIds.length, 2); // count
  name.writeUInt16BE(stringHeaderSize, 4); // stringOffset

  let curStrOffset = 0;
  for (let i = 0; i < nameIds.length; i++) {
    const recOff = 6 + i * 12;
    name.writeUInt16BE(3, recOff); // platformID: Windows
    name.writeUInt16BE(1, recOff + 2); // encodingID: Unicode BMP
    name.writeUInt16BE(0x0409, recOff + 4); // languageID: English US
    name.writeUInt16BE(nameIds[i], recOff + 6); // nameID
    name.writeUInt16BE(stringBuffers[i].length, recOff + 8); // length
    name.writeUInt16BE(curStrOffset, recOff + 10); // offset
    stringBuffers[i].copy(name, stringHeaderSize + curStrOffset);
    curStrOffset += stringBuffers[i].length;
  }

  // 9. Table 'post' (32 bytes)
  const post = Buffer.alloc(32);
  post.writeUInt32BE(0x00030000, 0); // format 3.0
  post.writeUInt32BE(0, 4); // italicAngle
  post.writeInt16BE(-100, 8); // underlinePosition
  post.writeInt16BE(50, 10); // underlineThickness
  post.writeUInt32BE(1, 12); // isFixedPitch = 1

  // 10. Table 'cmap' (44 bytes)
  const cmap = Buffer.alloc(44);
  cmap.writeUInt16BE(0, 0); // version 0
  cmap.writeUInt16BE(1, 2); // numTables = 1
  cmap.writeUInt16BE(3, 4); // platformID: Windows
  cmap.writeUInt16BE(1, 6); // encodingID: Unicode BMP
  cmap.writeUInt32BE(12, 8); // subtable offset = 12

  // cmap subtable format 4 (32 bytes at offset 12)
  const sub = cmap.subarray(12);
  sub.writeUInt16BE(4, 0); // format 4
  sub.writeUInt16BE(32, 2); // length 32
  sub.writeUInt16BE(0, 4); // language 0
  sub.writeUInt16BE(4, 6); // segCountX2 = 4 (2 segments)
  sub.writeUInt16BE(4, 8); // searchRange
  sub.writeUInt16BE(1, 10); // entrySelector
  sub.writeUInt16BE(0, 12); // rangeShift
  sub.writeUInt16BE(0x0020, 14); // endCode seg 0
  sub.writeUInt16BE(0xffff, 16); // endCode seg 1
  sub.writeUInt16BE(0, 18); // reservedPad
  sub.writeUInt16BE(0x0020, 20); // startCode seg 0
  sub.writeUInt16BE(0xffff, 22); // startCode seg 1
  sub.writeInt16BE(-0x0020, 24); // idDelta seg 0
  sub.writeInt16BE(1, 26); // idDelta seg 1
  sub.writeUInt16BE(0, 28); // idRangeOffset seg 0
  sub.writeUInt16BE(0, 30); // idRangeOffset seg 1

  // Alphabetically sorted table entries
  const rawTables: Array<{ tag: string; buf: Buffer }> = [
    { tag: 'OS/2', buf: os2 },
    { tag: 'cmap', buf: cmap },
    { tag: 'glyf', buf: glyf },
    { tag: 'head', buf: head },
    { tag: 'hhea', buf: hhea },
    { tag: 'hmtx', buf: hmtx },
    { tag: 'loca', buf: loca },
    { tag: 'maxp', buf: maxp },
    { tag: 'name', buf: name },
    { tag: 'post', buf: post },
  ];

  const tables = rawTables.map((t) => {
    const pad = (4 - (t.buf.length % 4)) % 4;
    const paddedBuf = pad === 0 ? t.buf : Buffer.concat([t.buf, Buffer.alloc(pad)]);
    return {
      tag: t.tag,
      origLength: t.buf.length,
      paddedBuf,
      checksum: calcTableChecksum(paddedBuf),
    };
  });

  const numTables = tables.length;
  const headerSize = 12 + numTables * 16;
  let totalSize = headerSize;
  for (const t of tables) {
    totalSize += t.paddedBuf.length;
  }

  const fontFile = Buffer.alloc(totalSize);
  fontFile.writeUInt32BE(0x00010000, 0); // sfntVersion (TrueType)
  fontFile.writeUInt16BE(numTables, 4);
  const maxPow2 = 1 << Math.floor(Math.log2(numTables));
  fontFile.writeUInt16BE(maxPow2 * 16, 6); // searchRange
  fontFile.writeUInt16BE(Math.floor(Math.log2(numTables)), 8); // entrySelector
  fontFile.writeUInt16BE(numTables * 16 - maxPow2 * 16, 10); // rangeShift

  let curOffset = headerSize;
  let headTableOffset = 0;

  for (let i = 0; i < numTables; i++) {
    const t = tables[i];
    const dirOffset = 12 + i * 16;
    fontFile.write(t.tag, dirOffset, 4, 'ascii');
    fontFile.writeUInt32BE(t.checksum, dirOffset + 4);
    fontFile.writeUInt32BE(curOffset, dirOffset + 8);
    fontFile.writeUInt32BE(t.origLength, dirOffset + 12);

    t.paddedBuf.copy(fontFile, curOffset);
    if (t.tag === 'head') {
      headTableOffset = curOffset;
    }
    curOffset += t.paddedBuf.length;
  }

  const fullFontChecksum = calcTableChecksum(fontFile);
  const checkSumAdjustment = (0xb1b0afba - fullFontChecksum) >>> 0;
  fontFile.writeUInt32BE(checkSumAdjustment, headTableOffset + 8);

  return fontFile;
}

/**
 * Ensures a Type 0 CIDFont with an embedded TrueType stream (/FontFile2)
 * and a 16-bit /ToUnicode CMap stream into the PDFDocument per ISO 32000-1.
 */
export function ensureUnicodeFont(doc: PDFDocument): UnicodeFontInfo {
  if ((doc as any)._unicodeFontInfo) {
    return (doc as any)._unicodeFontInfo;
  }

  const cmap = createToUnicodeCMap();
  const cmapStream = doc.context.flateStream(cmap);
  const cmapRef = doc.context.register(cmapStream);

  const ttfBuffer = buildMinimalTrueTypeFont();
  const fontStream = doc.context.flateStream(ttfBuffer);
  fontStream.dict.set(PDFName.of('Length1'), PDFNumber.of(ttfBuffer.length));
  const fontStreamRef = doc.context.register(fontStream);

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
    FontFile2: fontStreamRef,
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
 * Serializes text code points to exact 4-character hex strings (<XXXX>) without UTF-16BE BOM.
 * Encodes BMP characters as <XXXX> and astral plane characters (> 0xFFFF) as high/low surrogate pairs <XXXXYYYY>.
 */
export function encodeUnicodeTo4CharHex(text: string): string {
  let hex = '';
  for (const char of text) {
    const cp = char.codePointAt(0) ?? 0;
    if (cp <= 0xffff) {
      hex += cp.toString(16).padStart(4, '0').toUpperCase();
    } else {
      const high = Math.floor((cp - 0x10000) / 0x400) + 0xd800;
      const low = ((cp - 0x10000) % 0x400) + 0xdc00;
      hex +=
        high.toString(16).padStart(4, '0').toUpperCase() +
        low.toString(16).padStart(4, '0').toUpperCase();
    }
  }
  return hex;
}

/**
 * Encodes text safely for PDF invisible text layer embedding.
 * Preserves CJK (Korean, Chinese, Japanese) and extended Unicode code points
 * by serializing into exact 4-character hex strings without BOM (<XXXX>) conforming to ISO 32000-1.
 */
export function safeEncodeText(font: PDFFont, text: string): PDFHexString | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) {
    if (text.length > 0) {
      try {
        return font.encodeText(text);
      } catch {
        return PDFHexString.of(encodeUnicodeTo4CharHex(text));
      }
    }
    return null;
  }

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
    return PDFHexString.of(encodeUnicodeTo4CharHex(trimmed));
  }

  try {
    return font.encodeText(trimmed);
  } catch {
    return PDFHexString.of(encodeUnicodeTo4CharHex(trimmed));
  }
}

/**
 * Computes an ISO 32000-1 2D affine skew/rotation transformation matrix
 * [cos(θ), sin(θ), -sin(θ), cos(θ), x, y] cm for rotated or skewed OCR bounding boxes.
 */
export function computeAffineTransformationMatrix(
  bbox: OcrBBox,
  pageHeight: number,
  scaleX: number = 1.0,
  scaleY: number = 1.0
): [number, number, number, number, number, number] {
  const scaledX = bbox.x * scaleX;
  const scaledY = pageHeight - (bbox.y + bbox.height) * scaleY;

  // Resolve rotation angle in radians (all OCR angle/rotation properties default to degrees)
  let theta = 0;
  if (bbox.rotationRadians !== undefined) {
    theta = bbox.rotationRadians;
  } else if (bbox.rotationDegrees !== undefined) {
    theta = (bbox.rotationDegrees * Math.PI) / 180;
  } else if (bbox.rotation !== undefined) {
    theta = (bbox.rotation * Math.PI) / 180;
  } else if (bbox.angle !== undefined) {
    theta = (bbox.angle * Math.PI) / 180;
  }

  // Resolve skew angles in radians (skewX = horizontal shear, skewY = vertical shear)
  const skewX = bbox.skewX ?? 0;
  const skewY = bbox.skewY ?? 0;

  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);
  const tanSkewX = Math.tan(skewX);
  const tanSkewY = Math.tan(skewY);

  // 2D Affine concatenation: R(θ) * S(skewX, skewY)
  // R = [cosθ, sinθ; -sinθ, cosθ], S = [1, tan(skewY); tan(skewX), 1]
  const a = cosT + tanSkewX * sinT;
  const b = sinT + tanSkewY * cosT;
  const c = -sinT + tanSkewX * cosT;
  const d = cosT - tanSkewY * sinT;
  const e = scaledX;
  const f = scaledY;

  return [a, b, c, d, e, f];
}

/**
 * Builds an ISO 32000-1 TJ array operator and word spacing (Tw) parameter
 * with character kerning offsets between words or characters.
 */
export function buildTJArrayWithKerning(
  doc: PDFDocument,
  font: PDFFont,
  words: Array<{ text: string; bbox?: OcrBBox }>,
  fontSize: number,
  tz: number = 100,
  scaleX: number = 1.0,
  originX: number = 0
): { tjArray: any; wordSpacing: number; activeFontName: string } {
  const tjArray = PDFArray.withContext(doc.context);
  let activeFontName = font.name;

  // Determine if any word contains non-WinAnsi / CJK characters
  let hasNonWinAnsi = false;
  for (const w of words) {
    for (let i = 0; i < w.text.length; i++) {
      const code = w.text.charCodeAt(i);
      if (!((code >= 32 && code <= 126) || (code >= 160 && code <= 255))) {
        hasNonWinAnsi = true;
        break;
      }
    }
    if (hasNonWinAnsi) break;
  }

  if (hasNonWinAnsi) {
    const unicodeFont = ensureUnicodeFont(doc);
    activeFontName = unicodeFont.fontName;
  } else {
    ensureStandardFontToUnicode(doc, font);
    activeFontName = font.name;
  }

  const spaceWidthPt = hasNonWinAnsi
    ? fontSize * 0.5 * (tz / 100)
    : font.widthOfTextAtSize(' ', fontSize) * (tz / 100);

  // Compute gaps between words
  const gaps: number[] = [];
  for (let i = 0; i < words.length - 1; i++) {
    const w0 = words[i];
    const w1 = words[i + 1];
    if (w0.bbox && w1.bbox && w1.bbox.x > w0.bbox.x) {
      const gap = Math.max(0, (w1.bbox.x - (w0.bbox.x + w0.bbox.width)) * scaleX);
      gaps.push(gap > 0 ? gap : spaceWidthPt);
    } else {
      gaps.push(spaceWidthPt);
    }
  }

  // Calculate word spacing (Tw).
  // Note: ISO 32000-1 §9.3.3 specifies that Tw is ignored for composite fonts (Type 0 / CIDFonts).
  // For Type 0 fonts, all spacing adjustments are expressed directly in the TJ kerning array.
  let wordSpacing = 0;
  if (!hasNonWinAnsi && gaps.length > 0) {
    const avgGap = gaps.reduce((acc, g) => acc + g, 0) / gaps.length;
    // Tw is in unscaled text-space units (scaled by tz / 100 when rendered in user space)
    wordSpacing = Math.max(0, (avgGap - spaceWidthPt) / (tz / 100));
  }

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const trimmed = w.text.trim();
    if (!trimmed) continue;

    // Relative X offset for the first word if originX is specified
    if (i === 0 && w.bbox && originX > 0 && w.bbox.x * scaleX > originX) {
      const leadingGap = Math.max(0, w.bbox.x * scaleX - originX);
      if (leadingGap > 1) {
        const leadingKerning = -Math.round((leadingGap * 1000) / (fontSize * (tz / 100)));
        if (leadingKerning !== 0) {
          tjArray.push(PDFNumber.of(leadingKerning));
        }
      }
    }

    // Word text encoded
    if (hasNonWinAnsi) {
      tjArray.push(PDFHexString.of(encodeUnicodeTo4CharHex(trimmed)));
    } else {
      const enc = safeEncodeText(font, trimmed);
      if (enc) tjArray.push(enc);
    }

    // Gap to next word
    if (i < words.length - 1) {
      // Push explicit space glyph to ensure PDF viewers copy text with spaces
      if (hasNonWinAnsi) {
        tjArray.push(PDFHexString.of('0020'));
      } else {
        const spaceEnc = safeEncodeText(font, ' ');
        if (spaceEnc) tjArray.push(spaceEnc);
      }

      // Compute kerning offset for this specific gap
      const gap = gaps[i];
      const residual = gap - spaceWidthPt - wordSpacing * (tz / 100);
      if (Math.abs(residual) >= 0.1) {
        const kerning = -Math.round((residual * 1000) / (fontSize * (tz / 100)));
        if (kerning !== 0) {
          tjArray.push(PDFNumber.of(kerning));
        }
      }
    }
  }

  return { tjArray, wordSpacing, activeFontName };
}

/**
 * Renders an OCR line block with ISO 32000-1 compliant word spacing (Tw)
 * and TJ array operator with character kerning offsets, positioned using
 * a 2D affine skew/rotation transformation matrix ([cos(θ), sin(θ), -sin(θ), cos(θ), x, y] cm).
 */
export function renderLineBlockWithSpacing(
  page: PDFPage,
  font: PDFFont,
  block: OcrLineBlock,
  pageHeight: number,
  scaleX: number = 1.0,
  scaleY: number = 1.0
): void {
  const scaledWidth = block.bbox.width * scaleX;
  const scaledHeight = block.bbox.height * scaleY;
  const maxAvailableWidth = Math.max(10, page.getSize().width - block.bbox.x * scaleX - 5);
  const targetWidth = Math.min(scaledWidth, maxAvailableWidth);

  const words =
    block.words && block.words.length > 0
      ? block.words.filter((w) => w.text.trim().length > 0)
      : block.text
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .map((t) => ({ text: t, bbox: block.bbox }));

  if (words.length === 0) return;

  // Estimate typography units (1000 per em): CJK = 1000, Latin = 500, space = 300
  let estUnits = 0;
  for (const w of words) {
    for (let i = 0; i < w.text.length; i++) {
      estUnits += w.text.charCodeAt(i) > 255 ? 1000 : 500;
    }
  }
  estUnits += Math.max(0, words.length - 1) * 300;

  const maxFontForWidth = estUnits > 0 ? (targetWidth / estUnits) * 1000 : 72;
  const maxFontForHeight = scaledHeight * 0.85;
  const fontSize = Math.max(6, Math.min(72, maxFontForHeight, maxFontForWidth));

  const estimatedWidth = (estUnits / 1000) * fontSize;
  let tz = 100;
  if (estimatedWidth > 0 && targetWidth > 0) {
    tz = Math.max(70, Math.min(130, (targetWidth / estimatedWidth) * 100));
  }

  const originX = block.bbox.x * scaleX;
  const { tjArray, wordSpacing, activeFontName } = buildTJArrayWithKerning(
    page.doc,
    font,
    words,
    fontSize,
    tz,
    scaleX,
    originX
  );

  if (activeFontName === 'ECToUnicodeFont') {
    const unicodeFont = ensureUnicodeFont(page.doc);
    registerFontOnPage(page, unicodeFont);
  }

  const [a, b, c, d, e, f] = computeAffineTransformationMatrix(
    block.bbox,
    pageHeight,
    scaleX,
    scaleY
  );

  page.pushOperators(
    pushGraphicsState(),
    PDFOperator.of(PDFOperatorNames.ConcatTransformationMatrix, [
      PDFNumber.of(Number(a.toFixed(6))),
      PDFNumber.of(Number(b.toFixed(6))),
      PDFNumber.of(Number(c.toFixed(6))),
      PDFNumber.of(Number(d.toFixed(6))),
      PDFNumber.of(Number(e.toFixed(4))),
      PDFNumber.of(Number(f.toFixed(4))),
    ]),
    setTextRenderingMode(TextRenderingMode.Invisible), // 3 Tr
    beginText(),
    setFontAndSize(activeFontName, fontSize),
    PDFOperator.of(PDFOperatorNames.SetWordSpacing, [PDFNumber.of(Number(wordSpacing.toFixed(3)))]), // Tw
    PDFOperator.of(PDFOperatorNames.SetTextHorizontalScaling, [PDFNumber.of(Math.round(tz))]), // Tz
    setTextMatrix(1, 0, 0, 1, 0, 0), // 1 0 0 1 0 0 Tm
    PDFOperator.of(PDFOperatorNames.ShowTextAdjusted, [tjArray]), // TJ
    endText(),
    popGraphicsState()
  );
}

/**
 * Embeds an invisible text element on a PDF page with accurate positioning and metrics.
 */
export function embedInvisibleText(
  page: PDFPage,
  font: PDFFont,
  text: string,
  bbox: OcrBBox,
  pageHeight: number,
  scaleX: number = 1.0,
  scaleY: number = 1.0
): void {
  renderTextItem(page, font, text, bbox, pageHeight, scaleX, scaleY);
}

export function renderTextItem(
  page: PDFPage,
  font: PDFFont,
  text: string,
  bbox: OcrBBox,
  pageHeight: number,
  scaleX: number,
  scaleY: number
): void {
  const trimmed = text.trim();
  if (!trimmed) return;

  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length > 1) {
    renderLineBlockWithSpacing(
      page,
      font,
      { text: trimmed, bbox, words: words.map((w) => ({ text: w, bbox })) },
      pageHeight,
      scaleX,
      scaleY
    );
    return;
  }

  const scaledWidth = bbox.width * scaleX;
  const scaledHeight = bbox.height * scaleY;
  const fontSize = Math.max(6, Math.min(72, scaledHeight * 0.85));

  let hasNonWinAnsi = false;
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i);
    if (!((code >= 32 && code <= 126) || (code >= 160 && code <= 255))) {
      hasNonWinAnsi = true;
      break;
    }
  }

  ensureStandardFontToUnicode(page.doc, font);
  let activeFontName = font.name;
  let encodedText: PDFHexString | null = null;
  let tz = 100;

  if (hasNonWinAnsi) {
    const unicodeFont = ensureUnicodeFont(page.doc);
    registerFontOnPage(page, unicodeFont);
    activeFontName = unicodeFont.fontName;
    encodedText = PDFHexString.of(encodeUnicodeTo4CharHex(trimmed));

    let estimatedWidth = 0;
    for (let i = 0; i < trimmed.length; i++) {
      const code = trimmed.charCodeAt(i);
      estimatedWidth += code > 255 ? fontSize : fontSize * 0.5;
    }
    const maxAvailableWidth = Math.max(10, page.getSize().width - bbox.x * scaleX - 5);
    const targetWidth = Math.min(scaledWidth, maxAvailableWidth);
    if (estimatedWidth > 0 && targetWidth > 0) {
      tz = Math.max(70, Math.min(130, (targetWidth / estimatedWidth) * 100));
    }
  } else {
    encodedText = safeEncodeText(font, trimmed);
    try {
      const rawWidth = font.widthOfTextAtSize(trimmed, fontSize);
      if (rawWidth > 0 && scaledWidth > 0) {
        const maxAvailableWidth = Math.max(10, page.getSize().width - bbox.x * scaleX - 5);
        const targetWidth = Math.min(scaledWidth, maxAvailableWidth);
        tz = Math.max(70, Math.min(130, (targetWidth / rawWidth) * 100));
      }
    } catch {
      tz = 100;
    }
  }

  if (!encodedText) return;

  const [a, b, c, d, e, f] = computeAffineTransformationMatrix(bbox, pageHeight, scaleX, scaleY);

  page.pushOperators(
    pushGraphicsState(),
    PDFOperator.of(PDFOperatorNames.ConcatTransformationMatrix, [
      PDFNumber.of(Number(a.toFixed(6))),
      PDFNumber.of(Number(b.toFixed(6))),
      PDFNumber.of(Number(c.toFixed(6))),
      PDFNumber.of(Number(d.toFixed(6))),
      PDFNumber.of(Number(e.toFixed(4))),
      PDFNumber.of(Number(f.toFixed(4))),
    ]),
    setTextRenderingMode(TextRenderingMode.Invisible), // 3 Tr
    beginText(),
    setFontAndSize(activeFontName, fontSize),
    PDFOperator.of(PDFOperatorNames.SetWordSpacing, [PDFNumber.of(0)]),
    PDFOperator.of(PDFOperatorNames.SetTextHorizontalScaling, [PDFNumber.of(Math.round(tz))]),
    setTextMatrix(1, 0, 0, 1, 0, 0),
    showText(encodedText),
    endText(),
    popGraphicsState()
  );
}

/**
 * Injects an invisible searchable text layer into a PDF page's /Contents stream.
 * Uses PDF rendering mode 3 (3 Tr = Neither fill nor stroke), horizontal scaling (Tz),
 * word spacing (Tw / TJ array operator with character kerning offsets),
 * and 2D affine transformation matrices ([cos(θ), sin(θ), -sin(θ), cos(θ), x, y] cm).
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
      renderLineBlockWithSpacing(page, font, block, pageHeight, scaleX, scaleY);
    }
  } else if (ocrResult.lines && ocrResult.lines.length > 0) {
    // Fallback: estimate equidistant text lines
    const lineCount = ocrResult.lines.length;
    const lineHeight = Math.min(24, pageHeight / (lineCount + 2));

    for (let i = 0; i < lineCount; i++) {
      const lineText = ocrResult.lines[i];
      if (!lineText.trim()) continue;

      const y = 40 + i * lineHeight;
      renderLineBlockWithSpacing(
        page,
        font,
        {
          text: lineText,
          bbox: { x: 40, y, width: Math.max(10, pageWidth - 80), height: lineHeight },
          words: [],
        },
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
