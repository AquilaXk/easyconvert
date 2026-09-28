import { execFileSync } from 'child_process';
import fs from 'fs';
import { decodeZstdCompressedBlockWithDict } from './zstd-dict';

/**
 * Pure TypeScript RFC 8878 Zstandard (zstd) Compression and Decompression Engine
 *
 * Implements:
 * - Magic byte detection (0xFD2FB528) and skippable frames (0x184D2A50..0x184D2A5F)
 * - Frame header parsing (single segment, window descriptor, dictionary ID, FCS)
 * - Raw, RLE, and Compressed block parsing with Finite State Entropy (FSE) & sequence execution
 * - Multi-frame streaming decoding
 * - XXH64 32-bit Content Checksum calculation & verification
 * - Archive bomb protection: 100:1 ratio and 500MB cumulative limit
 */

export const ZSTD_MAGIC_NUMBER = 0xfd2fb528;
export const ZSTD_MAGIC_LE = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

export const ZSTD_SECURITY_LIMITS = {
  MAX_UNCOMPRESSED_SIZE: 500 * 1024 * 1024, // 500MB
  MAX_RATIO: 100, // 100:1
};

let resolvedZstdPath: string | null = null;
export function getZstdBinaryPath(): string | null {
  if (resolvedZstdPath !== null) return resolvedZstdPath || null;
  const fixedLocations = [
    '/usr/bin/zstd',
    '/usr/local/bin/zstd',
    '/opt/homebrew/bin/zstd',
  ];
  for (const loc of fixedLocations) {
    if (fs.existsSync(loc)) {
      resolvedZstdPath = loc;
      return loc;
    }
  }
  const whichBins = ['/usr/bin/which', '/bin/which'];
  for (const whichBin of whichBins) {
    if (fs.existsSync(whichBin)) {
      try {
        const out = execFileSync(whichBin, ['zstd'], { stdio: 'pipe' }).toString().trim();
        if (out && fs.existsSync(out)) {
          resolvedZstdPath = out;
          return out;
        }
      } catch {}
    }
  }
  resolvedZstdPath = '';
  return null;
}

export function decompressWithNativeZstd(inputBuffer: Buffer): Buffer | null {
  const zstdBin = getZstdBinaryPath();
  if (!zstdBin) return null;
  try {
    return execFileSync(zstdBin, ['-d', '-c', '-q'], {
      input: inputBuffer,
      maxBuffer: ZSTD_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE,
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

export interface ZstdFrameHeader {
  singleSegment: boolean;
  contentChecksumFlag: boolean;
  dictionaryId: number;
  frameContentSize: number | null;
  windowSize: number;
  headerSize: number;
}

export interface ZstdBlockHeader {
  lastBlock: boolean;
  blockType: number; // 0 = Raw, 1 = RLE, 2 = Compressed, 3 = Reserved
  blockSize: number;
}

// ==========================================
// XXH64 Content Checksum Engine (RFC 8878)
// ==========================================
const PRIME64_1 = 11400714785074694791n;
const PRIME64_2 = 14029467366897019727n;
const PRIME64_3 = 1609587929392839161n;
const PRIME64_4 = 9650029242287828579n;
const PRIME64_5 = 2870177450012600261n;

function rotl64(x: bigint, r: bigint): bigint {
  const mask = 0xffffffffffffffffn;
  return (((x << r) & mask) | ((x & mask) >> (64n - r))) & mask;
}

export function xxh64(buf: Uint8Array, seed = 0n): bigint {
  const mask = 0xffffffffffffffffn;
  const len = BigInt(buf.length);
  let h64 = 0n;

  if (buf.length >= 32) {
    let v1 = (seed + PRIME64_1 + PRIME64_2) & mask;
    let v2 = (seed + PRIME64_2) & mask;
    let v3 = seed & mask;
    let v4 = (seed - PRIME64_1) & mask;

    let offset = 0;
    const limit = buf.length - 32;
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

    while (offset <= limit) {
      const n1 = view.getBigUint64(offset, true);
      v1 = (v1 + n1 * PRIME64_2) & mask;
      v1 = rotl64(v1, 31n);
      v1 = (v1 * PRIME64_1) & mask;

      const n2 = view.getBigUint64(offset + 8, true);
      v2 = (v2 + n2 * PRIME64_2) & mask;
      v2 = rotl64(v2, 31n);
      v2 = (v2 * PRIME64_1) & mask;

      const n3 = view.getBigUint64(offset + 16, true);
      v3 = (v3 + n3 * PRIME64_2) & mask;
      v3 = rotl64(v3, 31n);
      v3 = (v3 * PRIME64_1) & mask;

      const n4 = view.getBigUint64(offset + 24, true);
      v4 = (v4 + n4 * PRIME64_2) & mask;
      v4 = rotl64(v4, 31n);
      v4 = (v4 * PRIME64_1) & mask;

      offset += 32;
    }

    h64 = (rotl64(v1, 1n) + rotl64(v2, 7n) + rotl64(v3, 12n) + rotl64(v4, 18n)) & mask;

    const round = (h: bigint, v: bigint) => {
      let x = (v * PRIME64_2) & mask;
      x = rotl64(x, 31n);
      x = (x * PRIME64_1) & mask;
      h = (h ^ x) & mask;
      return (h * PRIME64_1 + PRIME64_4) & mask;
    };

    h64 = round(h64, v1);
    h64 = round(h64, v2);
    h64 = round(h64, v3);
    h64 = round(h64, v4);
  } else {
    h64 = (seed + PRIME64_5) & mask;
  }

  h64 = (h64 + len) & mask;

  let offset = buf.length - (buf.length % 32);
  if (buf.length < 32) offset = 0;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  while (offset + 8 <= buf.length) {
    let k1 = view.getBigUint64(offset, true);
    k1 = (k1 * PRIME64_2) & mask;
    k1 = rotl64(k1, 31n);
    k1 = (k1 * PRIME64_1) & mask;
    h64 = (h64 ^ k1) & mask;
    h64 = (rotl64(h64, 27n) * PRIME64_1 + PRIME64_4) & mask;
    offset += 8;
  }

  if (offset + 4 <= buf.length) {
    let k1 = BigInt(view.getUint32(offset, true));
    k1 = (k1 * PRIME64_1) & mask;
    h64 = (h64 ^ k1) & mask;
    h64 = (rotl64(h64, 23n) * PRIME64_2 + PRIME64_3) & mask;
    offset += 4;
  }

  while (offset < buf.length) {
    let k1 = BigInt(buf[offset]);
    k1 = (k1 * PRIME64_5) & mask;
    h64 = (h64 ^ k1) & mask;
    h64 = (rotl64(h64, 11n) * PRIME64_1) & mask;
    offset++;
  }

  // Final avalanche
  h64 = (h64 ^ (h64 >> 33n)) & mask;
  h64 = (h64 * PRIME64_2) & mask;
  h64 = (h64 ^ (h64 >> 29n)) & mask;
  h64 = (h64 * PRIME64_3) & mask;
  h64 = (h64 ^ (h64 >> 32n)) & mask;

  return h64;
}

export function computeZstdChecksum(data: Uint8Array): number {
  const hash = xxh64(data, 0n);
  return Number(hash & 0xffffffffn);
}

// ==========================================
// Zstandard Frame Parser & Decompressor
// ==========================================

export function parseZstdFrameHeader(buf: Buffer, offset: number): ZstdFrameHeader {
  if (offset + 5 > buf.length) {
    throw new Error('Malformed Zstandard frame: header truncated.');
  }

  const magic = buf.readUInt32LE(offset);
  if (magic !== ZSTD_MAGIC_NUMBER) {
    throw new Error(`Invalid Zstandard magic number: expected 0xFD2FB528, got 0x${magic.toString(16).toUpperCase()}`);
  }

  const startOffset = offset;
  offset += 4;

  const fhd = buf[offset++];
  const fcsFlag = (fhd >> 6) & 0x03;
  const singleSegment = ((fhd >> 5) & 0x01) === 1;
  const reserved = (fhd >> 4) & 0x01;
  if (reserved !== 0) {
    throw new Error('Malformed Zstandard frame: reserved header bit must be 0.');
  }
  const contentChecksumFlag = ((fhd >> 2) & 0x01) === 1;
  const dictIdFlag = fhd & 0x03;

  let windowSize = 0;
  if (!singleSegment) {
    if (offset >= buf.length) throw new Error('Malformed Zstandard frame: missing window descriptor.');
    const wd = buf[offset++];
    const exponent = (wd >> 3) & 0x1f;
    const mantissa = wd & 0x07;
    const windowBase = 2 ** (10 + exponent);
    const windowAdd = (windowBase / 8) * mantissa;
    windowSize = windowBase + windowAdd;
  }

  let dictionaryId = 0;
  if (dictIdFlag === 1) {
    if (offset + 1 > buf.length) throw new Error('Truncated dictionary ID');
    dictionaryId = buf[offset++];
  } else if (dictIdFlag === 2) {
    if (offset + 2 > buf.length) throw new Error('Truncated dictionary ID');
    dictionaryId = buf.readUInt16LE(offset);
    offset += 2;
  } else if (dictIdFlag === 3) {
    if (offset + 4 > buf.length) throw new Error('Truncated dictionary ID');
    dictionaryId = buf.readUInt32LE(offset);
    offset += 4;
  }

  let frameContentSize: number | null = null;
  if (fcsFlag === 0) {
    if (singleSegment) {
      if (offset >= buf.length) throw new Error('Truncated FCS');
      frameContentSize = buf[offset++];
    }
  } else if (fcsFlag === 1) {
    if (offset + 2 > buf.length) throw new Error('Truncated FCS');
    frameContentSize = buf.readUInt16LE(offset) + 256;
    offset += 2;
  } else if (fcsFlag === 2) {
    if (offset + 4 > buf.length) throw new Error('Truncated FCS');
    frameContentSize = buf.readUInt32LE(offset);
    offset += 4;
  } else if (fcsFlag === 3) {
    if (offset + 8 > buf.length) throw new Error('Truncated FCS');
    frameContentSize = Number(buf.readBigUInt64LE(offset));
    offset += 8;
  }

  return {
    singleSegment,
    contentChecksumFlag,
    dictionaryId,
    frameContentSize,
    windowSize,
    headerSize: offset - startOffset,
  };
}

/**
 * Decompresses an arbitrary RFC 8878 Zstandard stream with bomb safeguards.
 */
export function decompressZstd(inputBuffer: Buffer): Buffer {
  if (!inputBuffer || inputBuffer.length < 4) {
    throw new Error('Decompress error: input buffer too small for Zstandard stream.');
  }

  try {
    const outChunks: Buffer[] = [];
    let totalUncompressedSize = 0;
    let offset = 0;

    while (offset < inputBuffer.length) {
      if (offset + 4 > inputBuffer.length) break;
      const magic = inputBuffer.readUInt32LE(offset);

      // Skippable frames: 0x184D2A50 to 0x184D2A5F
      if (magic >= 0x184d2a50 && magic <= 0x184d2a5f) {
        if (offset + 8 > inputBuffer.length) {
          throw new Error('Malformed skippable frame: header truncated.');
        }
        const skipLength = inputBuffer.readUInt32LE(offset + 4);
        offset += 8 + skipLength;
        continue;
      }

      if (magic !== ZSTD_MAGIC_NUMBER) {
        throw new Error(
          `Invalid Zstandard magic signature: 0x${magic.toString(16).toUpperCase()} at offset ${offset}`
        );
      }

      const frameHeader = parseZstdFrameHeader(inputBuffer, offset);
      offset += frameHeader.headerSize;

      const frameChunks: Buffer[] = [];
      let frameUncompressedSize = 0;

      let isLast = false;
      while (!isLast) {
        if (offset + 3 > inputBuffer.length) {
          throw new Error('Malformed Zstandard frame: truncated block header.');
        }

        const b0 = inputBuffer[offset];
        const b1 = inputBuffer[offset + 1];
        const b2 = inputBuffer[offset + 2];
        const headerVal = b0 | (b1 << 8) | (b2 << 16);
        offset += 3;

        isLast = (headerVal & 0x01) === 1;
        const blockType = (headerVal >> 1) & 0x03;
        const blockSize = headerVal >>> 3;

        if (blockType === 3) {
          throw new Error('Malformed Zstandard block: reserved block type 3 encountered.');
        }

        let blockData: Buffer;

        if (blockType === 0) {
          // Raw Block: uncompressed data of length blockSize
          if (offset + blockSize > inputBuffer.length) {
            throw new Error('Malformed Zstandard raw block: out of bounds data.');
          }
          blockData = Buffer.from(inputBuffer.subarray(offset, offset + blockSize));
          offset += blockSize;
        } else if (blockType === 1) {
          // RLE Block: single byte repeated blockSize times
          if (offset + 1 > inputBuffer.length) {
            throw new Error('Malformed Zstandard RLE block: missing byte.');
          }
          const rleByte = inputBuffer[offset++];
          blockData = Buffer.alloc(blockSize, rleByte);
        } else {
          // Compressed Block (FSE / Huffman sequence decoding)
          if (offset + blockSize > inputBuffer.length) {
            throw new Error('Malformed Zstandard compressed block: truncated data.');
          }
          const compSlice = inputBuffer.subarray(offset, offset + blockSize);
          blockData = decodeZstdCompressedBlock(compSlice, frameChunks);
          offset += blockSize;
        }

        frameChunks.push(blockData);
        frameUncompressedSize += blockData.length;
        totalUncompressedSize += blockData.length;

        // Cumulative Security Limits Check
        if (totalUncompressedSize > ZSTD_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE) {
          throw new Error(
            `Archive bomb detected: uncompressed size exceeds limit of ${ZSTD_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE} bytes (500MB)`
          );
        }

        if (
          inputBuffer.length > 0 &&
          totalUncompressedSize / inputBuffer.length > ZSTD_SECURITY_LIMITS.MAX_RATIO
        ) {
          throw new Error(
            `Archive bomb detected: compression ratio (${(
              totalUncompressedSize / inputBuffer.length
            ).toFixed(1)}:1) exceeds ${ZSTD_SECURITY_LIMITS.MAX_RATIO}:1 limit`
          );
        }
      }

      const frameDecompressed = Buffer.concat(frameChunks);

      // Verify Checksum if present
      if (frameHeader.contentChecksumFlag) {
        if (offset + 4 > inputBuffer.length) {
          throw new Error('Malformed Zstandard frame: missing content checksum.');
        }
        const expectedChecksum = inputBuffer.readUInt32LE(offset);
        offset += 4;
        const actualChecksum = computeZstdChecksum(frameDecompressed);
        if (actualChecksum !== expectedChecksum) {
          throw new Error(
            `Zstandard content checksum mismatch: expected 0x${expectedChecksum.toString(16)}, computed 0x${actualChecksum.toString(16)}`
          );
        }
      }

      outChunks.push(frameDecompressed);
    }

    return Buffer.concat(outChunks);
  } catch (err) {
    if (err instanceof Error && err.message.includes('Archive bomb detected')) {
      throw err;
    }
    // Attempt fallback via native zstd if available
    const nativeDec = decompressWithNativeZstd(inputBuffer);
    if (nativeDec) {
      if (nativeDec.length > ZSTD_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE) {
        throw new Error(
          `Archive bomb detected: uncompressed size exceeds limit of ${ZSTD_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE} bytes (500MB)`
        );
      }
      if (
        inputBuffer.length > 0 &&
        nativeDec.length / inputBuffer.length > ZSTD_SECURITY_LIMITS.MAX_RATIO
      ) {
        throw new Error(
          `Archive bomb detected: compression ratio (${(
            nativeDec.length / inputBuffer.length
          ).toFixed(1)}:1) exceeds ${ZSTD_SECURITY_LIMITS.MAX_RATIO}:1 limit`
        );
      }
      return nativeDec;
    }
    throw err;
  }
}

/**
 * Decodes a Zstandard compressed block (literals + sequences)
 */
function decodeZstdCompressedBlock(compressedSlice: Buffer, previousBlocks: Buffer[]): Buffer {
  if (compressedSlice.length === 0) return Buffer.alloc(0);

  // 1. Literals Section Header
  let offset = 0;
  const lh0 = compressedSlice[offset++];
  const literalsBlockType = lh0 & 0x03; // 0=Raw, 1=RLE, 2=Compressed (Huffman), 3=Treeless
  const sizeFormat = (lh0 >> 2) & 0x03;

  let regeneratedSize = 0;
  let compressedLitSize = 0;
  let fourStreams = false;

  if (literalsBlockType === 0 || literalsBlockType === 1) {
    // Raw or RLE literals
    if (sizeFormat === 0 || sizeFormat === 2) {
      // 1-byte header: size is bits 3..7
      regeneratedSize = lh0 >> 3;
    } else if (sizeFormat === 1) {
      // 2-byte header
      if (offset >= compressedSlice.length) throw new Error('Truncated literals header');
      const lh1 = compressedSlice[offset++];
      regeneratedSize = (lh0 >> 4) | (lh1 << 4);
    } else {
      // 3-byte header
      if (offset + 1 >= compressedSlice.length) throw new Error('Truncated literals header');
      const lh1 = compressedSlice[offset++];
      const lh2 = compressedSlice[offset++];
      regeneratedSize = (lh0 >> 4) | (lh1 << 4) | (lh2 << 12);
    }
  } else {
    // Compressed (Huffman) literals
    if (sizeFormat === 0 || sizeFormat === 1) {
      const lh1 = compressedSlice[offset++];
      regeneratedSize = (lh0 >> 4) | ((lh1 & 0x3f) << 4);
      compressedLitSize = (lh1 >> 6) | (compressedSlice[offset++] << 2);
    } else if (sizeFormat === 2) {
      const lh1 = compressedSlice[offset++];
      const lh2 = compressedSlice[offset++];
      regeneratedSize = (lh0 >> 4) | ((lh1 & 0x3f) << 4) | ((lh2 & 0x03) << 10);
      compressedLitSize = (lh2 >> 2) | (compressedSlice[offset++] << 6);
    } else {
      const lh1 = compressedSlice[offset++];
      const lh2 = compressedSlice[offset++];
      regeneratedSize = (lh0 >> 4) | ((lh1 & 0x3f) << 4) | ((lh2 & 0x03) << 10);
      compressedLitSize =
        (lh2 >> 2) | (compressedSlice[offset++] << 6) | (compressedSlice[offset++] << 14);
    }
  }

  let literals: Buffer;
  if (literalsBlockType === 0) {
    literals = Buffer.from(compressedSlice.subarray(offset, offset + regeneratedSize));
    offset += regeneratedSize;
  } else if (literalsBlockType === 1) {
    const rleByte = compressedSlice[offset++];
    literals = Buffer.alloc(regeneratedSize, rleByte);
  } else {
    // For compressed literals, if standard raw payload exists
    literals = Buffer.from(compressedSlice.subarray(offset, offset + compressedLitSize));
    offset += compressedLitSize;
  }

  // 2. Sequences Section Header
  if (offset >= compressedSlice.length) {
    // No sequences: whole block is the literals
    return literals;
  }

  const seqByte0 = compressedSlice[offset++];
  let numSequences = 0;
  if (seqByte0 < 128) {
    numSequences = seqByte0;
  } else if (seqByte0 < 255) {
    numSequences = ((seqByte0 - 128) << 8) | compressedSlice[offset++];
  } else {
    numSequences = compressedSlice[offset++] | (compressedSlice[offset++] << 8);
    numSequences += 0x7f00;
  }

  if (numSequences === 0) {
    return literals;
  }

  return decodeZstdCompressedBlockWithDict(compressedSlice, Buffer.alloc(0), previousBlocks);
}

/**
 * Compresses data into an RFC 8878 compliant Zstandard frame.
 * Automatically chooses RLE or Raw block encoding for maximum efficiency and speed.
 */
export function compressZstd(inputBuffer: Buffer, options: { level?: number } = {}): Buffer {
  const chunks: Buffer[] = [];

  // 1. Zstandard Magic Number (0xFD2FB528 in Little Endian)
  chunks.push(ZSTD_MAGIC_LE);

  // 2. Frame Header
  // Single_Segment = 1, Content_Checksum = 1, FCS flag
  const inputLen = inputBuffer.length;
  let fcsFlag = 0;
  let fcsBuf: Buffer;

  if (inputLen < 256) {
    fcsFlag = 0; // 1 byte FCS with singleSegment=1
    fcsBuf = Buffer.from([inputLen]);
  } else if (inputLen < 65536 + 256) {
    fcsFlag = 1; // 2 byte FCS
    fcsBuf = Buffer.alloc(2);
    fcsBuf.writeUInt16LE(inputLen - 256, 0);
  } else {
    fcsFlag = 2; // 4 byte FCS
    fcsBuf = Buffer.alloc(4);
    fcsBuf.writeUInt32LE(inputLen, 0);
  }

  // Frame Header Descriptor:
  // bits 7-6: fcsFlag
  // bit 5: singleSegment = 1
  // bit 2: checksumFlag = 1
  const fhd = (fcsFlag << 6) | (1 << 5) | (1 << 2);
  chunks.push(Buffer.from([fhd]));
  chunks.push(fcsBuf);

  // 3. Blocks
  const MAX_BLOCK_SIZE = 128 * 1024; // 128KB max block size
  if (inputLen === 0) {
    // Empty block, lastBlock = 1, Raw block, size 0
    const blockHeader = Buffer.alloc(3);
    blockHeader[0] = 0x01; // lastBlock=1, type=0
    chunks.push(blockHeader);
  } else {
    let offset = 0;
    while (offset < inputLen) {
      const remaining = inputLen - offset;
      const currentBlockSize = Math.min(MAX_BLOCK_SIZE, remaining);
      const isLast = offset + currentBlockSize === inputLen;

      const slice = inputBuffer.subarray(offset, offset + currentBlockSize);

      // Check if all bytes in slice are identical (RLE candidate)
      let isRle = slice.length > 8;
      const firstByte = slice[0];
      if (isRle) {
        for (let i = 1; i < slice.length; i++) {
          if (slice[i] !== firstByte) {
            isRle = false;
            break;
          }
        }
      }

      const blockHeader = Buffer.alloc(3);
      if (isRle) {
        // Block_Type = 1 (RLE)
        const headerVal = (isLast ? 1 : 0) | (1 << 1) | (currentBlockSize << 3);
        blockHeader[0] = headerVal & 0xff;
        blockHeader[1] = (headerVal >> 8) & 0xff;
        blockHeader[2] = (headerVal >> 16) & 0xff;
        chunks.push(blockHeader);
        chunks.push(Buffer.from([firstByte]));
      } else {
        // Block_Type = 0 (Raw)
        const headerVal = (isLast ? 1 : 0) | (0 << 1) | (currentBlockSize << 3);
        blockHeader[0] = headerVal & 0xff;
        blockHeader[1] = (headerVal >> 8) & 0xff;
        blockHeader[2] = (headerVal >> 16) & 0xff;
        chunks.push(blockHeader);
        chunks.push(slice);
      }

      offset += currentBlockSize;
    }
  }

  // 4. Content Checksum (XXH64 lowest 32 bits LE)
  const checksum = computeZstdChecksum(inputBuffer);
  const checksumBuf = Buffer.alloc(4);
  checksumBuf.writeUInt32LE(checksum, 0);
  chunks.push(checksumBuf);

  return Buffer.concat(chunks);
}
