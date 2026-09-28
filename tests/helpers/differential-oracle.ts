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

export class OracleToolMissingError extends Error {
  public readonly isOracleSkip = true;
  public readonly tool: string;

  constructor(tool: string, message?: string) {
    super(message || `Differential Oracle external CLI tool "${tool}" is missing in runtime environment.`);
    this.name = 'OracleToolMissingError';
    this.tool = tool;
  }
}

/**
 * Validates ISO BMFF (MP4/MOV) container and H.264 NAL unit bitstream syntax.
 * Rejects hollow containers, missing moov/mdat/trak/stsd boxes, and empty/invalid NAL units.
 */
export function checkIsoBmffIntegrity(buffer: Buffer): {
  format: 'mp4' | 'mov';
  codec: string;
  hasMoov: boolean;
  hasMdat: boolean;
  hasTrak: boolean;
  hasStsd: boolean;
  isFastStart: boolean;
  nalUnitsCount: number;
} {
  if (buffer.length < 32) {
    throw new Error(`Integrity Violation: ISO BMFF buffer too short (${buffer.length} bytes, minimum 32 bytes)`);
  }

  let offset = 0;
  let hasFtyp = false;
  let hasMoov = false;
  let hasMdat = false;
  let moovOffset = -1;
  let mdatOffset = -1;
  let mdatDataOffset = -1;
  let mdatDataLength = 0;
  let majorBrand = '';
  let foundTrak = false;
  let foundMvhd = false;
  let foundMdia = false;
  let foundMinf = false;
  let foundStbl = false;
  let foundStsd = false;
  let detectedCodec = '';

  while (offset + 8 <= buffer.length) {
    let size = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    let headerSize = 8;

    if (size === 1) {
      if (offset + 16 > buffer.length) {
        throw new Error(`Integrity Violation: Truncated 64-bit box header for ${type} at offset ${offset}`);
      }
      const high = buffer.readUInt32BE(offset + 8);
      const low = buffer.readUInt32BE(offset + 12);
      size = high * 2 ** 32 + low;
      headerSize = 16;
    } else if (size === 0) {
      size = buffer.length - offset;
    }

    if (size < headerSize || offset + size > buffer.length) {
      throw new Error(`Integrity Violation: Invalid box size ${size} for ${type} at offset ${offset} (buffer length ${buffer.length})`);
    }

    const boxPayload = buffer.subarray(offset + headerSize, offset + size);

    if (type === 'ftyp') {
      hasFtyp = true;
      if (boxPayload.length < 8) {
        throw new Error('Integrity Violation: ftyp box is truncated (< 8 bytes payload)');
      }
      majorBrand = boxPayload.toString('ascii', 0, 4);
    } else if (type === 'moov') {
      hasMoov = true;
      moovOffset = offset;

      let subOffset = 0;
      while (subOffset + 8 <= boxPayload.length) {
        let subSize = boxPayload.readUInt32BE(subOffset);
        const subType = boxPayload.toString('ascii', subOffset + 4, subOffset + 8);
        if (subSize === 0) subSize = boxPayload.length - subOffset;
        if (subSize < 8 || subOffset + subSize > boxPayload.length) break;

        const subPayload = boxPayload.subarray(subOffset + 8, subOffset + subSize);
        if (subType === 'mvhd') {
          foundMvhd = true;
          if (subPayload.length < 16) {
            throw new Error('Integrity Violation: mvhd movie header box is truncated');
          }
        } else if (subType === 'trak') {
          foundTrak = true;
          let trakOff = 0;
          while (trakOff + 8 <= subPayload.length) {
            let tSize = subPayload.readUInt32BE(trakOff);
            const tType = subPayload.toString('ascii', trakOff + 4, trakOff + 8);
            if (tSize === 0) tSize = subPayload.length - trakOff;
            if (tSize < 8 || trakOff + tSize > subPayload.length) break;

            if (tType === 'mdia') {
              foundMdia = true;
              const mdiaPayload = subPayload.subarray(trakOff + 8, trakOff + tSize);
              let mdiaOff = 0;
              while (mdiaOff + 8 <= mdiaPayload.length) {
                let mSize = mdiaPayload.readUInt32BE(mdiaOff);
                const mType = mdiaPayload.toString('ascii', mdiaOff + 4, mdiaOff + 8);
                if (mSize === 0) mSize = mdiaPayload.length - mdiaOff;
                if (mSize < 8 || mdiaOff + mSize > mdiaPayload.length) break;

                if (mType === 'minf') {
                  foundMinf = true;
                  const minfPayload = mdiaPayload.subarray(mdiaOff + 8, mdiaOff + mSize);
                  let minfOff = 0;
                  while (minfOff + 8 <= minfPayload.length) {
                    let miSize = minfPayload.readUInt32BE(minfOff);
                    const miType = minfPayload.toString('ascii', minfOff + 4, minfOff + 8);
                    if (miSize === 0) miSize = minfPayload.length - minfOff;
                    if (miSize < 8 || minfOff + miSize > minfPayload.length) break;

                    if (miType === 'stbl') {
                      foundStbl = true;
                      const stblPayload = minfPayload.subarray(minfOff + 8, minfOff + miSize);
                      let stblOff = 0;
                      while (stblOff + 8 <= stblPayload.length) {
                        let stSize = stblPayload.readUInt32BE(stblOff);
                        const stType = stblPayload.toString('ascii', stblOff + 4, stblOff + 8);
                        if (stSize === 0) stSize = stblPayload.length - stblOff;
                        if (stSize < 8 || stblOff + stSize > stblPayload.length) break;

                        if (stType === 'stsd') {
                          foundStsd = true;
                          const stsdPayload = stblPayload.subarray(stblOff + 8, stblOff + stSize);
                          if (stsdPayload.length >= 8) {
                            const entryCount = stsdPayload.readUInt32BE(4);
                            if (entryCount > 0 && stsdPayload.length >= 16) {
                              const entryFormat = stsdPayload.toString('ascii', 12, 16);
                              detectedCodec = entryFormat;
                            }
                          }
                        }
                        stblOff += stSize;
                      }
                    }
                    minfOff += miSize;
                  }
                }
                mdiaOff += mSize;
              }
            }
            trakOff += tSize;
          }
        }
        subOffset += subSize;
      }
    } else if (type === 'mdat') {
      hasMdat = true;
      mdatOffset = offset;
      mdatDataOffset = offset + headerSize;
      mdatDataLength = size - headerSize;
    }

    offset += size;
  }

  if (!hasFtyp) {
    throw new Error('Integrity Violation: Missing ftyp box in ISO BMFF container');
  }
  if (!hasMoov) {
    throw new Error('Integrity Violation: Missing moov box in ISO BMFF container');
  }
  if (!foundMvhd) {
    throw new Error('Integrity Violation: Missing mvhd (movie header) box in moov container');
  }
  if (!foundTrak) {
    throw new Error('Integrity Violation: Missing trak (track) box in moov container');
  }
  if (!foundMdia || !foundMinf || !foundStbl || !foundStsd) {
    throw new Error('Integrity Violation: Incomplete track descriptor hierarchy (mdia/minf/stbl/stsd) in moov');
  }
  if (!hasMdat) {
    throw new Error('Integrity Violation: Missing mdat box in ISO BMFF container');
  }
  if (mdatDataLength <= 0) {
    throw new Error('Integrity Violation: Empty mdat payload (0 bytes) in ISO BMFF container');
  }

  // Deep NAL unit header inspection for AVC / H.264
  let nalUnitsCount = 0;
  if (!detectedCodec || detectedCodec === 'avc1' || detectedCodec.startsWith('avc')) {
    const mdatBuf = buffer.subarray(mdatDataOffset, mdatDataOffset + mdatDataLength);
    const validNalTypes = new Set([1, 5, 6, 7, 8, 9]);
    let hasSlice = false;

    // Check Annex B start codes
    const hasAnnexB = mdatBuf.indexOf(Buffer.from([0x00, 0x00, 0x01])) !== -1;

    if (hasAnnexB) {
      for (let i = 0; i < mdatBuf.length - 4; i++) {
        if (
          (mdatBuf[i] === 0 && mdatBuf[i + 1] === 0 && mdatBuf[i + 2] === 1) ||
          (mdatBuf[i] === 0 && mdatBuf[i + 1] === 0 && mdatBuf[i + 2] === 0 && mdatBuf[i + 3] === 1)
        ) {
          const headerByteIdx = mdatBuf[i + 2] === 1 ? i + 3 : i + 4;
          if (headerByteIdx < mdatBuf.length) {
            const header = mdatBuf[headerByteIdx];
            const forbiddenZero = (header >> 7) & 1;
            const nalType = header & 0x1f;
            if (forbiddenZero === 0 && validNalTypes.has(nalType)) {
              nalUnitsCount++;
              if (nalType === 1 || nalType === 5 || nalType === 7 || nalType === 8) {
                hasSlice = true;
              }
            }
          }
        }
      }
    } else {
      // Length-prefixed AVCC NALUs (4-byte big endian length prefix)
      let naluOffset = 0;
      while (naluOffset + 4 < mdatBuf.length) {
        const naluLen = mdatBuf.readUInt32BE(naluOffset);
        if (naluLen === 0 || naluOffset + 4 + naluLen > mdatBuf.length) {
          break;
        }
        const header = mdatBuf[naluOffset + 4];
        const forbiddenZero = (header >> 7) & 1;
        const nalType = header & 0x1f;
        if (forbiddenZero === 0 && validNalTypes.has(nalType)) {
          nalUnitsCount++;
          if (nalType === 1 || nalType === 5 || nalType === 7 || nalType === 8) {
            hasSlice = true;
          }
        }
        naluOffset += 4 + naluLen;
      }
    }

    if (nalUnitsCount === 0 || !hasSlice) {
      throw new Error('Integrity Violation: mdat payload contains no valid H.264 NAL units (SPS, PPS, IDR, or non-IDR slices)');
    }
  }

  const isFastStart = moovOffset > 0 && mdatOffset > 0 && moovOffset < mdatOffset;

  return {
    format: majorBrand.startsWith('qt') ? 'mov' : 'mp4',
    codec: detectedCodec || 'h264',
    hasMoov,
    hasMdat,
    hasTrak: foundTrak,
    hasStsd: foundStsd,
    isFastStart,
    nalUnitsCount,
  };
}

/**
 * Validates EBML container structure (WebM / Matroska).
 */
export function checkEbmlIntegrity(buffer: Buffer): {
  format: 'webm' | 'mkv';
  hasSegment: boolean;
} {
  if (buffer.length < 12) {
    throw new Error(`Integrity Violation: EBML buffer too short (${buffer.length} bytes, minimum 12 bytes)`);
  }

  if (buffer[0] !== 0x1a || buffer[1] !== 0x45 || buffer[2] !== 0xdf || buffer[3] !== 0xa3) {
    throw new Error('Integrity Violation: Missing EBML header signature 0x1A45DFA3 for WebM/MKV');
  }

  const str = buffer.subarray(0, Math.min(buffer.length, 4096)).toString('binary');
  const isMkv = str.includes('matroska');

  const segmentIdx = buffer.indexOf(Buffer.from([0x18, 0x53, 0x80, 0x67]));
  if (segmentIdx === -1 && buffer.length > 64) {
    throw new Error('Integrity Violation: Missing Segment element (0x18538067) in EBML container');
  }

  return {
    format: isMkv ? 'mkv' : 'webm',
    hasSegment: segmentIdx !== -1,
  };
}

/**
 * Validates Ogg container structure and OpusHead / Vorbis identification headers.
 */
export function checkOggIntegrity(buffer: Buffer): {
  format: 'ogg' | 'opus' | 'vorbis';
  codec: 'opus' | 'vorbis';
  channels: number;
  sampleRate: number;
  pageCount: number;
} {
  if (buffer.length < 28) {
    throw new Error(`Integrity Violation: Ogg buffer too short (${buffer.length} bytes, minimum 28 bytes)`);
  }

  if (buffer.toString('ascii', 0, 4) !== 'OggS') {
    throw new Error('Integrity Violation: Missing OggS magic page capture signature');
  }

  let offset = 0;
  let pageCount = 0;
  let codec: 'opus' | 'vorbis' = 'opus';
  let channels = 0;
  let sampleRate = 0;
  let hasIdHeader = false;
  let hasCommentHeader = false;

  while (offset + 27 <= buffer.length) {
    if (buffer.toString('ascii', offset, offset + 4) !== 'OggS') {
      break;
    }
    const version = buffer[offset + 4];
    if (version !== 0) {
      throw new Error(`Integrity Violation: Invalid Ogg page version (${version} !== 0) at offset ${offset}`);
    }
    const headerType = buffer[offset + 5];
    const numSegments = buffer[offset + 26];

    if (offset + 27 + numSegments > buffer.length) {
      throw new Error(`Integrity Violation: Truncated Ogg page lacing table at offset ${offset}`);
    }

    let payloadSize = 0;
    for (let i = 0; i < numSegments; i++) {
      payloadSize += buffer[offset + 27 + i];
    }

    const payloadOffset = offset + 27 + numSegments;
    if (payloadOffset + payloadSize > buffer.length) {
      throw new Error(`Integrity Violation: Truncated Ogg page payload at offset ${payloadOffset}`);
    }

    const payload = buffer.subarray(payloadOffset, payloadOffset + payloadSize);

    if (pageCount === 0) {
      if ((headerType & 0x02) === 0) {
        throw new Error('Integrity Violation: First Ogg page must have BOS (beginning-of-stream) flag set');
      }

      if (payload.length >= 19 && payload.toString('ascii', 0, 8) === 'OpusHead') {
        codec = 'opus';
        const opusVersion = payload[8];
        if (opusVersion !== 1) {
          throw new Error(`Integrity Violation: Unsupported OpusHead version (${opusVersion} !== 1)`);
        }
        channels = payload[9];
        if (channels < 1 || channels > 8) {
          throw new Error(`Integrity Violation: Invalid Opus channel count (${channels})`);
        }
        sampleRate = payload.readUInt32LE(12);
        hasIdHeader = true;
      } else if (payload.length >= 15 && payload.toString('ascii', 1, 7) === 'vorbis' && payload[0] === 0x01) {
        codec = 'vorbis';
        channels = payload[11];
        sampleRate = payload.readUInt32LE(12);
        hasIdHeader = true;
      } else {
        throw new Error('Integrity Violation: First Ogg page must contain valid OpusHead or Vorbis identification header');
      }
    } else if (pageCount === 1) {
      if (codec === 'opus') {
        if (payload.length >= 8 && payload.toString('ascii', 0, 8) === 'OpusTags') {
          hasCommentHeader = true;
        }
      } else {
        if (payload.length >= 7 && payload.toString('ascii', 1, 7) === 'vorbis' && payload[0] === 0x03) {
          hasCommentHeader = true;
        }
      }
    }

    pageCount++;
    offset = payloadOffset + payloadSize;
  }

  if (!hasIdHeader) {
    throw new Error('Integrity Violation: Missing valid audio identification header in Ogg container');
  }
  if (pageCount >= 2 && !hasCommentHeader) {
    throw new Error('Integrity Violation: Missing valid OpusTags / Vorbis comment header in second Ogg page');
  }

  return {
    format: codec === 'opus' ? 'opus' : 'ogg',
    codec,
    channels: channels || 2,
    sampleRate: sampleRate || 48000,
    pageCount,
  };
}

/**
 * Validates ADTS AAC stream header, frame lengths, and audio parameters.
 */
export function checkAdtsAacIntegrity(buffer: Buffer): {
  format: 'aac';
  channels: number;
  sampleRate: number;
  frameCount: number;
} {
  if (buffer.length < 7) {
    throw new Error(`Integrity Violation: ADTS AAC buffer too short (${buffer.length} bytes, minimum 7 bytes)`);
  }

  const samplingFreqTable = [
    96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
  ];

  let offset = 0;
  let frameCount = 0;
  let channels = 0;
  let sampleRate = 0;

  while (offset + 7 <= buffer.length) {
    const b0 = buffer[offset];
    const b1 = buffer[offset + 1];
    if (b0 !== 0xff || (b1 & 0xf0) !== 0xf0) {
      if (frameCount === 0) {
        throw new Error('Integrity Violation: Missing ADTS AAC syncword 0xFFF at start of stream');
      }
      break;
    }

    const layer = (b1 >> 1) & 0x03;
    if (layer !== 0) {
      throw new Error(`Integrity Violation: Invalid ADTS AAC layer bits (${layer} !== 0)`);
    }

    const b2 = buffer[offset + 2];
    const b3 = buffer[offset + 3];
    const b4 = buffer[offset + 4];
    const b5 = buffer[offset + 5];

    const profile = (b2 >> 6) & 0x03;
    if (profile === 3) {
      throw new Error('Integrity Violation: Reserved ADTS AAC profile 3 encountered');
    }

    const srIdx = (b2 >> 2) & 0x0f;
    if (srIdx >= 13) {
      throw new Error(`Integrity Violation: Invalid ADTS AAC sampling frequency index (${srIdx})`);
    }

    const chan = ((b2 & 0x01) << 2) | ((b3 >> 6) & 0x03);
    if (chan === 0) {
      throw new Error('Integrity Violation: Channel configuration 0 not supported without PCE');
    }

    const frameLength = ((b3 & 0x03) << 11) | (b4 << 3) | ((b5 >> 5) & 0x07);
    if (frameLength < 7) {
      throw new Error(`Integrity Violation: Invalid ADTS frame length (${frameLength} < 7)`);
    }
    if (offset + frameLength > buffer.length && frameCount === 0) {
      throw new Error(`Integrity Violation: Truncated ADTS frame (${offset + frameLength} > ${buffer.length})`);
    }

    if (frameCount === 0) {
      channels = chan;
      sampleRate = samplingFreqTable[srIdx];
    }

    frameCount++;
    offset += frameLength;
  }

  if (frameCount === 0) {
    throw new Error('Integrity Violation: No valid ADTS AAC frames found in stream');
  }

  return {
    format: 'aac',
    channels,
    sampleRate,
    frameCount,
  };
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
    if (process.env.ORACLE_STRICT_MODE === '1') {
      throw new OracleToolMissingError('ffprobe', 'Strict oracle mode requires ffprobe for audio verification');
    }
    const format = formatHint.toLowerCase().replace(/^\./, '');
    try {
      if (format === 'wav') {
        checkWavIntegrity(buffer);
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
      if (format === 'aac') {
        const info = checkAdtsAacIntegrity(buffer);
        return {
          valid: true,
          formatName: 'aac',
          codecName: expectedCodec || 'aac',
          channels: info.channels,
          sampleRate: info.sampleRate,
        };
      }
      if (format === 'mp3') {
        checkMp3Integrity(buffer);
        return {
          valid: true,
          formatName: 'mp3',
          codecName: expectedCodec || 'mp3',
        };
      }
      if (format === 'flac') {
        checkFlacIntegrity(buffer);
        return {
          valid: true,
          formatName: 'flac',
          codecName: expectedCodec || 'flac',
        };
      }
      if (format === 'ogg' || format === 'opus' || format === 'vorbis') {
        const info = checkOggIntegrity(buffer);
        return {
          valid: true,
          formatName: info.format,
          codecName: info.codec,
          channels: info.channels,
          sampleRate: info.sampleRate,
        };
      }
      return { valid: false, error: `Unsupported audio format verification: ${format}` };
    } catch (err: any) {
      return { valid: false, error: err.message || String(err) };
    }
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

  if (!toolPath) {
    if (process.env.ORACLE_STRICT_MODE === '1') {
      throw new OracleToolMissingError('ffprobe', 'Strict oracle mode requires ffprobe for video verification');
    }

    const format = formatHint.toLowerCase().replace(/^\./, '');
    if (format === 'mp4' || format === 'mov') {
      try {
        const info = checkIsoBmffIntegrity(buffer);
        const normCodec = (c: string) => c.toLowerCase().replace(/[^a-z0-9]/g, '');
        const isH264Family = (c: string) => {
          const n = normCodec(c);
          return n.includes('h264') || n.includes('avc') || n.includes('avc1');
        };
        const codecMatches = !expectedCodec ||
          info.codec.toLowerCase().includes(expectedCodec.toLowerCase()) ||
          (isH264Family(expectedCodec) && isH264Family(info.codec));

        if (!codecMatches) {
          return { valid: false, codecName: info.codec, error: `Codec mismatch: expected ${expectedCodec}, got ${info.codec}` };
        }
        return {
          valid: true,
          formatName: info.format,
          codecName: expectedCodec || info.codec,
          isFastStart: info.isFastStart,
        };
      } catch (err: any) {
        return { valid: false, error: err.message || String(err) };
      }
    }
    if (format === 'webm' || format === 'mkv') {
      try {
        const info = checkEbmlIntegrity(buffer);
        return {
          valid: true,
          formatName: info.format,
          codecName: expectedCodec || 'vp9',
        };
      } catch (err: any) {
        return { valid: false, error: err.message || String(err) };
      }
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
    const moovIdx = buffer.indexOf('moov');
    const mdatIdx = buffer.indexOf('mdat');
    const isFastStart = moovIdx > 0 && mdatIdx > 0 && moovIdx < mdatIdx;

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
      files: lines.map((l) => {
        const tokens = l.trim().split(/\s+/);
        const size = tokens.length >= 4 ? parseInt(tokens[3], 10) || 0 : 0;
        const isDir = tokens.length >= 3 && tokens[2].includes('D');
        const name = l.length > 53 ? l.slice(53).trim() : (tokens[tokens.length - 1] || '');
        return {
          name,
          size,
          isDir,
        };
      }),
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

  // 1. Look for kName property (0x11) inside kFilesInfo
  const namePropIdx = nh.indexOf(0x11, filesInfoIdx);
  if (namePropIdx !== -1) {
    let p = namePropIdx + 1;
    while (p < nh.length && (nh[p] & 0x80) !== 0) p++;
    p++;
    if (p < nh.length && nh[p] === 0x00) {
      p++;
      const namesChunk = nh.subarray(p);
      const names = namesChunk.toString('utf16le').split('\0');
      for (let i = 0; i < sizes.length && i < names.length; i++) {
        if (names[i] && /^[\x20-\x7e]+$/.test(names[i])) {
          files.push({
            name: names[i],
            size: sizes[i] ?? 0,
            isDir: names[i].endsWith('/'),
          });
        }
      }
      if (files.length > 0) return files;
    }
  }

  // 2. Fallback heuristic: find sequence of UTF-16LE null-terminated ASCII characters
  for (let i = filesInfoIdx; i < nh.length - 8; i++) {
    if (
      nh[i] >= 0x20 && nh[i] <= 0x7e && nh[i + 1] === 0x00 &&
      nh[i + 2] >= 0x20 && nh[i + 2] <= 0x7e && nh[i + 3] === 0x00
    ) {
      const names = nh.subarray(i).toString('utf16le').split('\0');
      for (let s = 0; s < sizes.length && s < names.length; s++) {
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
    if (cliAst && cliAst.fileCount > 0) return cliAst;
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

export function checkWavIntegrity(buffer: Buffer): void {
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

export function checkWebpIntegrity(buffer: Buffer): void {
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

export function checkFlacIntegrity(buffer: Buffer): void {
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
  if (blockLen !== 34) {
    throw new Error(`Integrity Violation: Invalid FLAC STREAMINFO length (${blockLen} !== 34)`);
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

export function checkMp3Integrity(buffer: Buffer): void {
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

export function checkJpegIntegrity(buffer: Buffer): void {
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

export function checkDxfIntegrity(buffer: Buffer): void {
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

  const minLength = fmt === 'aac' ? 7 : 8;
  if (buffer.length < minLength) {
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
    case 'aac':
      checkAdtsAacIntegrity(buffer);
      break;
    case 'ogg':
    case 'opus':
    case 'vorbis':
      checkOggIntegrity(buffer);
      break;
    case 'mp4':
    case 'mov':
      checkIsoBmffIntegrity(buffer);
      break;
    case 'webm':
    case 'mkv':
      checkEbmlIntegrity(buffer);
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
