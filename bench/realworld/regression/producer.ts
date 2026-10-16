/**
 * The application that wrote a corpus file, read from the file's own metadata, and the coarse class the regression corpus
 * stratifies by. The three readers work on bytes in memory and never execute or render anything: a PDF is scanned as text for
 * its Info dictionary and XMP packet, an OLE document is read through its compound-file directory down to the
 * SummaryInformation stream (MS-CFB, MS-OLEPS), and an OOXML package is read through its ZIP directory down to
 * `docProps/app.xml`. Every length and every chain is bounded, so a damaged or hostile file ends in `null` and not in a loop.
 */
import { inflateEntry, locateCentralDirectory, parseCentralDirectory, EOCD_SEARCH_BYTES, type ZipEntry } from '../zip-range';

const MAX_PRODUCER_CHARS = 120;
/** Longest string the PDF scan reads before it gives up on a value that never ends. */
const MAX_STRING_SCAN_BYTES = 4096;
const MAX_PROPERTY_PART_BYTES = 1024 * 1024;
const PRINTABLE = /^[\p{L}\p{N}\p{P}\p{S}\p{Zs}]+$/u;

// --- PDF ---------------------------------------------------------------------------------------------------------------

const PDF_INFO_KEYS = ['Producer', 'Creator'] as const;
const XMP_PRODUCER = /<pdf:Producer>([^<]*)<\/pdf:Producer>/g;
const XMP_CREATOR_TOOL = /<xmp:CreatorTool>([^<]*)<\/xmp:CreatorTool>/g;
const PDF_ACTIVE_CONTENT = /\/(?:JavaScript|JS|Launch)\b/;
const BYTE_ORDER_MARK_LENGTH = 2;
const ESCAPES: Readonly<Record<string, string>> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };

function cleaned(text: string): string | null {
  const trimmed = text.replace(/\0/g, '').trim().slice(0, MAX_PRODUCER_CHARS);
  return trimmed !== '' && PRINTABLE.test(trimmed) ? trimmed : null;
}

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

/** A PDF text string: UTF-16BE behind a byte order mark, else UTF-8 where the bytes are valid UTF-8 (writers do this though the standard says PDFDocEncoding), else Latin-1. */
function decodePdfBytes(raw: Buffer): string {
  if (raw.length >= BYTE_ORDER_MARK_LENGTH && raw[0] === 0xfe && raw[1] === 0xff) {
    const wide = raw.subarray(BYTE_ORDER_MARK_LENGTH, raw.length - (raw.length % 2));
    return Buffer.from(wide).swap16().toString('utf16le');
  }
  try {
    return UTF8_DECODER.decode(raw);
  } catch {
    return raw.toString('latin1');
  }
}

const OCTAL_ESCAPE = /^[0-7]{1,3}/;

/** The byte a backslash escape at `at` stands for, and the index of its last character. */
function readEscape(text: string, at: number): { byte: number; last: number } {
  const octal = OCTAL_ESCAPE.exec(text.slice(at, at + 3));
  if (octal !== null) return { byte: parseInt(octal[0], 8) & 0xff, last: at + octal[0].length - 1 };
  const char = text[at] ?? '';
  return { byte: (ESCAPES[char] ?? char).charCodeAt(0), last: at };
}

/** The literal string that starts at `start` (just after its opening parenthesis), with escapes and balanced parentheses. */
function readLiteral(text: string, start: number): Buffer | null {
  const out: number[] = [];
  let depth = 1;
  for (let at = start; at < text.length && out.length <= MAX_STRING_SCAN_BYTES; at++) {
    const char = text[at];
    if (char === '\\') {
      const escape = readEscape(text, at + 1);
      out.push(escape.byte);
      at = escape.last;
    } else {
      if (char === '(') depth++;
      if (char === ')') depth--;
      if (depth === 0) return Buffer.from(out);
      out.push(char.charCodeAt(0));
    }
  }
  return null;
}

function readHex(text: string, start: number): Buffer | null {
  const end = text.indexOf('>', start);
  if (end === -1 || end - start > MAX_STRING_SCAN_BYTES * 2) return null;
  const digits = text.slice(start, end).replace(/\s+/g, '');
  return /^[0-9a-fA-F]*$/.test(digits) ? Buffer.from(digits.length % 2 === 0 ? digits : `${digits}0`, 'hex') : null;
}

/** The value of the last `/key` entry of the file whose value is a string, so an incremental update wins over what it replaced. */
function lastInfoValue(text: string, key: string): string | null {
  const pattern = new RegExp(`/${key}\\s*([(<])`, 'g');
  let value: string | null = null;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const start = match.index + match[0].length;
    const raw = match[1] === '(' ? readLiteral(text, start) : readHex(text, start);
    if (raw !== null) value = cleaned(decodePdfBytes(raw)) ?? value;
  }
  return value;
}

function lastMatch(text: string, pattern: RegExp): string | null {
  let value: string | null = null;
  for (const match of text.matchAll(pattern)) value = cleaned(match[1]) ?? value;
  return value;
}

/** The Producer of a PDF: the Info dictionary's, else the XMP packet's, else the Creator of either. */
export function pdfProducer(bytes: Buffer): string | null {
  const text = bytes.toString('latin1');
  const [producer, creator] = PDF_INFO_KEYS.map((key) => lastInfoValue(text, key));
  return producer ?? lastMatch(text, XMP_PRODUCER) ?? creator ?? lastMatch(text, XMP_CREATOR_TOOL);
}

// --- OLE compound files -------------------------------------------------------------------------------------------------

const CFB_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const CFB_HEADER_BYTES = 512;
const CFB_HEADER_DIFAT_SLOTS = 109;
const CFB_DIRECTORY_ENTRY_BYTES = 128;
const CFB_MAX_REGULAR_SECTOR = 0xfffffffa;
const CFB_END_OF_CHAIN = 0xfffffffe;
const CFB_NAME_BYTES_MAX = 64;
const SUMMARY_INFORMATION = '\u0005SummaryInformation';
const OLE_MACRO_STORAGES: ReadonlySet<string> = new Set(['VBA', '_VBA_PROJECT_CUR', 'Macros', '_VBA_PROJECT']);
const OLE_PROPERTY_SET_HEADER_BYTES = 48;
const OLE_PIDSI_CODEPAGE = 0x01;
const OLE_PIDSI_APPNAME = 0x12;
const VT_LPSTR = 0x1e;
const CODEPAGE_UTF8 = 65001;
const OLE_VALUE_HEADER_BYTES = 8;

class ProducerParseError extends Error {}

interface DirectoryEntry {
  name: string;
  type: number;
  start: number;
  size: number;
}

class CompoundFile {
  private readonly sectorSize: number;
  private readonly miniSectorSize: number;
  private readonly sectorCount: number;
  private readonly fat: number[];

  constructor(private readonly bytes: Buffer) {
    if (bytes.length < CFB_HEADER_BYTES || !bytes.subarray(0, CFB_SIGNATURE.length).equals(CFB_SIGNATURE)) throw new ProducerParseError('not a compound file');
    this.sectorSize = 2 ** bytes.readUInt16LE(30);
    this.miniSectorSize = 2 ** bytes.readUInt16LE(32);
    if (this.sectorSize !== 512 && this.sectorSize !== 4096) throw new ProducerParseError('unsupported sector size');
    this.sectorCount = Math.floor((bytes.length - CFB_HEADER_BYTES) / this.sectorSize);
    this.fat = this.readFat();
  }

  private sector(index: number): Buffer {
    if (index >= this.sectorCount) throw new ProducerParseError('sector past the end of the file');
    const start = CFB_HEADER_BYTES + index * this.sectorSize;
    return this.bytes.subarray(start, start + this.sectorSize);
  }

  private fatSectorIndexes(): number[] {
    const indexes: number[] = [];
    const count = this.bytes.readUInt32LE(44);
    for (let slot = 0; slot < Math.min(count, CFB_HEADER_DIFAT_SLOTS); slot++) indexes.push(this.bytes.readUInt32LE(76 + slot * 4));
    let difat = this.bytes.readUInt32LE(68);
    const entriesPerSector = this.sectorSize / 4 - 1;
    for (let hops = 0; indexes.length < count && difat <= CFB_MAX_REGULAR_SECTOR; hops++) {
      if (hops > this.sectorCount) throw new ProducerParseError('DIFAT chain loops');
      const sector = this.sector(difat);
      for (let slot = 0; slot < entriesPerSector && indexes.length < count; slot++) indexes.push(sector.readUInt32LE(slot * 4));
      difat = sector.readUInt32LE(entriesPerSector * 4);
    }
    return indexes;
  }

  private readFat(): number[] {
    const fat: number[] = [];
    for (const index of this.fatSectorIndexes()) {
      const sector = this.sector(index);
      for (let at = 0; at < sector.length; at += 4) fat.push(sector.readUInt32LE(at));
    }
    return fat;
  }

  /** The bytes of the sector chain that starts at `first`, at most `limit` bytes of them. */
  chain(first: number, limit: number): Buffer {
    const parts: Buffer[] = [];
    let total = 0;
    let current = first;
    for (let hops = 0; current <= CFB_MAX_REGULAR_SECTOR && total < limit; hops++) {
      if (hops > this.sectorCount) throw new ProducerParseError('sector chain loops');
      parts.push(this.sector(current));
      total += this.sectorSize;
      if (current >= this.fat.length) throw new ProducerParseError('sector missing from the FAT');
      current = this.fat[current];
    }
    return Buffer.concat(parts).subarray(0, limit);
  }

  directory(): DirectoryEntry[] {
    const raw = this.chain(this.bytes.readUInt32LE(48), this.sectorCount * this.sectorSize);
    const entries: DirectoryEntry[] = [];
    for (let at = 0; at + CFB_DIRECTORY_ENTRY_BYTES <= raw.length; at += CFB_DIRECTORY_ENTRY_BYTES) {
      const nameLength = Math.min(raw.readUInt16LE(at + 64), CFB_NAME_BYTES_MAX);
      const name = raw.subarray(at, at + Math.max(0, nameLength - 2)).toString('utf16le');
      entries.push({ name, type: raw.readUInt8(at + 66), start: raw.readUInt32LE(at + 116), size: raw.readUInt32LE(at + 120) });
    }
    return entries;
  }

  /** The content of a stream, from the regular sectors or, below the cutoff, from the mini stream. */
  stream(entry: DirectoryEntry, root: DirectoryEntry): Buffer {
    if (entry.size >= this.bytes.readUInt32LE(56)) return this.chain(entry.start, entry.size);
    const miniStream = this.chain(root.start, root.size);
    const miniFat = this.chain(this.bytes.readUInt32LE(60), this.bytes.readUInt32LE(64) * this.sectorSize);
    const parts: Buffer[] = [];
    let current = entry.start;
    for (let hops = 0; current <= CFB_MAX_REGULAR_SECTOR && parts.length * this.miniSectorSize < entry.size; hops++) {
      if (hops > miniFat.length / 4) throw new ProducerParseError('mini sector chain loops');
      const start = current * this.miniSectorSize;
      if (start + this.miniSectorSize > miniStream.length) throw new ProducerParseError('mini sector past the end of the mini stream');
      parts.push(miniStream.subarray(start, start + this.miniSectorSize));
      current = miniFat.readUInt32LE(current * 4);
    }
    return Buffer.concat(parts).subarray(0, entry.size);
  }
}

function propertyOffset(section: Buffer, id: number): number | null {
  const count = section.readUInt32LE(4);
  for (let property = 0; property < Math.min(count, section.length / 8); property++) {
    if (section.readUInt32LE(OLE_VALUE_HEADER_BYTES + property * 8) === id) return section.readUInt32LE(OLE_VALUE_HEADER_BYTES + property * 8 + 4);
  }
  return null;
}

function codePageOf(section: Buffer): number {
  const offset = propertyOffset(section, OLE_PIDSI_CODEPAGE);
  return offset === null ? 0 : section.readUInt16LE(offset + 4);
}

function applicationName(stream: Buffer): string | null {
  const sectionOffset = stream.readUInt32LE(OLE_PROPERTY_SET_HEADER_BYTES - 4);
  const section = stream.subarray(sectionOffset);
  const offset = propertyOffset(section, OLE_PIDSI_APPNAME);
  if (offset === null || section.readUInt32LE(offset) !== VT_LPSTR) return null;
  const length = section.readUInt32LE(offset + 4);
  const raw = section.subarray(offset + OLE_VALUE_HEADER_BYTES, offset + OLE_VALUE_HEADER_BYTES + length);
  const encoding = codePageOf(section) === CODEPAGE_UTF8 ? 'utf-8' : 'windows-1252';
  return cleaned(new TextDecoder(encoding).decode(raw));
}

function withCompoundFile<T>(bytes: Buffer, read: (file: CompoundFile, entries: DirectoryEntry[]) => T, empty: T): T {
  try {
    const file = new CompoundFile(bytes);
    return read(file, file.directory());
  } catch (error) {
    if (error instanceof ProducerParseError || error instanceof RangeError) return empty;
    throw error;
  }
}

/** The application name (PIDSI_APPNAME) of an OLE document, or null. */
export function oleApplication(bytes: Buffer): string | null {
  return withCompoundFile(
    bytes,
    (file, entries) => {
      const info = entries.find((entry) => entry.name === SUMMARY_INFORMATION);
      return info === undefined ? null : applicationName(file.stream(info, entries[0]));
    },
    null
  );
}

// --- OOXML packages -----------------------------------------------------------------------------------------------------

const APP_PART = 'docProps/app.xml';
const MACRO_PART = /(^|\/)vbaProject\.bin$/i;
const XML_ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function packageEntries(bytes: Buffer): ZipEntry[] {
  const tail = bytes.subarray(Math.max(0, bytes.length - EOCD_SEARCH_BYTES));
  const location = locateCentralDirectory(tail);
  return parseCentralDirectory(bytes.subarray(location.offset, location.offset + location.size), location.entries);
}

function withPackage<T>(bytes: Buffer, read: (entries: ZipEntry[]) => T, empty: T): T {
  try {
    return read(packageEntries(bytes));
  } catch (error) {
    if (error instanceof Error && (error.name === 'ZipRangeError' || error instanceof RangeError)) return empty;
    throw error;
  }
}

function partText(bytes: Buffer, entry: ZipEntry): string {
  const dataStart = entry.localHeaderOffset + 30 + bytes.readUInt16LE(entry.localHeaderOffset + 26) + bytes.readUInt16LE(entry.localHeaderOffset + 28);
  return inflateEntry(entry, bytes.subarray(dataStart, dataStart + entry.compressedSize)).toString('utf8');
}

const unescapeXml = (text: string): string => text.replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => XML_ENTITIES[name]);
const xmlField = (xml: string, name: string): string | null => {
  const match = new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml);
  return match === null ? null : cleaned(unescapeXml(match[1]));
};

/** `Application` and `AppVersion` of `docProps/app.xml` in an OOXML package, or null. */
export function ooxmlApplication(bytes: Buffer): string | null {
  return withPackage(
    bytes,
    (entries) => {
      const entry = entries.find((candidate) => candidate.name === APP_PART);
      if (entry === undefined || entry.size > MAX_PROPERTY_PART_BYTES) return null;
      const xml = partText(bytes, entry);
      const application = xmlField(xml, 'Application');
      if (application === null) return null;
      const version = xmlField(xml, 'AppVersion');
      return version === null ? application : `${application} ${version}`;
    },
    null
  );
}

// --- Dispatch ---------------------------------------------------------------------------------------------------------

const OLE_FORMATS: ReadonlySet<string> = new Set(['doc', 'xls', 'ppt', 'pps']);
const OOXML_FORMATS: ReadonlySet<string> = new Set(['docx', 'xlsx', 'pptx', 'ppsx']);

/** The producer of a file of the given registry format, or null where the format has no reader or the file names none. */
export function producerOf(format: string, bytes: Buffer): string | null {
  if (format === 'pdf') return pdfProducer(bytes);
  if (OLE_FORMATS.has(format)) return oleApplication(bytes);
  if (OOXML_FORMATS.has(format)) return ooxmlApplication(bytes);
  return null;
}

/**
 * Whether the file carries executable content: a Visual Basic project in an OLE document or OOXML package, or a script or launch
 * action in a PDF. The regression corpus leaves these out (malicious-file corpora belong to the security batch, #761).
 */
export function hasMacros(format: string, bytes: Buffer): boolean {
  if (format === 'pdf') return PDF_ACTIVE_CONTENT.test(bytes.toString('latin1'));
  if (OLE_FORMATS.has(format)) return withCompoundFile(bytes, (_, entries) => entries.some((entry) => OLE_MACRO_STORAGES.has(entry.name)), false);
  if (OOXML_FORMATS.has(format)) return withPackage(bytes, (entries) => entries.some((entry) => MACRO_PART.test(entry.name)), false);
  return false;
}

// --- Producer class ---------------------------------------------------------------------------------------------------

const UNKNOWN_CLASS = 'unknown';
const MAX_CLASS_CHARS = 24;
const CLASS_NAME_WORDS = 2;

/** Known writers, most specific first: the first pattern that matches names the class. */
const KNOWN_PRODUCERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/microsoft.*word/, 'microsoft-word'],
  [/microsoft.*excel/, 'microsoft-excel'],
  [/microsoft.*powerpoint/, 'microsoft-powerpoint'],
  [/pdfmaker/, 'acrobat-pdfmaker'],
  [/distiller/, 'acrobat-distiller'],
  [/adobe pdf library/, 'adobe-pdf-library'],
  [/indesign/, 'adobe-indesign'],
  [/illustrator/, 'adobe-illustrator'],
  [/photoshop/, 'adobe-photoshop'],
  [/quartz pdfcontext/, 'macos-quartz'],
  [/ghostscript/, 'ghostscript'],
  [/pdftex|xetex|luatex|dvips|dvipdfm|latex/, 'tex'],
  [/libreoffice|openoffice|staroffice/, 'openoffice-family'],
  [/tcpdf/, 'tcpdf'],
  [/itext/, 'itext'],
  [/skia/, 'skia-pdf'],
  [/wkhtmltopdf/, 'wkhtmltopdf'],
  [/reportlab/, 'reportlab'],
  [/crystal reports/, 'crystal-reports'],
  [/pdfcreator|pdf995|primopdf|cutepdf|bullzip|novapdf/, 'virtual-printer'],
];

const withoutVersions = (text: string): string =>
  text
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[®™©]/g, ' ')
    .replace(/\bv?\d+(?:[._-]\d+)*[a-z]?\b/g, ' ');

/** The coarse class of a producer string: a known writer, else its first two words without versions, else `unknown`. */
export function producerClass(raw: string | null): string {
  const lower = (raw ?? '').toLowerCase().replace(/[®™©]/g, ' ');
  const known = KNOWN_PRODUCERS.find(([pattern]) => pattern.test(lower));
  if (known !== undefined) return known[1];
  const words = withoutVersions(lower).match(/[a-z][a-z0-9]*/g) ?? [];
  const name = words.slice(0, CLASS_NAME_WORDS).join('-').slice(0, MAX_CLASS_CHARS).replace(/-+$/, '');
  return name === '' ? UNKNOWN_CLASS : name;
}
