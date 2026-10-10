import zlib from 'node:zlib';
import { CorruptStreamError, DecompressionLimitError, UnsupportedArchiveMethodError } from '../types';
import { decompressBzip2 } from './bzip2';
import { decodeLzma, decodeLzma2 } from './lzma-decoder';
import { AesKeyCache, decryptSevenZipAes } from './archive-sevenzip-aes';
import {
  decodeArm,
  decodeArm64,
  decodeArmThumb,
  decodeBcj2,
  decodeDelta,
  decodeIa64,
  decodePowerPc,
  decodeSparc,
  decodeX86,
} from './archive-sevenzip-filters';
import { SevenZipStructureError, type SevenZipCoder, type SevenZipFolder, type SevenZipFolderDecoder } from './sevenzip-reader';

/**
 * Decodes a 7z folder by following its coder graph (7zFormat.txt): the folder's final output is the output of the one
 * coder no bind pair consumes, and each input of a coder is either the output of another coder (a bind pair) or one
 * of the folder's pack streams. Compressors, the AES coder and the branch, Delta and BCJ2 filters are decoded in
 * process. A method this engine does not decode is an UnsupportedArchiveMethodError that names the method id: the
 * packed bytes are never passed on as if they were the file.
 *
 * Every coder's declared output size has been bounded by the reader before this runs, and every decoder here is given
 * that size as its limit (not the archive-wide cap), so a stream that expands past what the header declared stops at
 * the declared size and fails as a corrupt stream instead of growing. The folder's graph is checked as a whole before
 * the first byte is decoded.
 */

const COPY = '00';
const DELTA = '03';
const LZMA = '030101';
const LZMA2 = '21';
const DEFLATE = '040108';
const DEFLATE64 = '040109';
const BZIP2 = '040202';
const AES = '06f10701';
const BCJ2 = '0303011b';
const BCJ2_STREAMS = 4;
const DELTA_PROPERTY_BYTES = 1;
const LZMA_PROPERTY_BYTES = 5;
const BRANCH_START_OFFSET_BYTES = 4;

type BranchFilter = (buffer: Uint8Array, startOffset: number) => void;

/** Branch converters by method id: the long ids 7-Zip writes first, then the one-byte ids of the newer scheme. */
const BRANCH_FILTERS = new Map<string, { name: string; apply: BranchFilter }>([
  ['03030103', { name: 'BCJ x86', apply: decodeX86 }],
  ['04', { name: 'BCJ x86', apply: decodeX86 }],
  ['03030205', { name: 'PPC', apply: decodePowerPc }],
  ['05', { name: 'PPC', apply: decodePowerPc }],
  ['03030401', { name: 'IA64', apply: decodeIa64 }],
  ['06', { name: 'IA64', apply: decodeIa64 }],
  ['03030501', { name: 'ARM', apply: decodeArm }],
  ['07', { name: 'ARM', apply: decodeArm }],
  ['03030701', { name: 'ARMT', apply: decodeArmThumb }],
  ['08', { name: 'ARMT', apply: decodeArmThumb }],
  ['03030805', { name: 'SPARC', apply: decodeSparc }],
  ['09', { name: 'SPARC', apply: decodeSparc }],
  ['0a', { name: 'ARM64', apply: decodeArm64 }],
]);

export interface SevenZipDecodeOptions {
  /** The password of the request; used by the AES coder only. */
  password?: string;
  /** Cap on any one decoded stream, bytes. */
  maxOutputBytes: number;
  /** The archive's AES keys. Shared by every folder of one read; created from `password` when absent. */
  keys?: AesKeyCache;
}

function unsupported(coder: SevenZipCoder, what: string): UnsupportedArchiveMethodError {
  return new UnsupportedArchiveMethodError(`Unsupported 7z compression method 0x${coder.codecId.toString('hex')}: ${what}`);
}

function corrupt(detail: string): CorruptStreamError {
  return new CorruptStreamError(`Corrupted 7z archive: ${detail}`);
}

/** A defect of the folder's structure, which no key can change. */
function structure(detail: string): SevenZipStructureError {
  return new SevenZipStructureError(`Corrupted 7z archive: ${detail}`);
}

/** A stream that would pass the size its coder declares is a header that lies, not a payload that is too large. */
function withinDeclaredSize<T>(what: string, size: number, decode: () => T): T {
  try {
    return decode();
  } catch (err) {
    if (err instanceof DecompressionLimitError) throw corrupt(`${what} holds more than the ${size} bytes its coder declares`);
    throw err;
  }
}

function requireSize(stream: Buffer, size: number, what: string): void {
  if (stream.length !== size) throw corrupt(`${what} holds ${stream.length} bytes where the header declares ${size}`);
}

function startOffsetOf(coder: SevenZipCoder, name: string): number {
  if (coder.properties.length === 0) return 0;
  if (coder.properties.length !== BRANCH_START_OFFSET_BYTES) throw unsupported(coder, `the ${name} filter has properties it does not define`);
  return coder.properties.readUInt32LE(0);
}

/** Runs one coder over its input streams. Filters work in place on their input, which nothing else reads. */
function runCoder(coder: SevenZipCoder, inputs: Buffer[], outputSize: number, options: SevenZipDecodeOptions, keys: AesKeyCache): Buffer {
  const method = coder.codecId.toString('hex');
  const expectedInputs = method === BCJ2 ? BCJ2_STREAMS : 1;
  if (coder.numInStreams !== expectedInputs) {
    throw unsupported(coder, `a coder with ${coder.numInStreams} input streams`);
  }
  const [input] = inputs;
  const branch = BRANCH_FILTERS.get(method);
  if (branch !== undefined) {
    const startOffset = startOffsetOf(coder, branch.name);
    requireSize(input, outputSize, `the ${branch.name} filter input`);
    branch.apply(input, startOffset);
    return input;
  }
  switch (method) {
    case COPY:
      requireSize(input, outputSize, 'a stored stream');
      return input;
    case DELTA:
      if (coder.properties.length !== DELTA_PROPERTY_BYTES) throw unsupported(coder, 'the Delta filter needs one property byte');
      requireSize(input, outputSize, 'the Delta filter input');
      decodeDelta(input, coder.properties[0] + 1);
      return input;
    case BCJ2:
      if (coder.properties.length !== 0) throw unsupported(coder, 'the BCJ2 filter has properties it does not define');
      return decodeBcj2({ main: inputs[0], call: inputs[1], jump: inputs[2], rangeCoder: inputs[3] }, outputSize);
    case LZMA: {
      if (coder.properties.length < LZMA_PROPERTY_BYTES) throw structure('the LZMA properties need 5 bytes');
      if (outputSize === 0) return Buffer.alloc(0);
      const out = decodeLzma(input, coder.properties, outputSize, outputSize);
      return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
    }
    case LZMA2: {
      const out = withinDeclaredSize('an LZMA2 stream', outputSize, () => decodeLzma2(input, outputSize, outputSize));
      return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
    }
    case DEFLATE:
      try {
        return zlib.inflateRawSync(input, { maxOutputLength: Math.max(1, outputSize) });
      } catch (err) {
        throw corrupt(`invalid Deflate stream (${err instanceof Error ? err.message : String(err)})`);
      }
    case BZIP2:
      return withinDeclaredSize('a BZip2 stream', outputSize, () => decompressBzip2(input, Math.min(Math.max(outputSize, 1), options.maxOutputBytes)));
    case AES:
      return decryptSevenZipAes(input, coder.properties, keys, outputSize);
    case DEFLATE64:
      throw unsupported(coder, 'Deflate64 is not decoded');
    default:
      throw unsupported(coder, 'the method is not decoded by this engine');
  }
}

/** The decoder to hand to the 7z reader. */
export function createSevenZipFolderDecoder(options: SevenZipDecodeOptions): SevenZipFolderDecoder {
  const keys = options.keys ?? new AesKeyCache(options.password);
  return (folder, packed) => decodeSevenZipFolder(folder, packed, options, keys);
}

/**
 * Checks the folder's coder graph as a whole before anything is decoded: each coder has one output stream (so output
 * stream i is coder i's), the main output names a coder, every input reads a packed stream or another coder, and the
 * coders reachable from the main output are all of them, each read once. Returns the first input stream index of each
 * coder.
 */
function validateGraph(folder: SevenZipFolder): number[] {
  folder.coders.forEach((coder) => {
    if (coder.numOutStreams !== 1) throw structure(`a coder with ${coder.numOutStreams} output streams`);
  });
  if (folder.mainOut >= folder.coders.length) throw structure('the main output names no coder');
  const firstInput: number[] = [];
  let inputCount = 0;
  for (const coder of folder.coders) {
    firstInput.push(inputCount);
    inputCount += coder.numInStreams;
  }
  const boundTo = new Map(folder.bindPairs.map((pair) => [pair.inIndex, pair.outIndex]));
  const packed = new Set(folder.packedInStreams);
  for (let inIndex = 0; inIndex < inputCount; inIndex += 1) {
    const source = boundTo.get(inIndex);
    if (source === undefined ? !packed.has(inIndex) : source >= folder.coders.length) {
      throw structure('a coder input reads neither another coder nor a packed stream');
    }
  }
  const state = new Array<'open' | 'busy' | 'done'>(folder.coders.length).fill('open');
  const visit = (coderIndex: number): void => {
    if (state[coderIndex] !== 'open') throw structure('the coder graph of a folder loops or reads an output twice');
    state[coderIndex] = 'busy';
    for (let index = 0; index < folder.coders[coderIndex].numInStreams; index += 1) {
      const source = boundTo.get(firstInput[coderIndex] + index);
      if (source !== undefined) visit(source);
    }
    state[coderIndex] = 'done';
  };
  visit(folder.mainOut);
  if (state.some((value) => value !== 'done')) throw structure('a coder of the folder feeds nothing');
  return firstInput;
}

function decodeSevenZipFolder(folder: SevenZipFolder, packed: Buffer[], options: SevenZipDecodeOptions, keys: AesKeyCache): Buffer {
  const firstInput = validateGraph(folder);
  const boundTo = new Map(folder.bindPairs.map((pair) => [pair.inIndex, pair.outIndex]));
  const packIndexOf = new Map(folder.packedInStreams.map((inIndex, index) => [inIndex, index]));

  // The graph is a tree of single-output coders (validated above), so each output is decoded once, inputs first.
  const decodeCoder = (coderIndex: number): Buffer => {
    const coder = folder.coders[coderIndex];
    const inputs: Buffer[] = [];
    for (let index = 0; index < coder.numInStreams; index += 1) {
      const inIndex = firstInput[coderIndex] + index;
      const source = boundTo.get(inIndex);
      inputs.push(source !== undefined ? decodeCoder(source) : packed[packIndexOf.get(inIndex) as number]);
    }
    return runCoder(coder, inputs, folder.outSizes[coderIndex], options, keys);
  };
  return decodeCoder(folder.mainOut);
}
