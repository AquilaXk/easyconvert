import { ConversionFailedError } from '../types';

/**
 * Classic Macintosh font containers: bare resource forks (.dfont) and MacBinary II/III
 * wrappers (.bin). Both only carry an ordinary SFNT font inside an 'sfnt' resource (or, for
 * MacBinary, occasionally in the data fork); this module locates that font with strict bounds
 * checks and hands the raw SFNT bytes back to the font engine.
 *
 * References: Inside Macintosh "More Macintosh Toolbox" (Resource Manager, resource file
 * format) and the MacBinary II / III specifications.
 *
 * Face selection: a suitcase can hold several 'sfnt' resources. The first one in resource-map
 * order (type list, then reference list order) is used. The conversion API has no face-index
 * option, so the choice is deterministic and stable.
 */

export type MacFontErrorKind = 'malformed' | 'bitmap-only' | 'no-font';

/** Typed failure for Mac font containers; extends ConversionFailedError so the API answers HTTP 400. */
export class MacFontContainerError extends ConversionFailedError {
  readonly kind: MacFontErrorKind;
  constructor(message: string, kind: MacFontErrorKind = 'malformed') {
    super(message);
    this.name = 'MacFontContainerError';
    this.kind = kind;
  }
}

/** sfntVersion values accepted for an SFNT font: TrueType 1.0, 'OTTO', Apple 'true', PostScript 'typ1'. */
export const SFNT_VERSION_TAGS: ReadonlySet<number> = new Set([0x00010000, 0x4f54544f, 0x74727565, 0x74797031]);

const SFNT_MIN_LENGTH = 12;

/** Whether the buffer starts with a recognised SFNT version tag. */
export function looksLikeSfnt(buffer: Buffer): boolean {
  return buffer.length >= SFNT_MIN_LENGTH && SFNT_VERSION_TAGS.has(buffer.readUInt32BE(0));
}

// --- Resource fork layout (all fields big-endian) ---
const FORK_HEADER_SIZE = 16;
const MAP_HEADER_SIZE = 28; // 16 byte header copy + next map handle + file ref + attributes + 2 offsets
const TYPE_LIST_COUNT_SIZE = 2;
const TYPE_ENTRY_SIZE = 8;
const REF_ENTRY_SIZE = 12;
const RESOURCE_LENGTH_PREFIX = 4;
const NO_NAME_OFFSET = 0xffff;
const EMPTY_TYPE_LIST = 0xffff;
const UINT24_MASK = 0x00ffffff;
/** Real font forks hold a handful of types and resources; larger counts are corrupt or hostile. */
const MAX_RESOURCE_TYPES = 1024;
const MAX_RESOURCE_REFERENCES = 16384;

const SFNT_TYPE = 'sfnt';
const BITMAP_FONT_TYPES: ReadonlySet<string> = new Set(['NFNT', 'FONT', 'FOND']);

// --- MacBinary layout ---
const MACBINARY_HEADER_SIZE = 128;
const MACBINARY_BLOCK = 128;
const MACBINARY_MAX_NAME_LENGTH = 63;
const MACBINARY_VERSION_OFFSET = 0;
const MACBINARY_NAME_LENGTH_OFFSET = 1;
const MACBINARY_ZERO_OFFSET_A = 74;
const MACBINARY_ZERO_OFFSET_B = 82;
const MACBINARY_DATA_LENGTH_OFFSET = 83;
const MACBINARY_RESOURCE_LENGTH_OFFSET = 87;
const MACBINARY_SECONDARY_LENGTH_OFFSET = 120;
const MACBINARY_WRITER_VERSION_OFFSET = 122;
const MACBINARY_MIN_VERSION_OFFSET = 123;
const MACBINARY_CRC_OFFSET = 124;
const MACBINARY_CRC_COVERAGE = 124;
const MACBINARY_II_VERSION = 129;

const CRC16_XMODEM_POLY = 0x1021;
const CRC16_MASK = 0xffff;
const CRC16_TOP_BIT = 0x8000;
const BITS_PER_BYTE = 8;

function malformed(message: string): MacFontContainerError {
  return new MacFontContainerError(message, 'malformed');
}

/** CRC-16/XMODEM (poly 0x1021, init 0) as used by the MacBinary II header. */
export function crc16Xmodem(data: Uint8Array): number {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte << BITS_PER_BYTE;
    for (let bit = 0; bit < BITS_PER_BYTE; bit++) {
      if ((crc & CRC16_TOP_BIT) !== 0) {
        crc = ((crc << 1) ^ CRC16_XMODEM_POLY) & CRC16_MASK;
      } else {
        crc = (crc << 1) & CRC16_MASK;
      }
    }
  }
  return crc;
}

export interface MacResource {
  type: string;
  id: number;
  /** Resource name from the name list, when the resource has one. */
  name?: string;
  /** Resource payload (without its 4-byte length prefix). */
  data: Buffer;
}

interface ByteRange {
  start: number;
  end: number;
}

function assertNoOverlap(ranges: ByteRange[], what: string): void {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start < sorted[i - 1].end) {
      throw malformed(`Invalid Macintosh resource fork: overlapping ${what}.`);
    }
  }
}

function readPascalName(map: Buffer, nameListOffset: number, nameOffset: number): string {
  const position = nameListOffset + nameOffset;
  if (position + 1 > map.length) {
    throw malformed('Invalid Macintosh resource fork: resource name offset is outside the resource map.');
  }
  const length = map.readUInt8(position);
  if (position + 1 + length > map.length) {
    throw malformed('Invalid Macintosh resource fork: resource name runs past the resource map.');
  }
  return map.toString('latin1', position + 1, position + 1 + length);
}

/**
 * Parses a Macintosh resource fork and returns every resource whose type is in `wantedTypes`
 * (all resources when omitted) in resource-map order, together with the set of resource types
 * present in the fork. Every offset and length is bounds-checked; overlapping reference lists
 * or resource data are rejected.
 */
export function parseResourceFork(
  fork: Buffer,
  wantedTypes?: ReadonlySet<string>
): { resources: MacResource[]; typesPresent: string[] } {
  if (fork.length < FORK_HEADER_SIZE + MAP_HEADER_SIZE) {
    throw malformed('Invalid Macintosh resource fork: truncated header.');
  }
  const dataOffset = fork.readUInt32BE(0);
  const mapOffset = fork.readUInt32BE(4);
  const dataLength = fork.readUInt32BE(8);
  const mapLength = fork.readUInt32BE(12);

  if (dataOffset < FORK_HEADER_SIZE || dataOffset + dataLength > fork.length) {
    throw malformed('Invalid Macintosh resource fork: resource data area is outside the file.');
  }
  if (mapLength < MAP_HEADER_SIZE + TYPE_LIST_COUNT_SIZE || mapOffset < FORK_HEADER_SIZE || mapOffset + mapLength > fork.length) {
    throw malformed('Invalid Macintosh resource fork: resource map is outside the file.');
  }
  const dataEnd = dataOffset + dataLength;
  const mapEnd = mapOffset + mapLength;
  if (dataOffset < mapEnd && mapOffset < dataEnd) {
    throw malformed('Invalid Macintosh resource fork: resource data area overlaps the resource map.');
  }

  const map = fork.subarray(mapOffset, mapEnd);
  const typeListOffset = map.readUInt16BE(24);
  const nameListOffset = map.readUInt16BE(26);
  if (typeListOffset < MAP_HEADER_SIZE || typeListOffset + TYPE_LIST_COUNT_SIZE > map.length) {
    throw malformed('Invalid Macintosh resource fork: type list offset is outside the resource map.');
  }
  if (nameListOffset > map.length) {
    throw malformed('Invalid Macintosh resource fork: name list offset is outside the resource map.');
  }

  const typeCountField = map.readUInt16BE(typeListOffset);
  const typeCount = typeCountField === EMPTY_TYPE_LIST ? 0 : typeCountField + 1;
  if (typeCount > MAX_RESOURCE_TYPES) {
    throw malformed(`Invalid Macintosh resource fork: implausible resource type count (${typeCount}).`);
  }
  const typeEntriesEnd = typeListOffset + TYPE_LIST_COUNT_SIZE + typeCount * TYPE_ENTRY_SIZE;
  if (typeEntriesEnd > map.length) {
    throw malformed('Invalid Macintosh resource fork: type list runs past the resource map.');
  }

  interface TypeEntry {
    type: string;
    refCount: number;
    refListStart: number;
  }
  const entries: TypeEntry[] = [];
  const refListRanges: ByteRange[] = [];
  let totalRefs = 0;
  for (let i = 0; i < typeCount; i++) {
    const entryOffset = typeListOffset + TYPE_LIST_COUNT_SIZE + i * TYPE_ENTRY_SIZE;
    const type = map.toString('latin1', entryOffset, entryOffset + 4);
    const refCount = map.readUInt16BE(entryOffset + 4) + 1;
    const refListStart = typeListOffset + map.readUInt16BE(entryOffset + 6);
    const refListEnd = refListStart + refCount * REF_ENTRY_SIZE;
    totalRefs += refCount;
    if (totalRefs > MAX_RESOURCE_REFERENCES) {
      throw malformed(`Invalid Macintosh resource fork: implausible resource count (more than ${MAX_RESOURCE_REFERENCES}).`);
    }
    if (refListStart < typeEntriesEnd) {
      throw malformed(`Invalid Macintosh resource fork: reference list of type '${type}' points into the type list.`);
    }
    if (refListEnd > map.length) {
      throw malformed(`Invalid Macintosh resource fork: reference list of type '${type}' runs past the resource map.`);
    }
    entries.push({ type, refCount, refListStart });
    refListRanges.push({ start: refListStart, end: refListEnd });
  }
  assertNoOverlap(refListRanges, 'reference lists');

  const resources: MacResource[] = [];
  const typesPresent: string[] = [];
  const dataRanges: ByteRange[] = [];
  const nameListStart = nameListOffset;
  for (const entry of entries) {
    if (!typesPresent.includes(entry.type)) typesPresent.push(entry.type);
    for (let r = 0; r < entry.refCount; r++) {
      const refOffset = entry.refListStart + r * REF_ENTRY_SIZE;
      const id = map.readInt16BE(refOffset);
      const nameOffset = map.readUInt16BE(refOffset + 2);
      const resourceOffset = map.readUInt32BE(refOffset + 4) & UINT24_MASK;

      if (resourceOffset + RESOURCE_LENGTH_PREFIX > dataLength) {
        throw malformed(`Invalid Macintosh resource fork: '${entry.type}' resource ${id} starts outside the data area.`);
      }
      const lengthPosition = dataOffset + resourceOffset;
      const length = fork.readUInt32BE(lengthPosition);
      const payloadStart = lengthPosition + RESOURCE_LENGTH_PREFIX;
      if (payloadStart + length > dataEnd) {
        throw malformed(`Invalid Macintosh resource fork: '${entry.type}' resource ${id} runs past the data area.`);
      }
      dataRanges.push({ start: lengthPosition, end: payloadStart + length });

      if (wantedTypes && !wantedTypes.has(entry.type)) continue;
      const resource: MacResource = {
        type: entry.type,
        id,
        data: fork.subarray(payloadStart, payloadStart + length),
      };
      if (nameOffset !== NO_NAME_OFFSET) {
        resource.name = readPascalName(map, nameListStart, nameOffset);
      }
      resources.push(resource);
    }
  }
  assertNoOverlap(dataRanges, 'resource data');

  return { resources, typesPresent };
}

/**
 * Extracts the first 'sfnt' resource (resource-map order) from a resource fork; a .dfont is exactly a bare resource fork stored in the data fork. Throws a typed
 * error for bitmap-only (NFNT/FONT/FOND) forks and for forks without any outline font.
 */
export function extractSfntFromResourceFork(fork: Buffer): Buffer {
  const { resources, typesPresent } = parseResourceFork(fork, new Set([SFNT_TYPE]));
  if (resources.length === 0) {
    throw noSfntError(typesPresent);
  }
  const sfnt = resources[0].data;
  if (!looksLikeSfnt(sfnt)) {
    throw malformed(`Invalid Macintosh resource fork: 'sfnt' resource ${resources[0].id} is not an SFNT font.`);
  }
  return Buffer.from(sfnt);
}

function noSfntError(typesPresent: string[]): MacFontContainerError {
  const hasBitmap = typesPresent.some((type) => BITMAP_FONT_TYPES.has(type));
  if (hasBitmap) {
    return new MacFontContainerError(
      `Unsupported Macintosh font: the resource fork only holds bitmap/FOND font resources (${typesPresent.join(', ')}) and no outline 'sfnt' resource to convert.`,
      'bitmap-only'
    );
  }
  const found = typesPresent.length > 0 ? typesPresent.join(', ') : 'none';
  return new MacFontContainerError(
    `Unsupported Macintosh font: the resource fork has no 'sfnt' font resource (resource types found: ${found}).`,
    'no-font'
  );
}

function roundUpToBlock(value: number): number {
  return Math.ceil(value / MACBINARY_BLOCK) * MACBINARY_BLOCK;
}

export interface MacBinaryForks {
  dataFork: Buffer;
  resourceFork: Buffer;
}

/**
 * Validates a MacBinary I/II/III header and returns the data and resource forks. MacBinary II/III
 * (writer version byte >= 129) must carry a matching CRC-16/XMODEM of header bytes 0..123; the
 * The MacBinary III 'mBIN' signature is optional and not required. Fork lengths must lie inside the file.
 */
export function parseMacBinary(buffer: Buffer): MacBinaryForks {
  if (buffer.length < MACBINARY_HEADER_SIZE) {
    throw malformed('Invalid MacBinary file: truncated 128-byte header.');
  }
  if (buffer[MACBINARY_VERSION_OFFSET] !== 0 || buffer[MACBINARY_ZERO_OFFSET_A] !== 0 || buffer[MACBINARY_ZERO_OFFSET_B] !== 0) {
    throw malformed('Invalid MacBinary file: header zero bytes (0, 74, 82) are not zero.');
  }
  const nameLength = buffer[MACBINARY_NAME_LENGTH_OFFSET];
  if (nameLength < 1 || nameLength > MACBINARY_MAX_NAME_LENGTH) {
    throw malformed(`Invalid MacBinary file: filename length ${nameLength} is outside 1..${MACBINARY_MAX_NAME_LENGTH}.`);
  }

  const writerVersion = buffer[MACBINARY_WRITER_VERSION_OFFSET];
  const secondaryLength = buffer.readUInt16BE(MACBINARY_SECONDARY_LENGTH_OFFSET);
  if (writerVersion >= MACBINARY_II_VERSION) {
    const expectedCrc = buffer.readUInt16BE(MACBINARY_CRC_OFFSET);
    const actualCrc = crc16Xmodem(buffer.subarray(0, MACBINARY_CRC_COVERAGE));
    if (expectedCrc !== actualCrc) {
      throw malformed('Invalid MacBinary file: header CRC-16 mismatch.');
    }
  } else if (writerVersion !== 0 || buffer[MACBINARY_MIN_VERSION_OFFSET] !== 0 || secondaryLength !== 0) {
    throw malformed('Invalid MacBinary file: unrecognised header version.');
  }

  const dataLength = buffer.readUInt32BE(MACBINARY_DATA_LENGTH_OFFSET);
  const resourceLength = buffer.readUInt32BE(MACBINARY_RESOURCE_LENGTH_OFFSET);

  const dataStart = MACBINARY_HEADER_SIZE + roundUpToBlock(secondaryLength);
  const dataEnd = dataStart + dataLength;
  const resourceStart = dataStart + roundUpToBlock(dataLength);
  const resourceEnd = resourceStart + resourceLength;
  if (dataStart > buffer.length || dataEnd > buffer.length || resourceEnd > buffer.length) {
    throw malformed('Invalid MacBinary file: fork lengths run past the end of the file.');
  }
  return {
    dataFork: buffer.subarray(dataStart, dataEnd),
    resourceFork: buffer.subarray(resourceStart, resourceEnd),
  };
}

/**
 * Extracts the SFNT font from a MacBinary file: the first 'sfnt' resource of the resource fork,
 * or, when the resource fork carries no 'sfnt', an SFNT stored directly in the data fork.
 */
export function extractSfntFromMacBinary(buffer: Buffer): Buffer {
  const { dataFork, resourceFork } = parseMacBinary(buffer);
  if (resourceFork.length > 0) {
    const { resources, typesPresent } = parseResourceFork(resourceFork, new Set([SFNT_TYPE]));
    if (resources.length > 0) {
      const sfnt = resources[0].data;
      if (!looksLikeSfnt(sfnt)) {
        throw malformed(`Invalid Macintosh resource fork: 'sfnt' resource ${resources[0].id} is not an SFNT font.`);
      }
      return Buffer.from(sfnt);
    }
    if (looksLikeSfnt(dataFork)) return Buffer.from(dataFork);
    throw noSfntError(typesPresent);
  }
  if (looksLikeSfnt(dataFork)) return Buffer.from(dataFork);
  throw new MacFontContainerError(
    'Unsupported MacBinary file: neither the resource fork nor the data fork contains an SFNT font.',
    'no-font'
  );
}
