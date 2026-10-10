import { CorruptStreamError } from '../types';

/**
 * The filters a 7z folder chains in front of its compressor (7zFormat.txt, "Branch" and "Delta" coders), in their
 * decoding direction. Each branch filter turns the absolute branch targets the encoder stored back into the relative
 * displacements of the original machine code; Delta undoes a running difference; BCJ2 merges four streams back into
 * x86 code. They are written from the published filter descriptions, work in place on a buffer the caller owns, and
 * touch every byte at most once, so their cost is linear in the folder's unpack size, which the caller has already
 * bounded.
 */

const BYTE_MASK = 0xff;
const WORD_BYTES = 4;
const BUNDLE_BYTES = 16;
const X86_MIN_BYTES = 5;

function isSignExtensionByte(byte: number): boolean {
  return byte === 0x00 || byte === 0xff;
}

/** Positions are 32-bit in every branch filter; a start offset or a position wraps like the encoder's counter did. */
function wrap32(value: number): number {
  return value >>> 0;
}

const X86_MASK_ALLOWED = [true, true, true, false, true, false, false, false];
const X86_MASK_BIT_NUMBER = [0, 1, 2, 2, 3, 3, 3, 3];
const X86_MASK_KEEP = 0x77;
const X86_MASK_FRESH_CALL = 0x10;
const X86_MAX_RECENT_GAP = 5;

/**
 * x86 BCJ: E8 (call) and E9 (jump) with a 32-bit displacement whose top byte is 00 or FF. The mask remembers which of
 * the previous bytes were opcodes, so an operand that looks like another call is left alone exactly where the encoder
 * left it alone.
 */
export function decodeX86(buffer: Uint8Array, startOffset = 0): void {
  if (buffer.length < X86_MIN_BYTES) return;
  let previousMask = 0;
  let previousPosition = wrap32(startOffset - X86_MIN_BYTES);
  const limit = buffer.length - X86_MIN_BYTES;
  let position = 0;
  while (position <= limit) {
    const opcode = buffer[position];
    if (opcode !== 0xe8 && opcode !== 0xe9) {
      position += 1;
      continue;
    }
    const here = wrap32(startOffset + position);
    const gap = wrap32(here - previousPosition);
    previousPosition = here;
    if (gap > X86_MAX_RECENT_GAP) {
      previousMask = 0;
    } else {
      for (let step = 0; step < gap; step += 1) {
        previousMask &= X86_MASK_KEEP;
        previousMask <<= 1;
      }
    }
    let top = buffer[position + 4];
    if (isSignExtensionByte(top) && X86_MASK_ALLOWED[(previousMask >>> 1) & 7] && previousMask >>> 1 < 0x10) {
      let source = wrap32((top << 24) | (buffer[position + 3] << 16) | (buffer[position + 2] << 8) | buffer[position + 1]);
      let destination = 0;
      for (;;) {
        destination = wrap32(source - (here + X86_MIN_BYTES));
        if (previousMask === 0) break;
        const bitNumber = X86_MASK_BIT_NUMBER[previousMask >>> 1];
        top = (destination >>> (24 - bitNumber * 8)) & BYTE_MASK;
        if (!isSignExtensionByte(top)) break;
        source = wrap32(destination ^ (2 ** (32 - bitNumber * 8) - 1));
      }
      buffer[position + 4] = ((destination >>> 24) & 1) === 1 ? 0xff : 0x00;
      buffer[position + 3] = (destination >>> 16) & BYTE_MASK;
      buffer[position + 2] = (destination >>> 8) & BYTE_MASK;
      buffer[position + 1] = destination & BYTE_MASK;
      position += X86_MIN_BYTES;
      previousMask = 0;
    } else {
      position += 1;
      previousMask |= 1;
      if (isSignExtensionByte(top)) previousMask |= X86_MASK_FRESH_CALL;
    }
  }
}

/** ARM (32-bit, little endian): BL, condition "always" (top byte EB), 24-bit word displacement relative to pc + 8. */
export function decodeArm(buffer: Uint8Array, startOffset = 0): void {
  for (let position = 0; position + WORD_BYTES <= buffer.length; position += WORD_BYTES) {
    if (buffer[position + 3] !== 0xeb) continue;
    const source = ((buffer[position + 2] << 16) | (buffer[position + 1] << 8) | buffer[position]) << 2;
    const destination = wrap32(source - wrap32(startOffset + position + 8)) >>> 2;
    buffer[position + 2] = (destination >>> 16) & BYTE_MASK;
    buffer[position + 1] = (destination >>> 8) & BYTE_MASK;
    buffer[position] = destination & BYTE_MASK;
  }
}

/** ARM Thumb: the two-halfword BL pair (F000 and F800 prefixes), 22-bit halfword displacement relative to pc + 4. */
export function decodeArmThumb(buffer: Uint8Array, startOffset = 0): void {
  for (let position = 0; position + WORD_BYTES <= buffer.length; position += 2) {
    if ((buffer[position + 1] & 0xf8) !== 0xf0 || (buffer[position + 3] & 0xf8) !== 0xf8) continue;
    const source =
      (((buffer[position + 1] & 7) << 19) | (buffer[position] << 11) | ((buffer[position + 3] & 7) << 8) | buffer[position + 2]) << 1;
    const destination = wrap32(source - wrap32(startOffset + position + 4)) >>> 1;
    buffer[position + 1] = 0xf0 | ((destination >>> 19) & 7);
    buffer[position] = (destination >>> 11) & BYTE_MASK;
    buffer[position + 3] = 0xf8 | ((destination >>> 8) & 7);
    buffer[position + 2] = destination & BYTE_MASK;
    position += 2;
  }
}

const ARM64_BL_OPCODE = 0x25;
const ARM64_BL_BASE = 0x94000000;
const ARM64_BL_DISPLACEMENT = 0x03ffffff;
const ARM64_ADRP_MASK = 0x9f000000;
const ARM64_ADRP_BASE = 0x90000000;
const ARM64_ADRP_KEEP = 0x9000001f;
const ARM64_ADRP_RANGE_MASK = 0x001c0000;
const ARM64_ADRP_RANGE_BIAS = 0x00020000;
const ARM64_ADRP_SIGN_BIT = 0x00020000;
const ARM64_ADRP_SIGN_FILL = 0x00e00000;

/** ARM64: BL with a 26-bit word displacement, and ADRP when its page offset lies within +-512 MiB (18-bit span). */
export function decodeArm64(buffer: Uint8Array, startOffset = 0): void {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  for (let position = 0; position + WORD_BYTES <= buffer.length; position += WORD_BYTES) {
    const counter = wrap32(startOffset + position);
    let instruction = view.getUint32(position, true);
    if (instruction >>> 26 === ARM64_BL_OPCODE) {
      const delta = wrap32(0 - (counter >>> 2));
      instruction = wrap32(ARM64_BL_BASE | ((instruction + delta) & ARM64_BL_DISPLACEMENT));
      view.setUint32(position, instruction, true);
    } else if (wrap32(instruction & ARM64_ADRP_MASK) === ARM64_ADRP_BASE) {
      const source = ((instruction >>> 29) & 3) | ((instruction >>> 3) & 0x001ffffc);
      if (((source + ARM64_ADRP_RANGE_BIAS) & ARM64_ADRP_RANGE_MASK) !== 0) continue;
      const destination = wrap32(source + wrap32(0 - (counter >>> 12)));
      instruction = wrap32(instruction & ARM64_ADRP_KEEP);
      instruction |= (destination & 3) << 29;
      instruction |= (destination & 0x0003fffc) << 3;
      instruction |= wrap32(0 - (destination & ARM64_ADRP_SIGN_BIT)) & ARM64_ADRP_SIGN_FILL;
      view.setUint32(position, wrap32(instruction), true);
    }
  }
}

/** PowerPC (big endian): the `bl` form of the I-branch (opcode 18, AA = 0, LK = 1), 24-bit word displacement. */
export function decodePowerPc(buffer: Uint8Array, startOffset = 0): void {
  for (let position = 0; position + WORD_BYTES <= buffer.length; position += WORD_BYTES) {
    if (buffer[position] >>> 2 !== 0x12 || (buffer[position + 3] & 3) !== 1) continue;
    const source = ((buffer[position] & 3) << 24) | (buffer[position + 1] << 16) | (buffer[position + 2] << 8) | (buffer[position + 3] & ~3 & BYTE_MASK);
    const destination = wrap32(source - wrap32(startOffset + position));
    buffer[position] = 0x48 | ((destination >>> 24) & 3);
    buffer[position + 1] = (destination >>> 16) & BYTE_MASK;
    buffer[position + 2] = (destination >>> 8) & BYTE_MASK;
    buffer[position + 3] = (buffer[position + 3] & 3) | (destination & BYTE_MASK);
  }
}

/** SPARC (big endian): `call` with a 30-bit word displacement that is a small sign-extended value (22 bits). */
export function decodeSparc(buffer: Uint8Array, startOffset = 0): void {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  for (let position = 0; position + WORD_BYTES <= buffer.length; position += WORD_BYTES) {
    const first = buffer[position];
    const second = buffer[position + 1];
    const isNearForward = first === 0x40 && (second & 0xc0) === 0x00;
    const isNearBackward = first === 0x7f && (second & 0xc0) === 0xc0;
    if (!isNearForward && !isNearBackward) continue;
    const source = wrap32(view.getUint32(position, false) << 2);
    let destination = wrap32(source - wrap32(startOffset + position)) >>> 2;
    destination = wrap32((wrap32(0 - ((destination >>> 22) & 1)) << 22) & 0x3fffffff) | (destination & 0x3fffff) | 0x40000000;
    view.setUint32(position, wrap32(destination), false);
  }
}

/** The slots of an IA-64 bundle that can hold a branch, by bundle template (low five bits of the first byte). */
const IA64_BRANCH_SLOTS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 4, 6, 6, 0, 0, 7, 7, 4, 4, 0, 0, 4, 4, 0, 0];
const IA64_SLOT_BITS = 41;
const IA64_FIRST_SLOT_BIT = 5;
const IA64_INSTRUCTION_BYTES = 6;

/** IA-64 (Itanium): IP-relative branches in the 128-bit bundles, 21-bit bundle displacement. */
export function decodeIa64(buffer: Uint8Array, startOffset = 0): void {
  for (let bundle = 0; bundle + BUNDLE_BYTES <= buffer.length; bundle += BUNDLE_BYTES) {
    const slots = IA64_BRANCH_SLOTS[buffer[bundle] & 0x1f];
    for (let slot = 0, bitPosition = IA64_FIRST_SLOT_BIT; slot < 3; slot += 1, bitPosition += IA64_SLOT_BITS) {
      if (((slots >>> slot) & 1) === 0) continue;
      const bytePosition = bundle + (bitPosition >>> 3);
      const bitShift = BigInt(bitPosition & 7);
      let instruction = 0n;
      for (let index = 0; index < IA64_INSTRUCTION_BYTES; index += 1) instruction |= BigInt(buffer[bytePosition + index]) << BigInt(8 * index);
      let normalized = instruction >> bitShift;
      if (((normalized >> 37n) & 0xfn) !== 0x5n || ((normalized >> 9n) & 0x7n) !== 0n) continue;
      let source = Number((normalized >> 13n) & 0xfffffn);
      source |= Number((normalized >> 36n) & 1n) << 20;
      source <<= 4;
      const destination = wrap32(source - wrap32(startOffset + bundle)) >>> 4;
      normalized &= ~(0x8fffffn << 13n);
      normalized |= BigInt(destination & 0xfffff) << 13n;
      normalized |= BigInt(destination & 0x100000) << 16n;
      instruction = (instruction & ((1n << bitShift) - 1n)) | (normalized << bitShift);
      for (let index = 0; index < IA64_INSTRUCTION_BYTES; index += 1) {
        buffer[bytePosition + index] = Number((instruction >> BigInt(8 * index)) & 0xffn);
      }
    }
  }
}

/** Delta: each byte stores its difference from the byte `distance` places earlier. */
export function decodeDelta(buffer: Uint8Array, distance: number): void {
  for (let position = distance; position < buffer.length; position += 1) {
    buffer[position] = (buffer[position] + buffer[position - distance]) & BYTE_MASK;
  }
}

const RANGE_TOP = 0x01000000;
const RANGE_PROBABILITY_BITS = 11;
const RANGE_PROBABILITY_ONE = 1 << RANGE_PROBABILITY_BITS;
const RANGE_MOVE_BITS = 5;
const RANGE_INITIAL_PROBABILITY = RANGE_PROBABILITY_ONE >>> 1;
const RANGE_INIT_BYTES = 5;
const BCJ2_JUMP_PROBABILITY = 1;
const BCJ2_CALL_PROBABILITIES = 2;
const BCJ2_PROBABILITY_COUNT = 2 + 256;
const BCJ2_ADDRESS_BYTES = 4;

export interface Bcj2Streams {
  /** The code with the converted branches' operands cut out. */
  main: Uint8Array;
  /** Big-endian absolute targets of the converted calls (E8). */
  call: Uint8Array;
  /** Big-endian absolute targets of the converted jumps (E9 and 0F 8x). */
  jump: Uint8Array;
  /** The range coder bits that say, for each branch opcode, whether its operand was converted. */
  rangeCoder: Uint8Array;
}

function bcj2Corrupt(detail: string): CorruptStreamError {
  return new CorruptStreamError(`Corrupted 7z archive: BCJ2 ${detail}`);
}

/**
 * BCJ2 (x86, four streams): the main stream holds the code with the 32-bit operands of converted CALL (E8), JMP (E9)
 * and Jcc (0F 80-8F) instructions removed; a range coder bit after each such opcode says whether the operand was
 * moved to the call or jump stream as an absolute address. Decoding restores the relative displacement.
 */
export function decodeBcj2(streams: Bcj2Streams, outputSize: number): Buffer {
  const { main, call, jump, rangeCoder } = streams;
  const output = Buffer.alloc(outputSize);
  if (rangeCoder.length < RANGE_INIT_BYTES) throw bcj2Corrupt('range coder stream is too short');
  if (rangeCoder[0] !== 0) throw bcj2Corrupt('range coder stream does not start with a zero byte');
  let code = ((rangeCoder[1] << 24) | (rangeCoder[2] << 16) | (rangeCoder[3] << 8) | rangeCoder[4]) >>> 0;
  if (code === 0xffffffff) throw bcj2Corrupt('range coder stream starts with an impossible value');
  let range = 0xffffffff;
  let rangePosition = RANGE_INIT_BYTES;
  const probabilities = new Uint16Array(BCJ2_PROBABILITY_COUNT).fill(RANGE_INITIAL_PROBABILITY);

  let mainPosition = 0;
  let callPosition = 0;
  let jumpPosition = 0;
  let outputPosition = 0;
  let previous = 0;
  while (outputPosition < outputSize) {
    if (mainPosition >= main.length) throw bcj2Corrupt('main stream ends before the declared size');
    const byte = main[mainPosition];
    mainPosition += 1;
    output[outputPosition] = byte;
    outputPosition += 1;
    const isBranch = (byte & 0xfe) === 0xe8 || (previous === 0x0f && (byte & 0xf0) === 0x80);
    if (!isBranch || outputPosition === outputSize) {
      previous = byte;
      continue;
    }

    const index = byte === 0xe8 ? BCJ2_CALL_PROBABILITIES + previous : byte === 0xe9 ? BCJ2_JUMP_PROBABILITY : 0;
    if (range < RANGE_TOP) {
      if (rangePosition >= rangeCoder.length) throw bcj2Corrupt('range coder stream ends early');
      range = (range << 8) >>> 0;
      code = ((code << 8) | rangeCoder[rangePosition]) >>> 0;
      rangePosition += 1;
    }
    const probability = probabilities[index];
    const bound = (range >>> RANGE_PROBABILITY_BITS) * probability;
    if (code < bound) {
      range = bound;
      probabilities[index] = probability + ((RANGE_PROBABILITY_ONE - probability) >>> RANGE_MOVE_BITS);
      previous = byte;
      continue;
    }
    range = (range - bound) >>> 0;
    code = (code - bound) >>> 0;
    probabilities[index] = probability - (probability >>> RANGE_MOVE_BITS);

    let target: number;
    if (byte === 0xe8) {
      if (callPosition + BCJ2_ADDRESS_BYTES > call.length) throw bcj2Corrupt('call stream ends early');
      target = Buffer.from(call.buffer, call.byteOffset + callPosition, BCJ2_ADDRESS_BYTES).readUInt32BE(0);
      callPosition += BCJ2_ADDRESS_BYTES;
    } else {
      if (jumpPosition + BCJ2_ADDRESS_BYTES > jump.length) throw bcj2Corrupt('jump stream ends early');
      target = Buffer.from(jump.buffer, jump.byteOffset + jumpPosition, BCJ2_ADDRESS_BYTES).readUInt32BE(0);
      jumpPosition += BCJ2_ADDRESS_BYTES;
    }
    const displacement = wrap32(target - wrap32(outputPosition + BCJ2_ADDRESS_BYTES));
    const remaining = outputSize - outputPosition;
    if (remaining < BCJ2_ADDRESS_BYTES) throw bcj2Corrupt('operand runs past the declared size');
    output.writeUInt32LE(displacement, outputPosition);
    outputPosition += BCJ2_ADDRESS_BYTES;
    previous = displacement >>> 24;
  }
  return output;
}
