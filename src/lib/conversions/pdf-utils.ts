import zlib from 'zlib';

/**
 * PDF ToUnicode CMap structure per ISO 32000-1 Section 9.10
 */
export interface PdfToUnicodeCMap {
  name?: string;
  charMap: Map<number, string>;
}

/**
 * Text block with spatial coordinates for layout analysis and reading order reconstruction
 */
export interface PdfTextBlock {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontName?: string;
  fontSize?: number;
}

/**
 * Options for Recursive XY-Cut++ layout ordering
 */
export interface XyCutOptions {
  minGapX?: number; // Minimum column gutter width in points (default: 15)
  minGapY?: number; // Minimum paragraph/line gap in points (default: 3)
}

/**
 * Unescapes PDF literal strings (\n, \r, \t, octal codes, escaped parens)
 */
export function unescapePdfString(str: string): string {
  return str.replace(/\\([0-7]{1,3}|[nrtbf\\()])/g, (_match, p1) => {
    if (/^[0-7]+$/.test(p1)) {
      return String.fromCharCode(parseInt(p1, 8));
    }
    switch (p1) {
      case 'n': return '\n';
      case 'r': return '\r';
      case 't': return '\t';
      case 'b': return '\b';
      case 'f': return '\f';
      case '(': return '(';
      case ')': return ')';
      case '\\': return '\\';
      default: return p1;
    }
  });
}

/**
 * Decodes a PDF hexadecimal string (<FEFF...>, <...>)
 * Supports UTF-16BE BOM marker and CJK strings per PDF ISO 32000-1 Section 7.9.2.2.
 */
export function decodePdfHexString(hex: string): string {
  let cleanHex = hex.replace(/\s+/g, '');
  if (cleanHex.length % 2 !== 0) {
    cleanHex += '0'; // PDF spec: trailing odd hex digit is padded with '0'
  }
  const buf = Buffer.from(cleanHex, 'hex');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    // UTF-16BE with BOM: ensure even number of bytes to avoid ERR_INVALID_BUFFER_SIZE on swap16
    const payload = buf.subarray(2);
    const alignedLen = payload.length - (payload.length % 2);
    if (alignedLen === 0) return '';
    return Buffer.from(payload.subarray(0, alignedLen)).swap16().toString('utf16le');
  }
  // Check if it's valid UTF-8
  try {
    const utf8 = buf.toString('utf-8');
    if (!utf8.includes('\ufffd')) return utf8;
  } catch {}
  return buf.toString('latin1');
}

/**
 * Decodes raw hex string into Unicode string via a ToUnicode CMap
 */
export function decodeWithCMap(hex: string, cmap: PdfToUnicodeCMap): string {
  const cleanHex = hex.replace(/\s+/g, '');
  if (!cleanHex) return '';

  let result = '';
  // Try 4-digit (2-byte) glyph codes first (standard CID/Type0)
  if (cleanHex.length % 4 === 0) {
    let matchedAll = true;
    let temp = '';
    for (let i = 0; i < cleanHex.length; i += 4) {
      const code = parseInt(cleanHex.substring(i, i + 4), 16);
      if (cmap.charMap.has(code)) {
        temp += cmap.charMap.get(code);
      } else {
        matchedAll = false;
        break;
      }
    }
    if (matchedAll) return temp;
  }

  // Try 2-digit (1-byte) codes
  let matchedAll1Byte = true;
  let temp1Byte = '';
  for (let i = 0; i < cleanHex.length; i += 2) {
    const code = parseInt(cleanHex.substring(i, i + 2), 16);
    if (cmap.charMap.has(code)) {
      temp1Byte += cmap.charMap.get(code);
    } else {
      matchedAll1Byte = false;
      break;
    }
  }
  if (matchedAll1Byte) return temp1Byte;

  // Fallback to standard decodePdfHexString
  return decodePdfHexString(cleanHex);
}

/**
 * Parses a PostScript Adobe ToUnicode CMap stream per ISO 32000-1 Section 9.10
 */
export function parseToUnicodeCMap(cmapContent: string): PdfToUnicodeCMap {
  const charMap = new Map<number, string>();
  let name: string | undefined;

  const nameMatch = /\/CMapName\s*\/([^\s]+)/.exec(cmapContent);
  if (nameMatch) {
    name = nameMatch[1];
  }

  // Helper to decode destination UTF-16 hex
  const decodeDstHex = (hex: string): string => {
    const clean = hex.replace(/[<>\s]/g, '');
    let res = '';
    for (let i = 0; i < clean.length; i += 4) {
      const codeUnit = parseInt(clean.substring(i, Math.min(i + 4, clean.length)), 16);
      if (!Number.isNaN(codeUnit)) {
        res += String.fromCharCode(codeUnit);
      }
    }
    return res || String.fromCharCode(parseInt(clean, 16));
  };

  // 1. beginbfchar ... endbfchar
  const bfCharRegex = /beginbfchar\s+([\s\S]*?)\s+endbfchar/g;
  let bfMatch: RegExpExecArray | null;
  while ((bfMatch = bfCharRegex.exec(cmapContent)) !== null) {
    const lines = bfMatch[1].trim().split(/\r?\n/);
    for (const line of lines) {
      const tokens = line.trim().match(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/);
      if (tokens) {
        const srcCode = parseInt(tokens[1], 16);
        const dstChar = decodeDstHex(tokens[2]);
        charMap.set(srcCode, dstChar);
      }
    }
  }

  // 2. beginbfrange ... endbfrange
  const bfRangeRegex = /beginbfrange\s+([\s\S]*?)\s+endbfrange/g;
  let rangeMatch: RegExpExecArray | null;
  while ((rangeMatch = bfRangeRegex.exec(cmapContent)) !== null) {
    const content = rangeMatch[1].trim();
    // Format 1: <start> <end> <destStart>
    const directRegex = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g;
    let dMatch: RegExpExecArray | null;
    while ((dMatch = directRegex.exec(content)) !== null) {
      const start = parseInt(dMatch[1], 16);
      const end = parseInt(dMatch[2], 16);
      const dstBase = parseInt(dMatch[3], 16);
      for (let code = start; code <= end; code++) {
        charMap.set(code, String.fromCharCode(dstBase + (code - start)));
      }
    }

    // Format 2: <start> <end> [ <dst1> <dst2> ... ]
    const arrayRegex = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*\[([\s\S]*?)\]/g;
    let aMatch: RegExpExecArray | null;
    while ((aMatch = arrayRegex.exec(content)) !== null) {
      const start = parseInt(aMatch[1], 16);
      const end = parseInt(aMatch[2], 16);
      const elements = aMatch[3].match(/<([0-9a-fA-F]+)>/g) || [];
      for (let code = start; code <= end; code++) {
        const elemIdx = code - start;
        if (elemIdx < elements.length) {
          charMap.set(code, decodeDstHex(elements[elemIdx]));
        }
      }
    }
  }

  // 3. begincidchar ... endcidchar
  const cidCharRegex = /begincidchar\s+([\s\S]*?)\s+endcidchar/g;
  let cidCharMatch: RegExpExecArray | null;
  while ((cidCharMatch = cidCharRegex.exec(cmapContent)) !== null) {
    const lines = cidCharMatch[1].trim().split(/\r?\n/);
    for (const line of lines) {
      const tokens = line.trim().match(/<([0-9a-fA-F]+)>\s*([0-9]+)/);
      if (tokens) {
        const srcCode = parseInt(tokens[1], 16);
        const dstChar = String.fromCharCode(parseInt(tokens[2], 10));
        charMap.set(srcCode, dstChar);
      }
    }
  }

  return { name, charMap };
}

/**
 * Extracts and parses all embedded ToUnicode CMaps from a PDF document
 */
export function extractPdfFontCMaps(pdfBuffer: Buffer): Map<string, PdfToUnicodeCMap> {
  const binary = pdfBuffer.toString('binary');
  const cmaps = new Map<string, PdfToUnicodeCMap>();

  const streamRegex = /stream[\r\n]+([\s\S]*?)[\r\n]+endstream/g;
  let match: RegExpExecArray | null;

  while ((match = streamRegex.exec(binary)) !== null) {
    let content = '';
    const rawStream = Buffer.from(match[1], 'binary');
    try {
      content = zlib.inflateSync(rawStream).toString('latin1');
    } catch {
      try {
        content = zlib.inflateRawSync(rawStream).toString('latin1');
      } catch {
        content = match[1];
      }
    }

    if (content.includes('beginbfchar') || content.includes('beginbfrange') || content.includes('begincmap')) {
      const cmap = parseToUnicodeCMap(content);
      const key = cmap.name || `cmap_${cmaps.size}`;
      cmaps.set(key, cmap);
    }
  }

  return cmaps;
}

/**
 * Recursive XY-Cut++ Algorithm (Ha, Haralick, Phillips 1995; Meunier 2005)
 * Recursively partitions 2D spatial text blocks into natural human reading order
 * by projecting bounding boxes along alternating axes and locating projection valleys.
 */
export function recursiveXyCut(
  blocks: PdfTextBlock[],
  options: XyCutOptions = {}
): PdfTextBlock[] {
  if (blocks.length <= 1) return [...blocks];

  const minGapX = options.minGapX ?? 15; // Point width separating columns
  const minGapY = options.minGapY ?? 3; // Point height separating lines/paragraphs

  // 1. Calculate bounding box of current block group
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  for (const b of blocks) {
    if (b.x < minX) minX = b.x;
    if (b.x + b.width > maxX) maxX = b.x + b.width;
    if (b.y < minY) minY = b.y;
    if (b.y + b.height > maxY) maxY = b.y + b.height;
  }

  // 2. Try Vertical Cut (find vertical projection valleys along X-axis to split columns)
  const sortedByX = [...blocks].sort((a, b) => a.x - b.x);
  let bestXSplit = -1;
  let maxGapX = 0;

  for (let i = 0; i < sortedByX.length - 1; i++) {
    // Current rightmost boundary of left partition
    let leftRightmost = -Infinity;
    for (let j = 0; j <= i; j++) {
      if (sortedByX[j].x + sortedByX[j].width > leftRightmost) {
        leftRightmost = sortedByX[j].x + sortedByX[j].width;
      }
    }
    // Next block leftmost boundary
    const rightLeftmost = sortedByX[i + 1].x;
    const gap = rightLeftmost - leftRightmost;
    if (gap >= minGapX && gap > maxGapX) {
      maxGapX = gap;
      bestXSplit = i;
    }
  }

  if (bestXSplit !== -1) {
    const leftGroup = sortedByX.slice(0, bestXSplit + 1);
    const rightGroup = sortedByX.slice(bestXSplit + 1);
    return [
      ...recursiveXyCut(leftGroup, options),
      ...recursiveXyCut(rightGroup, options),
    ];
  }

  // 3. Try Horizontal Cut (find horizontal projection valleys along Y-axis to split paragraphs/lines)
  // PDF coordinate system: larger Y is near top of page, smaller Y is near bottom
  const sortedByYDesc = [...blocks].sort((a, b) => b.y - a.y);
  let bestYSplit = -1;
  let maxGapY = 0;

  for (let i = 0; i < sortedByYDesc.length - 1; i++) {
    // Current bottom boundary of top partition
    let topBottom = Infinity;
    for (let j = 0; j <= i; j++) {
      if (sortedByYDesc[j].y < topBottom) {
        topBottom = sortedByYDesc[j].y;
      }
    }
    // Next block top boundary
    const nextTop = sortedByYDesc[i + 1].y + sortedByYDesc[i + 1].height;
    const gap = topBottom - nextTop;
    if (gap >= minGapY && gap > maxGapY) {
      maxGapY = gap;
      bestYSplit = i;
    }
  }

  if (bestYSplit !== -1) {
    const topGroup = sortedByYDesc.slice(0, bestYSplit + 1);
    const bottomGroup = sortedByYDesc.slice(bestYSplit + 1);
    return [
      ...recursiveXyCut(topGroup, options),
      ...recursiveXyCut(bottomGroup, options),
    ];
  }

  // 4. Base sorting when no projection valley exists (line sorting: top-down, left-to-right)
  return [...blocks].sort((a, b) => {
    const yDiff = Math.abs(a.y - b.y);
    // If on roughly the same line (within 4 points), sort left to right
    if (yDiff <= 4) {
      return a.x - b.x;
    }
    // Otherwise top to bottom (descending Y in PDF)
    return b.y - a.y;
  });
}

/**
 * Extracts structured text blocks with layout coordinates and applies CMap resolution
 */
export function extractStructuredTextFromPdf(pdfBuffer: Buffer): {
  text: string;
  hasTextLayer: boolean;
  blocks: PdfTextBlock[];
  cmaps: Map<string, PdfToUnicodeCMap>;
} {
  const binary = pdfBuffer.toString('binary');
  if (!binary.includes('%PDF-')) {
    throw new Error('Invalid PDF document: missing %PDF- header');
  }

  const cmaps = extractPdfFontCMaps(pdfBuffer);
  // Default CMap if only one is available
  const defaultCMap = cmaps.size > 0 ? cmaps.values().next().value : undefined;

  const streamRegex = /stream[\r\n]+([\s\S]*?)[\r\n]+endstream/g;
  let match: RegExpExecArray | null;
  const rawBlocks: PdfTextBlock[] = [];

  while ((match = streamRegex.exec(binary)) !== null) {
    let content = '';
    const rawStream = Buffer.from(match[1], 'binary');
    try {
      content = zlib.inflateSync(rawStream).toString('latin1');
    } catch {
      try {
        content = zlib.inflateRawSync(rawStream).toString('latin1');
      } catch {
        content = match[1];
      }
    }

    const btRegex = /BT[\s\S]*?ET/g;
    let btMatch: RegExpExecArray | null;
    while ((btMatch = btRegex.exec(content)) !== null) {
      const block = btMatch[0];

      // Track text state
      let currX = 0;
      let currY = 0;
      let currFontSize = 12;
      let currFontName = '';

      // Font selection: /F1 12 Tf
      const tfRegex = /\/([a-zA-Z0-9_+\-]+)\s+([0-9.]+)\s+Tf/g;
      let tfMatch: RegExpExecArray | null;
      while ((tfMatch = tfRegex.exec(block)) !== null) {
        currFontName = tfMatch[1];
        currFontSize = parseFloat(tfMatch[2]) || 12;
      }

      const activeCMap = cmaps.get(currFontName) || defaultCMap;

      // Matrix operators: a b c d e f Tm
      const tmRegex = /([0-9.\-]+)\s+([0-9.\-]+)\s+([0-9.\-]+)\s+([0-9.\-]+)\s+([0-9.\-]+)\s+([0-9.\-]+)\s+Tm/g;
      let tmMatch: RegExpExecArray | null;
      while ((tmMatch = tmRegex.exec(block)) !== null) {
        currX = parseFloat(tmMatch[5]) || 0;
        currY = parseFloat(tmMatch[6]) || 0;
      }

      // Position operators: x y Td
      const tdRegex = /([0-9.\-]+)\s+([0-9.\-]+)\s+Td/g;
      let tdMatch: RegExpExecArray | null;
      while ((tdMatch = tdRegex.exec(block)) !== null) {
        currX += parseFloat(tdMatch[1]) || 0;
        currY += parseFloat(tdMatch[2]) || 0;
      }

      // 1. Array text operator: [...] TJ
      const tjRegex = /\[(.*?)\]\s*TJ/g;
      let tjArrayMatch: RegExpExecArray | null;
      while ((tjArrayMatch = tjRegex.exec(block)) !== null) {
        const inner = tjArrayMatch[1];
        const itemRegex = /\(((?:[^()\\]|\\.)*)\)|<([0-9a-fA-F\s]+)>/g;
        let itemMatch: RegExpExecArray | null;
        let line = '';
        while ((itemMatch = itemRegex.exec(inner)) !== null) {
          if (itemMatch[1] !== undefined) {
            line += unescapePdfString(itemMatch[1]);
          } else if (itemMatch[2] !== undefined) {
            line += activeCMap
              ? decodeWithCMap(itemMatch[2], activeCMap)
              : decodePdfHexString(itemMatch[2]);
          }
        }
        if (line.trim()) {
          rawBlocks.push({
            text: line.trim(),
            x: currX,
            y: currY,
            width: Math.max(10, line.length * (currFontSize * 0.5)),
            height: currFontSize,
            fontName: currFontName,
            fontSize: currFontSize,
          });
        }
      }

      // 2. Single text operator: (...) Tj or <...> Tj
      const singleTjRegex = /\(((?:[^()\\]|\\.)*)\)\s*Tj|<([0-9a-fA-F\s]+)>\s*Tj/g;
      let sMatch: RegExpExecArray | null;
      while ((sMatch = singleTjRegex.exec(block)) !== null) {
        let text = '';
        if (sMatch[1] !== undefined) {
          text = unescapePdfString(sMatch[1]);
        } else if (sMatch[2] !== undefined) {
          text = activeCMap
            ? decodeWithCMap(sMatch[2], activeCMap)
            : decodePdfHexString(sMatch[2]);
        }
        if (text.trim()) {
          rawBlocks.push({
            text: text.trim(),
            x: currX,
            y: currY,
            width: Math.max(10, text.length * (currFontSize * 0.5)),
            height: currFontSize,
            fontName: currFontName,
            fontSize: currFontSize,
          });
        }
      }

      // 3. Prime operators
      const primeRegex = /\(((?:[^()\\]|\\.)*)\)\s*['"]|<([0-9a-fA-F\s]+)>\s*['"]/g;
      let pMatch: RegExpExecArray | null;
      while ((pMatch = primeRegex.exec(block)) !== null) {
        let text = '';
        if (pMatch[1] !== undefined) {
          text = unescapePdfString(pMatch[1]);
        } else if (pMatch[2] !== undefined) {
          text = activeCMap
            ? decodeWithCMap(pMatch[2], activeCMap)
            : decodePdfHexString(pMatch[2]);
        }
        if (text.trim()) {
          rawBlocks.push({
            text: text.trim(),
            x: currX,
            y: currY,
            width: Math.max(10, text.length * (currFontSize * 0.5)),
            height: currFontSize,
            fontName: currFontName,
            fontSize: currFontSize,
          });
        }
      }
    }
  }

  // Apply Recursive XY-Cut++ reading order sorting
  const orderedBlocks = recursiveXyCut(rawBlocks);
  const text = orderedBlocks.map((b) => b.text).join('\n').trim();

  return {
    text: text || '',
    hasTextLayer: Boolean(text && text.length > 0),
    blocks: orderedBlocks,
    cmaps,
  };
}

/**
 * Extracts plain text from uncompressed or flate-compressed PDF streams
 * using CMap decoding and Recursive XY-Cut++ reading order
 */
export function extractTextFromPdf(pdfBuffer: Buffer): string {
  const result = extractStructuredTextFromPdf(pdfBuffer);
  return result.text;
}

/**
 * Extracts embedded image streams from PDF for OCR processing
 */
export function extractEmbeddedImageFromPdf(pdfBuffer: Buffer): Buffer | null {
  const binary = pdfBuffer.toString('binary');
  const dctRegex = /\/Filter\s*(\[\s*)?\/DCTDecode/i;
  const match = dctRegex.exec(binary);
  if (match) {
    const dctIndex = match.index;
    const streamStart = binary.indexOf('stream', dctIndex);
    if (streamStart !== -1) {
      const start =
        streamStart +
        (binary[streamStart + 6] === '\r' && binary[streamStart + 7] === '\n'
          ? 8
          : binary[streamStart + 6] === '\n'
          ? 7
          : 6);
      let end = binary.indexOf('endstream', start);
      if (end !== -1 && end > start) {
        if (binary[end - 1] === '\n') {
          end--;
          if (binary[end - 1] === '\r') {
            end--;
          }
        }
        return Buffer.from(binary.substring(start, end), 'binary');
      }
    }
  }
  return null;
}
