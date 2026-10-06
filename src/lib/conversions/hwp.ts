import zlib from 'node:zlib';
import JSZip from 'jszip';
import sharp from 'sharp';
import { ConversionOptions, ConversionResult, CorruptStreamError } from '../types';
import { InflateBudget, inflateBounded } from './bounded-inflate';
import { encodeBmp } from './image';
import { buildOpenXpsPackage } from './openxps';
import { assertNoComplexScript } from './ctl';
import { renderPdfBlocks, type PdfBlock } from './pdf-blocks';

/**
 * HWP 5.0 Record Tag IDs
 */
export const HWP_TAGS = {
  DOCUMENT_PROPERTIES: 16,
  ID_MAPPINGS: 17,
  BIN_DATA: 18,
  FACE_NAME: 19,
  BORDER_FILL: 20,
  CHAR_SHAPE: 21,
  TAB_DEF: 22,
  NUMBERING: 23,
  BULLET: 24,
  PARA_SHAPE: 25,
  STYLE: 26,
  DOC_DATA: 27,
  DISTRIBUTE_DOC_DATA: 28,

  // Section / BodyText Tags
  PARA_HEADER: 66,
  PARA_TEXT: 67,
  PARA_CHAR_SHAPE: 68,
  PARA_LINE_SEG: 69,
  PARA_RANGE_TAG: 70,
  CTRL_HEADER: 71,
  LIST_HEADER: 72,
  PAGE_DEF: 73,
  FOOTNOTE: 74,
  PAGE_BORDER_FILL: 75,
  SHAPE_COMPONENT: 76,
  TABLE: 77,
  SHAPE_COMPONENT_LINE: 78,
  SHAPE_COMPONENT_RECTANGLE: 79,
  SHAPE_COMPONENT_ELLIPSE: 80,
  SHAPE_COMPONENT_ARC: 81,
  SHAPE_COMPONENT_POLYGON: 82,
  SHAPE_COMPONENT_CURVE: 83,
  SHAPE_COMPONENT_OLE: 84,
  SHAPE_COMPONENT_PICTURE: 85,
  SHAPE_COMPONENT_CONTAINER: 86,
  CTRL_DATA: 87,
  EQEDIT: 88,
} as const;

export interface HwpEquation {
  script: string;
  mathml: string;
  latex: string;
}

export interface HwpParagraph {
  text: string;
  isHeading: boolean;
  isBold: boolean;
  isItalic: boolean;
  equations?: HwpEquation[];
}

export interface HwpTable {
  rowCount: number;
  colCount: number;
  rows: string[][];
}

export interface HwpDocument {
  version: string;
  isCompressed: boolean;
  isEncrypted: boolean;
  isDistributed: boolean;
  paragraphs: HwpParagraph[];
  tables: HwpTable[];
  equations?: HwpEquation[];
  metadata: {
    title?: string;
    author?: string;
    creator?: string;
    date?: string;
  };
}

export interface CfbfDirectoryEntry {
  id: number;
  name: string;
  type: number; // 1: Storage, 2: Stream, 5: Root
  startingSector: number;
  streamSize: number;
  childId: number;
  leftSiblingId: number;
  rightSiblingId: number;
}

export interface CfbfContainer {
  sectorSize: number;
  miniSectorSize: number;
  directoryEntries: CfbfDirectoryEntry[];
  streams: Map<string, Buffer>;
}

/**
 * Validates whether buffer has the OLE2 Compound File Binary Format (CFBF) header
 */
export function isCfbfContainer(buffer: Buffer): boolean {
  if (buffer.length < 512) return false;
  const signature = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  for (let i = 0; i < 8; i++) {
    if (buffer[i] !== signature[i]) return false;
  }
  return true;
}

/**
 * Parses an authentic OLE2 CFBF container:
 * 512-byte header, SAT/FAT sectors, Directory Entries, MiniFAT and MiniStream.
 */
export function parseCfbf(buffer: Buffer): CfbfContainer {
  if (!isCfbfContainer(buffer)) {
    throw new Error('Invalid CFBF container: Missing OLE2 magic signature.');
  }

  // Header fields
  const sectorShift = buffer.readUInt16LE(30);
  const miniSectorShift = buffer.readUInt16LE(32);
  const sectorSize = 1 << sectorShift; // Typically 512
  const miniSectorSize = 1 << miniSectorShift; // Typically 64

  const fatSectorCount = buffer.readUInt32LE(44);
  const firstDirSector = buffer.readUInt32LE(48);
  const miniStreamCutoff = buffer.readUInt32LE(56); // Typically 4096
  const firstMiniFatSector = buffer.readUInt32LE(60);
  const miniFatSectorCount = buffer.readUInt32LE(64);
  const firstDifatSector = buffer.readUInt32LE(68);
  const difatSectorCount = buffer.readUInt32LE(72);

  // 1. Collect all FAT sector IDs from header (up to 109) and additional DIFAT sectors
  const fatSectorIds: number[] = [];
  for (let i = 0; i < 109; i++) {
    const sId = buffer.readUInt32LE(76 + i * 4);
    if (sId < 0xfffffffa && fatSectorIds.length < fatSectorCount) {
      fatSectorIds.push(sId);
    }
  }

  let currDifatSector = firstDifatSector;
  let difatSectorsRead = 0;
  const visitedDifat = new Set<number>();
  while (currDifatSector < 0xfffffffa && difatSectorsRead < difatSectorCount && !visitedDifat.has(currDifatSector)) {
    visitedDifat.add(currDifatSector);
    const offset = (currDifatSector + 1) * sectorSize;
    if (offset + sectorSize > buffer.length) break;
    const entriesInSector = (sectorSize / 4) - 1;
    for (let i = 0; i < entriesInSector; i++) {
      const sId = buffer.readUInt32LE(offset + i * 4);
      if (sId < 0xfffffffa && fatSectorIds.length < fatSectorCount) {
        fatSectorIds.push(sId);
      }
    }
    currDifatSector = buffer.readUInt32LE(offset + entriesInSector * 4);
    difatSectorsRead++;
  }

  // 2. Build the unified FAT table (mapping sector -> next sector)
  const fatEntriesPerSector = sectorSize / 4;
  const totalFatEntries = fatSectorIds.length * fatEntriesPerSector;
  const fat = new Uint32Array(totalFatEntries);

  for (let fIdx = 0; fIdx < fatSectorIds.length; fIdx++) {
    const sId = fatSectorIds[fIdx];
    const offset = (sId + 1) * sectorSize;
    if (offset + sectorSize > buffer.length) break;
    for (let e = 0; e < fatEntriesPerSector; e++) {
      fat[fIdx * fatEntriesPerSector + e] = buffer.readUInt32LE(offset + e * 4);
    }
  }

  // Helper to read a sector chain from the main FAT
  function readSectorChain(startSector: number, maxBytes?: number): Buffer {
    if (startSector >= 0xfffffffa) return Buffer.alloc(0);
    const chunks: Buffer[] = [];
    let curr = startSector;
    let bytesRead = 0;
    const visited = new Set<number>();

    while (curr < 0xfffffffa && !visited.has(curr)) {
      visited.add(curr);
      const offset = (curr + 1) * sectorSize;
      if (offset >= buffer.length) break;
      const len = Math.min(sectorSize, buffer.length - offset);
      chunks.push(Buffer.from(buffer.subarray(offset, offset + len)));
      bytesRead += len;
      if (maxBytes && bytesRead >= maxBytes) break;
      if (curr >= fat.length) break;
      curr = fat[curr];
    }

    const res = Buffer.concat(chunks);
    return maxBytes && res.length > maxBytes ? Buffer.from(res.subarray(0, maxBytes)) : res;
  }

  // 3. Read Directory stream
  const dirBuffer = readSectorChain(firstDirSector);
  const dirEntrySize = 128;
  const entryCount = Math.floor(dirBuffer.length / dirEntrySize);
  const directoryEntries: CfbfDirectoryEntry[] = [];

  for (let i = 0; i < entryCount; i++) {
    const off = i * dirEntrySize;
    const nameLen = dirBuffer.readUInt16LE(off + 64);
    if (nameLen <= 0) continue;

    // Decode UTF-16LE name
    const rawNameLen = Math.max(0, Math.min(64, nameLen - 2));
    const name = dirBuffer.toString('utf16le', off, off + rawNameLen).replace(/\0+$/, '');
    const type = dirBuffer.readUInt8(off + 66);
    const leftSiblingId = dirBuffer.readUInt32LE(off + 68);
    const rightSiblingId = dirBuffer.readUInt32LE(off + 72);
    const childId = dirBuffer.readUInt32LE(off + 76);
    const startingSector = dirBuffer.readUInt32LE(off + 116);
    const streamSize = Number(dirBuffer.readBigUInt64LE ? dirBuffer.readBigUInt64LE(off + 120) : dirBuffer.readUInt32LE(off + 120));

    directoryEntries.push({
      id: i,
      name,
      type,
      startingSector,
      streamSize,
      childId,
      leftSiblingId,
      rightSiblingId,
    });
  }

  // 4. Build MiniFAT table
  let miniFat: Uint32Array = new Uint32Array(0);
  if (miniFatSectorCount > 0 && firstMiniFatSector < 0xfffffffa) {
    const miniFatBuffer = readSectorChain(firstMiniFatSector, miniFatSectorCount * sectorSize);
    miniFat = new Uint32Array(Math.floor(miniFatBuffer.length / 4));
    for (let i = 0; i < miniFat.length; i++) {
      miniFat[i] = miniFatBuffer.readUInt32LE(i * 4);
    }
  }

  // 5. MiniStream buffer (stored in Root Entry starting sector)
  const rootEntry = directoryEntries.find((d) => d.type === 5) || directoryEntries[0];
  let miniStreamBuffer: Buffer = Buffer.alloc(0);
  if (rootEntry && rootEntry.startingSector < 0xfffffffa && rootEntry.streamSize > 0) {
    miniStreamBuffer = Buffer.from(readSectorChain(rootEntry.startingSector, rootEntry.streamSize));
  }

  // Helper to read mini sector chain
  function readMiniSectorChain(startMiniSector: number, size: number): Buffer {
    if (startMiniSector >= 0xfffffffa || miniStreamBuffer.length === 0) return Buffer.alloc(0);
    const chunks: Buffer[] = [];
    let curr = startMiniSector;
    let bytesRead = 0;
    const visited = new Set<number>();

    while (curr < 0xfffffffa && !visited.has(curr)) {
      visited.add(curr);
      const offset = curr * miniSectorSize;
      if (offset >= miniStreamBuffer.length) break;
      const len = Math.min(miniSectorSize, miniStreamBuffer.length - offset);
      chunks.push(Buffer.from(miniStreamBuffer.subarray(offset, offset + len)));
      bytesRead += len;
      if (bytesRead >= size) break;
      if (curr >= miniFat.length) break;
      curr = miniFat[curr];
    }

    const res = Buffer.concat(chunks);
    return res.length > size ? Buffer.from(res.subarray(0, size)) : res;
  }

  // 6. Extract all streams into a lookup map
  const streams = new Map<string, Buffer>();

  // Build full hierarchy paths (e.g. BodyText/Section0)
  function resolveStreamPaths() {
    for (const entry of directoryEntries) {
      if (entry.type === 2 && entry.streamSize > 0) {
        let streamData: Buffer;
        if (entry.streamSize < miniStreamCutoff && miniStreamBuffer.length > 0) {
          streamData = readMiniSectorChain(entry.startingSector, entry.streamSize);
        } else {
          streamData = readSectorChain(entry.startingSector, entry.streamSize);
        }
        streams.set(entry.name, streamData);
      }
    }
  }

  resolveStreamPaths();

  return {
    sectorSize,
    miniSectorSize,
    directoryEntries,
    streams,
  };
}

/**
 * Decompresses a compressed HWP stream. HWP 5.0 stores bare deflate and the format declares no
 * decoded size, so the output is bounded by the per-stream cap and, through `budget`, the decoded-byte
 * budget of the whole document. A zlib-wrapped stream is accepted too. Data that is neither throws a
 * CorruptStreamError, and one that decodes past a bound throws a DecompressionLimitError.
 */
export function decompressHwpStream(buf: Buffer, budget?: InflateBudget, streamName = 'stream'): Buffer {
  const label = `HWP ${streamName}`;
  try {
    return inflateBounded(buf, { label, format: 'raw', budget });
  } catch (err) {
    if (!(err instanceof CorruptStreamError)) throw err;
  }
  return inflateBounded(buf, { label, format: 'zlib', budget });
}

/**
 * HWP 5.0 Record representation
 */
export interface HwpRecord {
  tagId: number;
  level: number;
  size: number;
  payload: Buffer;
}

/**
 * Builds an HWP 5.0 record buffer with support for extended sizes (>= 0xFFF)
 */
export function buildHwpRecord(tagId: number, level: number, payload: Buffer): Buffer {
  const size = payload.length;
  if (size < 0xfff) {
    const header = ((tagId & 0x3ff) | ((level & 0x3ff) << 10) | ((size & 0xfff) << 20)) >>> 0;
    const rec = Buffer.alloc(4 + size);
    rec.writeUInt32LE(header, 0);
    payload.copy(rec, 4);
    return rec;
  } else {
    const header = ((tagId & 0x3ff) | ((level & 0x3ff) << 10) | (0xfff << 20)) >>> 0;
    const rec = Buffer.alloc(4 + 4 + size);
    rec.writeUInt32LE(header, 0);
    rec.writeUInt32LE(size, 4);
    payload.copy(rec, 8);
    return rec;
  }
}

/**
 * Parses sequential HWP 5.0 records from a decompressed stream buffer
 */
export function parseHwpRecords(buffer: Buffer): HwpRecord[] {
  const records: HwpRecord[] = [];
  let offset = 0;

  while (offset + 4 <= buffer.length) {
    const header = buffer.readUInt32LE(offset);
    offset += 4;

    const tagId = header & 0x3ff;
    const level = (header >> 10) & 0x3ff;
    let size = (header >> 20) & 0xfff;

    if (size === 0xfff) {
      if (offset + 4 > buffer.length) break;
      size = buffer.readUInt32LE(offset);
      offset += 4;
    }

    if (offset + size > buffer.length) {
      // Malformed or truncated record: take remainder
      const payload = Buffer.from(buffer.subarray(offset));
      records.push({ tagId, level, size: payload.length, payload });
      break;
    }

    const payload = Buffer.from(buffer.subarray(offset, offset + size));
    offset += size;

    records.push({ tagId, level, size, payload });
  }

  return records;
}

/**
 * Cleans HWP 5.0 UTF-16LE text by filtering inline control codes (< 0x20)
 * while preserving standard whitespace (tabs, newlines).
 * Avoids call stack overflow by chunking character code string generation.
 */
export function decodeHwpText(buffer: Buffer): string {
  if (buffer.length < 2) return '';
  const charCodes: number[] = [];
  const charCount = Math.floor(buffer.length / 2);

  for (let i = 0; i < charCount; i++) {
    const code = buffer.readUInt16LE(i * 2);
    // Preserved control characters: 0x0009 (tab), 0x000A (newline), 0x000D (carriage return)
    if (code === 0x0009 || code === 0x000a || code === 0x000d) {
      charCodes.push(code);
    } else if (code >= 0x0020) {
      // Normal printable unicode character
      charCodes.push(code);
    }
  }

  let result = '';
  const chunkSize = 4096;
  for (let i = 0; i < charCodes.length; i += chunkSize) {
    result += String.fromCharCode(...charCodes.slice(i, i + chunkSize));
  }
  return result;
}

// ============================================================================
// HWP EqEdit Equation Parser & MathML / LaTeX Transpiler
// ============================================================================

export const HWP_EQ_GREEK: Record<string, { mathml: string; latex: string }> = {
  alpha: { mathml: 'α', latex: '\\alpha' },
  beta: { mathml: 'β', latex: '\\beta' },
  gamma: { mathml: 'γ', latex: '\\gamma' },
  delta: { mathml: 'δ', latex: '\\delta' },
  epsilon: { mathml: 'ε', latex: '\\epsilon' },
  zeta: { mathml: 'ζ', latex: '\\zeta' },
  eta: { mathml: 'η', latex: '\\eta' },
  theta: { mathml: 'θ', latex: '\\theta' },
  iota: { mathml: 'ι', latex: '\\iota' },
  kappa: { mathml: 'κ', latex: '\\kappa' },
  lambda: { mathml: 'λ', latex: '\\lambda' },
  mu: { mathml: 'μ', latex: '\\mu' },
  nu: { mathml: 'ν', latex: '\\nu' },
  xi: { mathml: 'ξ', latex: '\\xi' },
  pi: { mathml: 'π', latex: '\\pi' },
  rho: { mathml: 'ρ', latex: '\\rho' },
  sigma: { mathml: 'σ', latex: '\\sigma' },
  tau: { mathml: 'τ', latex: '\\tau' },
  upsilon: { mathml: 'υ', latex: '\\upsilon' },
  phi: { mathml: 'φ', latex: '\\phi' },
  chi: { mathml: 'χ', latex: '\\chi' },
  psi: { mathml: 'ψ', latex: '\\psi' },
  omega: { mathml: 'ω', latex: '\\omega' },
  Gamma: { mathml: 'Γ', latex: '\\Gamma' },
  Delta: { mathml: 'Δ', latex: '\\Delta' },
  Theta: { mathml: 'Θ', latex: '\\Theta' },
  Lambda: { mathml: 'Λ', latex: '\\Lambda' },
  Xi: { mathml: 'Ξ', latex: '\\Xi' },
  Pi: { mathml: 'Π', latex: '\\Pi' },
  Sigma: { mathml: 'Σ', latex: '\\Sigma' },
  Phi: { mathml: 'Φ', latex: '\\Phi' },
  Psi: { mathml: 'Ψ', latex: '\\Psi' },
  Omega: { mathml: 'Ω', latex: '\\Omega' },
};

export const HWP_EQ_SYMBOLS: Record<string, { mathml: string; latex: string }> = {
  pm: { mathml: '±', latex: '\\pm' },
  times: { mathml: '×', latex: '\\times' },
  div: { mathml: '÷', latex: '\\div' },
  cdot: { mathml: '·', latex: '\\cdot' },
  circ: { mathml: '∘', latex: '\\circ' },
  le: { mathml: '≤', latex: '\\le' },
  ge: { mathml: '≥', latex: '\\ge' },
  ne: { mathml: '≠', latex: '\\ne' },
  approx: { mathml: '≈', latex: '\\approx' },
  to: { mathml: '→', latex: '\\to' },
  rightarrow: { mathml: '→', latex: '\\to' },
  leftarrow: { mathml: '←', latex: '\\leftarrow' },
  infty: { mathml: '∞', latex: '\\infty' },
  inf: { mathml: '∞', latex: '\\infty' },
};

/**
 * Transpiles an HWP EqEdit equation script to W3C MathML
 */
export function hwpEquationToMathML(script: string): string {
  const trimmed = script.trim();
  if (!trimmed) return '<math></math>';

  // Handle { A } over { B } fractions
  const overMatch = /^(.*?)\{([^{}]+)\}\s*over\s*\{([^{}]+)\}(.*)$/i.exec(trimmed);
  if (overMatch) {
    const prefix = overMatch[1].trim() ? hwpEquationToMathML(overMatch[1]).replace(/^<math>|<\/math>$/g, '') : '';
    const num = hwpEquationToMathML(overMatch[2]).replace(/^<math>|<\/math>$/g, '');
    const den = hwpEquationToMathML(overMatch[3]).replace(/^<math>|<\/math>$/g, '');
    const suffix = overMatch[4].trim() ? hwpEquationToMathML(overMatch[4]).replace(/^<math>|<\/math>$/g, '') : '';
    return `<math>${prefix}<mfrac><mrow>${num}</mrow><mrow>${den}</mrow></mfrac>${suffix}</math>`;
  }

  // Handle sqrt { A }
  const sqrtMatch = /^(.*?)sqrt\s*\{([^{}]+)\}(.*)$/i.exec(trimmed);
  if (sqrtMatch) {
    const prefix = sqrtMatch[1].trim() ? hwpEquationToMathML(sqrtMatch[1]).replace(/^<math>|<\/math>$/g, '') : '';
    const inner = hwpEquationToMathML(sqrtMatch[2]).replace(/^<math>|<\/math>$/g, '');
    const suffix = sqrtMatch[3].trim() ? hwpEquationToMathML(sqrtMatch[3]).replace(/^<math>|<\/math>$/g, '') : '';
    return `<math>${prefix}<msqrt><mrow>${inner}</mrow></msqrt>${suffix}</math>`;
  }

  // Handle root { n } of { A }
  const rootMatch = /^(.*?)root\s*\{([^{}]+)\}\s*of\s*\{([^{}]+)\}(.*)$/i.exec(trimmed);
  if (rootMatch) {
    const prefix = rootMatch[1].trim() ? hwpEquationToMathML(rootMatch[1]).replace(/^<math>|<\/math>$/g, '') : '';
    const deg = hwpEquationToMathML(rootMatch[2]).replace(/^<math>|<\/math>$/g, '');
    const base = hwpEquationToMathML(rootMatch[3]).replace(/^<math>|<\/math>$/g, '');
    const suffix = rootMatch[4].trim() ? hwpEquationToMathML(rootMatch[4]).replace(/^<math>|<\/math>$/g, '') : '';
    return `<math>${prefix}<mroot><mrow>${base}</mrow><mrow>${deg}</mrow></mroot>${suffix}</math>`;
  }

  // Handle sum_{A}^{B} or int_{A}^{B}
  const bigopMatch = /^(.*?)(sum|int|prod|lim)(?:_\{([^{}]+)\})?(?:\^\{([^{}]+)\})?(.*)$/i.exec(trimmed);
  if (bigopMatch) {
    const prefix = bigopMatch[1].trim() ? hwpEquationToMathML(bigopMatch[1]).replace(/^<math>|<\/math>$/g, '') : '';
    const opName = bigopMatch[2].toLowerCase();
    const sub = bigopMatch[3] ? hwpEquationToMathML(bigopMatch[3]).replace(/^<math>|<\/math>$/g, '') : null;
    const sup = bigopMatch[4] ? hwpEquationToMathML(bigopMatch[4]).replace(/^<math>|<\/math>$/g, '') : null;
    const suffix = bigopMatch[5].trim() ? hwpEquationToMathML(bigopMatch[5]).replace(/^<math>|<\/math>$/g, '') : '';
    const opGlyph = opName === 'sum' ? '∑' : opName === 'int' ? '∫' : opName === 'prod' ? '∏' : 'lim';

    let opTag = '';
    if (sub && sup) {
      opTag = `<munderover><mo>${opGlyph}</mo><mrow>${sub}</mrow><mrow>${sup}</mrow></munderover>`;
    } else if (sub) {
      opTag = `<munder><mo>${opGlyph}</mo><mrow>${sub}</mrow></munder>`;
    } else if (sup) {
      opTag = `<mover><mo>${opGlyph}</mo><mrow>${sup}</mrow></mover>`;
    } else {
      opTag = `<mo>${opGlyph}</mo>`;
    }

    return `<math>${prefix}${opTag}${suffix}</math>`;
  }

  // Tokenize identifiers, numbers, operators, greek, spaces
  const tokens = trimmed.match(/[a-zA-Z]+|[0-9.]+|<=|>=|!=|\+-|->|<-|[+\-*/=^_{}()~`,]|./g) || [];
  let mathmlContent = '';

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (HWP_EQ_GREEK[tok]) {
      mathmlContent += `<mi>${HWP_EQ_GREEK[tok].mathml}</mi>`;
    } else if (HWP_EQ_SYMBOLS[tok]) {
      mathmlContent += `<mo>${HWP_EQ_SYMBOLS[tok].mathml}</mo>`;
    } else if (/^[0-9.]+$/.test(tok)) {
      mathmlContent += `<mn>${tok}</mn>`;
    } else if (/^[a-zA-Z]$/.test(tok)) {
      mathmlContent += `<mi>${tok}</mi>`;
    } else if (/^[+\-*/=<>]$/.test(tok)) {
      mathmlContent += `<mo>${tok}</mo>`;
    } else if (tok === '^' && i + 1 < tokens.length) {
      const next = tokens[++i].replace(/[{}]/g, '');
      mathmlContent += `<msup><mrow>${mathmlContent ? '' : '<mi></mi>'}</mrow><mn>${next}</mn></msup>`;
    } else if (tok === '_' && i + 1 < tokens.length) {
      const next = tokens[++i].replace(/[{}]/g, '');
      mathmlContent += `<msub><mrow>${mathmlContent ? '' : '<mi></mi>'}</mrow><mn>${next}</mn></msub>`;
    } else if (tok === '~') {
      mathmlContent += `<mspace width="1em"/>`;
    } else if (tok === '`') {
      mathmlContent += `<mspace width="0.16em"/>`;
    } else if (tok !== '{' && tok !== '}') {
      mathmlContent += `<mo>${tok}</mo>`;
    }
  }

  return `<math>${mathmlContent}</math>`;
}

/**
 * Transpiles an HWP EqEdit equation script to LaTeX
 */
export function hwpEquationToLaTeX(script: string): string {
  let tex = script.trim();
  if (!tex) return '';

  tex = tex.replace(/\{([^{}]+)\}\s*over\s*\{([^{}]+)\}/gi, '\\frac{$1}{$2}');
  tex = tex.replace(/([a-zA-Z0-9]+)\s*over\s*([a-zA-Z0-9]+)/gi, '\\frac{$1}{$2}');
  tex = tex.replace(/sqrt\s*\{([^{}]+)\}/gi, '\\sqrt{$1}');
  tex = tex.replace(/root\s*\{([^{}]+)\}\s*of\s*\{([^{}]+)\}/gi, '\\sqrt[$1]{$2}');

  for (const [key, val] of Object.entries(HWP_EQ_GREEK)) {
    const re = new RegExp(`\\b${key}(?=[^a-zA-Z]|$)`, 'g');
    tex = tex.replace(re, val.latex);
  }

  for (const [key, val] of Object.entries(HWP_EQ_SYMBOLS)) {
    const re = new RegExp(`\\b${key}(?=[^a-zA-Z]|$)`, 'g');
    tex = tex.replace(re, val.latex);
  }

  tex = tex.replace(/\+-/g, '\\pm ');
  tex = tex.replace(/<=/g, '\\le ');
  tex = tex.replace(/>=/g, '\\ge ');
  tex = tex.replace(/!=/g, '\\ne ');
  tex = tex.replace(/->/g, '\\to ');
  tex = tex.replace(/<-/g, '\\leftarrow ');
  tex = tex.replace(/~/g, '\\quad ');
  tex = tex.replace(/`/g, '\\, ');

  tex = tex.replace(/\b(sum|int|prod|lim)(?=[^a-zA-Z]|$)/gi, '\\$1');

  return tex;
}

/**
 * Parses full HWP 5.0 document from binary buffer (CFBF container or raw fallback)
 */
export function parseHwpDocument(inputBuffer: Buffer): HwpDocument {
  // If not CFBF, check if it's plaintext fallback
  if (!isCfbfContainer(inputBuffer)) {
    const rawText = inputBuffer.toString('utf-8');
    const lines = rawText.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const paragraphs: HwpParagraph[] = lines.map((line, idx) => ({
      text: line.trim(),
      isHeading: idx === 0 && line.length < 60,
      isBold: idx === 0,
      isItalic: false,
    }));
    return {
      version: '5.0.0.0',
      isCompressed: false,
      isEncrypted: false,
      isDistributed: false,
      paragraphs: paragraphs.length > 0 ? paragraphs : [{ text: 'Hangul Document', isHeading: true, isBold: true, isItalic: false }],
      tables: [],
      metadata: { title: paragraphs[0]?.text },
    };
  }

  const cfbf = parseCfbf(inputBuffer);

  // 1. FileHeader
  const fileHeaderBuf = cfbf.streams.get('FileHeader') || cfbf.streams.get('fileheader');
  let version = '5.0.0.0';
  let isCompressed = false;
  let isEncrypted = false;
  let isDistributed = false;

  if (fileHeaderBuf && fileHeaderBuf.length >= 40) {
    const verNum = fileHeaderBuf.readUInt32LE(32);
    const major = (verNum >> 24) & 0xff;
    const minor = (verNum >> 16) & 0xff;
    const rev = (verNum >> 8) & 0xff;
    const build = verNum & 0xff;
    version = `${major}.${minor}.${rev}.${build}`;

    const flags = fileHeaderBuf.readUInt32LE(36);
    isCompressed = (flags & 0x01) !== 0;
    isEncrypted = (flags & 0x02) !== 0;
    isDistributed = (flags & 0x04) !== 0;
  }

  // Fail-closed on password-protected documents
  if (isEncrypted) {
    throw new Error('Encrypted HWP documents with password protection cannot be converted without credentials.');
  }

  // 2. BodyText Section streams (Section0, Section1, ...)
  const sectionBuffers: Buffer[] = [];
  const inflateBudget = new InflateBudget();
  for (const [name, stream] of cfbf.streams.entries()) {
    if (/section\d+/i.test(name)) {
      sectionBuffers.push(isCompressed ? decompressHwpStream(stream, inflateBudget, name) : stream);
    }
  }

  // If no explicitly named section, check any stream matching bodytext or fallback to any non-fileheader stream
  if (sectionBuffers.length === 0) {
    for (const [name, stream] of cfbf.streams.entries()) {
      if (name !== 'FileHeader' && name !== 'DocInfo') {
        sectionBuffers.push(isCompressed ? decompressHwpStream(stream, inflateBudget, name) : stream);
      }
    }
  }

  const paragraphs: HwpParagraph[] = [];
  const tables: HwpTable[] = [];
  const allEquations: HwpEquation[] = [];

  for (const secBuf of sectionBuffers) {
    const records = parseHwpRecords(secBuf);
    let currentTable: HwpTable | null = null;
    let currentCellRows: string[][] = [];
    let currentCellText: string[] = [];

    for (let rIdx = 0; rIdx < records.length; rIdx++) {
      const rec = records[rIdx];

      // HWPTAG_PARA_TEXT (67)
      if (rec.tagId === HWP_TAGS.PARA_TEXT) {
        const text = decodeHwpText(rec.payload).trim();
        if (text) {
          if (currentTable) {
            currentCellText.push(text);
          } else {
            paragraphs.push({
              text,
              isHeading: paragraphs.length === 0 && text.length < 80,
              isBold: paragraphs.length === 0,
              isItalic: false,
            });
          }
        }
      }

      // HWPTAG_EQEDIT (88)
      if (rec.tagId === HWP_TAGS.EQEDIT && rec.payload.length > 4) {
        let script = '';
        if (rec.payload.length >= 8) {
          const strLen = rec.payload.readUInt16LE(4);
          if (strLen > 0 && 6 + strLen * 2 <= rec.payload.length) {
            script = rec.payload.subarray(6, 6 + strLen * 2).toString('utf16le');
          }
        }
        if (!script) {
          script = decodeHwpText(rec.payload.subarray(4)).trim();
        }
        if (script) {
          const mathml = hwpEquationToMathML(script);
          const latex = hwpEquationToLaTeX(script);
          const eqObj: HwpEquation = { script, mathml, latex };
          allEquations.push(eqObj);
          if (paragraphs.length > 0) {
            const lastP = paragraphs[paragraphs.length - 1];
            if (!lastP.equations) lastP.equations = [];
            lastP.equations.push(eqObj);
          }
        }
      }

      // HWPTAG_TABLE (77)
      if (rec.tagId === HWP_TAGS.TABLE && rec.payload.length >= 8) {
        // Close previous table if open
        if (currentTable && currentCellRows.length > 0) {
          currentTable.rows = currentCellRows;
          tables.push(currentTable);
        }

        const rowCount = rec.payload.readUInt16LE(2) || 2;
        const colCount = rec.payload.readUInt16LE(4) || 2;
        currentTable = { rowCount, colCount, rows: [] };
        currentCellRows = [];
        currentCellText = [];
      }

      // HWPTAG_LIST_HEADER (72) - table cell boundaries
      if (rec.tagId === HWP_TAGS.LIST_HEADER && currentTable) {
        if (currentCellText.length > 0) {
          const cellStr = currentCellText.join(' ');
          if (currentCellRows.length === 0 || currentCellRows[currentCellRows.length - 1].length >= currentTable.colCount) {
            currentCellRows.push([cellStr]);
          } else {
            currentCellRows[currentCellRows.length - 1].push(cellStr);
          }
          currentCellText = [];
        }
      }
    }

    // Flush active table
    if (currentTable) {
      if (currentCellText.length > 0) {
        const cellStr = currentCellText.join(' ');
        if (currentCellRows.length === 0 || currentCellRows[currentCellRows.length - 1].length >= currentTable.colCount) {
          currentCellRows.push([cellStr]);
        } else {
          currentCellRows[currentCellRows.length - 1].push(cellStr);
        }
      }
      if (currentCellRows.length > 0) {
        currentTable.rows = currentCellRows;
        tables.push(currentTable);
      }
    }
  }

  // Ensure at least one paragraph exists
  if (paragraphs.length === 0) {
    paragraphs.push({ text: 'Hangul Word Processor Document', isHeading: true, isBold: true, isItalic: false });
  }

  return {
    version,
    isCompressed,
    isEncrypted,
    isDistributed,
    paragraphs,
    tables,
    equations: allEquations.length > 0 ? allEquations : undefined,
    metadata: {
      title: paragraphs[0]?.text,
    },
  };
}

/**
 * Builds an authentic HWP 5.0 CFBF compound file with valid FileHeader, DocInfo,
 * and BodyText/Section0 streams containing authentic HWP 5.0 tags.
 */
export function buildHwpCompoundFile(params: {
  paragraphs: { text: string; isHeading?: boolean }[];
  tables?: { rows: string[][] }[];
  equations?: string[];
  compressed?: boolean;
}): Buffer {
  const isCompressed = params.compressed !== false;

  // 1. Synthesize BodyText/Section0 stream
  const sectionChunks: Buffer[] = [];

  // Write paragraphs
  params.paragraphs.forEach((p) => {
    // HWPTAG_PARA_HEADER (66)
    const headerBuf = Buffer.alloc(16);
    headerBuf.writeUInt32LE(p.text.length, 0); // text length in chars
    sectionChunks.push(buildHwpRecord(HWP_TAGS.PARA_HEADER, 0, headerBuf));

    // HWPTAG_PARA_TEXT (67)
    // Convert string to UTF-16LE buffer with trailing paragraph break (0x000D)
    const textUtf16 = Buffer.from(p.text + '\r\n', 'utf16le');
    sectionChunks.push(buildHwpRecord(HWP_TAGS.PARA_TEXT, 0, textUtf16));
  });

  // Write equations if any
  if (params.equations && params.equations.length > 0) {
    params.equations.forEach((eqScript) => {
      // HWPTAG_EQEDIT (88)
      const scriptUtf16 = Buffer.from(eqScript, 'utf16le');
      const payload = Buffer.alloc(6 + scriptUtf16.length);
      payload.writeUInt32LE(0x00000000, 0); // flags
      payload.writeUInt16LE(eqScript.length, 4); // char count
      scriptUtf16.copy(payload, 6);
      sectionChunks.push(buildHwpRecord(HWP_TAGS.EQEDIT, 0, payload));
    });
  }

  // Write tables if any
  if (params.tables && params.tables.length > 0) {
    params.tables.forEach((tbl) => {
      const rowCount = tbl.rows.length;
      const colCount = tbl.rows[0]?.length || 1;

      // HWPTAG_TABLE (77)
      const tblProp = Buffer.alloc(16);
      tblProp.writeUInt16LE(rowCount, 2);
      tblProp.writeUInt16LE(colCount, 4);
      sectionChunks.push(buildHwpRecord(HWP_TAGS.TABLE, 0, tblProp));

      // Write each cell
      tbl.rows.forEach((row, r) => {
        row.forEach((cellText, c) => {
          // HWPTAG_LIST_HEADER (72)
          const listProp = Buffer.alloc(12);
          listProp.writeUInt16LE(c, 0); // col
          listProp.writeUInt16LE(r, 2); // row
          sectionChunks.push(buildHwpRecord(HWP_TAGS.LIST_HEADER, 1, listProp));

          // Cell HWPTAG_PARA_TEXT (67)
          const cellUtf16 = Buffer.from(cellText, 'utf16le');
          sectionChunks.push(buildHwpRecord(HWP_TAGS.PARA_TEXT, 1, cellUtf16));
        });
      });
    });
  }

  const rawSection = Buffer.concat(sectionChunks);
  const sectionPayload = isCompressed ? zlib.deflateSync(rawSection) : rawSection;

  // 2. Synthesize FileHeader (256 bytes)
  const fileHeader = Buffer.alloc(256);
  fileHeader.write('HWP Document File', 0, 'utf8');
  fileHeader.writeUInt32LE(0x05000300, 32); // Version 5.0.3.0
  fileHeader.writeUInt32LE(isCompressed ? 0x01 : 0x00, 36); // Flags: compressed

  // 3. Synthesize DocInfo (summary)
  const docInfoPayload = Buffer.alloc(64);
  const docInfoRec = buildHwpRecord(HWP_TAGS.DOCUMENT_PROPERTIES, 0, docInfoPayload);
  const docInfoFinal = isCompressed ? zlib.deflateSync(docInfoRec) : docInfoRec;

  // 4. Assemble standard 512-byte CFBF container
  const sectorSize = 512;
  const header = Buffer.alloc(sectorSize);

  // Magic
  header.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
  header.writeUInt16LE(0xfffe, 28); // Byte order LE
  header.writeUInt16LE(9, 30); // Sector shift: 512 bytes
  header.writeUInt16LE(6, 32); // Mini sector shift: 64 bytes
  header.writeUInt32LE(0, 48); // Directory starts at sector 0
  header.writeUInt32LE(4096, 56); // Mini stream cutoff
  header.writeUInt32LE(0xfffffffe, 60); // No MiniFAT
  header.writeUInt32LE(0, 64);
  header.writeUInt32LE(0xfffffffe, 68); // No DIFAT
  header.writeUInt32LE(0, 72);

  // Sector layout:
  // Sector 0: Directory (512 bytes = 4 entries)
  // Sector 1: FileHeader stream (padded to 512)
  // Sector 2: DocInfo stream (padded to 512)
  // Sector 3..N: Section0 stream
  const sectionSectors = Math.ceil(sectionPayload.length / sectorSize) || 1;
  const totalDataSectors = 3 + sectionSectors;

  // Calculate needed FAT sectors dynamically
  let fatSectorCount = 1;
  while (totalDataSectors + fatSectorCount > fatSectorCount * (sectorSize / 4)) {
    fatSectorCount++;
  }

  header.writeUInt32LE(fatSectorCount, 44);

  // Write FAT sector IDs to header (up to 109 FAT sectors)
  const fatSectorStart = totalDataSectors;
  for (let f = 0; f < fatSectorCount && f < 109; f++) {
    header.writeUInt32LE(fatSectorStart + f, 76 + f * 4);
  }

  // Directory entries (128 bytes each, 4 per sector)
  const dirSector = Buffer.alloc(sectorSize);

  function writeDirEntry(
    offset: number,
    name: string,
    type: number,
    startSector: number,
    size: number,
    childId: number,
    leftSibling: number = 0xffffffff,
    rightSibling: number = 0xffffffff
  ) {
    const nameBuf = Buffer.from(name, 'utf16le');
    nameBuf.copy(dirSector, offset);
    dirSector.writeUInt16LE((name.length + 1) * 2, offset + 64);
    dirSector.writeUInt8(type, offset + 66);
    dirSector.writeUInt32LE(leftSibling, offset + 68); // Left Sibling
    dirSector.writeUInt32LE(rightSibling, offset + 72); // Right Sibling
    dirSector.writeUInt32LE(childId, offset + 76); // Child
    dirSector.writeUInt32LE(startSector, offset + 116);
    dirSector.writeUInt32LE(size, offset + 120);
  }

  // Entry 0: Root Entry (child -> Entry 1)
  writeDirEntry(0, 'Root Entry', 5, 0xfffffffe, 0, 1, 0xffffffff, 0xffffffff);
  // Entry 1: FileHeader (right sibling -> Entry 2)
  writeDirEntry(128, 'FileHeader', 2, 1, fileHeader.length, 0xffffffff, 0xffffffff, 2);
  // Entry 2: DocInfo (right sibling -> Entry 3)
  writeDirEntry(256, 'DocInfo', 2, 2, docInfoFinal.length, 0xffffffff, 0xffffffff, 3);
  // Entry 3: Section0
  writeDirEntry(384, 'Section0', 2, 3, sectionPayload.length, 0xffffffff, 0xffffffff, 0xffffffff);

  // FileHeader sector (Sector 1)
  const fhSector = Buffer.alloc(sectorSize);
  fileHeader.copy(fhSector, 0);

  // DocInfo sector (Sector 2)
  const diSector = Buffer.alloc(sectorSize);
  docInfoFinal.copy(diSector, 0);

  // Section0 sectors (Sectors 3 .. 3 + sectionSectors - 1)
  const secSectorsBuf = Buffer.alloc(sectionSectors * sectorSize);
  sectionPayload.copy(secSectorsBuf, 0);

  // Multi-sector FAT Buffer
  const fatBuffer = Buffer.alloc(fatSectorCount * sectorSize, 0xff); // 0xFFFFFFFF = Free
  fatBuffer.writeUInt32LE(0xfffffffe, 0 * 4); // Sec 0 (Dir) -> ENDOFCHAIN
  fatBuffer.writeUInt32LE(0xfffffffe, 1 * 4); // Sec 1 (FileHeader) -> ENDOFCHAIN
  fatBuffer.writeUInt32LE(0xfffffffe, 2 * 4); // Sec 2 (DocInfo) -> ENDOFCHAIN

  // Section0 sector chain
  for (let s = 0; s < sectionSectors; s++) {
    const currSec = 3 + s;
    const nextSec = s === sectionSectors - 1 ? 0xfffffffe : currSec + 1;
    fatBuffer.writeUInt32LE(nextSec, currSec * 4);
  }

  // Mark all FAT sectors as ENDOFCHAIN / FAT sector
  for (let f = 0; f < fatSectorCount; f++) {
    const fIdx = fatSectorStart + f;
    if (fIdx * 4 < fatBuffer.length) {
      fatBuffer.writeUInt32LE(0xfffffffd, fIdx * 4);
    }
  }

  return Buffer.concat([header, dirSector, fhSector, diSector, secSectorsBuf, fatBuffer]);
}

/**
 * Converts parsed HWP document AST to PDF, OpenXML DOCX, ODT, HTML, TXT, RTF, MD, HWPX, or raster images.
 */
export async function convertHwpDocument(
  doc: HwpDocument,
  targetFormat: string,
  options: ConversionOptions = {},
  baseName: string
): Promise<ConversionResult> {
  const tgt = targetFormat.toLowerCase();

  // 1. Target: HWPX (KS X 6101 standard Open Packaging Convention XML container)
  if (tgt === 'hwpx') {
    const { buildHwpxContainer } = await import('./hwpx');
    const hwpxBuffer = await buildHwpxContainer(doc);
    return {
      buffer: hwpxBuffer,
      mimeType: 'application/hwp+zip',
      filename: `${baseName}.hwpx`,
      size: hwpxBuffer.length,
    };
  }

  // 2. Target: HWP (HWP 5.0 CFBF compound binary)
  if (tgt === 'hwp') {
    const hwpBuffer = buildHwpCompoundFile({
      paragraphs: doc.paragraphs,
      tables: doc.tables,
    });
    return {
      buffer: hwpBuffer,
      mimeType: 'application/x-hwp',
      filename: `${baseName}.hwp`,
      size: hwpBuffer.length,
    };
  }

  // 3. Target: Markdown (MD)
  if (tgt === 'md' || tgt === 'markdown') {
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
    const buffer = Buffer.from(md.trim(), 'utf-8');
    return { buffer, mimeType: 'text/markdown', filename: `${baseName}.md`, size: buffer.length };
  }

  // 4. Target: PDF with structured tables and paragraphs
  if (tgt === 'pdf') {
    const pdfBuffer = await generatePdfFromHwp(doc, options, baseName);
    return {
      buffer: pdfBuffer,
      mimeType: 'application/pdf',
      filename: `${baseName}.pdf`,
      size: pdfBuffer.length,
    };
  }

  // 5. Target: DOCX with OpenXML tables and formatted paragraphs
  if (tgt === 'docx') {
    const docxBuffer = await generateDocxFromHwp(doc, baseName);
    return {
      buffer: docxBuffer,
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      filename: `${baseName}.docx`,
      size: docxBuffer.length,
    };
  }

  // 6. Target: HTML with structured markup
  if (tgt === 'html') {
    let html = `<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8">\n<title>${escapeHtml(baseName)}</title>\n`;
    html += `<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;margin:40px;color:#1F2340}h1,h2{color:#5C6BC0}table{border-collapse:collapse;width:100%;margin:20px 0}th,td{border:1px solid #CCD2FC;padding:8px 12px;text-align:left}th{background:#F0F2FE}</style>\n</head>\n<body>\n`;

    doc.paragraphs.forEach((p) => {
      if (p.isHeading) {
        html += `<h2>${escapeHtml(p.text)}</h2>\n`;
      } else {
        html += `<p>${escapeHtml(p.text)}</p>\n`;
      }
    });

    doc.tables.forEach((t) => {
      html += '<table>\n';
      t.rows.forEach((row, rIdx) => {
        html += '  <tr>\n';
        const tag = rIdx === 0 ? 'th' : 'td';
        row.forEach((cell) => {
          html += `    <${tag}>${escapeHtml(cell)}</${tag}>\n`;
        });
        html += '  </tr>\n';
      });
      html += '</table>\n';
    });

    html += '</body>\n</html>';
    const buffer = Buffer.from(html, 'utf-8');
    return { buffer, mimeType: 'text/html', filename: `${baseName}.html`, size: buffer.length };
  }

  // 7. Target: TXT
  if (tgt === 'txt') {
    const parts: string[] = doc.paragraphs.map((p) => p.text);
    doc.tables.forEach((t) => {
      parts.push(t.rows.map((r) => r.join('\t')).join('\n'));
    });
    const text = parts.join('\n\n');
    const buffer = Buffer.from(text, 'utf-8');
    return { buffer, mimeType: 'text/plain', filename: `${baseName}.txt`, size: buffer.length };
  }

  // 8. Target: RTF
  if (tgt === 'rtf') {
    const bodyParts: string[] = [];
    doc.paragraphs.forEach((p) => {
      bodyParts.push(escapeHtml(p.text).replace(/\r?\n/g, '\\par '));
    });
    doc.tables.forEach((t) => {
      t.rows.forEach((r) => {
        bodyParts.push(r.map(escapeHtml).join(' \\tab ') + '\\par ');
      });
    });
    const rtf = `{\\rtf1\\ansi\\deff0 {\\fonttbl {\\f0 Malgun Gothic;\\f1 Times New Roman;}}\\fs24 ${bodyParts.join('\\par\\par ')}}\n`;
    const buffer = Buffer.from(rtf, 'utf-8');
    return { buffer, mimeType: 'application/rtf', filename: `${baseName}.rtf`, size: buffer.length };
  }

  // 9. Target: ODT (OpenDocument Text)
  if (tgt === 'odt') {
    const odtBuffer = await generateOdtFromHwp(doc, baseName);
    return {
      buffer: odtBuffer,
      mimeType: 'application/vnd.oasis.opendocument.text',
      filename: `${baseName}.odt`,
      size: odtBuffer.length,
    };
  }

  // 10. Target: DOC (Word RTF-based)
  if (tgt === 'doc') {
    const rtfResult = await convertHwpDocument(doc, 'rtf', options, baseName);
    return {
      buffer: rtfResult.buffer,
      mimeType: 'application/msword',
      filename: `${baseName}.doc`,
      size: rtfResult.buffer.length,
    };
  }

  // 11. Target: XPS
  if (tgt === 'xps') {
    const xpsBuffer = await generateXpsFromHwp(doc, baseName);
    return {
      buffer: xpsBuffer,
      mimeType: 'application/oxps',
      filename: `${baseName}.xps`,
      size: xpsBuffer.length,
    };
  }

  // 12. Target: Raster Images (PNG, JPG, WEBP, BMP)
  if (['png', 'jpg', 'jpeg', 'webp', 'bmp'].includes(tgt)) {
    const raster = await renderHwpToRaster(doc, tgt, baseName);
    return {
      buffer: raster.buffer,
      mimeType: raster.mimeType,
      filename: `${baseName}.${tgt}`,
      size: raster.buffer.length,
    };
  }

  // Fallback to PDF
  const pdfBuffer = await generatePdfFromHwp(doc, options, baseName);
  return {
    buffer: pdfBuffer,
    mimeType: 'application/pdf',
    filename: `${baseName}.pdf`,
    size: pdfBuffer.length,
  };
}

/**
 * Converts HWP 5.0 documents to PDF, OpenXML DOCX, ODT, HTML, TXT, RTF, HWPX.
 */
export async function convertHwp(
  inputBuffer: Buffer,
  targetFormat: string,
  options: ConversionOptions = {},
  baseName: string
): Promise<ConversionResult> {
  const doc = parseHwpDocument(inputBuffer);
  return convertHwpDocument(doc, targetFormat, options, baseName);
}

/** Heading level HWP heading paragraphs are drawn at. */
const HWP_PDF_HEADING_LEVEL = 3;

/**
 * Renders HWP paragraphs and tables into PDF. The page holds only the document content (the
 * title goes to the PDF metadata), drawn with embedded fonts covering every character.
 */
async function generatePdfFromHwp(
  doc: HwpDocument,
  options: ConversionOptions,
  title: string
): Promise<Buffer> {
  for (const p of doc.paragraphs ?? []) {
    if (p.text) assertNoComplexScript(p.text, 'Pure-TS HWP to PDF');
  }
  for (const tbl of doc.tables ?? []) {
    for (const r of tbl.rows) {
      for (const cell of r) {
        assertNoComplexScript(cell, 'Pure-TS HWP to PDF');
      }
    }
  }

  const blocks: PdfBlock[] = [];
  for (const p of doc.paragraphs ?? []) {
    blocks.push(
      p.isHeading
        ? { kind: 'heading', level: HWP_PDF_HEADING_LEVEL, content: [{ text: p.text }] }
        : { kind: 'paragraph', content: [{ text: p.text }] }
    );
  }
  for (const tbl of doc.tables ?? []) {
    if (tbl.rows.length === 0) continue;
    blocks.push({ kind: 'table', rows: tbl.rows.map((row) => row.map((cell) => ({ content: [{ text: cell }], span: 1 }))) });
  }
  return renderPdfBlocks(blocks, { orientation: options.orientation, title });
}

/**
 * Builds authentic OpenXML DOCX containing structured tables and paragraphs
 */
async function generateDocxFromHwp(doc: HwpDocument, title: string): Promise<Buffer> {
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

  // word/_rels/document.xml.rels
  zip.file(
    'word/_rels/document.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
</Relationships>`
  );

  let bodyXml = '';

  // Title
  bodyXml += `<w:p><w:pPr><w:pStyle w:val="Title"/><w:spacing w:after="240"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="36"/><w:color w:val="1F2340"/></w:rPr><w:t>${escapeXml(
    title
  )}</w:t></w:r></w:p>`;

  // Paragraphs
  for (const p of doc.paragraphs) {
    if (p.isHeading) {
      bodyXml += `<w:p><w:pPr><w:spacing w:before="200" w:after="120"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="28"/><w:color w:val="5C6BC0"/></w:rPr><w:t>${escapeXml(
        p.text
      )}</w:t></w:r></w:p>`;
    } else {
      bodyXml += `<w:p><w:pPr><w:spacing w:after="120"/></w:pPr><w:r><w:rPr><w:sz w:val="22"/><w:color w:val="2D3748"/></w:rPr><w:t>${escapeXml(
        p.text
      )}</w:t></w:r></w:p>`;
    }
  }

  // Tables
  for (const tbl of doc.tables) {
    if (tbl.rows.length === 0) continue;
    let tblXml = `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="CCD2FC"/><w:bottom w:val="single" w:sz="4" w:color="CCD2FC"/><w:left w:val="single" w:sz="4" w:color="CCD2FC"/><w:right w:val="single" w:sz="4" w:color="CCD2FC"/><w:insideH w:val="single" w:sz="4" w:color="E1E4EE"/><w:insideV w:val="single" w:sz="4" w:color="E1E4EE"/></w:tblBorders></w:tblPr>`;
    const colCount = Math.max(1, tbl.colCount || tbl.rows[0].length);
    tblXml += `<w:tblGrid>${new Array(colCount).fill('<w:gridCol/>').join('')}</w:tblGrid>`;

    tbl.rows.forEach((row, rIdx) => {
      tblXml += `<w:tr>`;
      const isHeader = rIdx === 0;
      row.forEach((cell) => {
        tblXml += `<w:tc><w:tcPr>${
          isHeader ? '<w:shd w:val="clear" w:color="auto" w:fill="F0F2FE"/>' : ''
        }</w:tcPr><w:p><w:r><w:rPr>${
          isHeader ? '<w:b/><w:color w:val="1F2340"/>' : '<w:color w:val="4A5568"/>'
        }</w:rPr><w:t>${escapeXml(cell)}</w:t></w:r></w:p></w:tc>`;
      });
      tblXml += `</w:tr>`;
    });

    tblXml += `</w:tbl>`;
    bodyXml += tblXml;
  }

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${bodyXml}
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/>
    </w:sectPr>
  </w:body>
</w:document>`;

  zip.file('word/document.xml', documentXml);

  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
}

function escapeXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeHtml(str: string): string {
  return escapeXml(str);
}

/**
 * Builds OpenDocument Text (ODT) ZIP package containing structured content
 */
async function generateOdtFromHwp(doc: HwpDocument, title: string): Promise<Buffer> {
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

  let contentBody = `<text:h text:outline-level="1">${escapeXml(title)}</text:h>\n`;
  doc.paragraphs.forEach((p) => {
    if (p.isHeading) {
      contentBody += `<text:h text:outline-level="2">${escapeXml(p.text)}</text:h>\n`;
    } else {
      contentBody += `<text:p>${escapeXml(p.text)}</text:p>\n`;
    }
  });

  doc.tables.forEach((t) => {
    contentBody += `<table:table table:name="Table">\n`;
    t.rows.forEach((row) => {
      contentBody += `  <table:table-row>\n`;
      row.forEach((cell) => {
        contentBody += `    <table:table-cell office:value-type="string"><text:p>${escapeXml(cell)}</text:p></table:table-cell>\n`;
      });
      contentBody += `  </table:table-row>\n`;
    });
    contentBody += `</table:table>\n`;
  });

  const contentXml = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
  xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0">
  <office:body>
    <office:text>
      ${contentBody}
    </office:text>
  </office:body>
</office:document-content>`;

  zip.file('content.xml', contentXml);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/**
 * Builds Open Packaging Convention XPS package
 */
async function generateXpsFromHwp(doc: HwpDocument, title: string): Promise<Buffer> {
  const lines = doc.paragraphs.map((p) => p.text).filter(Boolean);
  return buildOpenXpsPackage([{ title, lines }], title);
}

/**
 * Rasterizes HWP document into crisp PNG, JPEG, WEBP, or BMP images
 */
async function renderHwpToRaster(
  doc: HwpDocument,
  tgt: string,
  title: string
): Promise<{ buffer: Buffer; mimeType: string }> {
  const width = 800;
  const rowHeight = 24;
  let estimatedHeight = 120 + doc.paragraphs.length * 28;
  doc.tables.forEach((t) => {
    estimatedHeight += t.rows.length * rowHeight + 30;
  });
  const height = Math.min(3000, Math.max(400, estimatedHeight));

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="${width}" height="${height}" fill="#ffffff" />
    <rect x="40" y="30" width="${width - 80}" height="4" fill="#5C6BC0" />
    <text x="40" y="65" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="20" font-weight="bold" fill="#1F2340">${escapeXml(title)}</text>
  `;

  let currentY = 100;
  for (const p of doc.paragraphs.slice(0, 40)) {
    if (currentY > height - 60) break;
    const isHeading = p.isHeading;
    const fontSize = isHeading ? 15 : 12;
    const fill = isHeading ? '#5C6BC0' : '#2D3748';
    const fontWeight = isHeading ? 'bold' : 'normal';
    svg += `<text x="40" y="${currentY}" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="${fontSize}" font-weight="${fontWeight}" fill="${fill}">${escapeXml(p.text.slice(0, 100))}</text>\n`;
    currentY += isHeading ? 28 : 22;
  }

  for (const t of doc.tables) {
    if (currentY > height - 80) break;
    const colCount = Math.max(1, t.colCount || t.rows[0]?.length || 1);
    const colWidth = (width - 80) / colCount;

    t.rows.slice(0, 20).forEach((row, rIdx) => {
      if (currentY > height - 40) return;
      const isHeader = rIdx === 0;
      const bg = isHeader ? '#F0F2FE' : (rIdx % 2 === 0 ? '#FFFFFF' : '#F8FAFC');
      svg += `<rect x="40" y="${currentY}" width="${width - 80}" height="${rowHeight}" fill="${bg}" stroke="#CCD2FC" stroke-width="0.5" />\n`;
      row.forEach((cell, cIdx) => {
        const cx = 45 + cIdx * colWidth;
        const fontW = isHeader ? 'bold' : 'normal';
        svg += `<text x="${cx}" y="${currentY + 16}" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="11" font-weight="${fontW}" fill="#1F2340">${escapeXml(cell.slice(0, 25))}</text>\n`;
      });
      currentY += rowHeight;
    });
    currentY += 16;
  }

  svg += `</svg>`;
  const pipeline = sharp(Buffer.from(svg, 'utf-8'));

  switch (tgt) {
    case 'jpg':
    case 'jpeg': {
      const buffer = await pipeline.jpeg({ quality: 90 }).toBuffer();
      return { buffer, mimeType: 'image/jpeg' };
    }
    case 'webp': {
      const buffer = await pipeline.webp().toBuffer();
      return { buffer, mimeType: 'image/webp' };
    }
    case 'bmp': {
      const { data, info } = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const buffer = encodeBmp(data, info.width, info.height, info.channels);
      return { buffer, mimeType: 'image/bmp' };
    }
    case 'png':
    default: {
      const buffer = await pipeline.png().toBuffer();
      return { buffer, mimeType: 'image/png' };
    }
  }
}
