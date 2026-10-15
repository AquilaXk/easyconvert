import zlib from 'node:zlib';
import { number7z } from './seven-zip-craft';

/**
 * Byte-level 7z writer for folders with a chosen coder graph: several coders, bind pairs and packed streams, with
 * sizes and properties the header states exactly as given. 7-Zip would never write a hostile graph, a coder count past
 * its own limit or a key derivation of 2^30 rounds, so the hostile tests build them here. The archive holds one
 * file per folder, named by the caller, with no sub-streams table.
 */
const SIGNATURE = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
const START_HEADER_BYTES = 32;
const CODER_COMPLEX = 0x10;
const CODER_HAS_PROPERTIES = 0x20;
const ID_END = 0x00;
const ID_HEADER = 0x01;
const ID_MAIN_STREAMS_INFO = 0x04;
const ID_FILES_INFO = 0x05;
const ID_PACK_INFO = 0x06;
const ID_UNPACK_INFO = 0x07;
const ID_SIZE = 0x09;
const ID_CRC = 0x0a;
const ID_FOLDER = 0x0b;
const ID_CODERS_UNPACK_SIZE = 0x0c;
const ID_NAME = 0x11;

export interface CraftedCoder {
  /** The method id bytes, for example `[0x03, 0x03, 0x01, 0x1b]` for BCJ2. */
  id: number[];
  /** Streams read from the packed side; 1 when absent. A value other than 1 on either count writes a complex coder. */
  inStreams?: number;
  outStreams?: number;
  properties?: Buffer;
}

export interface CraftedFolder {
  coders: CraftedCoder[];
  /** `[inIndex, outIndex]`: the input stream `inIndex` is fed by the output stream `outIndex`. */
  bindPairs: [number, number][];
  /** The input streams that read packed data, in pack order. Written only when there is more than one. */
  packedInStreams?: number[];
  /** The stored pack streams of this folder, in pack order. */
  packStreams: Buffer[];
  /** The size of every output stream, in output-stream order. */
  outSizes: number[];
  /** The CRC-32 of the folder's final output, when the header should state one. */
  crc?: number;
  name: string;
}

function folderBytes(folder: CraftedFolder): Buffer {
  const parts: Buffer[] = [number7z(folder.coders.length)];
  for (const coder of folder.coders) {
    const complex = (coder.inStreams ?? 1) !== 1 || (coder.outStreams ?? 1) !== 1;
    const flags = coder.id.length | (complex ? CODER_COMPLEX : 0) | (coder.properties ? CODER_HAS_PROPERTIES : 0);
    parts.push(Buffer.from([flags, ...coder.id]));
    if (complex) parts.push(number7z(coder.inStreams ?? 1), number7z(coder.outStreams ?? 1));
    if (coder.properties) parts.push(number7z(coder.properties.length), coder.properties);
  }
  for (const [inIndex, outIndex] of folder.bindPairs) parts.push(number7z(inIndex), number7z(outIndex));
  if (folder.packStreams.length > 1) {
    for (const index of folder.packedInStreams ?? []) parts.push(number7z(index));
  }
  return Buffer.concat(parts);
}

export function craftFolderArchive(folders: CraftedFolder[]): Buffer {
  const packStreams = folders.flatMap((folder) => folder.packStreams);
  const parts: Buffer[] = [
    Buffer.from([ID_HEADER, ID_MAIN_STREAMS_INFO, ID_PACK_INFO]),
    number7z(0),
    number7z(packStreams.length),
    Buffer.from([ID_SIZE]),
    ...packStreams.map((stream) => number7z(stream.length)),
    Buffer.from([ID_END, ID_UNPACK_INFO, ID_FOLDER]),
    number7z(folders.length),
    Buffer.from([0]),
    ...folders.map(folderBytes),
    Buffer.from([ID_CODERS_UNPACK_SIZE]),
    ...folders.flatMap((folder) => folder.outSizes.map((size) => number7z(size))),
  ];
  if (folders.some((folder) => folder.crc !== undefined)) {
    // Not every folder has to state a CRC: the all-defined byte is 0 and a bit vector follows.
    const bits = Buffer.alloc(Math.ceil(folders.length / 8));
    folders.forEach((folder, index) => {
      if (folder.crc !== undefined) bits[index >> 3] |= 0x80 >> (index & 7);
    });
    parts.push(Buffer.from([ID_CRC, 0]), bits);
    for (const folder of folders) {
      if (folder.crc === undefined) continue;
      const word = Buffer.alloc(4);
      word.writeUInt32LE(folder.crc, 0);
      parts.push(word);
    }
  }
  parts.push(Buffer.from([ID_END, ID_END]));

  parts.push(Buffer.from([ID_FILES_INFO]), number7z(folders.length));
  const names = Buffer.concat([Buffer.from([0]), ...folders.map((folder) => Buffer.from(`${folder.name}\0`, 'utf16le'))]);
  parts.push(Buffer.from([ID_NAME]), number7z(names.length), names, Buffer.from([ID_END, ID_END]));

  const header = Buffer.concat(parts);
  const packed = Buffer.concat(packStreams);
  const startFields = Buffer.alloc(20);
  startFields.writeBigUInt64LE(BigInt(packed.length), 0);
  startFields.writeBigUInt64LE(BigInt(header.length), 8);
  startFields.writeUInt32LE(zlib.crc32(header), 16);
  const start = Buffer.alloc(START_HEADER_BYTES);
  SIGNATURE.copy(start, 0);
  start[7] = 4;
  start.writeUInt32LE(zlib.crc32(startFields), 8);
  startFields.copy(start, 12);
  return Buffer.concat([start, packed, header]);
}
