import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import { compareImages, VrtOptions, VrtResult } from './vrt-engine';

// ============================================================================
// 1. External CLI Tool Probing & Availability
// ============================================================================

export type ExternalOracleTool =
  | 'pdftotext'
  | 'pdfinfo'
  | 'pdftoppm'
  | 'ffmpeg'
  | 'ffprobe'
  | 'soffice'
  | 'tesseract'
  | '7z'
  | 'tar'
  | 'zstd'
  | 'magick'
  | 'identify';

const toolCache = new Map<string, string | null>();

export function getOracleToolPath(tool: ExternalOracleTool): string | null {
  if (toolCache.has(tool)) {
    return toolCache.get(tool)!;
  }

  const pathEnvDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const candidateDirs = Array.from(
    new Set([
      ...pathEnvDirs,
      '/usr/bin',
      '/usr/local/bin',
      '/opt/homebrew/bin',
      '/opt/local/bin',
      '/bin',
    ])
  );

  for (const dir of candidateDirs) {
    const fullPath = path.join(dir, tool);
    if (fs.existsSync(fullPath)) {
      toolCache.set(tool, fullPath);
      return fullPath;
    }
  }

  try {
    const whichBinary = candidateDirs.find((d) => fs.existsSync(path.join(d, 'which')));
    if (whichBinary) {
      const res = execFileSync(path.join(whichBinary, 'which'), [tool], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'ignore'],
      }).trim();
      if (res && fs.existsSync(res)) {
        toolCache.set(tool, res);
        return res;
      }
    }
  } catch {
    // Not installed
  }

  toolCache.set(tool, null);
  return null;
}

export function isOracleToolAvailable(tool: ExternalOracleTool): boolean {
  return getOracleToolPath(tool) !== null;
}

export interface OracleToolDiagnostic {
  tool: ExternalOracleTool;
  available: boolean;
  path: string | null;
}

export function getOracleToolDiagnostics(): OracleToolDiagnostic[] {
  const tools: ExternalOracleTool[] = [
    'pdftotext',
    'pdfinfo',
    'pdftoppm',
    'ffmpeg',
    'ffprobe',
    'soffice',
    'tesseract',
    '7z',
    'tar',
    'zstd',
    'magick',
    'identify',
  ];
  return tools.map((tool) => ({
    tool,
    available: isOracleToolAvailable(tool),
    path: getOracleToolPath(tool),
  }));
}

/**
 * Validates image bitstream decoding using ImageMagick CLI (identify or magick identify) when available.
 */
export function verifyImageWithImageMagick(buffer: Buffer): boolean {
  const identifyPath = getOracleToolPath('identify') || getOracleToolPath('magick');
  if (!identifyPath) return false;
  try {
    const args = identifyPath.endsWith('identify')
      ? ['-format', '%m %w %h', '-']
      : ['identify', '-format', '%m %w %h', '-'];
    const out = execFileSync(identifyPath, args, {
      input: buffer,
      stdio: ['pipe', 'pipe', 'ignore'],
      encoding: 'utf-8',
    });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Validates audio container/bitstream using FFmpeg CLI when available.
 */
export function verifyAudioWithFfmpeg(buffer: Buffer): boolean {
  const ffmpegPath = getOracleToolPath('ffmpeg');
  if (!ffmpegPath) return false;
  try {
    execFileSync(ffmpegPath, ['-v', 'error', '-i', 'pipe:0', '-f', 'null', '-'], {
      input: buffer,
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates PDF document structure using Poppler pdfinfo CLI when available.
 */
export function verifyPdfWithPoppler(buffer: Buffer): boolean {
  const pdfinfoPath = getOracleToolPath('pdfinfo');
  if (!pdfinfoPath) return false;
  const tmpPath = path.join(os.tmpdir(), `oracle_pdfinfo_${crypto.randomUUID()}.pdf`);
  try {
    fs.writeFileSync(tmpPath, buffer);
    execFileSync(pdfinfoPath, [tmpPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  } finally {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {}
  }
}

/**
 * Extracts plain text using external Poppler pdftotext binary when available.
 */
export function extractTextWithExternalPdftotext(buffer: Buffer): string | null {
  const toolPath = getOracleToolPath('pdftotext');
  if (!toolPath) return null;
  const tmpPath = path.join(os.tmpdir(), `oracle_pdf_${crypto.randomUUID()}.pdf`);
  try {
    fs.writeFileSync(tmpPath, buffer);
    const stdout = execFileSync(toolPath, ['-q', tmpPath, '-'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 50 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return null;
  } finally {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {}
  }
}

/**
 * Validates 7z archive structure using real 7-Zip CLI engine.
 */
export function verifyArchiveWith7z(buffer: Buffer): boolean {
  const sevenZMagic = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
  if (buffer.length < 32 || !buffer.subarray(0, 6).equals(sevenZMagic)) {
    return false;
  }
  const toolPath = getOracleToolPath('7z');
  if (!toolPath) return false;
  const tmpPath = path.join(os.tmpdir(), `oracle_7z_${crypto.randomUUID()}.7z`);
  try {
    fs.writeFileSync(tmpPath, buffer);
    execFileSync(toolPath, ['t', '-y', tmpPath], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return true;
  } catch {
    return false;
  } finally {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {}
  }
}

/**
 * Validates TAR archive stream using standard system tar CLI.
 */
export function verifyArchiveWithTar(buffer: Buffer): boolean {
  if (buffer.length < 512) return false;
  const toolPath = getOracleToolPath('tar');
  if (!toolPath) return false;
  try {
    execFileSync(toolPath, ['-tf', '-'], {
      input: buffer,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Validates Zstandard compressed stream using standard zstd CLI.
 */
export function verifyArchiveWithZstd(buffer: Buffer): boolean {
  const zstdMagic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  if (buffer.length < 4 || !buffer.subarray(0, 4).equals(zstdMagic)) {
    return false;
  }
  const toolPath = getOracleToolPath('zstd');
  if (!toolPath) return false;
  try {
    execFileSync(toolPath, ['-t', '-q'], {
      input: buffer,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

export interface AudioBitstreamVerification {
  valid: boolean;
  formatName?: string;
  codecName?: string;
  sampleRate?: number;
  channels?: number;
  durationSec?: number;
  error?: string;
}

export function verifyAudioBitstreamWithFfprobe(
  buffer: Buffer,
  formatHint: string,
  expectedCodec?: string
): AudioBitstreamVerification {
  const toolPath = getOracleToolPath('ffprobe');
  if (!toolPath) {
    const format = formatHint.toLowerCase().replace(/^\./, '');
    if (buffer.length < 12) {
      return { valid: false, error: 'Buffer too small for audio header' };
    }
    if (format === 'wav') {
      if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WAVE') {
        const channels = buffer.readUInt16LE(22);
        const sampleRate = buffer.readUInt32LE(24);
        return {
          valid: true,
          formatName: 'wav',
          codecName: expectedCodec || 'pcm_s16le',
          sampleRate,
          channels,
        };
      }
      return { valid: false, error: 'Invalid WAV RIFF/WAVE header' };
    }
    if (format === 'aac') {
      if (buffer.length >= 7 && buffer[0] === 0xff && (buffer[1] & 0xf0) === 0xf0) {
        const chan = ((buffer[2] & 0x01) << 2) | ((buffer[3] >> 6) & 0x03);
        return {
          valid: true,
          formatName: 'aac',
          codecName: expectedCodec || 'aac',
          channels: chan,
        };
      }
      return { valid: false, error: 'Invalid ADTS AAC header syncword' };
    }
    if (format === 'mp3') {
      if (buffer.toString('ascii', 0, 3) === 'ID3' || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)) {
        return {
          valid: true,
          formatName: 'mp3',
          codecName: expectedCodec || 'mp3',
        };
      }
      return { valid: false, error: 'Invalid MP3 sync frame' };
    }
    if (format === 'flac') {
      if (buffer.toString('ascii', 0, 4) === 'fLaC') {
        return {
          valid: true,
          formatName: 'flac',
          codecName: expectedCodec || 'flac',
        };
      }
      return { valid: false, error: 'Invalid FLAC magic marker' };
    }
    if (format === 'ogg' || format === 'opus' || format === 'vorbis') {
      if (buffer.toString('ascii', 0, 4) === 'OggS') {
        return {
          valid: true,
          formatName: 'ogg',
          codecName: expectedCodec || format,
        };
      }
      return { valid: false, error: 'Invalid OggS page header' };
    }
    return { valid: false, error: `Unsupported audio format verification: ${format}` };
  }

  const tmpPath = path.join(os.tmpdir(), `oracle_audio_${crypto.randomUUID()}.${formatHint}`);
  try {
    fs.writeFileSync(tmpPath, buffer);
    const stdout = execFileSync(
      toolPath,
      [
        '-v', 'error',
        '-select_streams', 'a:0',
        '-show_entries', 'stream=codec_name,sample_rate,channels,duration:format=format_name,duration',
        '-of', 'json',
        tmpPath,
      ],
      {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
      }
    );
    const parsed = JSON.parse(stdout);
    const stream = parsed.streams && parsed.streams[0];
    const format = parsed.format;
    if (!stream && !format) {
      return { valid: false, error: 'No audio stream or format metadata found' };
    }
    const codecName = stream?.codec_name;
    if (expectedCodec && codecName && !codecName.includes(expectedCodec)) {
      return { valid: false, codecName, error: `Codec mismatch: expected ${expectedCodec}, got ${codecName}` };
    }
    return {
      valid: true,
      formatName: format?.format_name,
      codecName,
      sampleRate: stream?.sample_rate ? Number(stream.sample_rate) : undefined,
      channels: stream?.channels ? Number(stream.channels) : undefined,
      durationSec: stream?.duration ? Number(stream.duration) : (format?.duration ? Number(format.duration) : undefined),
    };
  } catch (err: any) {
    return { valid: false, error: err?.message || String(err) };
  } finally {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {}
  }
}

export interface VideoBitstreamVerification {
  valid: boolean;
  formatName?: string;
  codecName?: string;
  width?: number;
  height?: number;
  durationSec?: number;
  isFastStart?: boolean;
  error?: string;
}

export function verifyVideoBitstreamWithFfprobe(
  buffer: Buffer,
  formatHint: string,
  expectedCodec?: string
): VideoBitstreamVerification {
  const toolPath = getOracleToolPath('ffprobe');
  const moovIdx = buffer.indexOf('moov');
  const mdatIdx = buffer.indexOf('mdat');
  const isFastStart = moovIdx > 0 && mdatIdx > 0 && moovIdx < mdatIdx;

  if (!toolPath) {
    if (buffer.length < 32) {
      return { valid: false, error: 'Buffer too small' };
    }
    const format = formatHint.toLowerCase().replace(/^\./, '');
    if (format === 'mp4' || format === 'mov') {
      if (buffer.toString('ascii', 4, 8) !== 'ftyp') {
        return { valid: false, error: 'Missing ftyp box in MP4 container' };
      }
      if (moovIdx <= 0) {
        return { valid: false, error: 'Missing moov box in MP4 container' };
      }
      if (mdatIdx <= 0) {
        return { valid: false, error: 'Missing mdat box in MP4 container' };
      }
      return {
        valid: true,
        formatName: format,
        codecName: expectedCodec || 'h264',
        isFastStart,
      };
    }
    if (format === 'webm' || format === 'mkv') {
      if (buffer.length < 4 || buffer[0] !== 0x1a || buffer[1] !== 0x45 || buffer[2] !== 0xdf || buffer[3] !== 0xa3) {
        return { valid: false, error: 'Invalid EBML header signature for WebM/MKV' };
      }
      return {
        valid: true,
        formatName: format,
        codecName: expectedCodec || 'vp9',
      };
    }
    return {
      valid: false,
      error: `CLI tool "ffprobe" is absent and pure frame verification is unavailable for video format ${format}`,
    };
  }

  const tmpPath = path.join(os.tmpdir(), `oracle_video_${crypto.randomUUID()}.${formatHint}`);
  try {
    fs.writeFileSync(tmpPath, buffer);
    const stdout = execFileSync(
      toolPath,
      [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=codec_name,width,height,duration:format=format_name,duration',
        '-of', 'json',
        tmpPath,
      ],
      {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
      }
    );
    const parsed = JSON.parse(stdout);
    const stream = parsed.streams && parsed.streams[0];
    const format = parsed.format;
    if (!stream && !format) {
      return { valid: false, error: 'No video stream or format metadata found' };
    }
    const codecName = stream?.codec_name;
    if (expectedCodec && codecName && !codecName.includes(expectedCodec)) {
      return { valid: false, codecName, error: `Codec mismatch: expected ${expectedCodec}, got ${codecName}` };
    }
    return {
      valid: true,
      formatName: format?.format_name,
      codecName,
      width: stream?.width ? Number(stream.width) : undefined,
      height: stream?.height ? Number(stream.height) : undefined,
      durationSec: stream?.duration ? Number(stream.duration) : (format?.duration ? Number(format.duration) : undefined),
      isFastStart,
    };
  } catch (err: any) {
    return { valid: false, error: err?.message || String(err) };
  } finally {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {}
  }
}

// ============================================================================
// 2. Structural AST Reference Oracle Models
// ============================================================================

export interface PdfStructuralAst {
  format: 'pdf';
  version: string;
  pageCount: number;
  hasObjectStreams: boolean;
  hasXrefStream: boolean;
  textTokens: string[];
  extractedText: string;
  hasSandwichOcrText: boolean;
  producer?: string;
  title?: string;
}

export interface XlsxStructuralAst {
  format: 'xlsx';
  sheetNames: string[];
  sheetCount: number;
  sheets: Record<string, {
    rowCount: number;
    colCount: number;
    cells: Record<string, { value: any; type?: string; formula?: string; numFmtId?: number }>;
  }>;
  sharedStrings: string[];
  customNumberFormats: Record<number, string>;
}

export interface PptxStructuralAst {
  format: 'pptx';
  slideCount: number;
  slideWidthPt: number;
  slideHeightPt: number;
  slides: Array<{
    slideIndex: number;
    backgroundColor?: string;
    shapes: Array<{
      name?: string;
      geomType: string;
      fillColor?: string;
      bounds: { x: number; y: number; cx: number; cy: number };
      text?: string;
    }>;
    tableCount: number;
  }>;
}

export interface DocxStructuralAst {
  format: 'docx';
  paragraphCount: number;
  paragraphs: string[];
  tableCount: number;
  tables: Array<{
    rowCount: number;
    colCount: number;
    cellTexts: string[][];
  }>;
  columnCount: number;
  footnotes: string[];
}

export interface CadStepStructuralAst {
  format: 'step';
  schema: string;
  vertexCount: number;
  edgeCount: number;
  faceCount: number;
  eulerCharacteristic: number;
  isClosedManifold: boolean;
}

export interface AudioMediaAst {
  format: 'mp4' | 'webm' | 'mp3' | 'flac' | 'wav';
  containerBoxTypes: string[];
  hasAudioTrack: boolean;
  hasMoovHeader: boolean;
  hasEbmlHeader: boolean;
  estimatedSampleRate?: number;
  estimatedChannels?: number;
}

export interface ArchiveStructuralAst {
  format: 'zip' | '7z' | 'tar' | 'zstd';
  fileCount: number;
  files: Array<{
    name: string;
    size: number;
    crc32?: number;
    isDir: boolean;
  }>;
}

// ============================================================================
// 3. Reference Structural AST Parsers
// ============================================================================

/**
 * Inspects PDF content and compressed streams for ISO 32000-1 3 Tr invisible text operator.
 * Uses linear index search to prevent regex backtracking (typescript:S8786).
 */
function containsInvisibleTextOperator(content: string): boolean {
  if (content.includes('3 Tr') || content.includes('3 tr')) {
    return true;
  }

  let searchPos = 0;
  while (searchPos < content.length) {
    const streamStart = content.indexOf('stream', searchPos);
    if (streamStart === -1) break;

    let dataStart = streamStart + 6;
    if (content.charCodeAt(dataStart) === 0x0d) dataStart++;
    if (content.charCodeAt(dataStart) === 0x0a) dataStart++;

    const streamEnd = content.indexOf('endstream', dataStart);
    if (streamEnd === -1) break;

    const streamBuf = Buffer.from(content.slice(dataStart, streamEnd), 'latin1');

    try {
      const inflated = zlib.inflateSync(streamBuf).toString('latin1');
      if (inflated.includes('3 Tr') || inflated.includes('3 tr')) {
        return true;
      }
    } catch {}

    try {
      const inflated = zlib.inflateRawSync(streamBuf).toString('latin1');
      if (inflated.includes('3 Tr') || inflated.includes('3 tr')) {
        return true;
      }
    } catch {}

    searchPos = streamEnd + 9;
  }

  return false;
}

export async function parsePdfToAst(buffer: Buffer): Promise<PdfStructuralAst> {
  const content = buffer.toString('latin1');
  const verMatch = /%PDF-(\d+\.\d+)/.exec(content);
  const version = verMatch ? verMatch[1] : '1.4';

  let pageCount = 1;
  let title: string | undefined;
  let producer: string | undefined;

  try {
    const pdfDoc = await PDFDocument.load(buffer, { ignoreEncryption: true });
    pageCount = pdfDoc.getPageCount();
    title = pdfDoc.getTitle() || undefined;
    producer = pdfDoc.getProducer() || undefined;
  } catch {
    const pageMatches = content.match(/\/Type\s*\/Page\b/g) || [];
    pageCount = Math.max(1, pageMatches.length);
  }

  // Extract text strings via structural stream decoder and parentheses regex fallback
  const textTokens: string[] = [];
  const tjRegex = /\(([^()\r\n]+)\)\s*[Tj'"]/g;
  let m: RegExpExecArray | null;
  while ((m = tjRegex.exec(content)) !== null) {
    textTokens.push(m[1]);
  }

  const extractedText = textTokens.join(' ');
  const hasObjectStreams = content.includes('/Type /ObjStm') || content.includes('/ObjStm');
  const hasXrefStream = content.includes('/Type /XRef') || content.includes('/XRef');
  const hasSandwichOcrText = containsInvisibleTextOperator(content);

  if (!title) {
    const titleMatch = /\/Title\s*\(([^()]+)\)/.exec(content);
    title = titleMatch ? titleMatch[1] : undefined;
  }
  if (!producer) {
    const prodMatch = /\/Producer\s*\(([^()]+)\)/.exec(content);
    producer = prodMatch ? prodMatch[1] : undefined;
  }

  return {
    format: 'pdf',
    version,
    pageCount,
    hasObjectStreams,
    hasXrefStream,
    textTokens,
    extractedText,
    hasSandwichOcrText,
    title,
    producer,
  };
}

async function extractSharedStrings(zip: JSZip): Promise<string[]> {
  const sharedStrings: string[] = [];
  const sstFile = zip.file('xl/sharedStrings.xml');
  if (!sstFile) return sharedStrings;

  const xml = await sstFile.async('text');
  const tRegex = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
  let m: RegExpExecArray | null;
  while ((m = tRegex.exec(xml)) !== null) {
    sharedStrings.push(
      m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    );
  }
  return sharedStrings;
}

async function extractCustomNumberFormats(zip: JSZip): Promise<Record<number, string>> {
  const customNumberFormats: Record<number, string> = {};
  const stylesFile = zip.file('xl/styles.xml');
  if (!stylesFile) return customNumberFormats;

  const xml = await stylesFile.async('text');
  const tagRegex = /<numFmt\b[^>]*>/gi;
  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = tagRegex.exec(xml)) !== null) {
    const tag = tagMatch[0];
    const idMatch = /\bnumFmtId="(\d+)"/i.exec(tag);
    const codeMatch = /\bformatCode="([^"]*)"/i.exec(tag);
    if (idMatch && codeMatch) {
      customNumberFormats[Number.parseInt(idMatch[1], 10)] = codeMatch[1];
    }
  }
  return customNumberFormats;
}

async function extractSheetNames(zip: JSZip): Promise<string[]> {
  const sheetNames: string[] = [];
  const workbookFile = zip.file('xl/workbook.xml');
  if (!workbookFile) return sheetNames;

  const wbXml = await workbookFile.async('text');
  const tagRegex = /<sheet\b[^>]*>/gi;
  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = tagRegex.exec(wbXml)) !== null) {
    const nameMatch = /\bname="([^"]+)"/i.exec(tagMatch[0]);
    if (nameMatch) {
      sheetNames.push(nameMatch[1]);
    }
  }
  return sheetNames;
}

function colLettersToNumber(colLetters: string): number {
  let colNum = 0;
  const upper = colLetters.toUpperCase();
  for (let c = 0; c < upper.length; c++) {
    colNum = colNum * 26 + ((upper.codePointAt(c) ?? 64) - 64);
  }
  return colNum;
}

function parseCellTag(
  attrs: string,
  formula: string | undefined,
  valRaw: string | undefined,
  sharedStrings: string[]
): { cellRef: string; colNum: number; data: { value: any; type?: string; formula?: string; numFmtId?: number } } | null {
  const rAttrMatch = /\br="([A-Z]+)(\d+)"/i.exec(attrs);
  if (!rAttrMatch) return null;

  const colNum = colLettersToNumber(rAttrMatch[1]);
  const cellRef = rAttrMatch[0].replace(/r="|"/g, '');
  const tAttrMatch = /\bt="([^"]+)"/i.exec(attrs);
  const sAttrMatch = /\bs="(\d+)"/i.exec(attrs);
  const type = tAttrMatch ? tAttrMatch[1] : undefined;
  let val: any = valRaw;

  if (type === 's' && val !== undefined) {
    val = sharedStrings[Number.parseInt(val, 10)] ?? val;
  } else if (val !== undefined && typeof val === 'string' && val.trim().length > 0 && !Number.isNaN(Number(val))) {
    val = Number(val);
  }

  return {
    cellRef,
    colNum,
    data: {
      value: val,
      type,
      formula,
      numFmtId: sAttrMatch ? Number.parseInt(sAttrMatch[1], 10) : undefined,
    },
  };
}

function parseWorksheetXml(
  xml: string,
  sharedStrings: string[]
): {
  rowCount: number;
  colCount: number;
  cells: Record<string, { value: any; type?: string; formula?: string; numFmtId?: number }>;
} {
  const cells: Record<string, { value: any; type?: string; formula?: string; numFmtId?: number }> = {};
  let maxRow = 0;
  let maxCol = 0;

  const rowRegex = /<row\b[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/gi;
  let rMatch: RegExpExecArray | null;
  while ((rMatch = rowRegex.exec(xml)) !== null) {
    const rowIdx = Number.parseInt(rMatch[1], 10);
    maxRow = Math.max(maxRow, rowIdx);

    const cellRegex = /<c\b([^>]*)>(?:<f>([\s\S]*?)<\/f>)?(?:<v>([\s\S]*?)<\/v>)?/gi;
    let cMatch: RegExpExecArray | null;
    while ((cMatch = cellRegex.exec(rMatch[2])) !== null) {
      const parsed = parseCellTag(cMatch[1], cMatch[2], cMatch[3], sharedStrings);
      if (parsed) {
        maxCol = Math.max(maxCol, parsed.colNum);
        cells[parsed.cellRef] = parsed.data;
      }
    }
  }

  return { rowCount: maxRow, colCount: maxCol, cells };
}

export async function parseXlsxToAst(buffer: Buffer): Promise<XlsxStructuralAst> {
  const zip = await JSZip.loadAsync(buffer);
  const sharedStrings = await extractSharedStrings(zip);
  const customNumberFormats = await extractCustomNumberFormats(zip);
  const sheetNames = await extractSheetNames(zip);

  const sheets: XlsxStructuralAst['sheets'] = {};
  const sheetFiles = Object.keys(zip.files)
    .filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(f))
    .sort((a, b) => {
      const numA = Number.parseInt((a.match(/sheet(\d+)\.xml/i) || [])[1] || '0', 10);
      const numB = Number.parseInt((b.match(/sheet(\d+)\.xml/i) || [])[1] || '0', 10);
      return numA - numB;
    });

  for (let i = 0; i < sheetFiles.length; i++) {
    const name = sheetNames[i] || `Sheet${i + 1}`;
    const xml = await zip.files[sheetFiles[i]].async('text');
    sheets[name] = parseWorksheetXml(xml, sharedStrings);
  }

  return {
    format: 'xlsx',
    sheetNames,
    sheetCount: sheetNames.length,
    sheets,
    sharedStrings,
    customNumberFormats,
  };
}

async function extractPptxSlideDimensions(zip: JSZip): Promise<{ slideWidthPt: number; slideHeightPt: number }> {
  let slideWidthPt = 960;
  let slideHeightPt = 540;
  const presFile = zip.file('ppt/presentation.xml');
  if (presFile) {
    const xml = await presFile.async('text');
    const tagMatch = /<p:sldSz\b[^>]*>/i.exec(xml);
    if (tagMatch) {
      const cx = /\bcx="(\d+)"/i.exec(tagMatch[0]);
      const cy = /\bcy="(\d+)"/i.exec(tagMatch[0]);
      if (cx && cy) {
        slideWidthPt = Math.round(Number.parseInt(cx[1], 10) / 12700);
        slideHeightPt = Math.round(Number.parseInt(cy[1], 10) / 12700);
      }
    }
  }
  return { slideWidthPt, slideHeightPt };
}

function parsePptxShape(spXml: string): PptxStructuralAst['slides'][0]['shapes'][0] {
  const nameMatch = /<p:cNvPr\b[^>]*\bname="([^"]*)"/i.exec(spXml);
  const prstMatch = /<a:prstGeom\b[^>]*\bprst="([^"]*)"/i.exec(spXml);
  const fillMatch = /<a:srgbClr\b[^>]*\bval="([0-9a-f]{6})"/i.exec(spXml);

  let bounds = { x: 0, y: 0, cx: 0, cy: 0 };
  const offMatch = /<a:off\b[^>]*\bx="(\d+)"\s+y="(\d+)"/i.exec(spXml);
  const extMatch = /<a:ext\b[^>]*\bcx="(\d+)"\s+cy="(\d+)"/i.exec(spXml);
  if (offMatch && extMatch) {
    bounds = {
      x: Math.round(Number.parseInt(offMatch[1], 10) / 12700),
      y: Math.round(Number.parseInt(offMatch[2], 10) / 12700),
      cx: Math.round(Number.parseInt(extMatch[1], 10) / 12700),
      cy: Math.round(Number.parseInt(extMatch[2], 10) / 12700),
    };
  }

  const textParts: string[] = [];
  const tRegex = /<a:t\b[^>]*>([\s\S]*?)<\/a:t>/gi;
  let tMatch: RegExpExecArray | null;
  while ((tMatch = tRegex.exec(spXml)) !== null) {
    textParts.push(
      tMatch[1]
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
    );
  }

  return {
    name: nameMatch ? nameMatch[1] : undefined,
    geomType: prstMatch ? prstMatch[1] : 'rect',
    fillColor: fillMatch ? `#${fillMatch[1].toUpperCase()}` : undefined,
    bounds,
    text: textParts.join(' '),
  };
}

function parsePptxSlide(xml: string, slideIndex: number): PptxStructuralAst['slides'][0] {
  const bgMatch = /<a:srgbClr\b[^>]*\bval="([0-9a-f]{6})"/i.exec(xml);
  const backgroundColor = bgMatch ? `#${bgMatch[1].toUpperCase()}` : undefined;

  const shapes: PptxStructuralAst['slides'][0]['shapes'] = [];
  const spRegex = /<p:sp\b[^>]*>([\s\S]*?)<\/p:sp>/gi;
  let spMatch: RegExpExecArray | null;
  while ((spMatch = spRegex.exec(xml)) !== null) {
    shapes.push(parsePptxShape(spMatch[1]));
  }

  const tableCount = (xml.match(/<a:tbl\b/gi) || []).length;
  return { slideIndex, backgroundColor, shapes, tableCount };
}

export async function parsePptxToAst(buffer: Buffer): Promise<PptxStructuralAst> {
  const zip = await JSZip.loadAsync(buffer);
  const { slideWidthPt, slideHeightPt } = await extractPptxSlideDimensions(zip);

  const slideFiles = Object.keys(zip.files)
    .filter((f) => /^ppt\/slides\/slide\d+\.xml$/i.test(f))
    .sort((a, b) => {
      const numA = Number.parseInt((a.match(/slide(\d+)\.xml/i) || [])[1] || '0', 10);
      const numB = Number.parseInt((b.match(/slide(\d+)\.xml/i) || [])[1] || '0', 10);
      return numA - numB;
    });

  const slides: PptxStructuralAst['slides'] = [];
  for (let i = 0; i < slideFiles.length; i++) {
    const xml = await zip.files[slideFiles[i]].async('text');
    slides.push(parsePptxSlide(xml, i + 1));
  }

  return {
    format: 'pptx',
    slideCount: slides.length,
    slideWidthPt,
    slideHeightPt,
    slides,
  };
}

function extractDocxParagraphs(xml: string): string[] {
  const paragraphs: string[] = [];
  const pRegex = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/gi;
  let pMatch: RegExpExecArray | null;
  while ((pMatch = pRegex.exec(xml)) !== null) {
    const words: string[] = [];
    const tRegex = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gi;
    let tMatch: RegExpExecArray | null;
    while ((tMatch = tRegex.exec(pMatch[1])) !== null) {
      words.push(tMatch[1]);
    }
    if (words.length > 0) {
      paragraphs.push(words.join(''));
    }
  }
  return paragraphs;
}

function extractDocxTables(xml: string): DocxStructuralAst['tables'] {
  const tables: DocxStructuralAst['tables'] = [];
  const tblRegex = /<w:tbl\b[^>]*>([\s\S]*?)<\/w:tbl>/gi;
  let tblMatch: RegExpExecArray | null;
  while ((tblMatch = tblRegex.exec(xml)) !== null) {
    const rows: string[][] = [];
    const trRegex = /<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/gi;
    let trMatch: RegExpExecArray | null;
    while ((trMatch = trRegex.exec(tblMatch[1])) !== null) {
      const rowCells: string[] = [];
      const tcRegex = /<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/gi;
      let tcMatch: RegExpExecArray | null;
      while ((tcMatch = tcRegex.exec(trMatch[1])) !== null) {
        const cellWords: string[] = [];
        const tRegex = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gi;
        let tMatch: RegExpExecArray | null;
        while ((tMatch = tRegex.exec(tcMatch[1])) !== null) {
          cellWords.push(tMatch[1]);
        }
        rowCells.push(cellWords.join(''));
      }
      rows.push(rowCells);
    }
    tables.push({
      rowCount: rows.length,
      colCount: rows[0] ? rows[0].length : 0,
      cellTexts: rows,
    });
  }
  return tables;
}

async function extractDocxFootnotes(zip: JSZip): Promise<string[]> {
  const footnotes: string[] = [];
  const fnFile = zip.file('word/footnotes.xml');
  if (!fnFile) return footnotes;

  const fnXml = await fnFile.async('text');
  const fnRegex = /<w:footnote\b[^>]*>([\s\S]*?)<\/w:footnote>/gi;
  let fnMatch: RegExpExecArray | null;
  while ((fnMatch = fnRegex.exec(fnXml)) !== null) {
    const words: string[] = [];
    const tRegex = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gi;
    let tMatch: RegExpExecArray | null;
    while ((tMatch = tRegex.exec(fnMatch[1])) !== null) {
      words.push(tMatch[1]);
    }
    if (words.length > 0) footnotes.push(words.join(''));
  }
  return footnotes;
}

export async function parseDocxToAst(buffer: Buffer): Promise<DocxStructuralAst> {
  const zip = await JSZip.loadAsync(buffer);
  const docFile = zip.file('word/document.xml');
  if (!docFile) {
    throw new Error('Invalid DOCX: missing word/document.xml');
  }

  const xml = await docFile.async('text');
  const paragraphs = extractDocxParagraphs(xml);
  const tables = extractDocxTables(xml);
  const footnotes = await extractDocxFootnotes(zip);

  const colMatch = /<w:cols\b[^>]*\bw:num="(\d+)"/i.exec(xml);
  const columnCount = colMatch ? Number.parseInt(colMatch[1], 10) : 1;
  const totalTableCount = (xml.match(/<w:tbl\b/gi) || []).length;

  return {
    format: 'docx',
    paragraphCount: paragraphs.length,
    paragraphs,
    tableCount: totalTableCount,
    tables,
    columnCount,
    footnotes,
  };
}

export function parseCadStepToAst(buffer: Buffer): CadStepStructuralAst {
  let content = buffer.toString('utf-8');
  content = content.replace(/\/\*[\s\S]*?\*\//g, '');
  const schemaMatch = /FILE_SCHEMA\(\('([^']+)'/i.exec(content);
  const schema = schemaMatch ? schemaMatch[1] : 'UNKNOWN';

  const vertexMatches = content.match(/=\s*VERTEX_POINT\b/g) || [];
  const edgeMatches = content.match(/=\s*EDGE_CURVE\b/g) || [];
  const faceMatches = content.match(/=\s*ADVANCED_FACE\b/g) || [];
  const isClosedManifold = content.includes('CLOSED_SHELL') && content.includes('MANIFOLD_SOLID_BREP');

  const vertexCount = vertexMatches.length;
  const edgeCount = edgeMatches.length;
  const faceCount = faceMatches.length;
  const eulerCharacteristic = vertexCount - edgeCount + faceCount;

  return {
    format: 'step',
    schema,
    vertexCount,
    edgeCount,
    faceCount,
    eulerCharacteristic,
    isClosedManifold,
  };
}

function parseMp4AudioAst(buffer: Buffer): AudioMediaAst {
  const boxTypes: string[] = [];
  let hasAudioTrack = false;
  let hasMoov = false;
  let offset = 0;

  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    boxTypes.push(type);
    if (type === 'moov') hasMoov = true;
    if (type === 'soun' || type === 'mp4a') hasAudioTrack = true;
    if (size <= 0) break;
    offset += size;
  }

  return {
    format: 'mp4',
    containerBoxTypes: boxTypes,
    hasAudioTrack: hasAudioTrack || hasMoov,
    hasMoovHeader: hasMoov,
    hasEbmlHeader: false,
    estimatedSampleRate: 44100,
    estimatedChannels: 2,
  };
}

function parseWebmAudioAst(buffer: Buffer): AudioMediaAst {
  const hasEbml = buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  return {
    format: 'webm',
    containerBoxTypes: ['EBML'],
    hasAudioTrack: buffer.includes('Audio') || buffer.includes('A_OPUS'),
    hasMoovHeader: false,
    hasEbmlHeader: hasEbml,
    estimatedSampleRate: 48000,
    estimatedChannels: 2,
  };
}

function parseMp3AudioAst(buffer: Buffer): AudioMediaAst {
  let syncFound = false;
  for (let i = 0; i < Math.min(buffer.length - 2, 4096); i++) {
    if (buffer[i] === 0xff && (buffer[i + 1] & 0xe0) === 0xe0) {
      syncFound = true;
      break;
    }
  }
  return {
    format: 'mp3',
    containerBoxTypes: syncFound ? ['MPEG_FRAME'] : [],
    hasAudioTrack: syncFound,
    hasMoovHeader: false,
    hasEbmlHeader: false,
    estimatedSampleRate: 44100,
    estimatedChannels: 2,
  };
}

function parseFlacAudioAst(buffer: Buffer): AudioMediaAst {
  const isFlac = buffer.length >= 42 && buffer.subarray(0, 4).toString('ascii') === 'fLaC';
  let sampleRate = 44100;
  let channels = 2;

  if (isFlac) {
    const b18 = buffer[18];
    const b19 = buffer[19];
    const b20 = buffer[20];
    sampleRate = (b18 << 12) | (b19 << 4) | (b20 >> 4);
    channels = ((b20 >> 1) & 0x07) + 1;
  }

  return {
    format: 'flac',
    containerBoxTypes: isFlac ? ['fLaC', 'STREAMINFO'] : [],
    hasAudioTrack: isFlac,
    hasMoovHeader: false,
    hasEbmlHeader: false,
    estimatedSampleRate: sampleRate,
    estimatedChannels: channels,
  };
}

function parseWavAudioAst(buffer: Buffer): AudioMediaAst {
  let sampleRate = 44100;
  let channels = 2;
  const isWav =
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WAVE';

  if (isWav) {
    const fmtIdx = buffer.indexOf('fmt ');
    if (fmtIdx !== -1 && fmtIdx + 16 <= buffer.length) {
      channels = buffer.readUInt16LE(fmtIdx + 8 + 2);
      sampleRate = buffer.readUInt32LE(fmtIdx + 8 + 4);
    }
  }

  return {
    format: 'wav',
    containerBoxTypes: [buffer.subarray(0, 4).toString('ascii')],
    hasAudioTrack: isWav,
    hasMoovHeader: false,
    hasEbmlHeader: false,
    estimatedSampleRate: sampleRate,
    estimatedChannels: channels,
  };
}

export function parseAudioMediaToAst(buffer: Buffer, format: string): AudioMediaAst {
  const fmt = format.toLowerCase();
  switch (fmt) {
    case 'mp4':
    case 'm4a':
      return parseMp4AudioAst(buffer);
    case 'webm':
      return parseWebmAudioAst(buffer);
    case 'mp3':
      return parseMp3AudioAst(buffer);
    case 'flac':
      return parseFlacAudioAst(buffer);
    default:
      return parseWavAudioAst(buffer);
  }
}

export async function parseArchiveToAst(buffer: Buffer, format: string): Promise<ArchiveStructuralAst> {
  const fmt = format.toLowerCase();

  if (fmt === 'zip') {
    const zip = await JSZip.loadAsync(buffer);
    const files = await Promise.all(
      Object.keys(zip.files).map(async (name) => {
        const entry = zip.files[name];
        let size = 0;
        if (!entry.dir) {
          const content = await entry.async('nodebuffer');
          size = content.length;
        }
        return {
          name,
          size,
          isDir: entry.dir,
        };
      })
    );
    return {
      format: 'zip',
      fileCount: files.length,
      files,
    };
  }

  if (fmt === 'tar') {
    return parseTarArchiveStructure(buffer);
  }

  if (fmt === '7z') {
    return parse7zArchiveStructure(buffer);
  }

  if (fmt === 'zstd' || fmt === 'zst') {
    return {
      format: 'zstd',
      fileCount: 1,
      files: [{ name: 'stream.bin', size: buffer.length, isDir: false }],
    };
  }

  return {
    format: 'zstd',
    fileCount: 0,
    files: [],
  };
}

function parseTarArchiveStructure(buffer: Buffer): ArchiveStructuralAst {
  const toolPath = getOracleToolPath('tar');
  if (toolPath) {
    try {
      const out = execFileSync(toolPath, ['-tf', '-'], {
        input: buffer,
        stdio: ['pipe', 'pipe', 'ignore'],
        encoding: 'utf-8',
      });
      const lines = out.split('\n').filter(Boolean);
      return {
        format: 'tar',
        fileCount: lines.length,
        files: lines.map((name) => ({
          name,
          size: 0,
          isDir: name.endsWith('/'),
        })),
      };
    } catch {}
  }
  if (buffer.length >= 512 && buffer.toString('ascii', 257, 262) === 'ustar') {
    const rawName = buffer.toString('ascii', 0, 100);
    const nullIdx = rawName.indexOf('\0');
    const name = nullIdx !== -1 ? rawName.slice(0, nullIdx) : rawName;
    return {
      format: 'tar',
      fileCount: name ? 1 : 0,
      files: name ? [{ name, size: 0, isDir: false }] : [],
    };
  }
  return { format: 'tar', fileCount: 0, files: [] };
}

function parse7zCliListing(toolPath: string, buffer: Buffer): ArchiveStructuralAst | null {
  const tmpPath = path.join(os.tmpdir(), `oracle_list_${crypto.randomUUID()}.7z`);
  try {
    fs.writeFileSync(tmpPath, buffer);
    const out = execFileSync(toolPath, ['l', '-ba', tmpPath], {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
    });
    const lines = out.split('\n').filter(Boolean);
    return {
      format: '7z',
      fileCount: lines.length,
      files: lines.map((l) => ({
        name: l.trim().split(/\s+/).pop() || '',
        size: 0,
        isDir: false,
      })),
    };
  } catch {
    return null;
  } finally {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {}
  }
}

function extract7zHeaderUnpackSizes(nh: Buffer): number[] {
  const sizes: number[] = [];
  const unpackSizeIdx = nh.indexOf(0x0c);
  if (unpackSizeIdx === -1) return sizes;

  let p = unpackSizeIdx + 1;
  while (p < nh.length && nh[p] !== 0x0a && nh[p] !== 0x00 && nh[p] !== 0x05) {
    const b = nh[p++];
    sizes.push(b < 0x80 ? b : b & 0x7f);
  }
  return sizes;
}

function extract7zHeaderFiles(nh: Buffer, sizes: number[]): { name: string; size: number; isDir: boolean }[] {
  const files: { name: string; size: number; isDir: boolean }[] = [];
  const filesInfoIdx = nh.indexOf(0x05);
  if (filesInfoIdx === -1) return files;

  // Search for UTF-16LE file names inside or after kFilesInfo
  let p = filesInfoIdx + 2;
  while (p < nh.length && nh[p] !== 0x00) {
    p++;
    let propLen = 0;
    if (p < nh.length) {
      const b = nh[p++];
      propLen = b < 0x80 ? b : b & 0x7f;
    }
    const external = p < nh.length ? nh[p++] : 1;
    if (external === 0 && p < nh.length) {
      const chunk = nh.subarray(p, Math.min(nh.length, p + propLen));
      const names = chunk.toString('utf16le').split('\0').filter(Boolean);
      if (names.length > 0 && names.every((n) => /^[\x20-\x7e]+$/.test(n))) {
        for (let i = 0; i < names.length; i++) {
          files.push({
            name: names[i],
            size: sizes[i] ?? 0,
            isDir: names[i].endsWith('/'),
          });
        }
        return files;
      }
    }
    p += propLen;
  }

  // Fallback heuristic: find sequence of UTF-16LE null-terminated ASCII characters
  for (let i = filesInfoIdx; i < nh.length - 8; i++) {
    if (
      nh[i] >= 0x20 && nh[i] <= 0x7e && nh[i + 1] === 0x00 &&
      nh[i + 2] >= 0x20 && nh[i + 2] <= 0x7e && nh[i + 3] === 0x00
    ) {
      const names = nh.subarray(i).toString('utf16le').split('\0').filter(Boolean);
      for (let s = 0; s < names.length; s++) {
        if (/^[\x20-\x7e]+$/.test(names[s])) {
          files.push({
            name: names[s],
            size: sizes[s] ?? 0,
            isDir: names[s].endsWith('/'),
          });
        }
      }
      if (files.length > 0) break;
    }
  }

  return files;
}

function parse7zArchiveStructure(buffer: Buffer): ArchiveStructuralAst {
  const toolPath = getOracleToolPath('7z');
  if (toolPath) {
    const cliAst = parse7zCliListing(toolPath, buffer);
    if (cliAst) return cliAst;
  }

  const sevenZMagic = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
  if (buffer.length < 32 || !buffer.subarray(0, 6).equals(sevenZMagic)) {
    return { format: '7z', fileCount: 0, files: [] };
  }
  const nextHeaderOffset = Number(buffer.readBigUInt64LE(12));
  const nextHeaderSize = Number(buffer.readBigUInt64LE(20));
  const nhStart = 32 + nextHeaderOffset;
  if (nhStart + nextHeaderSize > buffer.length || nextHeaderSize === 0) {
    return { format: '7z', fileCount: 0, files: [] };
  }

  const nh = buffer.subarray(nhStart, nhStart + nextHeaderSize);
  const sizes = extract7zHeaderUnpackSizes(nh);
  const files = extract7zHeaderFiles(nh, sizes);

  return {
    format: '7z',
    fileCount: files.length,
    files,
  };
}

// ============================================================================
export interface DifferentialComparisonOptions {
  vrtOptions?: VrtOptions;
  minStructuralScore?: number;
  minTextScore?: number;
  minSsim?: number;
  minPsnr?: number;
}

export interface DifferentialReport {
  matched: boolean;
  oracleType: 'external_cli' | 'structural_ast_reference';
  structuralScore: number; // 0.0 to 1.0
  textSimilarity: number;  // 0.0 to 1.0
  ssim?: number;
  psnr?: number;
  vrtResult?: VrtResult;
  discrepancies: string[];
}

export function calculateNormalizedTextSimilarity(strA: string, strB: string): number {
  const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const normA = normalize(strA);
  const normB = normalize(strB);

  if (normA === normB) return 1.0;
  if (!normA.length || !normB.length) return 0.0;

  const wordsA = new Set(normA.split(' '));
  const wordsB = new Set(normB.split(' '));

  let intersect = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersect++;
  }

  const union = new Set([...wordsA, ...wordsB]).size;
  return union === 0 ? 1.0 : intersect / union;
}

async function comparePdfDifferential(
  actualBuffer: Buffer,
  referenceBuffer: Buffer,
  discrepancies: string[]
): Promise<{ structuralScore: number; textSimilarity: number }> {
  let structuralScore = 1.0;
  const actualAst = await parsePdfToAst(actualBuffer);
  const refAst = await parsePdfToAst(referenceBuffer);

  if (actualAst.pageCount !== refAst.pageCount) {
    discrepancies.push(`Page count mismatch: actual=${actualAst.pageCount}, ref=${refAst.pageCount}`);
    structuralScore -= 0.3;
  }
  if (refAst.hasObjectStreams && !actualAst.hasObjectStreams) {
    discrepancies.push('ObjectStreams missing in actual output');
    structuralScore -= 0.1;
  }
  let textSimilarity = 1.0;
  if (isOracleToolAvailable('pdftotext')) {
    const actualText = extractTextWithExternalPdftotext(actualBuffer);
    const refText = extractTextWithExternalPdftotext(referenceBuffer);
    if (actualText !== null && refText !== null) {
      textSimilarity = calculateNormalizedTextSimilarity(actualText, refText);
    } else {
      textSimilarity = calculateNormalizedTextSimilarity(actualAst.extractedText, refAst.extractedText);
    }
  } else {
    textSimilarity = calculateNormalizedTextSimilarity(actualAst.extractedText, refAst.extractedText);
  }
  return { structuralScore, textSimilarity };
}

async function compareXlsxDifferential(
  actualBuffer: Buffer,
  referenceBuffer: Buffer,
  discrepancies: string[]
): Promise<{ structuralScore: number; textSimilarity: number }> {
  let structuralScore = 1.0;
  const actualAst = await parseXlsxToAst(actualBuffer);
  const refAst = await parseXlsxToAst(referenceBuffer);

  if (actualAst.sheetCount !== refAst.sheetCount) {
    discrepancies.push(`Sheet count mismatch: actual=${actualAst.sheetCount}, ref=${refAst.sheetCount}`);
    structuralScore -= 0.4;
  }
  for (const sheetName of refAst.sheetNames) {
    if (!actualAst.sheetNames.includes(sheetName)) {
      discrepancies.push(`Missing expected sheet: ${sheetName}`);
      structuralScore -= 0.2;
    }
  }
  const textSimilarity = calculateNormalizedTextSimilarity(
    actualAst.sharedStrings.join(' '),
    refAst.sharedStrings.join(' ')
  );
  return { structuralScore, textSimilarity };
}

async function comparePptxDifferential(
  actualBuffer: Buffer,
  referenceBuffer: Buffer,
  discrepancies: string[]
): Promise<{ structuralScore: number }> {
  let structuralScore = 1.0;
  const actualAst = await parsePptxToAst(actualBuffer);
  const refAst = await parsePptxToAst(referenceBuffer);

  if (actualAst.slideCount !== refAst.slideCount) {
    discrepancies.push(`Slide count mismatch: actual=${actualAst.slideCount}, ref=${refAst.slideCount}`);
    structuralScore -= 0.5;
  }
  if (actualAst.slideWidthPt !== refAst.slideWidthPt || actualAst.slideHeightPt !== refAst.slideHeightPt) {
    discrepancies.push('Slide dimension mismatch');
    structuralScore -= 0.2;
  }
  return { structuralScore };
}

function compareCadStepDifferential(
  actualBuffer: Buffer,
  referenceBuffer: Buffer,
  discrepancies: string[]
): { structuralScore: number } {
  let structuralScore = 1.0;
  const actualAst = parseCadStepToAst(actualBuffer);
  const refAst = parseCadStepToAst(referenceBuffer);

  if (actualAst.vertexCount !== refAst.vertexCount) {
    discrepancies.push(`CAD Vertex mismatch: actual=${actualAst.vertexCount}, ref=${refAst.vertexCount}`);
    structuralScore -= 0.25;
  }
  if (actualAst.faceCount !== refAst.faceCount) {
    discrepancies.push(`CAD Face mismatch: actual=${actualAst.faceCount}, ref=${refAst.faceCount}`);
    structuralScore -= 0.25;
  }
  if (actualAst.eulerCharacteristic !== refAst.eulerCharacteristic) {
    discrepancies.push(`Euler characteristic deviation: ${actualAst.eulerCharacteristic} vs ${refAst.eulerCharacteristic}`);
    structuralScore -= 0.5;
  }
  return { structuralScore };
}

export async function runDifferentialComparison(
  actualBuffer: Buffer,
  referenceBuffer: Buffer,
  format: string,
  options: DifferentialComparisonOptions = {}
): Promise<DifferentialReport> {
  const fmt = format.toLowerCase();
  const discrepancies: string[] = [];
  let structuralScore = 1.0;
  let textSimilarity = 1.0;
  let vrtResult: VrtResult | undefined;
  let oracleType: 'external_cli' | 'structural_ast_reference' = 'structural_ast_reference';

  try {
    assertFormatIntegrity(actualBuffer, fmt);
  } catch (err: any) {
    discrepancies.push(`Actual buffer integrity violation: ${err?.message || 'Failed format integrity check'}`);
    return {
      matched: false,
      oracleType,
      structuralScore: 0,
      textSimilarity: 0,
      vrtResult: undefined,
      discrepancies,
    };
  }

  try {
    assertFormatIntegrity(referenceBuffer, fmt);
  } catch (err: any) {
    discrepancies.push(`Reference buffer integrity violation: ${err?.message || 'Failed reference integrity check'}`);
    return {
      matched: false,
      oracleType,
      structuralScore: 0,
      textSimilarity: 0,
      vrtResult: undefined,
      discrepancies,
    };
  }

  if (fmt === 'pdf') {
    if (isOracleToolAvailable('pdfinfo') || isOracleToolAvailable('pdftotext')) {
      oracleType = 'external_cli';
      if (isOracleToolAvailable('pdfinfo') && !verifyPdfWithPoppler(actualBuffer)) {
        discrepancies.push('Poppler external oracle CLI failed to verify PDF structure');
      }
    }
    const res = await comparePdfDifferential(actualBuffer, referenceBuffer, discrepancies);
    structuralScore = res.structuralScore;
    textSimilarity = res.textSimilarity;
  } else if (fmt === 'xlsx') {
    const res = await compareXlsxDifferential(actualBuffer, referenceBuffer, discrepancies);
    structuralScore = res.structuralScore;
    textSimilarity = res.textSimilarity;
  } else if (fmt === 'pptx') {
    const res = await comparePptxDifferential(actualBuffer, referenceBuffer, discrepancies);
    structuralScore = res.structuralScore;
  } else if (fmt === 'step' || fmt === 'stp') {
    const res = compareCadStepDifferential(actualBuffer, referenceBuffer, discrepancies);
    structuralScore = res.structuralScore;
  } else if (['png', 'webp', 'bmp', 'jpg', 'jpeg'].includes(fmt)) {
    if (isOracleToolAvailable('identify') || isOracleToolAvailable('magick')) {
      oracleType = 'external_cli';
      if (!verifyImageWithImageMagick(actualBuffer)) {
        discrepancies.push('ImageMagick external oracle CLI failed to decode actual image bitstream');
      }
    }
    vrtResult = await compareImages(actualBuffer, referenceBuffer, options.vrtOptions);
    const ssim = vrtResult.ssim;
    const psnr = vrtResult.psnr;

    if (!vrtResult.passed) {
      discrepancies.push(
        `VRT failure: deltaRatio=${(vrtResult.deltaRatio * 100).toFixed(3)}%, SSIM=${ssim.toFixed(3)}, PSNR=${psnr === Infinity ? 'Infinity' : psnr.toFixed(2)}dB`
      );
      structuralScore = ssim;
    }

    if (options.minSsim !== undefined && ssim < options.minSsim) {
      discrepancies.push(
        `Quantitative SSIM assertion failed: observed ${ssim.toFixed(4)} < required minimum ${options.minSsim}`
      );
    }

    if (options.minPsnr !== undefined && psnr < options.minPsnr) {
      discrepancies.push(
        `Quantitative PSNR assertion failed: observed ${psnr === Infinity ? 'Infinity' : psnr.toFixed(2)}dB < required minimum ${options.minPsnr}dB`
      );
    }
  } else if (['wav', 'mp3', 'flac'].includes(fmt)) {
    if (isOracleToolAvailable('ffmpeg')) {
      oracleType = 'external_cli';
      if (!verifyAudioWithFfmpeg(actualBuffer)) {
        discrepancies.push(`FFmpeg external oracle CLI failed to decode ${fmt} audio bitstream`);
        structuralScore = 0;
      }
    }
    const actualAst = parseAudioMediaToAst(actualBuffer, fmt);
    const refAst = parseAudioMediaToAst(referenceBuffer, fmt);
    if (actualAst.estimatedSampleRate !== refAst.estimatedSampleRate) {
      discrepancies.push(`Audio sample rate mismatch: actual=${actualAst.estimatedSampleRate}, ref=${refAst.estimatedSampleRate}`);
      structuralScore -= 0.3;
    }
    if (actualAst.estimatedChannels !== refAst.estimatedChannels) {
      discrepancies.push(`Audio channels mismatch: actual=${actualAst.estimatedChannels}, ref=${refAst.estimatedChannels}`);
      structuralScore -= 0.3;
    }
    if (!actualAst.hasAudioTrack) {
      discrepancies.push('Missing audio track in decoded bitstream');
      structuralScore = 0;
    }
  }

  structuralScore = Math.max(0, Math.min(1.0, structuralScore));
  const minScore = options.minStructuralScore ?? 0.8;
  const minText = options.minTextScore ?? 0.7;

  if (fmt === 'tar') {
    if (isOracleToolAvailable('tar')) {
      oracleType = 'external_cli';
      const isValid = verifyArchiveWithTar(actualBuffer);
      if (!isValid) {
        discrepancies.push('External tar CLI archive verification failed');
        structuralScore = 0;
      }
    } else {
      try {
        checkTarIntegrity(actualBuffer);
      } catch (err: any) {
        discrepancies.push(`Native TAR validation failed: ${err?.message}`);
        structuralScore = 0;
      }
    }
  } else if (fmt === 'zstd' || fmt === 'zst') {
    if (isOracleToolAvailable('zstd')) {
      oracleType = 'external_cli';
      const isValid = verifyArchiveWithZstd(actualBuffer);
      if (!isValid) {
        discrepancies.push('External zstd CLI decompression verification failed');
        structuralScore = 0;
      }
    } else {
      try {
        checkZstdIntegrity(actualBuffer);
      } catch (err: any) {
        discrepancies.push(`Native Zstandard validation failed: ${err?.message}`);
        structuralScore = 0;
      }
    }
  } else if (fmt === '7z') {
    if (isOracleToolAvailable('7z')) {
      oracleType = 'external_cli';
      const isValid = verifyArchiveWith7z(actualBuffer);
      if (!isValid) {
        discrepancies.push('External 7z CLI archive test failed');
        structuralScore = 0;
      }
    } else {
      if (actualBuffer.length < 32) {
        discrepancies.push('Native 7z validation failed: Truncated 7z archive header (minimum 32 bytes required)');
        structuralScore = 0;
      } else {
        try {
          check7zIntegrity(actualBuffer);
        } catch (err: any) {
          discrepancies.push(`Native 7z validation failed: ${err?.message}`);
          structuralScore = 0;
        }
      }
    }
  }

  return {
    matched: structuralScore >= minScore && textSimilarity >= minText && discrepancies.length === 0,
    oracleType,
    structuralScore,
    textSimilarity,
    ssim: vrtResult?.ssim,
    psnr: vrtResult?.psnr,
    vrtResult,
    discrepancies,
  };
}

// ============================================================================
// 5. Hard Assertion Gates
// ============================================================================

function checkPdfIntegrity(buffer: Buffer): void {
  if (buffer.length < 8 || !buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
    throw new Error('Integrity Violation: Missing PDF magic header %PDF-');
  }
  const latin1 = buffer.toString('latin1');
  if (!latin1.includes('%%EOF')) {
    throw new Error('Integrity Violation: Missing PDF EOF marker %%EOF');
  }
  if (!latin1.includes('obj') || !latin1.includes('endobj')) {
    throw new Error('Integrity Violation: Missing PDF object definitions (obj / endobj)');
  }
  if (isOracleToolAvailable('pdfinfo') && buffer.length > 200 && latin1.includes('/Root')) {
    if (!verifyPdfWithPoppler(buffer)) {
      throw new Error('Integrity Violation: Poppler pdfinfo CLI verification failed on PDF document');
    }
  }
}

function checkPngIntegrity(buffer: Buffer): void {
  const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(pngMagic)) {
    throw new Error('Integrity Violation: Missing PNG 8-byte magic signature');
  }
  const ihdrLen = buffer.readUInt32BE(8);
  const ihdrType = buffer.subarray(12, 16).toString('ascii');
  if (ihdrType !== 'IHDR' || ihdrLen < 13) {
    throw new Error('Integrity Violation: Missing or invalid PNG IHDR chunk');
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width === 0 || height === 0) {
    throw new Error(`Integrity Violation: Invalid PNG dimensions (width=${width}, height=${height})`);
  }
  if (!buffer.includes(Buffer.from('IEND', 'ascii'))) {
    throw new Error('Integrity Violation: Missing PNG IEND chunk');
  }
  if (isOracleToolAvailable('identify') || isOracleToolAvailable('magick')) {
    if (!verifyImageWithImageMagick(buffer)) {
      throw new Error('Integrity Violation: ImageMagick CLI failed to decode PNG bitstream');
    }
  }
}

function check7zIntegrity(buffer: Buffer): void {
  const sevenZMagic = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
  if (buffer.length < 6 || !buffer.subarray(0, 6).equals(sevenZMagic)) {
    throw new Error('Integrity Violation: Missing 7z 6-byte magic signature');
  }
  if (buffer.length < 32) {
    throw new Error('Integrity Violation: Truncated 7z archive header (minimum 32 bytes required)');
  }
  const major = buffer[6];
  if (major > 10) {
    throw new Error(`Integrity Violation: Invalid 7z major version ${major}`);
  }
  if (isOracleToolAvailable('7z') && buffer.length > 100) {
    if (!verifyArchiveWith7z(buffer)) {
      throw new Error('Integrity Violation: External 7z CLI verification failed');
    }
  }
}

function checkZipIntegrity(buffer: Buffer): void {
  const zipMagic = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  if (buffer.length < 22 || !buffer.subarray(0, 4).equals(zipMagic)) {
    throw new Error(String.raw`Integrity Violation: Missing OpenXML / ZIP PK\x03\x04 magic header`);
  }
  const eocdMagic = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  if (buffer.lastIndexOf(eocdMagic) === -1) {
    throw new Error(String.raw`Integrity Violation: Missing ZIP End of Central Directory (EOCD) record PK\x05\x06`);
  }
}

function checkDocxIntegrity(buffer: Buffer): void {
  checkZipIntegrity(buffer);
  const latin1 = buffer.toString('latin1');
  if (!latin1.includes('word/') && !latin1.includes('[Content_Types].xml')) {
    throw new Error('Integrity Violation: Missing WordprocessingML structures (word/ or [Content_Types].xml)');
  }
}

function checkXlsxIntegrity(buffer: Buffer): void {
  checkZipIntegrity(buffer);
  const latin1 = buffer.toString('latin1');
  if (!latin1.includes('xl/') && !latin1.includes('[Content_Types].xml')) {
    throw new Error('Integrity Violation: Missing SpreadsheetML structures (xl/ or [Content_Types].xml)');
  }
}

function checkPptxIntegrity(buffer: Buffer): void {
  checkZipIntegrity(buffer);
  const latin1 = buffer.toString('latin1');
  if (!latin1.includes('ppt/') && !latin1.includes('[Content_Types].xml')) {
    throw new Error('Integrity Violation: Missing PresentationML structures (ppt/ or [Content_Types].xml)');
  }
}

function checkOdsIntegrity(buffer: Buffer): void {
  checkZipIntegrity(buffer);
  const latin1 = buffer.toString('latin1');
  if (!latin1.includes('opendocument.spreadsheet') && !latin1.includes('table:table') && !latin1.includes('table:name')) {
    throw new Error('Integrity Violation: Missing ODS OpenDocument spreadsheet structures (mimetype or table elements)');
  }
}

function checkOdtIntegrity(buffer: Buffer): void {
  checkZipIntegrity(buffer);
  const latin1 = buffer.toString('latin1');
  if (!latin1.includes('opendocument.text') && !latin1.includes('text:p')) {
    throw new Error('Integrity Violation: Missing ODT OpenDocument text structures (mimetype or text elements)');
  }
}

function checkOdpIntegrity(buffer: Buffer): void {
  checkZipIntegrity(buffer);
  const latin1 = buffer.toString('latin1');
  if (!latin1.includes('opendocument.presentation') && !latin1.includes('draw:page')) {
    throw new Error('Integrity Violation: Missing ODP OpenDocument presentation structures (mimetype or draw elements)');
  }
}



function checkStepIntegrity(buffer: Buffer): void {
  const str = buffer.toString('utf-8', 0, Math.min(buffer.length, 4096));
  if (!str.includes('ISO-10303-21')) {
    throw new Error('Integrity Violation: Missing ISO-10303-21 STEP header');
  }
  if (!str.includes('HEADER;') || (!str.includes('DATA;') && !str.includes('ENDSEC;'))) {
    throw new Error('Integrity Violation: Incomplete STEP AP214 structure (missing HEADER/DATA sections)');
  }
}

function checkTarIntegrity(buffer: Buffer): void {
  if (buffer.length < 512) {
    throw new Error('Integrity Violation: TAR archive must be at least 512 bytes');
  }
  if (buffer.length % 512 !== 0) {
    throw new Error(`Integrity Violation: TAR archive length (${buffer.length}) must be a multiple of 512 bytes`);
  }
  const magic = buffer.subarray(257, 263).toString('ascii');
  if (!magic.startsWith('ustar')) {
    throw new Error('Integrity Violation: Missing ustar magic header in TAR block');
  }
  const chksumStr = buffer.subarray(148, 156).toString('ascii').replace(/\0/g, ' ').trim();
  const storedChksum = parseInt(chksumStr, 8);
  if (Number.isNaN(storedChksum)) {
    throw new Error('Integrity Violation: Invalid TAR header checksum field');
  }
  let expectedChksum = 0;
  for (let i = 0; i < 512; i++) {
    if (i >= 148 && i < 156) {
      expectedChksum += 0x20;
    } else {
      expectedChksum += buffer[i];
    }
  }
  if (storedChksum !== expectedChksum) {
    throw new Error(`Integrity Violation: TAR checksum mismatch (stored ${storedChksum} !== computed ${expectedChksum})`);
  }
}

function checkZstdIntegrity(buffer: Buffer): void {
  const zstdMagic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  if (buffer.length < 4 || !buffer.subarray(0, 4).equals(zstdMagic)) {
    throw new Error('Integrity Violation: Missing RFC 8878 Zstandard magic 0x28B52FFD');
  }
  if (buffer.length >= 5) {
    const fhd = buffer[4];
    if ((fhd & 0x10) !== 0) {
      throw new Error('Integrity Violation: Invalid Zstandard Frame_Header_Descriptor (reserved bit 4 is set)');
    }
    const singleSegment = (fhd >> 5) & 1;
    const fcsFlag = (fhd >> 6) & 3;
    const didFlag = fhd & 3;

    const windowDescBytes = singleSegment === 1 ? 0 : 1;
    let didBytes = 0;
    if (didFlag === 1) didBytes = 1;
    else if (didFlag === 2) didBytes = 2;
    else if (didFlag === 3) didBytes = 4;

    let fcsBytes = 0;
    if (fcsFlag === 0) fcsBytes = singleSegment === 1 ? 1 : 0;
    else if (fcsFlag === 1) fcsBytes = 2;
    else if (fcsFlag === 2) fcsBytes = 4;
    else if (fcsFlag === 3) fcsBytes = 8;

    const headerLength = 5 + windowDescBytes + didBytes + fcsBytes;
    if (buffer.length >= headerLength + 3) {
      const blockHdr = buffer.readUIntLE(headerLength, 3);
      const blockType = (blockHdr >> 1) & 0x03;
      if (blockType === 3) {
        throw new Error('Integrity Violation: Invalid Zstandard block type (reserved type 3)');
      }
      const blockSize = blockHdr >> 3;
      if (blockSize > 128 * 1024 * 1024) {
        throw new Error(`Integrity Violation: Zstandard block size exceeds maximum (${blockSize})`);
      }
    }
  }
}

function checkWoff2Integrity(buffer: Buffer): void {
  const woff2Magic = Buffer.from([0x77, 0x4f, 0x46, 0x32]); // 'wOF2'
  if (buffer.length < 48 || !buffer.subarray(0, 4).equals(woff2Magic)) {
    throw new Error('Integrity Violation: Missing or truncated WOFF2 header (minimum 48 bytes)');
  }
  const numTables = buffer.readUInt16BE(12);
  const reserved = buffer.readUInt16BE(14);
  const totalSfntSize = buffer.readUInt32BE(16);
  if (reserved !== 0 || numTables === 0 || totalSfntSize === 0) {
    throw new Error(`Integrity Violation: Invalid WOFF2 header structure (numTables=${numTables}, reserved=${reserved}, sfntSize=${totalSfntSize})`);
  }
}

function checkHwpIntegrity(buffer: Buffer): void {
  const hwpOleMagic = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  if (buffer.length < 512 || !buffer.subarray(0, 8).equals(hwpOleMagic)) {
    throw new Error('Integrity Violation: Missing HWP5 OLE compound document magic header');
  }
  const sectorShift = buffer.readUInt16LE(30);
  if (sectorShift !== 9 && sectorShift !== 12) {
    throw new Error(`Integrity Violation: Invalid OLE sector size shift (${sectorShift})`);
  }
  const latin1 = buffer.toString('latin1');
  if (!latin1.includes('FileHeader') && !latin1.includes('DocInfo') && !latin1.includes('HWP Document File')) {
    throw new Error('Integrity Violation: Missing HWP 5.0 CFBF stream signatures');
  }
}

function checkParquetIntegrity(buffer: Buffer): void {
  if (buffer.length < 12) {
    throw new Error('Integrity Violation: Apache Parquet buffer too short (< 12 bytes)');
  }
  const par1 = Buffer.from('PAR1', 'ascii');
  if (!buffer.subarray(0, 4).equals(par1) || !buffer.subarray(buffer.length - 4).equals(par1)) {
    throw new Error('Integrity Violation: Missing Apache Parquet PAR1 4-byte bounding magic');
  }
  const footerLen = buffer.readUInt32LE(buffer.length - 8);
  if (footerLen <= 0 || buffer.length - 8 - footerLen < 4) {
    throw new Error(`Integrity Violation: Invalid Parquet footer length (${footerLen})`);
  }
}

function checkWavIntegrity(buffer: Buffer): void {
  if (buffer.length < 44) {
    throw new Error('Integrity Violation: WAV buffer too small (minimum 44 bytes for standard header)');
  }
  if (buffer.subarray(0, 4).toString('ascii') !== 'RIFF' || buffer.subarray(8, 12).toString('ascii') !== 'WAVE') {
    throw new Error('Integrity Violation: Missing RIFF/WAVE header in audio buffer');
  }
  const riffLen = buffer.readUInt32LE(4);
  if (riffLen < 36) {
    throw new Error(`Integrity Violation: Invalid RIFF length (${riffLen}) in WAV`);
  }
  if (buffer.length > 44) {
    const fmtIdx = buffer.indexOf('fmt ');
    if (fmtIdx === -1) {
      throw new Error('Integrity Violation: Missing fmt chunk in WAV container');
    }
    if (fmtIdx + 16 > buffer.length) {
      throw new Error('Integrity Violation: Truncated fmt chunk in WAV container');
    }
    const channels = buffer.readUInt16LE(fmtIdx + 8 + 2);
    const sampleRate = buffer.readUInt32LE(fmtIdx + 8 + 4);
    const bitsPerSample = buffer.readUInt16LE(fmtIdx + 8 + 14);

    if (channels === 0 || sampleRate === 0 || bitsPerSample === 0) {
      throw new Error(`Integrity Violation: Invalid WAV fmt parameters (channels=${channels}, sampleRate=${sampleRate}, bits=${bitsPerSample})`);
    }

    const dataIdx = buffer.indexOf('data');
    if (dataIdx === -1) {
      throw new Error('Integrity Violation: Missing data chunk in WAV container');
    }
    const dataLen = buffer.readUInt32LE(dataIdx + 4);
    if (dataLen === 0 && buffer.length > 44) {
      throw new Error('Integrity Violation: Empty PCM payload in WAV data chunk');
    }

    if (isOracleToolAvailable('ffmpeg')) {
      if (!verifyAudioWithFfmpeg(buffer)) {
        throw new Error('Integrity Violation: FFmpeg CLI failed to decode WAV bitstream');
      }
    }
  }
}

function checkWebpIntegrity(buffer: Buffer): void {
  if (buffer.length < 16) {
    throw new Error('Integrity Violation: WebP buffer too short (< 16 bytes)');
  }
  if (buffer.subarray(0, 4).toString('ascii') !== 'RIFF' || buffer.subarray(8, 12).toString('ascii') !== 'WEBP') {
    throw new Error('Integrity Violation: Missing RIFF/WEBP header in image buffer');
  }
  const chunkType = buffer.subarray(12, 16).toString('ascii');
  if (!['VP8 ', 'VP8L', 'VP8X'].includes(chunkType)) {
    throw new Error(`Integrity Violation: Invalid WebP chunk type '${chunkType}' (expected VP8, VP8L, or VP8X)`);
  }
  if ((isOracleToolAvailable('identify') || isOracleToolAvailable('magick')) && buffer.length > 64) {
    if (!verifyImageWithImageMagick(buffer)) {
      throw new Error('Integrity Violation: ImageMagick CLI failed to decode WebP bitstream');
    }
  }
}

function checkFlacIntegrity(buffer: Buffer): void {
  if (buffer.length < 42) {
    throw new Error('Integrity Violation: FLAC buffer too small (< 42 bytes)');
  }
  if (buffer.subarray(0, 4).toString('ascii') !== 'fLaC') {
    throw new Error('Integrity Violation: Missing fLaC magic header');
  }
  const blockType = buffer[4] & 0x7f;
  if (blockType !== 0) {
    throw new Error(`Integrity Violation: First FLAC metadata block must be STREAMINFO (type 0, found ${blockType})`);
  }
  const blockLen = (buffer[5] << 16) | (buffer[6] << 8) | buffer[7];
  if (blockLen < 34) {
    throw new Error(`Integrity Violation: Invalid FLAC STREAMINFO length (${blockLen} < 34)`);
  }
  const b18 = buffer[18];
  const b19 = buffer[19];
  const b20 = buffer[20];
  const sampleRate = (b18 << 12) | (b19 << 4) | (b20 >> 4);
  const channels = ((b20 >> 1) & 0x07) + 1;
  if (sampleRate === 0 || channels === 0) {
    throw new Error(`Integrity Violation: Invalid FLAC parameters (sampleRate=${sampleRate}, channels=${channels})`);
  }
  if (isOracleToolAvailable('ffmpeg') && buffer.length > 100) {
    if (!verifyAudioWithFfmpeg(buffer)) {
      throw new Error('Integrity Violation: FFmpeg CLI failed to decode FLAC bitstream');
    }
  }
}

function checkMp3Integrity(buffer: Buffer): void {
  let searchOffset = 0;
  if (buffer.length >= 10 && buffer.subarray(0, 3).toString('ascii') === 'ID3') {
    const b6 = buffer[6];
    const b7 = buffer[7];
    const b8 = buffer[8];
    const b9 = buffer[9];
    if ((b6 & 0x80) !== 0 || (b7 & 0x80) !== 0 || (b8 & 0x80) !== 0 || (b9 & 0x80) !== 0) {
      throw new Error('Integrity Violation: Invalid ID3v2 synchsafe integer size in MP3 header');
    }
    const tagSize = ((b6 & 0x7f) << 21) | ((b7 & 0x7f) << 14) | ((b8 & 0x7f) << 7) | (b9 & 0x7f);
    searchOffset = 10 + tagSize;
  }

  let hasSync = false;
  const startPos = (searchOffset < buffer.length - 3) ? searchOffset : 0;
  for (let i = startPos; i < buffer.length - 3; i++) {
    if (buffer[i] === 0xff && (buffer[i + 1] & 0xe0) === 0xe0) {
      const layer = (buffer[i + 1] >> 1) & 0x03;
      const bitrateIdx = (buffer[i + 2] >> 4) & 0x0f;
      const srIdx = (buffer[i + 2] >> 2) & 0x03;
      if (layer !== 0 && bitrateIdx !== 15 && srIdx !== 3) {
        hasSync = true;
        break;
      }
    }
  }

  if (!hasSync && searchOffset > 0) {
    for (let i = 0; i < Math.min(buffer.length - 3, 4096); i++) {
      if (buffer[i] === 0xff && (buffer[i + 1] & 0xe0) === 0xe0) {
        const layer = (buffer[i + 1] >> 1) & 0x03;
        const bitrateIdx = (buffer[i + 2] >> 4) & 0x0f;
        const srIdx = (buffer[i + 2] >> 2) & 0x03;
        if (layer !== 0 && bitrateIdx !== 15 && srIdx !== 3) {
          hasSync = true;
          break;
        }
      }
    }
  }

  if (!hasSync) {
    throw new Error('Integrity Violation: Missing valid MPEG audio frame sync or ID3 header');
  }

  if (isOracleToolAvailable('ffmpeg') && buffer.length > 200) {
    if (!verifyAudioWithFfmpeg(buffer)) {
      throw new Error('Integrity Violation: FFmpeg CLI failed to decode MP3 bitstream');
    }
  }
}

function checkJpegIntegrity(buffer: Buffer): void {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[2] !== 0xff) {
    throw new Error('Integrity Violation: Missing JPEG SOI marker 0xFFD8FF');
  }
  const initialMarker = buffer[3];
  if (initialMarker < 0xc0) {
    throw new Error(`Integrity Violation: Invalid JPEG initial marker 0xFF${initialMarker.toString(16).padStart(2, '0')}`);
  }
  if (buffer.length >= 32) {
    const hasEoi = buffer.lastIndexOf(Buffer.from([0xff, 0xd9])) !== -1;
    let hasStructuralMarker = false;
    for (let i = 2; i < buffer.length - 1; i++) {
      if (buffer[i] === 0xff) {
        const m = buffer[i + 1];
        if (m === 0xdb || (m >= 0xc0 && m <= 0xc3) || (m >= 0xe0 && m <= 0xef)) {
          hasStructuralMarker = true;
          break;
        }
      }
    }
    if (!hasStructuralMarker && !hasEoi) {
      throw new Error('Integrity Violation: Missing JPEG structural markers (SOF/DQT/APPn) or EOI');
    }
  }
  if ((isOracleToolAvailable('identify') || isOracleToolAvailable('magick')) && buffer.length > 64) {
    if (!verifyImageWithImageMagick(buffer)) {
      throw new Error('Integrity Violation: ImageMagick CLI failed to decode JPEG bitstream');
    }
  }
}

function checkDxfIntegrity(buffer: Buffer): void {
  const str = buffer.toString('utf-8');
  if (!/\b0\s*\r?\n\s*SECTION\b/i.test(str)) {
    throw new Error('Integrity Violation: Missing AutoCAD DXF 0 SECTION header');
  }
  if (!/\b0\s*\r?\n\s*EOF\b/i.test(str) && !/\b0\s*\r?\n\s*ENDSEC\b/i.test(str)) {
    throw new Error('Integrity Violation: Missing AutoCAD DXF 0 EOF or ENDSEC termination marker');
  }
}

export function assertFormatIntegrity(buffer: Buffer, format: string): void {
  const fmt = format.toLowerCase();

  if (buffer.length < 8) {
    throw new Error(`Integrity Violation: ${fmt} buffer is too short (${buffer.length} bytes)`);
  }

  switch (fmt) {
    case 'pdf':
      checkPdfIntegrity(buffer);
      break;
    case 'png':
      checkPngIntegrity(buffer);
      break;
    case '7z':
      check7zIntegrity(buffer);
      break;
    case 'tar':
      checkTarIntegrity(buffer);
      break;
    case 'zstd':
    case 'zst':
      checkZstdIntegrity(buffer);
      break;
    case 'woff2':
      checkWoff2Integrity(buffer);
      break;
    case 'hwp':
      checkHwpIntegrity(buffer);
      break;
    case 'parquet':
      checkParquetIntegrity(buffer);
      break;
    case 'wav':
      checkWavIntegrity(buffer);
      break;
    case 'webp':
      checkWebpIntegrity(buffer);
      break;
    case 'flac':
      checkFlacIntegrity(buffer);
      break;
    case 'mp3':
      checkMp3Integrity(buffer);
      break;
    case 'jpg':
    case 'jpeg':
      checkJpegIntegrity(buffer);
      break;
    case 'zip':
      checkZipIntegrity(buffer);
      break;
    case 'docx':
      checkDocxIntegrity(buffer);
      break;
    case 'xlsx':
      checkXlsxIntegrity(buffer);
      break;
    case 'pptx':
      checkPptxIntegrity(buffer);
      break;
    case 'ods':
      checkOdsIntegrity(buffer);
      break;
    case 'odt':
      checkOdtIntegrity(buffer);
      break;
    case 'odp':
      checkOdpIntegrity(buffer);
      break;
    case 'dxf':
      checkDxfIntegrity(buffer);
      break;
    case 'step':
    case 'stp':
      checkStepIntegrity(buffer);
      break;
    default:
      break;
  }
}
