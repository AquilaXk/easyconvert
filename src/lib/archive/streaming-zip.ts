/**
 * Pure streaming STORE (uncompressed) ZIP 4.5 + ZIP64 generator.
 *
 * Ported and adapted from Touffy/client-zip (commit f16ccbebda27f70ef0d89cbbcebd6064f9daa02a, src/zip.ts)
 * Licensed under MIT License:
 * Copyright (c) 2020 Touffy
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 */

const LOCAL_HEADER_SIG = 0x04034b50;
const DATA_DESCRIPTOR_SIG = 0x08074b50;
const CENTRAL_HEADER_SIG = 0x02014b50;
const END_OF_CENTRAL_DIR_SIG = 0x06054b50;
const ZIP64_END_OF_CENTRAL_DIR_SIG = 0x06064b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;

const LOCAL_HEADER_LENGTH = 30;
const CENTRAL_HEADER_LENGTH = 46;
const END_OF_CENTRAL_DIR_LENGTH = 22;
const ZIP64_END_LENGTH = 56;
const ZIP64_LOCATOR_LENGTH = 20;

const UINT32_MAX = 0xffffffffn;
const UINT16_MAX = 0xffffn;

const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC32_TABLE[i] = c >>> 0;
}

export function crc32(data: Uint8Array, previous = 0): number {
  let crc = (previous ^ -1) >>> 0;
  for (let i = 0; i < data.length; i++) {
    crc = (CRC32_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ -1) >>> 0;
}

function formatDosDateTime(date: Date = new Date()): { time: number; date: number } {
  const year = date.getFullYear();
  const dosYear = year < 1980 ? 0 : year - 1980;
  const dosDate = ((dosYear & 0x7f) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  return { time: dosTime, date: dosDate };
}

export type StreamingZipInput =
  | Uint8Array
  | ArrayBuffer
  | Blob
  | ReadableStream<Uint8Array>
  | AsyncIterable<Uint8Array>
  | Iterable<Uint8Array>;

export interface StreamingZipEntry {
  name: string;
  data: StreamingZipInput;
  size?: number | bigint;
  date?: Date;
  mode?: number;
}

interface CentralDirectoryEntry {
  encodedName: Uint8Array;
  crc: number;
  size: bigint;
  offset: bigint;
  dosTime: number;
  dosDate: number;
  mode: number;
  zip64ExtraSize: 0 | 12 | 28;
}

const textEncoder = new TextEncoder();

function createDataView(byteLength: number): { bytes: Uint8Array; view: DataView } {
  const buffer = new ArrayBuffer(byteLength);
  return { bytes: new Uint8Array(buffer), view: new DataView(buffer) };
}

function buildLocalFileHeader(encodedName: Uint8Array, dosTime: number, dosDate: number): Uint8Array {
  const { bytes, view } = createDataView(LOCAL_HEADER_LENGTH);
  view.setUint32(0, LOCAL_HEADER_SIG, true);
  view.setUint16(4, 45, true); // ZIP version 4.5
  view.setUint16(6, 0x0808, true); // Bit 3 (data descriptor) + Bit 11 (UTF-8 name)
  view.setUint16(8, 0, true); // STORE method (no compression)
  view.setUint16(10, dosTime, true);
  view.setUint16(12, dosDate, true);
  view.setUint32(14, 0, true); // CRC zeroed for streaming descriptor
  view.setUint32(18, 0, true); // Compressed size zeroed
  view.setUint32(22, 0, true); // Uncompressed size zeroed
  view.setUint16(26, encodedName.length, true);
  view.setUint16(28, 0, true); // Extra field length zeroed
  return bytes;
}

function buildDataDescriptor(crc: number, size: bigint, isZip64: boolean): Uint8Array {
  if (isZip64) {
    const { bytes, view } = createDataView(24);
    view.setUint32(0, DATA_DESCRIPTOR_SIG, true);
    view.setUint32(4, crc, true);
    view.setBigUint64(8, size, true);
    view.setBigUint64(16, size, true);
    return bytes;
  }
  const { bytes, view } = createDataView(16);
  view.setUint32(0, DATA_DESCRIPTOR_SIG, true);
  view.setUint32(4, crc, true);
  view.setUint32(8, Number(size) >>> 0, true);
  view.setUint32(12, Number(size) >>> 0, true);
  return bytes;
}

function buildZip64Extra(entry: CentralDirectoryEntry): Uint8Array {
  const { bytes, view } = createDataView(entry.zip64ExtraSize);
  view.setUint16(0, 0x0001, true); // Tag: ZIP64
  view.setUint16(2, entry.zip64ExtraSize - 4, true);
  if (entry.zip64ExtraSize === 28) {
    view.setBigUint64(4, entry.size, true);
    view.setBigUint64(12, entry.size, true);
    view.setBigUint64(20, entry.offset, true);
  } else {
    view.setBigUint64(4, entry.offset, true);
  }
  return bytes;
}

function buildCentralDirectoryHeader(entry: CentralDirectoryEntry): Uint8Array {
  const { bytes, view } = createDataView(CENTRAL_HEADER_LENGTH);
  view.setUint32(0, CENTRAL_HEADER_SIG, true);
  view.setUint16(4, 0x032d, true); // UNIX system (3) | ZIP 4.5 (45)
  view.setUint16(6, 45, true); // ZIP version needed: 4.5
  view.setUint16(8, 0x0808, true); // Bit 3 + Bit 11
  view.setUint16(10, 0, true); // STORE
  view.setUint16(12, entry.dosTime, true);
  view.setUint16(14, entry.dosDate, true);
  view.setUint32(16, entry.crc, true);
  view.setUint32(20, entry.size >= UINT32_MAX ? 0xffffffff : Number(entry.size) >>> 0, true);
  view.setUint32(24, entry.size >= UINT32_MAX ? 0xffffffff : Number(entry.size) >>> 0, true);
  view.setUint16(28, entry.encodedName.length, true);
  view.setUint16(30, entry.zip64ExtraSize, true);
  view.setUint16(32, 0, true); // Comment length
  view.setUint16(34, 0, true); // Disk start
  view.setUint16(36, 0, true); // Internal attributes
  view.setUint32(38, ((entry.mode || 0o100644) << 16) >>> 0, true); // External attributes
  view.setUint32(42, entry.offset >= UINT32_MAX ? 0xffffffff : Number(entry.offset) >>> 0, true);
  return bytes;
}

function buildZip64EndOfCentralDir(fileCount: bigint, centralSize: bigint, offset: bigint): Uint8Array {
  const { bytes, view } = createDataView(ZIP64_END_LENGTH + ZIP64_LOCATOR_LENGTH);
  view.setUint32(0, ZIP64_END_OF_CENTRAL_DIR_SIG, true);
  view.setBigUint64(4, BigInt(ZIP64_END_LENGTH - 12), true);
  view.setUint16(12, 0x032d, true); // Version made by
  view.setUint16(14, 45, true); // Version needed: 4.5
  view.setUint32(16, 0, true); // Number of this disk
  view.setUint32(20, 0, true); // Disk with central dir
  view.setBigUint64(24, fileCount, true);
  view.setBigUint64(32, fileCount, true);
  view.setBigUint64(40, centralSize, true);
  view.setBigUint64(48, offset, true);

  view.setUint32(56, ZIP64_LOCATOR_SIG, true);
  view.setUint32(60, 0, true); // Disk with Zip64 end
  view.setBigUint64(64, offset + centralSize, true);
  view.setUint32(72, 1, true); // Total disks
  return bytes;
}

function buildEndOfCentralDirectory(fileCount: bigint, centralSize: bigint, offset: bigint): Uint8Array {
  const { bytes, view } = createDataView(END_OF_CENTRAL_DIR_LENGTH);
  view.setUint32(0, END_OF_CENTRAL_DIR_SIG, true);
  view.setUint16(4, 0, true); // Disk number
  view.setUint16(6, 0, true); // Disk with central directory
  view.setUint16(8, fileCount >= UINT16_MAX ? 0xffff : Number(fileCount), true);
  view.setUint16(10, fileCount >= UINT16_MAX ? 0xffff : Number(fileCount), true);
  view.setUint32(12, centralSize >= UINT32_MAX ? 0xffffffff : Number(centralSize) >>> 0, true);
  view.setUint32(16, offset >= UINT32_MAX ? 0xffffffff : Number(offset) >>> 0, true);
  view.setUint16(20, 0, true); // Comment length
  return bytes;
}

async function* iterateInputChunks(data: StreamingZipInput): AsyncGenerator<Uint8Array, void, undefined> {
  if (data instanceof Uint8Array) {
    if (data.byteLength > 0) yield data;
    return;
  }
  if (data instanceof ArrayBuffer) {
    if (data.byteLength > 0) yield new Uint8Array(data);
    return;
  }
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    if (typeof data.stream === 'function') {
      const stream = data.stream();
      yield* iterateInputChunks(stream);
      return;
    }
    const buf = await data.arrayBuffer();
    if (buf.byteLength > 0) yield new Uint8Array(buf);
    return;
  }
  if ('getReader' in data && typeof data.getReader === 'function') {
    const reader = data.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) yield value;
      }
    } finally {
      reader.releaseLock();
    }
    return;
  }
  if (Symbol.asyncIterator in data) {
    for await (const chunk of data as AsyncIterable<Uint8Array>) {
      if (chunk && chunk.byteLength > 0) yield chunk;
    }
    return;
  }
  if (Symbol.iterator in data) {
    for (const chunk of data as Iterable<Uint8Array>) {
      if (chunk && chunk.byteLength > 0) yield chunk;
    }
  }
}

function resolveZip64ExtraSize(size: bigint, offset: bigint): 0 | 12 | 28 {
  const bigFile = size >= UINT32_MAX;
  const bigOffset = offset >= UINT32_MAX;
  if (bigFile) return 28;
  if (bigOffset) return 12;
  return 0;
}

export async function* streamZip(
  entries: Iterable<StreamingZipEntry> | AsyncIterable<StreamingZipEntry>
): AsyncGenerator<Uint8Array, void, undefined> {
  const centralEntries: CentralDirectoryEntry[] = [];
  let currentOffset = 0n;
  let fileCount = 0n;
  let archiveNeedsZip64 = false;

  for await (const entry of entries) {
    const encodedName = textEncoder.encode(entry.name.replace(/\\/g, '/'));
    const { time: dosTime, date: dosDate } = formatDosDateTime(entry.date);
    const entryStartOffset = currentOffset;

    yield buildLocalFileHeader(encodedName, dosTime, dosDate);
    yield encodedName;
    currentOffset += BigInt(LOCAL_HEADER_LENGTH + encodedName.length);

    let entryCrc = 0;
    let entrySize = 0n;
    for await (const chunk of iterateInputChunks(entry.data)) {
      yield chunk;
      entryCrc = crc32(chunk, entryCrc);
      entrySize += BigInt(chunk.byteLength);
    }
    currentOffset += entrySize;

    const isZip64Entry = entrySize >= UINT32_MAX;
    if (isZip64Entry) archiveNeedsZip64 = true;

    const descriptor = buildDataDescriptor(entryCrc, entrySize, isZip64Entry);
    yield descriptor;
    currentOffset += BigInt(descriptor.length);

    const zip64ExtraSize = resolveZip64ExtraSize(entrySize, entryStartOffset);
    if (zip64ExtraSize > 0) archiveNeedsZip64 = true;

    centralEntries.push({
      encodedName,
      crc: entryCrc,
      size: entrySize,
      offset: entryStartOffset,
      dosTime,
      dosDate,
      mode: entry.mode ?? 0o100644,
      zip64ExtraSize,
    });
    fileCount += 1n;
  }

  const centralDirStartOffset = currentOffset;
  let centralDirSize = 0n;

  for (const entry of centralEntries) {
    const header = buildCentralDirectoryHeader(entry);
    yield header;
    yield entry.encodedName;
    centralDirSize += BigInt(header.length + entry.encodedName.length);

    if (entry.zip64ExtraSize > 0) {
      const extra = buildZip64Extra(entry);
      yield extra;
      centralDirSize += BigInt(extra.length);
    }
  }

  const needsZip64Summary =
    archiveNeedsZip64 ||
    currentOffset >= UINT32_MAX ||
    centralDirStartOffset >= UINT32_MAX ||
    centralDirSize >= UINT32_MAX ||
    fileCount >= UINT16_MAX;

  if (needsZip64Summary) {
    yield buildZip64EndOfCentralDir(fileCount, centralDirSize, centralDirStartOffset);
  }

  yield buildEndOfCentralDirectory(fileCount, centralDirSize, centralDirStartOffset);
}

export function streamZipReadable(
  entries: Iterable<StreamingZipEntry> | AsyncIterable<StreamingZipEntry>
): ReadableStream<Uint8Array> {
  const iterator = streamZip(entries);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) {
          controller.close();
        } else {
          controller.enqueue(next.value);
        }
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}
