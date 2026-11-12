/**
 * Reads and edits the EXIF block of a picture (a TIFF structure, CIPA DC-008). The field names are the ones ExifTool prints
 * (behaviour only: the tag numbers are those of the specification).
 *
 * An edit never rebuilds the block. The values and the entries it keeps stay at the offsets they have, so a MakerNote, a
 * thumbnail or a vendor block that points into the file keeps working; the changed directory is written again at the end of the
 * block with the new values after it, and the one pointer that names it is changed. The old directory stays as unused bytes.
 */

export type ExifValue = string | number | number[];

/** The groups of the report an EXIF directory belongs to: the picture's own tags, and the position the camera recorded. */
export type ExifGroup = 'EXIF' | 'GPS';

const TIFF_HEADER_BYTES = 8;
const TIFF_MAGIC = 42;
const ENTRY_BYTES = 12;
const MAX_ENTRIES = 1024;
const MAX_LIST_ITEMS = 16;
const MAX_TEXT_BYTES = 4096;
const WORD = 2;
const EXIF_PREFIX = 'Exif\0\0';
const USER_COMMENT_CHARSET = 'ASCII\0\0\0';

const TYPE_BYTE = 1;
const TYPE_ASCII = 2;
const TYPE_SHORT = 3;
const TYPE_LONG = 4;
const TYPE_RATIONAL = 5;
const TYPE_UNDEFINED = 7;
const TYPE_SSHORT = 8;
const TYPE_SLONG = 9;
const TYPE_SRATIONAL = 10;
const TYPE_SIZES: readonly number[] = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];

const TAG_EXIF_IFD = 0x8769;
const TAG_GPS_IFD = 0x8825;

interface TagInfo {
  name: string;
  /** The type an edit writes; reading accepts any type that decodes. */
  type: number;
  /** Whether an edit may set or remove the tag. */
  write?: true;
}

const IFD0_TAGS: Readonly<Record<number, TagInfo>> = {
  0x010e: { name: 'ImageDescription', type: TYPE_ASCII, write: true },
  0x010f: { name: 'Make', type: TYPE_ASCII, write: true },
  0x0110: { name: 'Model', type: TYPE_ASCII, write: true },
  0x0112: { name: 'Orientation', type: TYPE_SHORT, write: true },
  0x011a: { name: 'XResolution', type: TYPE_RATIONAL },
  0x011b: { name: 'YResolution', type: TYPE_RATIONAL },
  0x0128: { name: 'ResolutionUnit', type: TYPE_SHORT },
  0x0131: { name: 'Software', type: TYPE_ASCII, write: true },
  0x0132: { name: 'ModifyDate', type: TYPE_ASCII, write: true },
  0x013b: { name: 'Artist', type: TYPE_ASCII, write: true },
  0x8298: { name: 'Copyright', type: TYPE_ASCII, write: true },
};

const EXIF_IFD_TAGS: Readonly<Record<number, TagInfo>> = {
  0x829a: { name: 'ExposureTime', type: TYPE_RATIONAL },
  0x829d: { name: 'FNumber', type: TYPE_RATIONAL },
  0x8822: { name: 'ExposureProgram', type: TYPE_SHORT },
  0x8827: { name: 'ISO', type: TYPE_SHORT },
  0x9000: { name: 'ExifVersion', type: TYPE_UNDEFINED },
  0x9003: { name: 'DateTimeOriginal', type: TYPE_ASCII, write: true },
  0x9004: { name: 'CreateDate', type: TYPE_ASCII, write: true },
  0x9201: { name: 'ShutterSpeedValue', type: TYPE_SRATIONAL },
  0x9202: { name: 'ApertureValue', type: TYPE_RATIONAL },
  0x9204: { name: 'ExposureCompensation', type: TYPE_SRATIONAL },
  0x9207: { name: 'MeteringMode', type: TYPE_SHORT },
  0x9209: { name: 'Flash', type: TYPE_SHORT },
  0x920a: { name: 'FocalLength', type: TYPE_RATIONAL },
  0x9286: { name: 'UserComment', type: TYPE_UNDEFINED, write: true },
  0xa001: { name: 'ColorSpace', type: TYPE_SHORT },
  0xa002: { name: 'ExifImageWidth', type: TYPE_LONG },
  0xa003: { name: 'ExifImageHeight', type: TYPE_LONG },
  0xa402: { name: 'ExposureMode', type: TYPE_SHORT },
  0xa403: { name: 'WhiteBalance', type: TYPE_SHORT },
  0xa405: { name: 'FocalLengthIn35mmFormat', type: TYPE_SHORT },
  0xa420: { name: 'ImageUniqueID', type: TYPE_ASCII },
  0xa431: { name: 'SerialNumber', type: TYPE_ASCII, write: true },
  0xa433: { name: 'LensMake', type: TYPE_ASCII, write: true },
  0xa434: { name: 'LensModel', type: TYPE_ASCII, write: true },
};

const GPS_TAGS = { latitudeRef: 1, latitude: 2, longitudeRef: 3, longitude: 4, altitudeRef: 5, altitude: 6 } as const;

/** An EXIF block that cannot be read or edited: it is cut short, loops, or has a directory out of its limits. */
export class ExifFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExifFormatError';
  }
}

interface RawEntry {
  tag: number;
  type: number;
  count: number;
  /** The 4 bytes of the entry that hold the value, or the offset of the value. */
  field: Buffer;
}

interface Directory {
  entries: RawEntry[];
  next: number;
}

/** The TIFF block inside the bytes of an EXIF profile (with or without the `Exif\0\0` prefix), or null when none is there. */
export function tiffBlockOf(bytes: Buffer): Buffer | null {
  const block = bytes.toString('latin1', 0, EXIF_PREFIX.length) === EXIF_PREFIX ? bytes.subarray(EXIF_PREFIX.length) : bytes;
  if (block.length < TIFF_HEADER_BYTES) return null;
  const order = block.toString('latin1', 0, 2);
  if (order !== 'II' && order !== 'MM') return null;
  return new Tiff(block).u16(2) === TIFF_MAGIC ? block : null;
}

/** The bounds-checked view of a TIFF block in its byte order. */
class Tiff {
  readonly little: boolean;
  constructor(readonly bytes: Buffer) {
    this.little = bytes.toString('latin1', 0, 2) === 'II';
  }

  private need(at: number, length: number): void {
    if (at < 0 || at + length > this.bytes.length) throw new ExifFormatError('The EXIF block is cut short.');
  }

  u16(at: number): number {
    this.need(at, 2);
    return this.little ? this.bytes.readUInt16LE(at) : this.bytes.readUInt16BE(at);
  }

  u32(at: number): number {
    this.need(at, 4);
    return this.little ? this.bytes.readUInt32LE(at) : this.bytes.readUInt32BE(at);
  }

  i32(at: number): number {
    this.need(at, 4);
    return this.little ? this.bytes.readInt32LE(at) : this.bytes.readInt32BE(at);
  }

  directory(offset: number): Directory {
    const count = this.u16(offset);
    if (count > MAX_ENTRIES) throw new ExifFormatError('An EXIF directory lists more entries than any camera writes.');
    this.need(offset + WORD, count * ENTRY_BYTES + 4);
    const entries: RawEntry[] = [];
    for (let index = 0; index < count; index++) {
      const at = offset + WORD + index * ENTRY_BYTES;
      entries.push({ tag: this.u16(at), type: this.u16(at + 2), count: this.u32(at + 4), field: Buffer.from(this.bytes.subarray(at + 8, at + 12)) });
    }
    return { entries, next: this.u32(offset + WORD + count * ENTRY_BYTES) };
  }

  /** The bytes of the value of an entry: inside the field when they fit in 4 bytes, else at the offset the field holds. */
  valueBytes(entry: RawEntry): Buffer | null {
    const size = TYPE_SIZES[entry.type] === undefined ? 0 : TYPE_SIZES[entry.type] * entry.count;
    if (size === 0) return null;
    if (size <= 4) return entry.field.subarray(0, size);
    const at = this.little ? entry.field.readUInt32LE(0) : entry.field.readUInt32BE(0);
    this.need(at, size);
    return this.bytes.subarray(at, at + size);
  }
}

function decodeText(bytes: Buffer): string {
  const end = bytes.indexOf(0);
  return bytes
    .subarray(0, end < 0 ? bytes.length : end)
    .toString('utf8')
    .trimEnd();
}

function decodeNumbers(little: boolean, entry: RawEntry, bytes: Buffer): number[] {
  const size = TYPE_SIZES[entry.type];
  const u16 = (at: number): number => (little ? bytes.readUInt16LE(at) : bytes.readUInt16BE(at));
  const u32 = (at: number): number => (little ? bytes.readUInt32LE(at) : bytes.readUInt32BE(at));
  const i32 = (at: number): number => (little ? bytes.readInt32LE(at) : bytes.readInt32BE(at));
  const out: number[] = [];
  for (let index = 0; index < Math.min(entry.count, MAX_LIST_ITEMS); index++) {
    const at = index * size;
    switch (entry.type) {
      case TYPE_BYTE:
        out.push(bytes[at]);
        break;
      case TYPE_SHORT:
        out.push(u16(at));
        break;
      case TYPE_SSHORT:
        out.push((u16(at) << 16) >> 16);
        break;
      case TYPE_LONG:
        out.push(u32(at));
        break;
      case TYPE_SLONG:
        out.push(i32(at));
        break;
      case TYPE_RATIONAL:
      case TYPE_SRATIONAL: {
        const signed = entry.type === TYPE_SRATIONAL;
        const numerator = signed ? i32(at) : u32(at);
        const denominator = signed ? i32(at + 4) : u32(at + 4);
        out.push(denominator === 0 ? Number.NaN : Number((numerator / denominator).toPrecision(10)));
        break;
      }
      default:
        return [];
    }
  }
  return out.filter((value) => !Number.isNaN(value));
}

function decodeEntry(tiff: Tiff, entry: RawEntry): ExifValue | undefined {
  const bytes = tiff.valueBytes(entry);
  if (bytes === null) return undefined;
  if (entry.type === TYPE_ASCII) return decodeText(bytes.subarray(0, MAX_TEXT_BYTES));
  if (entry.type === TYPE_UNDEFINED) {
    if (entry.tag === 0x9286) return decodeText(bytes.subarray(USER_COMMENT_CHARSET.length, MAX_TEXT_BYTES));
    return entry.tag === 0x9000 ? bytes.toString('latin1') : undefined;
  }
  const numbers = decodeNumbers(tiff.little, entry, bytes);
  if (numbers.length === 0) return undefined;
  return numbers.length === 1 ? numbers[0] : numbers;
}

function namedValues(tiff: Tiff, directory: Directory, table: Readonly<Record<number, TagInfo>>): Record<string, ExifValue> {
  const out: Record<string, ExifValue> = {};
  for (const entry of directory.entries) {
    const info = table[entry.tag];
    if (info === undefined) continue;
    const value = decodeEntry(tiff, entry);
    if (value !== undefined && value !== '') out[info.name] = value;
  }
  return out;
}

function subDirectory(tiff: Tiff, directory: Directory, tag: number): Directory | null {
  const pointer = directory.entries.find((entry) => entry.tag === tag && entry.type === TYPE_LONG && entry.count === 1);
  if (pointer === undefined) return null;
  return tiff.directory(tiff.little ? pointer.field.readUInt32LE(0) : pointer.field.readUInt32BE(0));
}

function degrees(parts: ExifValue | undefined, reference: ExifValue | undefined, negative: string): number | undefined {
  if (!Array.isArray(parts) || parts.length !== 3) return undefined;
  const value = parts[0] + parts[1] / 60 + parts[2] / 3600;
  return Number((reference === negative ? -value : value).toFixed(7));
}

/** The tags of an EXIF block by group, as the specification names them and ExifTool prints them; a tag the table does not list is left out. */
export function readExif(block: Buffer): Partial<Record<ExifGroup, Record<string, ExifValue>>> {
  const tiff = new Tiff(block);
  const ifd0 = tiff.directory(tiff.u32(4));
  const exifDirectory = subDirectory(tiff, ifd0, TAG_EXIF_IFD);
  const gpsDirectory = subDirectory(tiff, ifd0, TAG_GPS_IFD);
  const exif = { ...namedValues(tiff, ifd0, IFD0_TAGS), ...(exifDirectory ? namedValues(tiff, exifDirectory, EXIF_IFD_TAGS) : {}) };
  const raw = gpsDirectory ? gpsDirectory.entries : [];
  const gpsValue = (tag: number): ExifValue | undefined => {
    const entry = raw.find((candidate) => candidate.tag === tag);
    return entry === undefined ? undefined : decodeEntry(tiff, entry);
  };
  const gps: Record<string, ExifValue> = {};
  const latitude = degrees(gpsValue(GPS_TAGS.latitude), gpsValue(GPS_TAGS.latitudeRef), 'S');
  const longitude = degrees(gpsValue(GPS_TAGS.longitude), gpsValue(GPS_TAGS.longitudeRef), 'W');
  const altitude = gpsValue(GPS_TAGS.altitude);
  if (latitude !== undefined) gps.GPSLatitude = latitude;
  if (longitude !== undefined) gps.GPSLongitude = longitude;
  if (typeof altitude === 'number') gps.GPSAltitude = gpsValue(GPS_TAGS.altitudeRef) === 1 ? -altitude : altitude;
  const groups: Partial<Record<ExifGroup, Record<string, ExifValue>>> = {};
  if (Object.keys(exif).length > 0) groups.EXIF = exif;
  if (Object.keys(gps).length > 0) groups.GPS = gps;
  return groups;
}

// ---- Editing ----

/** The tags an edit can set or remove, by the name ExifTool uses, and the directory each belongs to. */
const WRITABLE: ReadonlyArray<{ name: string; tag: number; directory: 'ifd0' | 'exif'; type: number }> = [
  ...Object.entries(IFD0_TAGS).filter(([, info]) => info.write).map(([tag, info]) => ({ name: info.name, tag: Number(tag), directory: 'ifd0' as const, type: info.type })),
  ...Object.entries(EXIF_IFD_TAGS).filter(([, info]) => info.write).map(([tag, info]) => ({ name: info.name, tag: Number(tag), directory: 'exif' as const, type: info.type })),
];

const MAX_ALTITUDE_METERS = 100_000;
/** The GPS fields an edit sets, with the largest absolute value each takes. */
const GPS_LIMITS: Readonly<Record<string, number>> = { GPSLatitude: 90, GPSLongitude: 180, GPSAltitude: MAX_ALTITUDE_METERS };
const GPS_FIELDS: readonly string[] = Object.keys(GPS_LIMITS);

/** The names of the EXIF fields an edit accepts. */
export const WRITABLE_EXIF_FIELDS: readonly string[] = [...WRITABLE.map((field) => field.name), ...GPS_FIELDS];

const DATE_FIELDS: ReadonlySet<string> = new Set(['ModifyDate', 'DateTimeOriginal', 'CreateDate']);
const EXIF_DATE = /^\d{4}:\d{2}:\d{2} \d{2}:\d{2}:\d{2}$/;
const MAX_ORIENTATION = 8;
const MIN_TEXT_BYTES = 1;
const RATIONAL_SCALE = 1_000_000;
const MINUTES_PER_DEGREE = 60;
const SECONDS_SCALE = 10_000;

/** A value an edit sets that its field cannot hold: its message says what the field takes. */
export class ExifValueError extends Error {
  constructor(readonly field: string, message: string) {
    super(message);
    this.name = 'ExifValueError';
  }
}

interface NewEntry {
  tag: number;
  type: number;
  count: number;
  data: Buffer;
}

function asciiEntry(tag: number, text: string): NewEntry {
  const data = Buffer.from(`${text}\0`, 'utf8');
  return { tag, type: TYPE_ASCII, count: data.length, data };
}

function makeEntry(tiff: Tiff, field: { name: string; tag: number; type: number }, value: string | number): NewEntry {
  const text = typeof value === 'string' ? value : String(value);
  if (field.type === TYPE_SHORT) {
    const orientation = Number(value);
    if (!Number.isInteger(orientation) || orientation < 1 || orientation > MAX_ORIENTATION) throw new ExifValueError(field.name, `"${field.name}" takes a whole number from 1 to ${MAX_ORIENTATION}.`);
    const data = Buffer.alloc(WORD);
    if (tiff.little) data.writeUInt16LE(orientation);
    else data.writeUInt16BE(orientation);
    return { tag: field.tag, type: TYPE_SHORT, count: 1, data };
  }
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') < MIN_TEXT_BYTES) throw new ExifValueError(field.name, `"${field.name}" takes text.`);
  if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) throw new ExifValueError(field.name, `"${field.name}" takes at most ${MAX_TEXT_BYTES} bytes.`);
  if (DATE_FIELDS.has(field.name) && !EXIF_DATE.test(text)) throw new ExifValueError(field.name, `"${field.name}" takes a date as "YYYY:MM:DD HH:MM:SS".`);
  if (field.type === TYPE_UNDEFINED) {
    const data = Buffer.concat([Buffer.from(USER_COMMENT_CHARSET, 'latin1'), Buffer.from(text, 'utf8')]);
    return { tag: field.tag, type: TYPE_UNDEFINED, count: data.length, data };
  }
  return asciiEntry(field.tag, text);
}

function u32Bytes(tiff: Tiff, value: number): Buffer {
  const out = Buffer.alloc(4);
  if (tiff.little) out.writeUInt32LE(value);
  else out.writeUInt32BE(value);
  return out;
}

function rationals(tiff: Tiff, pairs: ReadonlyArray<readonly [number, number]>): Buffer {
  return Buffer.concat(pairs.flatMap(([numerator, denominator]) => [u32Bytes(tiff, numerator), u32Bytes(tiff, denominator)]));
}

function gpsEntries(tiff: Tiff, field: string, value: number, limit: number): NewEntry[] {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > limit) throw new ExifValueError(field, `"${field}" takes a number from -${limit} to ${limit}.`);
  const absolute = Math.abs(value);
  if (field === 'GPSAltitude') {
    return [
      { tag: GPS_TAGS.altitudeRef, type: TYPE_BYTE, count: 1, data: Buffer.from([value < 0 ? 1 : 0]) },
      { tag: GPS_TAGS.altitude, type: TYPE_RATIONAL, count: 1, data: rationals(tiff, [[Math.round(absolute * 1000), 1000]]) },
    ];
  }
  const whole = Math.floor(absolute);
  const minutesExact = (absolute - whole) * MINUTES_PER_DEGREE;
  const minutes = Math.floor(minutesExact);
  const seconds = Math.round((minutesExact - minutes) * MINUTES_PER_DEGREE * SECONDS_SCALE);
  const latitude = field === 'GPSLatitude';
  const hemisphere = latitude ? ['S', 'N'] : ['W', 'E'];
  return [
    asciiEntry(latitude ? GPS_TAGS.latitudeRef : GPS_TAGS.longitudeRef, hemisphere[value < 0 ? 0 : 1]),
    {
      tag: latitude ? GPS_TAGS.latitude : GPS_TAGS.longitude,
      type: TYPE_RATIONAL,
      count: 3,
      data: rationals(tiff, [[whole, 1], [minutes, 1], [seconds, SECONDS_SCALE]]),
    },
  ];
}

/** An edit: a field name and the value it takes, or null to remove the field. */
export type ExifEdits = Readonly<Record<string, string | number | null>>;

class Growing {
  chunks: Buffer[] = [];
  length: number;
  constructor(readonly original: Buffer) {
    this.length = original.length;
  }

  /** Appends `data` on a 2-byte boundary and returns the offset it has. */
  append(data: Buffer): number {
    if (this.length % WORD === 1) {
      this.chunks.push(Buffer.alloc(1));
      this.length += 1;
    }
    const at = this.length;
    this.chunks.push(data);
    this.length += data.length;
    return at;
  }

  result(): Buffer {
    return Buffer.concat([this.original, ...this.chunks]);
  }
}

function writeEntryBytes(tiff: Tiff, entry: RawEntry | NewEntry, grow: Growing): Buffer {
  const out = Buffer.alloc(ENTRY_BYTES);
  const write16 = (value: number, at: number) => (tiff.little ? out.writeUInt16LE(value, at) : out.writeUInt16BE(value, at));
  const write32 = (value: number, at: number) => (tiff.little ? out.writeUInt32LE(value, at) : out.writeUInt32BE(value, at));
  write16(entry.tag, 0);
  write16(entry.type, 2);
  write32(entry.count, 4);
  if ('field' in entry) {
    entry.field.copy(out, 8);
  } else if (entry.data.length <= 4) {
    entry.data.copy(out, 8);
  } else {
    write32(grow.append(entry.data), 8);
  }
  return out;
}

/** Writes a directory made of `entries` at the end of the block, after the values its new entries hold, and returns its offset. */
function appendDirectory(tiff: Tiff, entries: ReadonlyArray<RawEntry | NewEntry>, next: number, grow: Growing): number {
  const sorted = [...entries].sort((a, b) => a.tag - b.tag);
  const rows = sorted.map((entry) => writeEntryBytes(tiff, entry, grow));
  const body = Buffer.alloc(WORD + rows.length * ENTRY_BYTES + 4);
  if (tiff.little) body.writeUInt16LE(rows.length, 0);
  else body.writeUInt16BE(rows.length, 0);
  rows.forEach((row, index) => row.copy(body, WORD + index * ENTRY_BYTES));
  if (tiff.little) body.writeUInt32LE(next, body.length - 4);
  else body.writeUInt32BE(next, body.length - 4);
  return grow.append(body);
}

function directoryWith(tiff: Tiff, current: Directory | null, remove: ReadonlySet<number>, add: readonly NewEntry[]): { entries: Array<RawEntry | NewEntry>; next: number } {
  const replaced = new Set([...remove, ...add.map((entry) => entry.tag)]);
  return { entries: [...(current?.entries ?? []).filter((entry) => !replaced.has(entry.tag)), ...add], next: current?.next ?? 0 };
}

const GPS_REMOVED: Readonly<Record<string, readonly number[]>> = {
  GPSLatitude: [GPS_TAGS.latitudeRef, GPS_TAGS.latitude],
  GPSLongitude: [GPS_TAGS.longitudeRef, GPS_TAGS.longitude],
  GPSAltitude: [GPS_TAGS.altitudeRef, GPS_TAGS.altitude],
};

/** An empty block: the header and a directory with no entry. */
function emptyBlock(): Buffer {
  const block = Buffer.alloc(TIFF_HEADER_BYTES + WORD + 4);
  block.write('II', 0, 'latin1');
  block.writeUInt16LE(TIFF_MAGIC, 2);
  block.writeUInt32LE(TIFF_HEADER_BYTES, 4);
  return block;
}

/**
 * The EXIF block with `edits` applied: a field set takes the new value, one set to null is removed, every other entry stays as it
 * was. `block` is null for a picture without EXIF, which starts from an empty one. Throws ExifValueError for a value its field
 * cannot hold and ExifFormatError for a block that cannot be read.
 */
export function editExif(block: Buffer | null, edits: ExifEdits): Buffer {
  const source = block ?? emptyBlock();
  const tiff = new Tiff(source);
  const grow = new Growing(source);
  const ifd0 = tiff.directory(tiff.u32(4));
  const exifCurrent = subDirectory(tiff, ifd0, TAG_EXIF_IFD);
  const gpsCurrent = subDirectory(tiff, ifd0, TAG_GPS_IFD);
  const buckets = { ifd0: { remove: new Set<number>(), add: [] as NewEntry[] }, exif: { remove: new Set<number>(), add: [] as NewEntry[] }, gps: { remove: new Set<number>(), add: [] as NewEntry[] } };

  for (const [name, value] of Object.entries(edits)) {
    const field = WRITABLE.find((candidate) => candidate.name === name);
    if (field !== undefined) {
      const bucket = buckets[field.directory];
      if (value === null) bucket.remove.add(field.tag);
      else bucket.add.push(makeEntry(tiff, field, value));
    } else if (GPS_FIELDS.includes(name)) {
      for (const tag of GPS_REMOVED[name]) buckets.gps.remove.add(tag);
      if (value !== null) buckets.gps.add.push(...gpsEntries(tiff, name, value as number, GPS_LIMITS[name]));
    } else {
      throw new ExifValueError(name, `"${name}" is not an EXIF field that can be written.`);
    }
  }

  const pointer = (tag: number, offset: number): NewEntry => ({ tag, type: TYPE_LONG, count: 1, data: u32Bytes(tiff, offset) });
  if (buckets.exif.add.length > 0 || (buckets.exif.remove.size > 0 && exifCurrent !== null)) {
    const next = directoryWith(tiff, exifCurrent, buckets.exif.remove, buckets.exif.add);
    buckets.ifd0.add.push(pointer(TAG_EXIF_IFD, appendDirectory(tiff, next.entries, next.next, grow)));
  }
  if (buckets.gps.add.length > 0 || (buckets.gps.remove.size > 0 && gpsCurrent !== null)) {
    const next = directoryWith(tiff, gpsCurrent, buckets.gps.remove, buckets.gps.add);
    buckets.ifd0.add.push(pointer(TAG_GPS_IFD, appendDirectory(tiff, next.entries, next.next, grow)));
  }
  if (buckets.ifd0.add.length === 0 && buckets.ifd0.remove.size === 0) return source;

  const next = directoryWith(tiff, ifd0, buckets.ifd0.remove, buckets.ifd0.add);
  const at = appendDirectory(tiff, next.entries, next.next, grow);
  const out = grow.result();
  if (tiff.little) out.writeUInt32LE(at, 4);
  else out.writeUInt32BE(at, 4);
  return out;
}
