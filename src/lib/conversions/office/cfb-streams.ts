import { isCfbfContainer, parseCfbf } from '../hwp';
import { LegacyOfficeFormatError } from './legacy-office-errors';

/** Largest compound file the legacy readers accept; everything is held in memory while parsing. */
export const LEGACY_OFFICE_MAX_INPUT_BYTES = 256 * 1024 * 1024;

/** Most directory entries (storages and streams) a compound file may declare before it is refused. */
export const CFB_MAX_DIRECTORY_ENTRIES = 65_536;

// [MS-CFB] 2.2 header fields: byte order mark, major version and sector shifts.
const CFB_MAJOR_VERSION_OFFSET = 26;
const CFB_BYTE_ORDER_OFFSET = 28;
const CFB_SECTOR_SHIFT_OFFSET = 30;
const CFB_MINI_SECTOR_SHIFT_OFFSET = 32;
const CFB_LITTLE_ENDIAN_MARK = 0xfffe;
const CFB_MAJOR_VERSION_3 = 3;
const CFB_MAJOR_VERSION_4 = 4;
const CFB_SECTOR_SHIFT_V3 = 9;
const CFB_SECTOR_SHIFT_V4 = 12;
const CFB_MINI_SECTOR_SHIFT = 6;

function assertCfbHeader(buffer: Buffer, label: string): void {
  const version = buffer.readUInt16LE(CFB_MAJOR_VERSION_OFFSET);
  const sectorShift = buffer.readUInt16LE(CFB_SECTOR_SHIFT_OFFSET);
  const versionMatchesShift =
    (version === CFB_MAJOR_VERSION_3 && sectorShift === CFB_SECTOR_SHIFT_V3) ||
    (version === CFB_MAJOR_VERSION_4 && sectorShift === CFB_SECTOR_SHIFT_V4);
  if (
    buffer.readUInt16LE(CFB_BYTE_ORDER_OFFSET) !== CFB_LITTLE_ENDIAN_MARK ||
    buffer.readUInt16LE(CFB_MINI_SECTOR_SHIFT_OFFSET) !== CFB_MINI_SECTOR_SHIFT ||
    !versionMatchesShift
  ) {
    throw new LegacyOfficeFormatError(`${label}: the compound file header is invalid.`);
  }
}

/**
 * Opens an OLE2 compound file ([MS-CFB]) and returns its streams by name. A file that is not a compound
 * file, has an inconsistent header, declares too many directory entries or cannot be walked throws a
 * LegacyOfficeFormatError; no failure escapes as an untyped error.
 */
export function readCfbStreams(buffer: Buffer, label: string): ReadonlyMap<string, Buffer> {
  if (buffer.length > LEGACY_OFFICE_MAX_INPUT_BYTES) {
    throw new LegacyOfficeFormatError(`${label}: the file exceeds the ${LEGACY_OFFICE_MAX_INPUT_BYTES}-byte limit.`);
  }
  if (!isCfbfContainer(buffer)) {
    throw new LegacyOfficeFormatError(`${label}: the file is not an OLE2 compound file.`);
  }
  assertCfbHeader(buffer, label);
  try {
    const container = parseCfbf(buffer);
    if (container.directoryEntries.length > CFB_MAX_DIRECTORY_ENTRIES) {
      throw new LegacyOfficeFormatError(`${label}: the compound file declares more than ${CFB_MAX_DIRECTORY_ENTRIES} directory entries.`);
    }
    return container.streams;
  } catch (err) {
    if (err instanceof LegacyOfficeFormatError) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    throw new LegacyOfficeFormatError(`${label}: the compound file is malformed (${reason}).`);
  }
}

/** Returns a named stream, or throws when the compound file does not hold it. */
export function requireCfbStream(streams: ReadonlyMap<string, Buffer>, name: string, label: string): Buffer {
  const stream = streams.get(name);
  if (!stream) {
    throw new LegacyOfficeFormatError(`${label}: the required "${name}" stream is missing.`);
  }
  return stream;
}

/** Bounds-checked little-endian reads: an offset past the end of the data throws a typed error. */
export class CheckedReader {
  constructor(
    private readonly data: Buffer,
    private readonly label: string
  ) {}

  get length(): number {
    return this.data.length;
  }

  private assertRange(offset: number, size: number): void {
    if (!Number.isInteger(offset) || offset < 0 || offset + size > this.data.length) {
      throw new LegacyOfficeFormatError(`${this.label}: a read of ${size} byte(s) at offset ${offset} is outside the ${this.data.length}-byte stream.`);
    }
  }

  u8(offset: number): number {
    this.assertRange(offset, 1);
    return this.data[offset];
  }

  u16(offset: number): number {
    this.assertRange(offset, 2);
    return this.data.readUInt16LE(offset);
  }

  u32(offset: number): number {
    this.assertRange(offset, 4);
    return this.data.readUInt32LE(offset);
  }

  slice(offset: number, size: number): Buffer {
    this.assertRange(offset, size);
    return this.data.subarray(offset, offset + size);
  }
}
