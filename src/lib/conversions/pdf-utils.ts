import { PayloadLimitError } from '../types';
import { PdfDocument } from './pdf-document';

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

/** Character codes one bfrange entry may map; a 2-byte code space has 0x10000. */
export const MAX_CMAP_RANGE_CODES = 0x10000;
/** Character mappings one CMap stream may write, counting repeated writes of the same code. */
export const MAX_CMAP_MAPPINGS = 0x40000;
/** Character mappings all CMaps of one document may hold together. */
export const MAX_PDF_CMAP_MAPPINGS = 0x80000;

/** Bodies between each `begin...` marker and the next `end...` marker, found without rescanning the stream. */
function* cmapSections(content: string, begin: string, end: string): Generator<string> {
  let from = 0;
  while (true) {
    const open = content.indexOf(begin, from);
    if (open === -1) return;
    const bodyStart = open + begin.length;
    const close = content.indexOf(end, bodyStart);
    if (close === -1) return;
    yield content.slice(bodyStart, close).trim();
    from = close + end.length;
  }
}

/**
 * Parses a PostScript Adobe ToUnicode CMap stream per ISO 32000-1 Section 9.10.
 * A bfrange past MAX_CMAP_RANGE_CODES, or a stream writing more than MAX_CMAP_MAPPINGS mappings,
 * throws a PayloadLimitError.
 */
export function parseToUnicodeCMap(cmapContent: string): PdfToUnicodeCMap {
  const charMap = new Map<number, string>();
  let name: string | undefined;
  let written = 0;
  const claim = (count: number): void => {
    written += count;
    if (written > MAX_CMAP_MAPPINGS) {
      throw new PayloadLimitError(`ToUnicode CMap writes more than ${MAX_CMAP_MAPPINGS} character mappings.`);
    }
  };

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
  for (const body of cmapSections(cmapContent, 'beginbfchar', 'endbfchar')) {
    const lines = body.split(/\r?\n/);
    for (const line of lines) {
      const tokens = line.trim().match(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/);
      if (tokens) {
        claim(1);
        const srcCode = parseInt(tokens[1], 16);
        const dstChar = decodeDstHex(tokens[2]);
        charMap.set(srcCode, dstChar);
      }
    }
  }

  // 2. beginbfrange ... endbfrange
  for (const content of cmapSections(cmapContent, 'beginbfrange', 'endbfrange')) {
    // Format 1: <start> <end> <destStart>
    const directRegex = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g;
    let dMatch: RegExpExecArray | null;
    while ((dMatch = directRegex.exec(content)) !== null) {
      const start = parseInt(dMatch[1], 16);
      const end = parseInt(dMatch[2], 16);
      const dstBase = parseInt(dMatch[3], 16);
      const count = end - start + 1;
      if (count > MAX_CMAP_RANGE_CODES) {
        throw new PayloadLimitError(`ToUnicode bfrange spans more than ${MAX_CMAP_RANGE_CODES} codes.`);
      }
      if (!(count > 0)) continue;
      claim(count);
      for (let code = start; code <= end; code++) {
        charMap.set(code, String.fromCharCode(dstBase + (code - start)));
      }
    }

    // Format 2: <start> <end> [ <dst1> <dst2> ... ]; the array decides how many codes are mapped
    const arrayRegex = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*\[/g;
    let aMatch: RegExpExecArray | null;
    while ((aMatch = arrayRegex.exec(content)) !== null) {
      const close = content.indexOf(']', arrayRegex.lastIndex);
      if (close === -1) break;
      const start = parseInt(aMatch[1], 16);
      const end = parseInt(aMatch[2], 16);
      const elements = content.slice(arrayRegex.lastIndex, close).match(/<([0-9a-fA-F]+)>/g) || [];
      arrayRegex.lastIndex = close + 1;
      const count = Math.min(end - start + 1, elements.length);
      if (!(count > 0)) continue;
      claim(count);
      for (let elemIdx = 0; elemIdx < count; elemIdx++) {
        charMap.set(start + elemIdx, decodeDstHex(elements[elemIdx]));
      }
    }
  }

  // 3. begincidchar ... endcidchar
  for (const body of cmapSections(cmapContent, 'begincidchar', 'endcidchar')) {
    const lines = body.split(/\r?\n/);
    for (const line of lines) {
      const tokens = line.trim().match(/<([0-9a-fA-F]+)>\s*([0-9]+)/);
      if (tokens) {
        claim(1);
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
  return collectFontCMaps(new PdfDocument(pdfBuffer));
}

function collectFontCMaps(document: PdfDocument): Map<string, PdfToUnicodeCMap> {
  const cmaps = new Map<string, PdfToUnicodeCMap>();
  let mappings = 0;
  document.toUnicodeStreams((content) => {
    if (content.includes('beginbfchar') || content.includes('beginbfrange') || content.includes('begincmap')) {
      const cmap = parseToUnicodeCMap(content);
      mappings += cmap.charMap.size;
      if (mappings > MAX_PDF_CMAP_MAPPINGS) {
        throw new PayloadLimitError(`PDF CMaps hold more than ${MAX_PDF_CMAP_MAPPINGS} character mappings.`);
      }
      const key = cmap.name || `cmap_${cmaps.size}`;
      cmaps.set(key, cmap);
    }
  });
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
  return xyCutGroup(blocks, options, 0);
}

/** Cut levels after which a group is ordered line by line instead of being cut further. */
export const MAX_XY_CUT_DEPTH = 128;

function xyCutGroup(blocks: PdfTextBlock[], options: XyCutOptions, depth: number): PdfTextBlock[] {
  if (blocks.length <= 1) return [...blocks];
  const cutting = depth < MAX_XY_CUT_DEPTH;

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

  // Rightmost boundary of the left partition, extended one block per step
  let leftRightmost = -Infinity;
  for (let i = 0; cutting && i < sortedByX.length - 1; i++) {
    leftRightmost = Math.max(leftRightmost, sortedByX[i].x + sortedByX[i].width);
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
      ...xyCutGroup(leftGroup, options, depth + 1),
      ...xyCutGroup(rightGroup, options, depth + 1),
    ];
  }

  // 3. Try Horizontal Cut (find horizontal projection valleys along Y-axis to split paragraphs/lines)
  // PDF coordinate system: larger Y is near top of page, smaller Y is near bottom
  const sortedByYDesc = [...blocks].sort((a, b) => b.y - a.y);
  let bestYSplit = -1;
  let maxGapY = 0;

  // Bottom boundary of the top partition, extended one block per step
  let topBottom = Infinity;
  for (let i = 0; cutting && i < sortedByYDesc.length - 1; i++) {
    topBottom = Math.min(topBottom, sortedByYDesc[i].y);
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
      ...xyCutGroup(topGroup, options, depth + 1),
      ...xyCutGroup(bottomGroup, options, depth + 1),
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

/** Text blocks one document may yield, counting every drawing of a form XObject. */
export const MAX_PDF_TEXT_BLOCKS = 100 * 1000;

const CHAR_TAB = 9;
const CHAR_LF = 10;
const CHAR_FF = 12;
const CHAR_CR = 13;
const CHAR_NUL = 0;
const CHAR_SPACE = 32;
const CHAR_LEFT_PAREN = 40;
const CHAR_RIGHT_PAREN = 41;
const CHAR_PLUS = 43;
const CHAR_MINUS = 45;
const CHAR_DOT = 46;
const CHAR_SLASH = 47;
const CHAR_DIGIT_0 = 48;
const CHAR_DIGIT_9 = 57;
const CHAR_PERCENT = 37;
const CHAR_LESS = 60;
const CHAR_GREATER = 62;
const CHAR_LEFT_BRACKET = 91;
const CHAR_BACKSLASH = 92;
const CHAR_RIGHT_BRACKET = 93;
const CHAR_LEFT_BRACE = 123;
const CHAR_RIGHT_BRACE = 125;

/** Operands kept while looking for the operator that consumes them; text operators take at most six. */
const MAX_TEXT_OPERANDS = 64;
const DEFAULT_FONT_SIZE = 12;
const TEXT_WIDTH_PER_POINT = 0.5;
const MIN_TEXT_WIDTH = 10;

const TEXT_DELIMITERS = new Set<number>([
  CHAR_LEFT_PAREN,
  CHAR_RIGHT_PAREN,
  CHAR_LESS,
  CHAR_GREATER,
  CHAR_LEFT_BRACKET,
  CHAR_RIGHT_BRACKET,
  CHAR_LEFT_BRACE,
  CHAR_RIGHT_BRACE,
  CHAR_SLASH,
  CHAR_PERCENT,
]);

/** One string operand: a literal with its escapes intact, or the digits of a hex string. */
interface TextItem {
  literal?: string;
  hex?: string;
}
interface NameOperand {
  name: string;
}
type TextOperand = number | NameOperand | TextItem | TextItem[];

/** What one BT..ET block says, before fonts and CMaps turn its strings into text. */
interface ScannedTextObject {
  fontName: string;
  fontSize: number;
  x: number;
  y: number;
  arrays: TextItem[][];
  shows: TextItem[];
  quotes: TextItem[];
}

function isTextSpace(code: number): boolean {
  return code === CHAR_SPACE || code === CHAR_LF || code === CHAR_CR || code === CHAR_TAB || code === CHAR_FF || code === CHAR_NUL;
}

function isTextRegular(code: number): boolean {
  return !Number.isNaN(code) && !isTextSpace(code) && !TEXT_DELIMITERS.has(code);
}

function isNumberChar(code: number): boolean {
  return (code >= CHAR_DIGIT_0 && code <= CHAR_DIGIT_9) || code === CHAR_DOT || code === CHAR_MINUS || code === CHAR_PLUS;
}

function isHexContent(text: string): boolean {
  let digits = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const isHexDigit =
      (code >= CHAR_DIGIT_0 && code <= CHAR_DIGIT_9) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102);
    if (isHexDigit) digits++;
    else if (!isTextSpace(code)) return false;
  }
  return digits > 0;
}

function isTextItem(operand: TextOperand | undefined): operand is TextItem {
  return typeof operand === 'object' && operand !== null && !Array.isArray(operand) && !('name' in operand);
}

/**
 * Reads the text operators of one BT..ET block in a single left-to-right pass: Tf, Tm and Td set the
 * font and position, TJ, Tj, ' and " show strings. Every position is advanced by at least one
 * character, so the cost is linear in the block whatever the operands look like.
 */
function scanTextObject(block: string): ScannedTextObject {
  const result: ScannedTextObject = { fontName: '', fontSize: DEFAULT_FONT_SIZE, x: 0, y: 0, arrays: [], shows: [], quotes: [] };
  let tmX = 0;
  let tmY = 0;
  let tdX = 0;
  let tdY = 0;
  let operands: TextOperand[] = [];
  let arrayItems: TextItem[] | null = null;
  const length = block.length;
  let pos = 0;

  const push = (operand: TextOperand): void => {
    operands.push(operand);
    if (operands.length >= 2 * MAX_TEXT_OPERANDS) operands = operands.slice(-MAX_TEXT_OPERANDS);
  };
  const addItem = (item: TextItem): void => {
    if (arrayItems) arrayItems.push(item);
    else push(item);
  };
  const lastNumbers = (count: number): number[] | null => {
    const tail = operands.slice(-count);
    return tail.length === count && tail.every((o) => typeof o === 'number') ? (tail as number[]) : null;
  };

  while (pos < length) {
    const code = block.charCodeAt(pos);
    if (isTextSpace(code)) {
      pos++;
    } else if (code === CHAR_PERCENT) {
      while (pos < length && block.charCodeAt(pos) !== CHAR_LF && block.charCodeAt(pos) !== CHAR_CR) pos++;
    } else if (code === CHAR_LEFT_PAREN) {
      let depth = 0;
      let i = pos;
      while (i < length) {
        const c = block.charCodeAt(i);
        if (c === CHAR_BACKSLASH) {
          i += 2;
          continue;
        }
        if (c === CHAR_LEFT_PAREN) depth++;
        if (c === CHAR_RIGHT_PAREN) {
          depth--;
          if (depth === 0) break;
        }
        i++;
      }
      if (i >= length) {
        pos = length; // unterminated string: nothing after it can be read
      } else {
        addItem({ literal: block.slice(pos + 1, i) });
        pos = i + 1;
      }
    } else if (code === CHAR_LESS) {
      if (block.charCodeAt(pos + 1) === CHAR_LESS) {
        pos += 2;
      } else {
        const close = block.indexOf('>', pos);
        if (close === -1) {
          pos = length;
        } else {
          const digits = block.slice(pos + 1, close);
          if (isHexContent(digits)) addItem({ hex: digits });
          pos = close + 1;
        }
      }
    } else if (code === CHAR_LEFT_BRACKET) {
      arrayItems = [];
      pos++;
    } else if (code === CHAR_RIGHT_BRACKET) {
      if (arrayItems) push(arrayItems);
      arrayItems = null;
      pos++;
    } else if (code === CHAR_SLASH) {
      let end = pos + 1;
      while (isTextRegular(block.charCodeAt(end))) end++;
      if (!arrayItems) push({ name: block.slice(pos + 1, end) });
      pos = end;
    } else if (isNumberChar(code)) {
      let end = pos + 1;
      while (isNumberChar(block.charCodeAt(end))) end++;
      if (!arrayItems) push(Number.parseFloat(block.slice(pos, end)) || 0);
      pos = end;
    } else if (isTextRegular(code)) {
      let end = pos + 1;
      while (isTextRegular(block.charCodeAt(end))) end++;
      const operator = block.slice(pos, end);
      pos = end;
      const last = operands[operands.length - 1];

      if (operator === 'Tf') {
        const [fontName, size] = operands.slice(-2);
        if (typeof fontName === 'object' && !Array.isArray(fontName) && 'name' in fontName && typeof size === 'number') {
          result.fontName = fontName.name;
          result.fontSize = size || DEFAULT_FONT_SIZE;
        }
      } else if (operator === 'Tm') {
        const matrix = lastNumbers(6);
        if (matrix) {
          tmX = matrix[4];
          tmY = matrix[5];
        }
      } else if (operator === 'Td') {
        const offset = lastNumbers(2);
        if (offset) {
          tdX += offset[0];
          tdY += offset[1];
        }
      } else if (operator === 'TJ') {
        if (Array.isArray(last)) result.arrays.push(last);
      } else if (operator === 'Tj') {
        if (isTextItem(last)) result.shows.push(last);
      } else if (operator === "'" || operator === '"') {
        if (isTextItem(last)) result.quotes.push(last);
      }
      operands = [];
      arrayItems = null;
    } else {
      pos++; // a stray delimiter such as ')', '>', '{' or '}'
    }
  }

  result.x = tmX + tdX;
  result.y = tmY + tdY;
  return result;
}

/**
 * Appends the positioned text of every BT..ET block of one decoded content stream to `rawBlocks`.
 * Past MAX_PDF_TEXT_BLOCKS blocks in the document it throws a PayloadLimitError.
 */
function appendTextBlocks(
  content: string,
  cmaps: Map<string, PdfToUnicodeCMap>,
  defaultCMap: PdfToUnicodeCMap | undefined,
  rawBlocks: PdfTextBlock[]
): void {
  // Same blocks as /BT[\s\S]*?ET/g, found with indexOf so an unterminated BT cannot rescan the stream.
  let searchFrom = 0;
  while (true) {
    const open = content.indexOf('BT', searchFrom);
    if (open === -1) break;
    const close = content.indexOf('ET', open + 2);
    if (close === -1) break;
    const scanned = scanTextObject(content.slice(open, close + 2));
    searchFrom = close + 2;

    const activeCMap = cmaps.get(scanned.fontName) || defaultCMap;
    const decode = (item: TextItem): string => {
      if (item.literal !== undefined) return unescapePdfString(item.literal);
      const hex = item.hex ?? '';
      return activeCMap ? decodeWithCMap(hex, activeCMap) : decodePdfHexString(hex);
    };
    const emit = (text: string): void => {
      if (!text.trim()) return;
      if (rawBlocks.length >= MAX_PDF_TEXT_BLOCKS) {
        throw new PayloadLimitError(`PDF yields more than ${MAX_PDF_TEXT_BLOCKS} text blocks.`);
      }
      rawBlocks.push({
        text: text.trim(),
        x: scanned.x,
        y: scanned.y,
        width: Math.max(MIN_TEXT_WIDTH, text.length * (scanned.fontSize * TEXT_WIDTH_PER_POINT)),
        height: scanned.fontSize,
        fontName: scanned.fontName,
        fontSize: scanned.fontSize,
      });
    };

    for (const array of scanned.arrays) emit(array.map(decode).join(''));
    for (const item of scanned.shows) emit(decode(item));
    for (const item of scanned.quotes) emit(decode(item));
  }
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
  if (!pdfBuffer.includes('%PDF-')) {
    throw new Error('Invalid PDF document: missing %PDF- header');
  }

  // Only the content streams a page draws are decoded (see PdfDocument), each within the stream cap and
  // the document budget, so unreferenced, superseded and image streams never contribute text.
  const document = new PdfDocument(pdfBuffer);
  const cmaps = collectFontCMaps(document);
  // Default CMap if only one is available
  const defaultCMap = cmaps.size > 0 ? cmaps.values().next().value : undefined;

  const rawBlocks: PdfTextBlock[] = [];
  document.contentStreams((content) => appendTextBlocks(content, cmaps, defaultCMap, rawBlocks));

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
