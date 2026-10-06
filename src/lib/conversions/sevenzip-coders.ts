import crypto from 'node:crypto';
import {
  ConversionFailedError,
  ArchivePasswordRequiredError,
  UnsupportedOptionError,
  DecompressionLimitError,
} from '../types';
import { inflateBounded, MAX_STREAM_INFLATE_BYTES } from './bounded-inflate';

export const MAX_UNCOMPRESSED_SIZE = 500 * 1024 * 1024;

/**
 * 7z method IDs and coder implementations.
 */

export const METHOD_COPY = '00';
export const METHOD_DELTA = '03';
export const METHOD_LZMA = '030101';
export const METHOD_BCJ = '03030103';
export const METHOD_PPC = '03030205';
export const METHOD_IA64 = '03030401';
export const METHOD_ARM = '03030501';
export const METHOD_ARMT = '03030701';
export const METHOD_SPARC = '03030805';
export const METHOD_ARM64 = '03030f01';
export const METHOD_ARM64_ALT = '0a';
export const METHOD_BCJ2 = '0303011b';
export const METHOD_DEFLATE = '04';
export const METHOD_DEFLATE_ZIP = '040108';
export const METHOD_DEFLATE_64 = '040109';
export const METHOD_BZIP2 = '040202';
export const METHOD_AES256 = '06f10701';
export const METHOD_LZMA2 = '21';

export function methodIdToHex(methodId: Buffer | Uint8Array): string {
  return Buffer.from(methodId).toString('hex').toLowerCase();
}

/**
 * Derives a 32-byte AES-256 key from a UTF-16LE password, salt, and cycles power.
 * 7-Zip specification caps numCyclesPower at 24.
 */
export function derive7zAesKey(password: string, salt: Buffer, numCyclesPower: number): Buffer {
  if (numCyclesPower > 24 && numCyclesPower !== 0x3f) {
    throw new ConversionFailedError(`7z AES key derivation cycle power ${numCyclesPower} exceeds maximum limit of 24`);
  }

  const passwordBuf = Buffer.from(password, 'utf16le');

  if (numCyclesPower === 0x3f) {
    const key = Buffer.alloc(32);
    let pos = 0;
    for (let i = 0; i < salt.length && pos < 32; i++) key[pos++] = salt[i];
    for (let i = 0; i < passwordBuf.length && pos < 32; i++) key[pos++] = passwordBuf[i];
    return key;
  }

  const hash = crypto.createHash('sha256');
  const baseBuf = Buffer.concat([salt, passwordBuf, Buffer.alloc(8)]);
  const bufLen = baseBuf.length;
  const numRounds = 1 << numCyclesPower;

  const chunkSize = Math.min(numRounds, 64);
  const chunkBuf = Buffer.alloc(bufLen * chunkSize);
  for (let c = 0; c < chunkSize; c++) {
    baseBuf.copy(chunkBuf, c * bufLen);
  }

  for (let r = 0; r < numRounds; r += chunkSize) {
    const currentChunk = Math.min(chunkSize, numRounds - r);
    for (let i = 0; i < currentChunk; i++) {
      const idx = r + i;
      chunkBuf.writeUInt32LE(idx >>> 0, i * bufLen + bufLen - 8);
      chunkBuf.writeUInt32LE(Math.floor(idx / 0x100000000), i * bufLen + bufLen - 4);
    }
    hash.update(chunkBuf.subarray(0, currentChunk * bufLen));
  }

  return hash.digest();
}

/**
 * Decrypts 7z AES-256 CBC data.
 */
export function decrypt7zAes(
  data: Buffer,
  properties: Buffer | undefined,
  password: string | undefined,
  unpackSize: number
): Buffer {
  if (!password) {
    throw new ArchivePasswordRequiredError('Password required to decrypt 7z archive');
  }

  if (!properties || properties.length < 1) {
    throw new ConversionFailedError('Corrupted 7z AES properties');
  }

  const b0 = properties[0];
  const numCyclesPower = b0 & 0x3f;
  let saltSize = 0;
  let ivSize = 0;
  let propPos = 1;

  if ((b0 & 0xc0) !== 0) {
    if (properties.length < 2) {
      throw new ConversionFailedError('Corrupted 7z AES properties header');
    }
    const b1 = properties[1];
    propPos = 2;
    saltSize = ((b0 >> 7) & 1) + (b1 >> 4);
    ivSize = ((b0 >> 6) & 1) + (b1 & 0x0f);
  }

  if (properties.length < propPos + saltSize + ivSize) {
    throw new ConversionFailedError('Truncated 7z AES properties');
  }

  const salt = properties.subarray(propPos, propPos + saltSize);
  const rawIv = properties.subarray(propPos + saltSize, propPos + saltSize + ivSize);
  const iv = Buffer.alloc(16);
  rawIv.copy(iv);

  const key = derive7zAesKey(password, salt, numCyclesPower);

  try {
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    decipher.setAutoPadding(false);
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
    return unpackSize ? decrypted.subarray(0, unpackSize) : decrypted;
  } catch (err) {
    throw new ConversionFailedError(
      `Failed to decrypt 7z AES stream: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Delta filter decoder.
 */
export function decodeDelta(data: Buffer, properties: Buffer | undefined): Buffer {
  const delta = (properties && properties.length > 0 ? properties[0] : 0) + 1;
  const out = Buffer.from(data);
  for (let i = delta; i < out.length; i++) {
    out[i] = (out[i] + out[i - delta]) & 0xff;
  }
  return out;
}

/**
 * BCJ (x86 branch conversion) decoder.
 */
export function decodeBcj(data: Buffer, ip = 0): Buffer {
  const out = Buffer.from(data);
  const len = out.length;
  if (len < 5) return out;
  const lim = len - 4;
  let pos = 0;

  const testByte = (b: number): boolean => b === 0x00 || b === 0xff;

  while (pos < lim) {
    const b = out[pos];
    if (b !== 0xe8 && b !== 0xe9) {
      pos++;
      continue;
    }
    const offset = pos + 1;
    let src = out.readUInt32LE(offset);
    while (true) {
      const b2 = (src >> 24) & 0xff;
      if (!testByte(b2)) break;
      const curIp = (ip + pos + 5) >>> 0;
      src = (src - curIp) >>> 0;
      out.writeUInt32LE(src, offset);
      pos += 4;
      break;
    }
    pos++;
  }
  return out;
}

/**
 * ARM 32-bit branch conversion decoder.
 */
export function decodeArm(data: Buffer, ip = 0): Buffer {
  const out = Buffer.from(data);
  const lim = out.length & ~3;
  let pos = 0;
  while (pos < lim) {
    if (out[pos + 3] === 0xeb) {
      let v = out.readUInt32LE(pos);
      const c = (ip + pos + 8) >> 2;
      v = (v - c) >>> 0;
      v = ((v & 0x00ffffff) | (0xeb << 24)) >>> 0;
      out.writeUInt32LE(v, pos);
    }
    pos += 4;
  }
  return out;
}

/**
 * ARMT (Thumb 16-bit BL) branch conversion decoder.
 */
export function decodeArmt(data: Buffer, ip = 0): Buffer {
  const out = Buffer.from(data);
  const lim = out.length - 4;
  let pos = 0;
  while (pos <= lim) {
    const b1 = out[pos + 1];
    const b3 = out[pos + 3];
    if ((b1 & 0xf8) === 0xf0 && (b3 & 0xf8) === 0xf8) {
      let v = ((out.readUInt16LE(pos) << 11) | (out.readUInt16LE(pos + 2) & 0x7ff)) >>> 0;
      const c = (ip + pos + 4) >> 1;
      v = (v - c) >>> 0;
      out.writeUInt16LE(((v >> 11) & 0x7ff) | 0xf000, pos);
      out.writeUInt16LE((v & 0x7ff) | 0xf800, pos + 2);
      pos += 4;
      continue;
    }
    pos += 2;
  }
  return out;
}

/**
 * ARM64 branch conversion decoder.
 */
export function decodeArm64(data: Buffer, ip = 0): Buffer {
  const out = Buffer.from(data);
  const lim = out.length & ~3;
  let pos = 0;
  const flag = 1 << (24 - 4);
  const mask = (1 << 24) - (flag << 1);

  while (pos < lim) {
    let v = out.readUInt32LE(pos);
    if (((v - 0x94000000) & 0xfc000000) === 0) {
      const c = (ip + pos) >> 2;
      v = (v - c) >>> 0;
      v = ((v & 0x03ffffff) | 0x94000000) >>> 0;
      out.writeUInt32LE(v, pos);
    } else if (((v - 0x90000000) & 0x9f000000) === 0) {
      const v2 = (v + flag) >>> 0;
      if ((v2 & mask) === 0) {
        let z = ((v2 & 0xffffffe0) | (v2 >>> 26)) >>> 0;
        const c = ((ip + pos) >> (12 - 3)) & ~7;
        z = (z - c) >>> 0;
        let res = (v2 & 0x1f) | 0x90000000;
        res = (res | ((z << 26) >>> 0)) >>> 0;
        res = (res | (0x00fffffe0 & ((z & ((flag << 1) - 1)) - flag))) >>> 0;
        out.writeUInt32LE(res, pos);
      }
    }
    pos += 4;
  }
  return out;
}

/**
 * PowerPC (PPC) Big-Endian branch conversion decoder.
 */
export function decodePpc(data: Buffer, ip = 0): Buffer {
  const out = Buffer.from(data);
  const lim = out.length & ~3;
  let pos = 0;
  while (pos < lim) {
    let v = out.readUInt32BE(pos);
    if ((v & 0xfc000003) === 0x48000001) {
      const c = ip + pos;
      v = (v - c) >>> 0;
      v = ((v & 0x03ffffff) | 0x48000000) >>> 0;
      out.writeUInt32BE(v, pos);
    }
    pos += 4;
  }
  return out;
}

/**
 * SPARC Big-Endian branch conversion decoder.
 */
export function decodeSparc(data: Buffer, ip = 0): Buffer {
  const out = Buffer.from(data);
  const lim = out.length & ~3;
  let pos = 0;
  while (pos < lim) {
    const v = out.readUInt32BE(pos);
    if ((v >> 30) === 1) {
      let val = (v << 2) >>> 0;
      const c = ip + pos;
      val = (val - c) >>> 0;
      val = (((val >> 2) & 0x3fffffff) | 0x40000000) >>> 0;
      out.writeUInt32BE(val, pos);
    }
    pos += 4;
  }
  return out;
}

/**
 * IA64 branch conversion decoder.
 */
export function decodeIa64(data: Buffer, ip = 0): Buffer {
  const out = Buffer.from(data);
  let p = 0;
  const size = out.length & ~15;
  let pc = ip;
  pc -= 1 << 4;
  pc >>>= 3;

  while (p < size) {
    let m = 0;
    while (p < size) {
      m = (0x334b0000 >>> (out[p] & 0x1e)) & 3;
      p += 16;
      pc = (pc + 2) >>> 0;
      if (m !== 0) break;
    }
    if (m === 0) break;
    p += m * 5 - 20;
    do {
      const t = out.readUInt16LE(p);
      let z = (out.readUInt32LE(p + 1) >>> m) >>> 0;
      p += 5;
      if (((t >>> m) & (0x70 << 1)) === 0 && (((z - (0x5000000 << 1)) >>> 0) & (0xf000000 << 1)) === 0) {
        let v = (((0x8fffff << 1) | 1) & z) >>> 0;
        z ^= v;
        const c = (pc | ~(((0x1fffff << 1) | 1) >>> 0)) >>> 0;
        v = (v - c) >>> 0;
        v &= ~((0x600000 << 1) >>> 0);
        v = (v + (0x700000 << 1)) >>> 0;
        v &= ((0x8fffff << 1) | 1) >>> 0;
        z |= v;
        z = (z << m) >>> 0;
        out.writeUInt32LE(z, p - 4);
      }
      m = (m + 1) & 3;
    } while (m !== 0);
  }
  return out;
}

/**
 * BCJ2 decoder for x86 code with 4 streams:
 * in0 = main stream
 * in1 = call stream
 * in2 = jump stream
 * in3 = range coder stream
 */
export function decodeBcj2(
  main: Buffer,
  call: Buffer,
  jump: Buffer,
  rc: Buffer,
  unpackSize: number
): Buffer {
  const out = Buffer.alloc(unpackSize);
  let outPos = 0;
  let mainPos = 0;
  let callPos = 0;
  let jumpPos = 0;
  let rcPos = 0;

  let range = 0xffffffff;
  let code = 0;
  for (let i = 0; i < 5; i++) {
    code = ((code << 8) | (rc[rcPos++] || 0)) >>> 0;
  }

  const probs = new Uint16Array(258).fill(1024);
  let prevByte = 0;

  while (outPos < unpackSize && mainPos < main.length) {
    const b = main[mainPos++];
    out[outPos++] = b;

    const isCall = b === 0xe8;
    const isJump = b === 0xe9;
    const isJcc = prevByte === 0x0f && (b & 0xf0) === 0x80;

    if (isCall || isJump || isJcc) {
      let probIdx = 0;
      if (isCall) {
        probIdx = 2 + prevByte;
      } else if (isJump) {
        probIdx = 1;
      } else {
        probIdx = 0;
      }

      const prob = probs[probIdx];
      const bound = ((range >>> 11) * prob) >>> 0;

      let bit = 0;
      if (code < bound) {
        range = bound;
        probs[probIdx] = (prob + ((2048 - prob) >> 5)) & 0xffff;
        bit = 0;
      } else {
        range = (range - bound) >>> 0;
        code = (code - bound) >>> 0;
        probs[probIdx] = (prob - (prob >> 5)) & 0xffff;
        bit = 1;
      }

      while (range < 0x01000000) {
        range = (range << 8) >>> 0;
        code = ((code << 8) | (rc[rcPos++] || 0)) >>> 0;
      }

      if (bit === 1) {
        const destStream = isCall ? call : jump;
        const destPos = isCall ? callPos : jumpPos;
        if (destPos + 4 > destStream.length) {
          throw new ConversionFailedError('Truncated stream in BCJ2 decoder');
        }

        const rel = destStream.readUInt32BE(destPos);
        if (isCall) callPos += 4;
        else jumpPos += 4;

        const curIp = outPos + 4;
        const abs = (rel - curIp) >>> 0;

        out.writeUInt32LE(abs, outPos);
        outPos += 4;
        prevByte = (abs >>> 24) & 0xff;
        continue;
      }
    }

    prevByte = b;
  }

  return out.subarray(0, outPos);
}

/**
 * Continuous-buffer LZMA2 Stream Decoder.
 * Carries dictionary history and state models across all chunks in the stream.
 */
export class Lzma2StreamDecoder {
  readonly outBuf: Buffer;
  outPos = 0;
  state = 0;
  rep0 = 0;
  rep1 = 0;
  rep2 = 0;
  rep3 = 0;
  dictStart = 0;
  lc = 3;
  lp = 0;
  pb = 2;

  isMatch = new Uint16Array(12 << 4).fill(1024);
  isRep = new Uint16Array(12).fill(1024);
  isRepG0 = new Uint16Array(12).fill(1024);
  isRepG1 = new Uint16Array(12).fill(1024);
  isRepG2 = new Uint16Array(12).fill(1024);
  isRep0Long = new Uint16Array(12 << 4).fill(1024);
  posSlotDecoder: Uint16Array[] = [];
  posDecoders = new Uint16Array(114).fill(1024);
  posAlignDecoder = new Uint16Array(16).fill(1024);
  lenLow = new Uint16Array(16 * 8).fill(1024);
  lenMid = new Uint16Array(16 * 8).fill(1024);
  lenHigh = new Uint16Array(256).fill(1024);
  repLenLow = new Uint16Array(16 * 8).fill(1024);
  repLenMid = new Uint16Array(16 * 8).fill(1024);
  repLenHigh = new Uint16Array(256).fill(1024);
  lenChoice1 = new Uint16Array(1).fill(1024);
  lenChoice2 = new Uint16Array(1).fill(1024);
  repLenChoice1 = new Uint16Array(1).fill(1024);
  repLenChoice2 = new Uint16Array(1).fill(1024);
  litProbs: Uint16Array = new Uint16Array(0);

  constructor(readonly unpackSize: number) {
    this.outBuf = Buffer.alloc(unpackSize);
    for (let i = 0; i < 4; i++) {
      this.posSlotDecoder.push(new Uint16Array(1 << 6).fill(1024));
    }
    this.resetProbs();
  }

  resetProbs(): void {
    this.isMatch.fill(1024);
    this.isRep.fill(1024);
    this.isRepG0.fill(1024);
    this.isRepG1.fill(1024);
    this.isRepG2.fill(1024);
    this.isRep0Long.fill(1024);
    for (const d of this.posSlotDecoder) d.fill(1024);
    this.posDecoders.fill(1024);
    this.posAlignDecoder.fill(1024);
    this.lenLow.fill(1024);
    this.lenMid.fill(1024);
    this.lenHigh.fill(1024);
    this.repLenLow.fill(1024);
    this.repLenMid.fill(1024);
    this.repLenHigh.fill(1024);
    this.lenChoice1.fill(1024);
    this.lenChoice2.fill(1024);
    this.repLenChoice1.fill(1024);
    this.repLenChoice2.fill(1024);
    const numLitContexts = 1 << (this.lc + this.lp);
    this.litProbs = new Uint16Array(numLitContexts * 0x300).fill(1024);
  }

  setProps(propByte: number): void {
    let d = propByte;
    this.lc = d % 9;
    d = Math.floor(d / 9);
    this.lp = d % 5;
    this.pb = Math.floor(d / 5);
    this.resetProbs();
  }

  decode(input: Buffer): Buffer {
    let inPos = 0;
    while (inPos < input.length && this.outPos < this.unpackSize) {
      const control = input[inPos++];
      if (control === 0) break;

      if (control === 1 || control === 2) {
        if (control === 1) {
          this.dictStart = this.outPos;
          this.rep0 = 0;
          this.rep1 = 0;
          this.rep2 = 0;
          this.rep3 = 0;
          this.state = 0;
        }
        if (inPos + 2 > input.length) {
          throw new ConversionFailedError('Truncated uncompressed chunk in LZMA2');
        }
        const chunkSize = ((input[inPos++] << 8) | input[inPos++]) + 1;
        if (inPos + chunkSize > input.length) {
          throw new ConversionFailedError('Truncated uncompressed payload in LZMA2');
        }
        input.copy(this.outBuf, this.outPos, inPos, inPos + chunkSize);
        this.outPos += chunkSize;
        inPos += chunkSize;
      } else if (control >= 0x80) {
        if (inPos + 4 > input.length) {
          throw new ConversionFailedError('Truncated LZMA header in LZMA2');
        }
        const chunkUnpackSize = (((control & 0x1f) << 16) | (input[inPos++] << 8) | input[inPos++]) + 1;
        const chunkPackSize = ((input[inPos++] << 8) | input[inPos++]) + 1;
        const mode = (control >> 5) & 3;

        if (mode === 3) {
          if (inPos >= input.length) throw new ConversionFailedError('Missing LZMA2 property byte');
          const propByte = input[inPos++];
          this.setProps(propByte);
          this.state = 0;
          this.rep0 = 0;
          this.rep1 = 0;
          this.rep2 = 0;
          this.rep3 = 0;
          this.dictStart = this.outPos;
        } else if (mode === 2) {
          this.resetProbs();
          this.state = 0;
        } else if (mode === 1) {
          this.state = 0;
        }

        if (inPos + chunkPackSize > input.length) {
          throw new ConversionFailedError('Truncated LZMA chunk payload in LZMA2');
        }
        const chunkData = input.subarray(inPos, inPos + chunkPackSize);
        inPos += chunkPackSize;

        this.decodeLzmaChunk(chunkData, chunkUnpackSize);
      } else {
        throw new ConversionFailedError(`Invalid LZMA2 control byte: 0x${control.toString(16)}`);
      }
    }
    return this.outBuf.subarray(0, this.outPos);
  }

  private decodeLzmaChunk(chunkData: Buffer, chunkUnpackSize: number): void {
    if (chunkData.length < 5) {
      throw new ConversionFailedError('Truncated LZMA range coder header');
    }
    let rcPos = 0;
    let range = 0xffffffff;
    let code = 0;
    rcPos++; // Discard leading byte (0x00) of LZMA range coder stream
    code = (
      ((chunkData[rcPos++] << 24) |
        (chunkData[rcPos++] << 16) |
        (chunkData[rcPos++] << 8) |
        chunkData[rcPos++]) >>>
      0
    );

    const decodeBit = (probs: Uint16Array, index: number): number => {
      const prob = probs[index];
      const bound = (range >>> 11) * prob;
      if (code < bound) {
        range = bound >>> 0;
        probs[index] = (prob + ((2048 - prob) >>> 5)) & 0xffff;
        if (range < 0x01000000) {
          range = (range << 8) >>> 0;
          code = ((code << 8) | (chunkData[rcPos++] || 0)) >>> 0;
        }
        return 0;
      } else {
        range = (range - bound) >>> 0;
        code = (code - bound) >>> 0;
        probs[index] = (prob - (prob >>> 5)) & 0xffff;
        if (range < 0x01000000) {
          range = (range << 8) >>> 0;
          code = ((code << 8) | (chunkData[rcPos++] || 0)) >>> 0;
        }
        return 1;
      }
    };

    const decodeBitTree = (probs: Uint16Array, baseIndex: number, numBits: number): number => {
      let m = 1;
      for (let i = 0; i < numBits; i++) {
        m = (m << 1) | decodeBit(probs, baseIndex + m);
      }
      return m - (1 << numBits);
    };

    const decodeReverseBitTree = (probs: Uint16Array, offset: number, numBits: number): number => {
      let m = 1;
      let symbol = 0;
      for (let i = 0; i < numBits; i++) {
        const bit = decodeBit(probs, offset + m);
        m = (m << 1) | bit;
        symbol |= (bit << i);
      }
      return symbol;
    };

    const decodeLen = (
      choice1: Uint16Array,
      choice2: Uint16Array,
      low: Uint16Array,
      mid: Uint16Array,
      high: Uint16Array,
      posState: number
    ): number => {
      if (decodeBit(choice1, 0) === 0) return decodeBitTree(low, posState * 8, 3);
      if (decodeBit(choice2, 0) === 0) return 8 + decodeBitTree(mid, posState * 8, 3);
      return 16 + decodeBitTree(high, 0, 8);
    };

    const targetPos = Math.min(this.unpackSize, this.outPos + chunkUnpackSize);
    const posStateMask = (1 << this.pb) - 1;

    while (this.outPos < targetPos) {
      const posState = this.outPos & posStateMask;
      const isMatchIdx = (this.state << 4) + posState;

      if (decodeBit(this.isMatch, isMatchIdx) === 0) {
        const prevByte = this.outPos > this.dictStart ? this.outBuf[this.outPos - 1] : 0;
        const litContext = ((this.outPos & ((1 << this.lp) - 1)) << this.lc) | (prevByte >> (8 - this.lc));
        const baseIdx = litContext * 0x300;

        let symbol = 1;
        if (this.state >= 7) {
          let matchByte = (this.outPos - this.dictStart) > this.rep0 ? this.outBuf[this.outPos - this.rep0 - 1] : 0;
          let matchMode = true;
          while (symbol < 0x100) {
            matchByte <<= 1;
            const matchBit = (matchByte >> 8) & 1;
            const probIdx = matchMode ? baseIdx + 0x100 + (matchBit << 8) + symbol : baseIdx + symbol;
            const bit = decodeBit(this.litProbs, probIdx);
            symbol = (symbol << 1) | bit;
            if (matchMode && bit !== matchBit) matchMode = false;
          }
        } else {
          while (symbol < 0x100) {
            symbol = (symbol << 1) | decodeBit(this.litProbs, baseIdx + symbol);
          }
        }

        this.outBuf[this.outPos++] = (symbol - 0x100) & 0xff;
        if (this.state < 4) this.state = 0;
        else if (this.state < 10) this.state -= 3;
        else this.state -= 6;
      } else {
        let len = 0;
        if (decodeBit(this.isRep, this.state) === 1) {
          if (decodeBit(this.isRepG0, this.state) === 0) {
            if (decodeBit(this.isRep0Long, (this.state << 4) + posState) === 0) {
              this.state = this.state < 7 ? 9 : 11;
              if (this.rep0 >= (this.outPos - this.dictStart)) {
                throw new ConversionFailedError('Corrupted LZMA stream: rep distance exceeds available data');
              }
              this.outBuf[this.outPos] = this.outBuf[this.outPos - this.rep0 - 1];
              this.outPos++;
              continue;
            }
          } else {
            let dist = 0;
            if (decodeBit(this.isRepG1, this.state) === 0) {
              dist = this.rep1;
            } else {
              if (decodeBit(this.isRepG2, this.state) === 0) {
                dist = this.rep2;
              } else {
                dist = this.rep3;
                this.rep3 = this.rep2;
              }
              this.rep2 = this.rep1;
            }
            this.rep1 = this.rep0;
            this.rep0 = dist;
          }
          len = decodeLen(this.repLenChoice1, this.repLenChoice2, this.repLenLow, this.repLenMid, this.repLenHigh, posState);
          this.state = this.state < 7 ? 8 : 11;
        } else {
          this.rep3 = this.rep2;
          this.rep2 = this.rep1;
          this.rep1 = this.rep0;
          this.state = this.state < 7 ? 7 : 10;
          len = decodeLen(this.lenChoice1, this.lenChoice2, this.lenLow, this.lenMid, this.lenHigh, posState);
          const posSlot = decodeBitTree(this.posSlotDecoder[Math.min(len, 3)], 0, 6);
          if (posSlot >= 4) {
            const footerBits = (posSlot >> 1) - 1;
            let rep = (2 | (posSlot & 1)) << footerBits;
            if (posSlot < 14) {
              rep += decodeReverseBitTree(this.posDecoders, rep - posSlot - 1, footerBits);
            } else {
              const directBits = footerBits - 4;
              let directVal = 0;
              for (let i = 0; i < directBits; i++) {
                range = range >>> 1;
                code = (code - range) >>> 0;
                const t = (code >>> 31) & 1;
                if (t !== 0) code = (code + range) >>> 0;
                if (range < 0x01000000) {
                  range = (range << 8) >>> 0;
                  code = ((code << 8) | (chunkData[rcPos++] || 0)) >>> 0;
                }
                directVal = (directVal << 1) | (1 - t);
              }
              rep += (directVal << 4);
              rep += decodeReverseBitTree(this.posAlignDecoder, 0, 4);
            }
            this.rep0 = rep;
          } else {
            this.rep0 = posSlot;
          }

        }

        len += 2;
        if (this.rep0 >= (this.outPos - this.dictStart)) {
          throw new ConversionFailedError(
            `Corrupted LZMA stream: rep distance ${this.rep0} exceeds available decoded data (${this.outPos - this.dictStart})`
          );
        }

        const copyLen = Math.min(len, targetPos - this.outPos);
        for (let i = 0; i < copyLen; i++) {
          this.outBuf[this.outPos] = this.outBuf[this.outPos - this.rep0 - 1];
          this.outPos++;
        }
      }
    }
  }
}

/**
 * Decompress a single LZMA1 stream.
 */
export function decompressLzma(
  input: Buffer | Uint8Array,
  props?: Buffer | Uint8Array | number,
  unpackSize?: number
): Buffer {
  let effectiveSize = unpackSize ?? 0;
  let effectiveProps: Buffer | Uint8Array;
  if (typeof props === 'number') {
    effectiveSize = props;
    effectiveProps = Buffer.from([0x5d, 0, 0, 0, 0]);
  } else if (!props || props.length < 5) {
    effectiveProps = Buffer.from([0x5d, 0, 0, 0, 0]);
  } else {
    effectiveProps = props;
  }

  if (effectiveSize === 0) return Buffer.alloc(0);
  if (effectiveSize > MAX_UNCOMPRESSED_SIZE) {
    throw new DecompressionLimitError(
      `Archive bomb detected: unpack size (${effectiveSize}) exceeds limit of ${MAX_UNCOMPRESSED_SIZE} bytes`
    );
  }

  const d = effectiveProps[0];
  const lc = d % 9;
  const remainder = Math.floor(d / 9);
  const lp = remainder % 5;
  const pb = Math.floor(remainder / 5);

  let dictSize =
    ((effectiveProps[1] |
      (effectiveProps[2] << 8) |
      (effectiveProps[3] << 16) |
      (effectiveProps[4] << 24)) >>>
      0);
  if (dictSize < 4096) dictSize = 4096;

  const outBuf = Buffer.alloc(effectiveSize);
  let outPos = 0;
  let inPos = 0;

  function readByte(): number {
    return inPos < input.length ? input[inPos++] : 0;
  }

  // LZMA range decoder header: first byte is 0 (or ignored), then 4 bytes of initial code
  readByte();
  let code =
    (((readByte() << 24) |
      (readByte() << 16) |
      (readByte() << 8) |
      readByte()) >>>
      0);
  let range = 0xffffffff;

  function decodeBit(probs: Uint16Array, index: number): number {
    const prob = probs[index];
    const bound = (range >>> 11) * prob;
    if ((code >>> 0) < (bound >>> 0)) {
      range = bound >>> 0;
      probs[index] = (prob + ((2048 - prob) >>> 5)) & 0xffff;
      if (range < 0x01000000) {
        code = (((code << 8) | readByte()) >>> 0);
        range = ((range << 8) >>> 0);
      }
      return 0;
    } else {
      range = ((range - bound) >>> 0);
      code = ((code - bound) >>> 0);
      probs[index] = (prob - (prob >>> 5)) & 0xffff;
      if (range < 0x01000000) {
        code = (((code << 8) | readByte()) >>> 0);
        range = ((range << 8) >>> 0);
      }
      return 1;
    }
  }

  function decodeDirectBits(numBits: number): number {
    let res = 0;
    for (let i = 0; i < numBits; i++) {
      range >>>= 1;
      code = ((code - range) >>> 0);
      const t = (code >> 31) & 1;
      if (t !== 0) {
        code = ((code + range) >>> 0);
      }
      if (range < 0x01000000) {
        code = (((code << 8) | readByte()) >>> 0);
        range = ((range << 8) >>> 0);
      }
      res = (res << 1) | (1 - t);
    }
    return res >>> 0;
  }

  function decodeBitTree(probs: Uint16Array, offset: number, numBits: number): number {
    let m = 1;
    for (let i = 0; i < numBits; i++) {
      m = (m << 1) | decodeBit(probs, offset + m);
    }
    return m - (1 << numBits);
  }

  function decodeReverseBitTree(probs: Uint16Array, offset: number, numBits: number): number {
    let m = 1;
    let symbol = 0;
    for (let i = 0; i < numBits; i++) {
      const bit = decodeBit(probs, offset + m);
      m = (m << 1) | bit;
      symbol |= (bit << i);
    }
    return symbol;
  }

  const isMatch = new Uint16Array(12 * 16).fill(1024);
  const isRep = new Uint16Array(12).fill(1024);
  const isRepG0 = new Uint16Array(12).fill(1024);
  const isRepG1 = new Uint16Array(12).fill(1024);
  const isRepG2 = new Uint16Array(12).fill(1024);
  const isRep0Long = new Uint16Array(12 * 16).fill(1024);
  const posSlot = new Uint16Array(4 * 64).fill(1024);
  const specPos = new Uint16Array(128).fill(1024);
  const align = new Uint16Array(16).fill(1024);

  class LenDecoder {
    choice1 = new Uint16Array(1).fill(1024);
    choice2 = new Uint16Array(1).fill(1024);
    low = new Uint16Array(16 * 8).fill(1024);
    mid = new Uint16Array(16 * 8).fill(1024);
    high = new Uint16Array(256).fill(1024);

    decode(posState: number): number {
      if (decodeBit(this.choice1, 0) === 0) {
        return decodeBitTree(this.low, posState * 8, 3);
      }
      if (decodeBit(this.choice2, 0) === 0) {
        return 8 + decodeBitTree(this.mid, posState * 8, 3);
      }
      return 16 + decodeBitTree(this.high, 0, 8);
    }
  }

  const lenDecoder = new LenDecoder();
  const repLenDecoder = new LenDecoder();

  const numLitContexts = 1 << (lc + lp);
  const litProbs = new Uint16Array(numLitContexts * 0x300).fill(1024);

  let state = 0;
  let rep0 = 0;
  let rep1 = 0;
  let rep2 = 0;
  let rep3 = 0;

  const posStateMask = (1 << pb) - 1;

  while (outPos < effectiveSize) {
    const posState = outPos & posStateMask;
    const isMatchIdx = (state << 4) + posState;

    if (decodeBit(isMatch, isMatchIdx) === 0) {
      const prevByte = outPos > 0 ? outBuf[outPos - 1] : 0;
      const litContext = (((outPos & ((1 << lp) - 1)) << lc) | (prevByte >> (8 - lc)));
      const baseIdx = litContext * 0x300;

      let symbol = 1;
      if (state >= 7) {
        let matchByte = outPos > rep0 ? outBuf[outPos - rep0 - 1] : 0;
        let matchMode = true;
        while (symbol < 0x100) {
          matchByte <<= 1;
          const matchBit = (matchByte >> 8) & 1;
          const probIdx = matchMode
            ? baseIdx + 0x100 + (matchBit << 8) + symbol
            : baseIdx + symbol;
          const bit = decodeBit(litProbs, probIdx);
          symbol = (symbol << 1) | bit;
          if (matchMode && bit !== matchBit) {
            matchMode = false;
          }
        }
      } else {
        while (symbol < 0x100) {
          symbol = (symbol << 1) | decodeBit(litProbs, baseIdx + symbol);
        }
      }

      outBuf[outPos++] = (symbol - 0x100) & 0xff;
      if (state < 4) {
        state = 0;
      } else if (state < 10) {
        state -= 3;
      } else {
        state -= 6;
      }
    } else {
      let len = 0;
      if (decodeBit(isRep, state) === 1) {
        if (decodeBit(isRepG0, state) === 0) {
          if (decodeBit(isRep0Long, (state << 4) + posState) === 0) {
            state = state < 7 ? 9 : 11;
            if (rep0 >= outPos) {
              throw new ConversionFailedError('Corrupted LZMA stream: rep distance exceeds available data');
            }
            outBuf[outPos] = outBuf[outPos - rep0 - 1];
            outPos++;
            continue;
          }
        } else {
          let dist = 0;
          if (decodeBit(isRepG1, state) === 0) {
            dist = rep1;
          } else {
            if (decodeBit(isRepG2, state) === 0) {
              dist = rep2;
            } else {
              dist = rep3;
              rep3 = rep2;
            }
            rep2 = rep1;
          }
          rep1 = rep0;
          rep0 = dist;
        }
        len = repLenDecoder.decode(posState) + 2;
        state = state < 7 ? 8 : 11;
      } else {
        rep3 = rep2;
        rep2 = rep1;
        rep1 = rep0;
        len = lenDecoder.decode(posState) + 2;
        state = state < 7 ? 7 : 10;

        const lenToPosState = Math.min(len - 2, 3);
        const slot = decodeBitTree(posSlot, lenToPosState * 64, 6);
        if (slot >= 4) {
          const numDirectBits = (slot >> 1) - 1;
          rep0 = ((2 | (slot & 1)) << numDirectBits);
          if (slot < 14) {
            rep0 += decodeReverseBitTree(specPos, rep0 - slot - 1, numDirectBits);
          } else {
            rep0 += (decodeDirectBits(numDirectBits - 4) << 4);
            rep0 += decodeReverseBitTree(align, 0, 4);
          }
        } else {
          rep0 = slot;
        }
        if (rep0 === 0xffffffff) {
          break;
        }
      }

      if (rep0 >= outPos) {
        throw new ConversionFailedError(`Corrupted LZMA stream: rep distance ${rep0} exceeds available data (${outPos})`);
      }

      const copyLen = Math.min(len, effectiveSize - outPos);
      for (let i = 0; i < copyLen; i++) {
        outBuf[outPos] = outBuf[outPos - rep0 - 1];
        outPos++;
      }
    }
  }

  return outBuf.subarray(0, outPos);
}


/**
 * Decompress LZMA2 stream.
 */
export function decompressLzma2(
  input: Buffer | Uint8Array,
  propsOrUnpackSize?: Buffer | Uint8Array | number,
  unpackSize?: number
): Buffer {
  let effectiveSize: number;
  if (typeof propsOrUnpackSize === 'number') {
    effectiveSize = propsOrUnpackSize;
  } else if (unpackSize !== undefined) {
    effectiveSize = unpackSize;
  } else {
    effectiveSize = 64 * 1024 * 1024;
  }

  if (effectiveSize === 0) return Buffer.alloc(0);
  if (effectiveSize > MAX_UNCOMPRESSED_SIZE) {
    throw new DecompressionLimitError(
      `Archive bomb detected: unpack size (${effectiveSize}) exceeds limit of ${MAX_UNCOMPRESSED_SIZE} bytes`
    );
  }

  const decoder = new Lzma2StreamDecoder(effectiveSize);
  return decoder.decode(Buffer.from(input));
}

