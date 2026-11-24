/**
 * Pure streaming STORE (uncompressed) ZIP 4.5 + ZIP64 generator.
 *
 * Ported and adapted from Touffy/client-zip (commit f16ccbebda27f70ef0d89cbbcebd6064f9daa02a, src/zip.ts)
 * Licensed under the MIT License:
 * Copyright 2020 David Junger
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

const LOCAL_HEADER_SIG = 0x04034b50;
const DATA_DESCRIPTOR_SIG = 0x08074b50;
const CENTRAL_HEADER_SIG = 0x02014b50;
const END_OF_CENTRAL_DIR_SIG = 0x06054b50;
const ZIP64_END_OF_CENTRAL_DIR_SIG = 0x06064b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;

const ZIP64_EXTRA_TAG = 0x0001;
const LOCAL_HEADER_LENGTH = 30;
const LOCAL_ZIP64_EXTRA_LENGTH = 20;
const CENTRAL_HEADER_LENGTH = 46;
const END_OF_CENTRAL_DIR_LENGTH = 22;
const ZIP64_END_LENGTH = 56;
const ZIP64_LOCATOR_LENGTH = 20;

const VERSION_DEFAULT = 20;
const VERSION_ZIP64 = 45;
const HOST_UNIX = 3;
const FLAGS_DATA_DESCRIPTOR_UTF8 = 0x0808;
const DEFAULT_FILE_MODE = 0o100644;

const UINT32_MAX = 0xffffffffn;
const UINT16_MAX = 0xffffn;
const UINT64_MAX = 0xffffffffffffffffn;

/** Maximum UTF-8 encoded length of a ZIP entry path per PKWARE APPNOTE 4.4.10. */
export const MAX_ZIP_ENTRY_NAME_BYTES = 0xffff;
/** Maximum entry count buffered for the streaming ZIP central directory (matches ZIP_WRITER_MAX_ENTRIES). */
export const MAX_STREAMING_ZIP_ENTRIES = 262_144;

const WINDOWS_DRIVE_PREFIX = /^[A-Za-z]:(?:\/|$)/;

function buildCrc32Tables(): readonly Uint32Array[] {
  const tables = Array.from({ length: 8 }, () => new Uint32Array(256));
  const t0 = tables[0];
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t0[i] = c >>> 0;
  }
  for (let t = 1; t < 8; t++) {
    const prev = tables[t - 1];
    const curr = tables[t];
    for (let i = 0; i < 256; i++) {
      curr[i] = (t0[prev[i] & 0xff] ^ (prev[i] >>> 8)) >>> 0;
    }
  }
  return tables;
}

const CRC32_TABLES = buildCrc32Tables();

/** Compute standard ISO 3309 / PKZIP CRC-32 across arbitrarily aligned Uint8Array chunks using Slicing-by-8. */
export function crc32(data: Uint8Array, previous = 0): number {
  let crc = (previous ^ -1) >>> 0;
  const len = data.byteLength;
  const end8 = len - 7;
  const [t0, t1, t2, t3, t4, t5, t6, t7] = CRC32_TABLES;
  let i = 0;

  while (i < end8) {
    const lo =
      (crc ^ (data[i] | (data[i + 1] << 8) | (data[i + 2] << 16) | (data[i + 3] << 24))) >>> 0;
    const hi =
      (data[i + 4] | (data[i + 5] << 8) | (data[i + 6] << 16) | (data[i + 7] << 24)) >>> 0;
    crc =
      (t7[lo & 0xff] ^
        t6[(lo >>> 8) & 0xff] ^
        t5[(lo >>> 16) & 0xff] ^
        t4[lo >>> 24] ^
        t3[hi & 0xff] ^
        t2[(hi >>> 8) & 0xff] ^
        t1[(hi >>> 16) & 0xff] ^
        t0[hi >>> 24]) >>>
      0;
    i += 8;
  }

  while (i < len) {
    crc = (t0[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
    i++;
  }
  return (crc ^ -1) >>> 0;
}

function formatDosDateTime(date: Date = new Date()): { time: number; date: number } {
  const year = date.getFullYear();
  const dosYear = Math.min(127, Math.max(0, year - 1980));
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
  sizesInZip64: boolean;
  offsetInZip64: boolean;
  zip64ExtraSize: 0 | 12 | 20 | 28;
}

const textEncoder = new TextEncoder();

function createDataView(byteLength: number): { bytes: Uint8Array; view: DataView } {
  const buffer = new ArrayBuffer(byteLength);
  return { bytes: new Uint8Array(buffer), view: new DataView(buffer) };
}

/** Validate and UTF-8 encode a relative archive entry name, rejecting Zip Slip paths and > 65,535-byte names. */
function encodeSafeEntryName(rawName: string): Uint8Array {
  if (typeof rawName !== 'string' || rawName.length === 0) {
    throw new RangeError('ZIP entry name must be a non-empty string.');
  }
  if (rawName.includes('\0')) {
    throw new RangeError('ZIP entry name cannot contain NUL bytes.');
  }
  const normalized = rawName.replace(/\\/g, '/');
  if (normalized.startsWith('/') || WINDOWS_DRIVE_PREFIX.test(normalized)) {
    throw new RangeError(`ZIP entry name must be a relative path: "${rawName.slice(0, 64)}"`);
  }
  const withoutTrailingSlash = normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
  if (
    withoutTrailingSlash.length === 0 ||
    withoutTrailingSlash.split('/').some((seg) => seg.length === 0 || seg === '.' || seg === '..')
  ) {
    throw new RangeError(`ZIP entry name contains unsafe path segments: "${rawName.slice(0, 64)}"`);
  }
  const encoded = textEncoder.encode(normalized);
  if (encoded.byteLength > MAX_ZIP_ENTRY_NAME_BYTES) {
    throw new RangeError(
      `ZIP entry name exceeds ${MAX_ZIP_ENTRY_NAME_BYTES} UTF-8 bytes (got ${encoded.byteLength}).`
    );
  }
  return encoded;
}

/** Resolve declared or intrinsic entry byte size when known up front; streams/iterables without `size` return undefined. */
function resolveKnownEntrySize(entry: StreamingZipEntry): bigint | undefined {
  if (entry.size !== undefined) {
    if (typeof entry.size === 'bigint') {
      if (entry.size < 0n || entry.size > UINT64_MAX) {
        throw new RangeError(`Invalid ZIP entry size: ${entry.size}`);
      }
      return entry.size;
    }
    if (typeof entry.size !== 'number' || !Number.isSafeInteger(entry.size) || entry.size < 0) {
      throw new RangeError(`Invalid ZIP entry size: ${String(entry.size)}`);
    }
    return BigInt(entry.size);
  }
  if (entry.data instanceof Uint8Array || entry.data instanceof ArrayBuffer) {
    return BigInt(entry.data.byteLength);
  }
  if (typeof Blob !== 'undefined' && entry.data instanceof Blob) {
    if (typeof entry.data.size === 'number' && Number.isSafeInteger(entry.data.size) && entry.data.size >= 0) {
      return BigInt(entry.data.size);
    }
  }
  return undefined;
}

function buildLocalFileHeader(
  encodedName: Uint8Array,
  dosTime: number,
  dosDate: number,
  localZip64: boolean
): Uint8Array {
  const { bytes, view } = createDataView(LOCAL_HEADER_LENGTH);
  view.setUint32(0, LOCAL_HEADER_SIG, true);
  view.setUint16(4, localZip64 ? VERSION_ZIP64 : VERSION_DEFAULT, true);
  view.setUint16(6, FLAGS_DATA_DESCRIPTOR_UTF8, true); // Bit 3 (data descriptor) + Bit 11 (UTF-8 name)
  view.setUint16(8, 0, true); // STORE method (no compression)
  view.setUint16(10, dosTime, true);
  view.setUint16(12, dosDate, true);
  view.setUint32(14, 0, true); // CRC follows in data descriptor
  // Set 32-bit size fields to 0xffffffff when ZIP64 so extractors inspect the 24-byte 64-bit data descriptor.
  view.setUint32(18, localZip64 ? 0xffffffff : 0, true);
  view.setUint32(22, localZip64 ? 0xffffffff : 0, true);
  view.setUint16(26, encodedName.byteLength, true);
  view.setUint16(28, localZip64 ? LOCAL_ZIP64_EXTRA_LENGTH : 0, true);
  return bytes;
}

/** 20-byte LFH 0x0001 extra field matching APPNOTE 4.3.9.2 / 4.5.3 with zeroed sizes under bit-3 data descriptor. */
function buildLocalZip64Extra(): Uint8Array {
  const { bytes, view } = createDataView(LOCAL_ZIP64_EXTRA_LENGTH);
  view.setUint16(0, ZIP64_EXTRA_TAG, true);
  view.setUint16(2, 16, true);
  view.setBigUint64(4, 0n, true);
  view.setBigUint64(12, 0n, true);
  return bytes;
}

function buildDataDescriptor(crc: number, size: bigint, localZip64: boolean): Uint8Array {
  if (localZip64) {
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
  view.setUint16(0, ZIP64_EXTRA_TAG, true);
  view.setUint16(2, entry.zip64ExtraSize - 4, true);
  let cursor = 4;
  if (entry.sizesInZip64) {
    view.setBigUint64(cursor, entry.size, true);
    view.setBigUint64(cursor + 8, entry.size, true);
    cursor += 16;
  }
  if (entry.offsetInZip64) {
    view.setBigUint64(cursor, entry.offset, true);
  }
  return bytes;
}

function buildCentralDirectoryHeader(entry: CentralDirectoryEntry): Uint8Array {
  const { bytes, view } = createDataView(CENTRAL_HEADER_LENGTH);
  const versionNeeded = entry.zip64ExtraSize > 0 ? VERSION_ZIP64 : VERSION_DEFAULT;
  view.setUint32(0, CENTRAL_HEADER_SIG, true);
  view.setUint16(4, (HOST_UNIX << 8) | versionNeeded, true);
  view.setUint16(6, versionNeeded, true);
  view.setUint16(8, FLAGS_DATA_DESCRIPTOR_UTF8, true);
  view.setUint16(10, 0, true); // STORE
  view.setUint16(12, entry.dosTime, true);
  view.setUint16(14, entry.dosDate, true);
  view.setUint32(16, entry.crc, true);
  view.setUint32(20, entry.sizesInZip64 ? 0xffffffff : Number(entry.size) >>> 0, true);
  view.setUint32(24, entry.sizesInZip64 ? 0xffffffff : Number(entry.size) >>> 0, true);
  view.setUint16(28, entry.encodedName.byteLength, true);
  view.setUint16(30, entry.zip64ExtraSize, true);
  view.setUint16(32, 0, true); // Comment length
  view.setUint16(34, 0, true); // Disk start
  view.setUint16(36, 0, true); // Internal attributes
  view.setUint32(38, ((entry.mode || DEFAULT_FILE_MODE) << 16) >>> 0, true);
  view.setUint32(42, entry.offsetInZip64 ? 0xffffffff : Number(entry.offset) >>> 0, true);
  return bytes;
}

function buildZip64EndOfCentralDir(fileCount: bigint, centralSize: bigint, offset: bigint): Uint8Array {
  const { bytes, view } = createDataView(ZIP64_END_LENGTH + ZIP64_LOCATOR_LENGTH);
  view.setUint32(0, ZIP64_END_OF_CENTRAL_DIR_SIG, true);
  view.setBigUint64(4, BigInt(ZIP64_END_LENGTH - 12), true);
  view.setUint16(12, (HOST_UNIX << 8) | VERSION_ZIP64, true);
  view.setUint16(14, VERSION_ZIP64, true);
  view.setUint32(16, 0, true);
  view.setUint32(20, 0, true);
  view.setBigUint64(24, fileCount, true);
  view.setBigUint64(32, fileCount, true);
  view.setBigUint64(40, centralSize, true);
  view.setBigUint64(48, offset, true);

  view.setUint32(56, ZIP64_LOCATOR_SIG, true);
  view.setUint32(60, 0, true);
  view.setBigUint64(64, offset + centralSize, true);
  view.setUint32(72, 1, true);
  return bytes;
}

function buildEndOfCentralDirectory(fileCount: bigint, centralSize: bigint, offset: bigint): Uint8Array {
  const { bytes, view } = createDataView(END_OF_CENTRAL_DIR_LENGTH);
  view.setUint32(0, END_OF_CENTRAL_DIR_SIG, true);
  view.setUint16(4, 0, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, fileCount >= UINT16_MAX ? 0xffff : Number(fileCount), true);
  view.setUint16(10, fileCount >= UINT16_MAX ? 0xffff : Number(fileCount), true);
  view.setUint32(12, centralSize >= UINT32_MAX ? 0xffffffff : Number(centralSize) >>> 0, true);
  view.setUint32(16, offset >= UINT32_MAX ? 0xffffffff : Number(offset) >>> 0, true);
  view.setUint16(20, 0, true);
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
      yield* iterateInputChunks(data.stream());
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

function resolveCentralZip64ExtraSize(sizesInZip64: boolean, offsetInZip64: boolean): 0 | 12 | 20 | 28 {
  if (sizesInZip64 && offsetInZip64) return 28;
  if (sizesInZip64) return 20;
  if (offsetInZip64) return 12;
  return 0;
}

/** Stream STORE ZIP / ZIP64 chunks incrementally with bounded central-directory memory and APPNOTE-compliant headers. */
export async function* streamZip(
  entries: Iterable<StreamingZipEntry> | AsyncIterable<StreamingZipEntry>
): AsyncGenerator<Uint8Array, void, undefined> {
  const centralEntries: CentralDirectoryEntry[] = [];
  let currentOffset = 0n;
  let fileCount = 0n;

  for await (const entry of entries) {
    if (centralEntries.length >= MAX_STREAMING_ZIP_ENTRIES) {
      throw new RangeError(`ZIP entry count exceeds ${MAX_STREAMING_ZIP_ENTRIES} limit.`);
    }
    const encodedName = encodeSafeEntryName(entry.name);
    const knownSize = resolveKnownEntrySize(entry);
    // Unsize-declared streams and >= 4 GiB-1 entries require ZIP64 local headers so extractors expect a 24-byte DD.
    const localZip64 = knownSize === undefined || knownSize >= UINT32_MAX;
    const { time: dosTime, date: dosDate } = formatDosDateTime(entry.date);
    const entryStartOffset = currentOffset;

    yield buildLocalFileHeader(encodedName, dosTime, dosDate, localZip64);
    yield encodedName;
    if (localZip64) {
      yield buildLocalZip64Extra();
      currentOffset += BigInt(LOCAL_HEADER_LENGTH + encodedName.byteLength + LOCAL_ZIP64_EXTRA_LENGTH);
    } else {
      currentOffset += BigInt(LOCAL_HEADER_LENGTH + encodedName.byteLength);
    }

    let entryCrc = 0;
    let entrySize = 0n;
    for await (const chunk of iterateInputChunks(entry.data)) {
      yield chunk;
      entryCrc = crc32(chunk, entryCrc);
      entrySize += BigInt(chunk.byteLength);
    }
    if (knownSize !== undefined && entrySize !== knownSize) {
      throw new RangeError(
        `ZIP entry "${entry.name.slice(0, 64)}" declared ${knownSize} bytes but produced ${entrySize}.`
      );
    }
    if (!localZip64 && entrySize >= UINT32_MAX) {
      throw new RangeError(
        `ZIP entry "${entry.name.slice(0, 64)}" outgrew its classic 32-bit local header.`
      );
    }
    currentOffset += entrySize;

    const descriptor = buildDataDescriptor(entryCrc, entrySize, localZip64);
    yield descriptor;
    currentOffset += BigInt(descriptor.byteLength);

    const sizesInZip64 = localZip64 || entrySize >= UINT32_MAX;
    const offsetInZip64 = entryStartOffset >= UINT32_MAX;
    const zip64ExtraSize = resolveCentralZip64ExtraSize(sizesInZip64, offsetInZip64);

    centralEntries.push({
      encodedName,
      crc: entryCrc,
      size: entrySize,
      offset: entryStartOffset,
      dosTime,
      dosDate,
      mode: entry.mode ?? DEFAULT_FILE_MODE,
      sizesInZip64,
      offsetInZip64,
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
    centralDirSize += BigInt(header.byteLength + entry.encodedName.byteLength);

    if (entry.zip64ExtraSize > 0) {
      const extra = buildZip64Extra(entry);
      yield extra;
      centralDirSize += BigInt(extra.byteLength);
    }
  }

  const needsZip64Summary =
    fileCount >= UINT16_MAX || centralDirSize >= UINT32_MAX || centralDirStartOffset >= UINT32_MAX;

  if (needsZip64Summary) {
    yield buildZip64EndOfCentralDir(fileCount, centralDirSize, centralDirStartOffset);
  }

  yield buildEndOfCentralDirectory(fileCount, centralDirSize, centralDirStartOffset);
}

/** Expose {@link streamZip} as a backpressure-driven Web ReadableStream. */
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
