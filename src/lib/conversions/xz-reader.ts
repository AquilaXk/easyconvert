import crypto from 'node:crypto';
import { ConversionFailedError, DecompressionLimitError } from '../types';
import { ARCHIVE_SECURITY_LIMITS } from './archive-limits';
import { decompressLzma } from './archive';

// ---------------------------------------------------------------------------
// CRC Tables and Verification
// ---------------------------------------------------------------------------

const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC32_TABLE[i] = c >>> 0;
}

export function crc32(buf: Uint8Array | Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC32_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return ((c ^ 0xffffffff) >>> 0);
}

// ECMA-182 polynomial reflected: 0xC96C5795D7870F42n
const CRC64_TABLE = new BigUint64Array(256);
const CRC64_POLY = 0xc96c5795d7870f42n;
for (let i = 0; i < 256; i++) {
  let c = BigInt(i);
  for (let j = 0; j < 8; j++) {
    c = (c & 1n) ? (CRC64_POLY ^ (c >> 1n)) : (c >> 1n);
  }
  CRC64_TABLE[i] = c;
}

export function crc64(buf: Uint8Array | Buffer): bigint {
  let c = 0xffffffffffffffffn;
  for (let i = 0; i < buf.length; i++) {
    const idx = Number((c ^ BigInt(buf[i])) & 0xffn);
    c = CRC64_TABLE[idx] ^ (c >> 8n);
  }
  return c ^ 0xffffffffffffffffn;
}

// ---------------------------------------------------------------------------
// Variable-Length Integer (VLI)
// ---------------------------------------------------------------------------

function readVli(buf: Buffer, state: { pos: number }): bigint {
  let num = 0n;
  let shift = 0n;
  for (let i = 0; i < 9; i++) {
    if (state.pos >= buf.length) {
      throw new ConversionFailedError('Truncated VLI integer in XZ archive');
    }
    const b = BigInt(buf[state.pos++]);
    num |= (b & 0x7fn) << shift;
    shift += 7n;
    if ((b & 0x80n) === 0n) {
      return num;
    }
  }
  throw new ConversionFailedError('Invalid VLI integer: exceeds 9 bytes');
}

// ---------------------------------------------------------------------------
// Reverse Filters (Delta & BCJ)
// ---------------------------------------------------------------------------

export function reverseDelta(buf: Buffer, dist: number): Buffer {
  const out = Buffer.from(buf);
  for (let i = dist; i < out.length; i++) {
    out[i] = (out[i] + out[i - dist]) & 0xff;
  }
  return out;
}

export function reverseBcjX86(buf: Buffer, startOffset: number = 0): Buffer {
  const out = Buffer.from(buf);
  const size = out.length;
  if (size <= 4) return out;
  const maskToAllowed = [true, true, true, false, true, false, false, false];
  const maskToBitNum = [0, 1, 2, 2, 3, 3, 3, 3];
  let prevPos = -1;
  let prevMask = 0;
  const limit = size - 4;
  let i = 0;
  while (i < limit) {
    if ((out[i] & 0xfe) !== 0xe8) {
      i++;
      continue;
    }
    const p = i - prevPos;
    if (p > 3) {
      prevMask = 0;
    } else {
      prevMask = (prevMask << (p - 1)) & 7;
      if (prevMask !== 0) {
        const b = out[i + 4 - maskToBitNum[prevMask]];
        if (!maskToAllowed[prevMask] || b === 0 || b === 0xff) {
          prevPos = i;
          prevMask = (prevMask << 1) | 1;
          i++;
          continue;
        }
      }
    }
    prevPos = i;
    if (out[i + 4] === 0 || out[i + 4] === 0xff) {
      let src = out.readUInt32LE(i + 1);
      let dest: number;
      while (true) {
        dest = (src - (startOffset + i + 5)) >>> 0;
        if (prevMask === 0) break;
        const j = maskToBitNum[prevMask] * 8;
        const b = (dest >>> (24 - j)) & 0xff;
        if (b !== 0 && b !== 0xff) break;
        src = (dest ^ (((1 << (32 - j)) - 1) >>> 0)) >>> 0;
      }
      dest &= 0x01ffffff;
      if ((dest & 0x01000000) !== 0) {
        dest = (dest | 0xfe000000) >>> 0;
      }
      out.writeUInt32LE(dest, i + 1);
      i += 4;
    } else {
      prevMask = (prevMask << 1) | 1;
    }
    i++;
  }
  return out;
}

export function reverseBcjPowerPC(buf: Buffer, startOffset: number = 0): Buffer {
  const out = Buffer.from(buf);
  const size = out.length & ~3;
  for (let i = 0; i < size; i += 4) {
    const instr = out.readUInt32BE(i);
    if ((instr >>> 26) === 18 && (instr & 3) === 1) {
      let addr = (instr & 0x03fffffc) - (startOffset + i);
      addr = (addr & 0x03fffffc) >>> 0;
      out.writeUInt32BE((18 << 26) | addr | 1, i);
    }
  }
  return out;
}

export function reverseBcjIa64(buf: Buffer, startOffset: number = 0): Buffer {
  const out = Buffer.from(buf);
  const BRANCH_TABLE = [
    0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    4, 4, 6, 6, 0, 0, 7, 7,
    4, 4, 0, 0, 4, 4, 0, 0
  ];
  const size = out.length & ~15;
  for (let i = 0; i < size; i += 16) {
    const instrTemplate = out[i] & 0x1f;
    const mask = BRANCH_TABLE[instrTemplate];
    let bitPos = 5;
    for (let slot = 0; slot < 3; slot++, bitPos += 41) {
      if (((mask >> slot) & 1) === 0) continue;
      const bytePos = bitPos >> 3;
      const bitRes = BigInt(bitPos & 7);
      let instruction = 0n;
      for (let j = 0; j < 6; j++) {
        instruction += BigInt(out[i + j + bytePos]) << BigInt(8 * j);
      }
      let instNorm = instruction >> bitRes;
      if (((instNorm >> 37n) & 0xfn) === 0x5n && ((instNorm >> 9n) & 0x7n) === 0n) {
        let src = Number((instNorm >> 13n) & 0xfffffn);
        src |= Number((instNorm >> 36n) & 1n) << 20;
        src <<= 4;
        let dest = (src - (startOffset + i)) >>> 0;
        dest >>>= 4;
        instNorm &= ~(0x8fffffn << 13n);
        instNorm |= BigInt(dest & 0xfffff) << 13n;
        instNorm |= BigInt(dest & 0x100000) << 16n;
        instruction &= (1n << bitRes) - 1n;
        instruction |= instNorm << bitRes;
        for (let j = 0; j < 6; j++) {
          out[i + j + bytePos] = Number((instruction >> BigInt(8 * j)) & 0xffn);
        }
      }
    }
  }
  return out;
}

export function reverseBcjArm(buf: Buffer, startOffset: number = 0): Buffer {
  const out = Buffer.from(buf);
  const size = out.length & ~3;
  for (let i = 0; i < size; i += 4) {
    if (out[i + 3] === 0xeb) {
      let addr = out[i] | (out[i + 1] << 8) | (out[i + 2] << 16);
      addr <<= 2;
      addr = (addr - (startOffset + i + 8)) >>> 0;
      addr >>>= 2;
      out[i] = addr & 0xff;
      out[i + 1] = (addr >>> 8) & 0xff;
      out[i + 2] = (addr >>> 16) & 0xff;
    }
  }
  return out;
}

export function reverseBcjArmThumb(buf: Buffer, startOffset: number = 0): Buffer {
  const out = Buffer.from(buf);
  if (out.length < 4) return out;
  const size = out.length - 4;
  for (let i = 0; i <= size; i += 2) {
    if ((out[i + 1] & 0xf8) === 0xf0 && (out[i + 3] & 0xf8) === 0xf8) {
      let addr =
        (((out[i + 1] & 0x07) << 19) |
          (out[i] << 11) |
          ((out[i + 3] & 0x07) << 8) |
          out[i + 2]) >>> 0;
      addr <<= 1;
      addr = (addr - (startOffset + i + 4)) >>> 0;
      addr >>>= 1;
      out[i + 1] = 0xf0 | ((addr >>> 19) & 0x07);
      out[i] = (addr >>> 11) & 0xff;
      out[i + 3] = 0xf8 | ((addr >>> 8) & 0x07);
      out[i + 2] = addr & 0xff;
      i += 2;
    }
  }
  return out;
}

export function reverseBcjSparc(buf: Buffer, startOffset: number = 0): Buffer {
  const out = Buffer.from(buf);
  const size = out.length & ~3;
  for (let i = 0; i < size; i += 4) {
    let instr = out.readUInt32BE(i);
    if ((instr >>> 22) === 0x100 || (instr >>> 22) === 0x1ff) {
      instr <<= 2;
      instr = (instr - (startOffset + i)) >>> 0;
      instr >>>= 2;
      instr = (((0x40000000 - (instr & 0x400000)) >>> 0) | 0x40000000 | (instr & 0x3fffff)) >>> 0;
      out.writeUInt32BE(instr, i);
    }
  }
  return out;
}

export function reverseBcjArm64(buf: Buffer, startOffset: number = 0): Buffer {
  const out = Buffer.from(buf);
  const size = out.length & ~3;
  for (let i = 0; i < size; i += 4) {
    let instr = out.readUInt32LE(i);
    if ((instr >>> 26) === 0x25) {
      const addr = (instr - ((startOffset + i) >>> 2)) >>> 0;
      instr = (0x94000000 | (addr & 0x03ffffff)) >>> 0;
      out.writeUInt32LE(instr, i);
    } else if ((instr & 0x9f000000) === 0x90000000) {
      let addr = ((instr >>> 29) & 3) | ((instr >>> 3) & 0x1ffffc);
      if (!((addr + 0x020000) & 0x1c0000)) {
        addr = (addr - ((startOffset + i) >>> 12)) >>> 0;
        instr = (instr & 0x9000001f) >>> 0;
        instr |= (addr & 3) << 29;
        instr |= (addr & 0x03fffc) << 3;
        instr |= ((0 - (addr & 0x020000)) & 0xe00000) >>> 0;
        out.writeUInt32LE(instr >>> 0, i);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// LZMA2 Stream Reader
// ---------------------------------------------------------------------------

function decodeLzma2Payload(
  input: Buffer,
  inOffset: number,
  maxPackSize: number | null
): { uncompressed: Buffer; consumedPackSize: number } {
  let curIn = inOffset;
  const maxIn = maxPackSize !== null ? inOffset + maxPackSize : input.length;
  const chunks: Buffer[] = [];
  let totalUnpack = 0;
  let curProps = Buffer.from([0x5d, 0, 0, 0, 0]);

  while (curIn < maxIn) {
    const control = input[curIn++];
    if (control === 0) {
      // EOS
      break;
    }
    if (control === 1 || control === 2) {
      const chunkSize = ((input[curIn] << 8) | input[curIn + 1]) + 1;
      curIn += 2;
      if (curIn + chunkSize > maxIn) {
        throw new ConversionFailedError('Truncated uncompressed chunk in LZMA2');
      }
      const chunk = input.subarray(curIn, curIn + chunkSize);
      curIn += chunkSize;
      chunks.push(chunk);
      totalUnpack += chunk.length;
    } else if (control >= 0x80) {
      const chunkUnpackSize = (((control & 0x1f) << 16) | (input[curIn] << 8) | input[curIn + 1]) + 1;
      curIn += 2;
      const chunkPackSize = ((input[curIn] << 8) | input[curIn + 1]) + 1;
      curIn += 2;
      const mode = (control >> 5) & 3;
      if (mode === 2 || mode === 3) {
        const propByte = input[curIn++];
        curProps = Buffer.from([propByte, 0, 0, 0, 0]);
      }
      if (curIn + chunkPackSize > maxIn) {
        throw new ConversionFailedError('Truncated LZMA chunk in LZMA2');
      }
      const chunkData = input.subarray(curIn, curIn + chunkPackSize);
      curIn += chunkPackSize;

      const decoded = decompressLzma(chunkData, curProps, chunkUnpackSize);
      chunks.push(decoded);
      totalUnpack += decoded.length;
    } else {
      throw new ConversionFailedError(`Invalid LZMA2 control byte: 0x${control.toString(16)}`);
    }

    if (totalUnpack > ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE) {
      throw new DecompressionLimitError(
        `Archive bomb detected: uncompressed size exceeds ${ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE} bytes`
      );
    }
  }

  return {
    uncompressed: Buffer.concat(chunks),
    consumedPackSize: curIn - inOffset,
  };
}

// ---------------------------------------------------------------------------
// XZ Format 1.2.0 Stream Reader
// ---------------------------------------------------------------------------

interface FilterDesc {
  id: bigint;
  props: Buffer;
}

interface BlockRecord {
  unpaddedSize: number;
  uncompressedSize: number;
}

export function readXzStream(buf: Buffer): Buffer {
  if (buf.length < 32) {
    throw new ConversionFailedError('Invalid XZ archive: buffer too small for complete stream');
  }

  let pos = 0;
  const streamOutputs: Buffer[] = [];
  let totalUncompressedSize = 0;

  while (pos < buf.length) {
    // 1. Verify Stream Header Magic: FD 37 7A 58 5A 00
    if (
      buf[pos] !== 0xfd ||
      buf[pos + 1] !== 0x37 ||
      buf[pos + 2] !== 0x7a ||
      buf[pos + 3] !== 0x58 ||
      buf[pos + 4] !== 0x5a ||
      buf[pos + 5] !== 0x00
    ) {
      throw new ConversionFailedError('Invalid XZ stream header magic');
    }

    const headerStart = pos;
    const streamFlags = buf.subarray(pos + 6, pos + 8);
    if (streamFlags[0] !== 0x00 || (streamFlags[1] & 0xf0) !== 0) {
      throw new ConversionFailedError('Unsupported XZ stream flags');
    }
    const checkType = streamFlags[1] & 0x0f;
    let checkSize = 0;
    if (checkType === 0) checkSize = 0;
    else if (checkType === 1) checkSize = 4;
    else if (checkType === 4) checkSize = 8;
    else if (checkType === 10) checkSize = 32;
    else {
      throw new ConversionFailedError(`Unsupported XZ check type: ${checkType}`);
    }

    const headerFlagsCrc = buf.readUInt32LE(pos + 8);
    if (crc32(streamFlags) !== headerFlagsCrc) {
      throw new ConversionFailedError('Corrupted XZ stream flags CRC32');
    }
    pos += 12;

    // 2. Decode Blocks until Index indicator (0x00)
    const blockRecords: BlockRecord[] = [];

    while (pos < buf.length) {
      if (buf[pos] === 0x00) {
        // Index Indicator reached!
        break;
      }

      const blockStart = pos;
      const encodedHeaderSize = buf[pos];
      const headerSize = (encodedHeaderSize + 1) * 4;
      if (pos + headerSize > buf.length) {
        throw new ConversionFailedError('Truncated XZ block header');
      }

      const storedHeaderCrc = buf.readUInt32LE(pos + headerSize - 4);
      const computedHeaderCrc = crc32(buf.subarray(pos, pos + headerSize - 4));
      if (storedHeaderCrc !== computedHeaderCrc) {
        throw new ConversionFailedError('Corrupted XZ block header CRC32');
      }

      const blockFlags = buf[pos + 1];
      const numFilters = (blockFlags & 0x03) + 1;
      if ((blockFlags & 0x3c) !== 0) {
        throw new ConversionFailedError('Reserved bits set in XZ block flags');
      }
      const hasCompressedSize = Boolean(blockFlags & 0x40);
      const hasUncompressedSize = Boolean(blockFlags & 0x80);

      const state = { pos: pos + 2 };
      let headerCompressedSize: bigint | null = null;
      if (hasCompressedSize) {
        headerCompressedSize = readVli(buf, state);
      }
      let headerUncompressedSize: bigint | null = null;
      if (hasUncompressedSize) {
        headerUncompressedSize = readVli(buf, state);
      }

      const filters: FilterDesc[] = [];
      for (let f = 0; f < numFilters; f++) {
        const filterId = readVli(buf, state);
        const propsSize = Number(readVli(buf, state));
        if (state.pos + propsSize > pos + headerSize - 4) {
          throw new ConversionFailedError('Filter properties exceed block header size');
        }
        const props = buf.subarray(state.pos, state.pos + propsSize);
        state.pos += propsSize;
        filters.push({ id: filterId, props });
      }

      // Check remaining padding in block header
      while (state.pos < pos + headerSize - 4) {
        if (buf[state.pos++] !== 0) {
          throw new ConversionFailedError('Non-zero padding in XZ block header');
        }
      }

      pos = blockStart + headerSize;

      // Ensure last filter is LZMA2 (0x21)
      const lastFilter = filters[filters.length - 1];
      if (lastFilter.id !== 0x21n) {
        throw new ConversionFailedError(`Unsupported primary XZ filter: 0x${lastFilter.id.toString(16)}`);
      }

      // Decompress LZMA2 payload
      const maxPack = headerCompressedSize !== null ? Number(headerCompressedSize) : null;
      const { uncompressed: lzma2Out, consumedPackSize } = decodeLzma2Payload(buf, pos, maxPack);

      let decompressed = lzma2Out;

      // Apply preceding filters in reverse order (numFilters - 2 down to 0)
      for (let fi = filters.length - 2; fi >= 0; fi--) {
        const f = filters[fi];
        const startOff = f.props.length >= 4 ? f.props.readUInt32LE(0) : 0;
        if (f.id === 0x03n) {
          const dist = f.props.length > 0 ? f.props[0] + 1 : 1;
          decompressed = reverseDelta(decompressed, dist);
        } else if (f.id === 0x04n) {
          decompressed = reverseBcjX86(decompressed, startOff);
        } else if (f.id === 0x05n) {
          decompressed = reverseBcjPowerPC(decompressed, startOff);
        } else if (f.id === 0x06n) {
          decompressed = reverseBcjIa64(decompressed, startOff);
        } else if (f.id === 0x07n) {
          decompressed = reverseBcjArm(decompressed, startOff);
        } else if (f.id === 0x08n) {
          decompressed = reverseBcjArmThumb(decompressed, startOff);
        } else if (f.id === 0x09n) {
          decompressed = reverseBcjSparc(decompressed, startOff);
        } else if (f.id === 0x0an) {
          decompressed = reverseBcjArm64(decompressed, startOff);
        } else {
          throw new ConversionFailedError(`Unsupported XZ non-primary filter ID: 0x${f.id.toString(16)}`);
        }
      }

      // Verify uncompressed size if declared in header
      if (headerUncompressedSize !== null && BigInt(decompressed.length) !== headerUncompressedSize) {
        throw new ConversionFailedError('XZ block uncompressed size mismatch');
      }

      pos += consumedPackSize;

      // Handle 4-byte alignment padding for compressed data
      const padLen = (4 - (consumedPackSize % 4)) % 4;
      for (let p = 0; p < padLen; p++) {
        if (pos >= buf.length || buf[pos++] !== 0) {
          throw new ConversionFailedError('Invalid non-zero padding after compressed data in XZ block');
        }
      }

      // Verify block check
      if (checkSize > 0) {
        if (pos + checkSize > buf.length) {
          throw new ConversionFailedError('Truncated XZ block check');
        }
        if (checkType === 1) {
          const storedCrc = buf.readUInt32LE(pos);
          if (crc32(decompressed) !== storedCrc) {
            throw new ConversionFailedError('XZ block check mismatch: payload CRC32 mismatch');
          }
        } else if (checkType === 4) {
          const storedCrc64 = buf.readBigUInt64LE(pos);
          if (crc64(decompressed) !== storedCrc64) {
            throw new ConversionFailedError('XZ block check mismatch: CRC64 does not match');
          }
        } else if (checkType === 10) {
          const storedSha = buf.subarray(pos, pos + 32);
          const computedSha = crypto.createHash('sha256').update(decompressed).digest();
          if (!storedSha.equals(computedSha)) {
            throw new ConversionFailedError('XZ block check mismatch: SHA-256 does not match');
          }
        }
        pos += checkSize;
      }

      const unpaddedSize = headerSize + consumedPackSize + checkSize;
      blockRecords.push({
        unpaddedSize,
        uncompressedSize: decompressed.length,
      });

      totalUncompressedSize += decompressed.length;
      if (totalUncompressedSize > ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE) {
        throw new DecompressionLimitError(
          `Archive bomb detected: total uncompressed size exceeds ${ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE} bytes`
        );
      }

      streamOutputs.push(decompressed);
    }

    // 3. Verify Index
    if (pos >= buf.length || buf[pos] !== 0x00) {
      throw new ConversionFailedError('Expected XZ Index indicator (0x00)');
    }

    const indexStart = pos;
    const indexState = { pos: pos + 1 };
    const numRecords = Number(readVli(buf, indexState));
    if (numRecords !== blockRecords.length) {
      throw new ConversionFailedError(
        `XZ Index record count mismatch: expected ${blockRecords.length}, got ${numRecords}`
      );
    }

    for (let r = 0; r < numRecords; r++) {
      const recUnpadded = Number(readVli(buf, indexState));
      const recUncompressed = Number(readVli(buf, indexState));
      if (recUnpadded !== blockRecords[r].unpaddedSize || recUncompressed !== blockRecords[r].uncompressedSize) {
        throw new ConversionFailedError(`XZ Index record ${r} does not match block sizes`);
      }
    }

    // Index padding to 4-byte boundary
    const indexBytesBeforePadding = indexState.pos - indexStart;
    const indexPadLen = (4 - (indexBytesBeforePadding % 4)) % 4;
    for (let p = 0; p < indexPadLen; p++) {
      if (buf[indexState.pos++] !== 0) {
        throw new ConversionFailedError('Non-zero padding in XZ Index');
      }
    }

    // Index CRC32
    const storedIndexCrc = buf.readUInt32LE(indexState.pos);
    const computedIndexCrc = crc32(buf.subarray(indexStart, indexState.pos));
    if (storedIndexCrc !== computedIndexCrc) {
      throw new ConversionFailedError('Corrupted XZ Index CRC32');
    }
    indexState.pos += 4;
    const realIndexSize = indexState.pos - indexStart;
    pos = indexState.pos;

    // 4. Verify Stream Footer (12 bytes)
    if (pos + 12 > buf.length) {
      throw new ConversionFailedError('Truncated XZ stream footer');
    }

    const storedFooterCrc = buf.readUInt32LE(pos);
    const computedFooterCrc = crc32(buf.subarray(pos + 4, pos + 10));
    if (storedFooterCrc !== computedFooterCrc) {
      throw new ConversionFailedError('Corrupted XZ stream footer CRC32 (footer CRC mismatch)');
    }

    const backwardSize = buf.readUInt32LE(pos + 4);
    if ((backwardSize + 1) * 4 !== realIndexSize) {
      throw new ConversionFailedError('XZ stream footer backward size mismatch');
    }

    const footerFlags = buf.subarray(pos + 8, pos + 10);
    if (!footerFlags.equals(streamFlags)) {
      throw new ConversionFailedError('XZ stream footer flags do not match stream header flags (stream flags mismatch)');
    }

    if (buf[pos + 10] !== 0x59 || buf[pos + 11] !== 0x5a) {
      throw new ConversionFailedError('Invalid XZ stream footer magic (expected YZ)');
    }
    pos += 12;

    // 5. Handle Stream Padding (multiples of 4 null bytes)
    let nullCount = 0;
    while (pos < buf.length && buf[pos] === 0) {
      nullCount++;
      pos++;
    }
    if (nullCount % 4 !== 0) {
      throw new ConversionFailedError('XZ stream padding is not a multiple of 4 bytes');
    }
  }

  const result = Buffer.concat(streamOutputs);
  if (buf.length > 0 && result.length / buf.length > ARCHIVE_SECURITY_LIMITS.MAX_RATIO) {
    throw new DecompressionLimitError(
      `Archive bomb detected: compression ratio (${(result.length / buf.length).toFixed(1)}:1) exceeds ${ARCHIVE_SECURITY_LIMITS.MAX_RATIO}:1 limit`
    );
  }

  return result;
}
