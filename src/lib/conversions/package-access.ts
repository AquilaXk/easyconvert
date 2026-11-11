import JSZip from 'jszip';
import { readZipDirectory, readZipEntryCount } from './archive-zip-reader';
import { readZipEntryBytes } from './zip-entry-reader';
import type { InflateBudget } from './bounded-inflate';
import { ConversionFailedError, PayloadLimitError } from '../types';
import { decodeWindows1252 } from './office/windows-1252';

/**
 * Access to ZIP-based document packages (OPC, ODF, EPUB OCF): opening one, reading an entry under a size limit,
 * resolving a reference to an entry, and decoding XML bytes with their declared encoding.
 */

const UTF8_BOM = [0xef, 0xbb, 0xbf];
const UTF16LE_BOM = [0xff, 0xfe];
const UTF16BE_BOM = [0xfe, 0xff];
const XML_DECLARATION_SCAN_BYTES = 200;
const XML_ENCODING_PATTERN = /<\?xml[^>]*\bencoding\s*=\s*["']([A-Za-z0-9._-]+)["']/;

/** PK\x03\x04: the local file header every ZIP-based package starts with. */
export const ZIP_LOCAL_HEADER_SIGNATURE = [0x50, 0x4b, 0x03, 0x04];

export function startsWithBytes(buffer: Buffer, prefix: readonly number[]): boolean {
  return prefix.every((byte, index) => buffer[index] === byte);
}

/** Text of an XML or XHTML file: its byte order mark, or else the encoding its declaration names, or UTF-8. */
export function decodeXmlBytes(bytes: Buffer, what: string): string {
  if (startsWithBytes(bytes, UTF8_BOM)) return bytes.toString('utf-8', UTF8_BOM.length);
  if (startsWithBytes(bytes, UTF16LE_BOM)) return bytes.toString('utf16le', UTF16LE_BOM.length);
  if (startsWithBytes(bytes, UTF16BE_BOM)) {
    const swapped = Buffer.from(bytes.subarray(UTF16BE_BOM.length));
    return swapped.swap16().toString('utf16le');
  }
  const label = XML_ENCODING_PATTERN.exec(bytes.toString('latin1', 0, XML_DECLARATION_SCAN_BYTES))?.[1]?.toLowerCase();
  if (label === undefined || label === 'utf-8' || label === 'utf8') return bytes.toString('utf-8');
  if (label === 'windows-1252' || label === 'cp1252') return decodeWindows1252(bytes);
  try {
    return new TextDecoder(label, { fatal: true }).decode(bytes);
  } catch {
    throw new ConversionFailedError(`The ${what} declares the encoding "${label}", which cannot be decoded.`);
  }
}

/**
 * Most entries a package may hold. JSZip builds an object for every entry of the central directory (about 1.7 KB each, measured at
 * 100,000 entries), so a file of a million tiny entries would cost it gigabytes before any part is read. A document holds hundreds;
 * this is the limit the macro check has always had (`MACRO_STRIP_MAX_ENTRIES`).
 */
export const MAX_PACKAGE_ENTRIES = 100_000;

/** The entries the end records of a ZIP file declare, or undefined when they cannot be read. */
export function declaredPackageEntries(input: Uint8Array): number | undefined {
  try {
    return readZipEntryCount(Buffer.from(input.buffer, input.byteOffset, input.byteLength));
  } catch {
    return undefined;
  }
}

/**
 * Refuses a ZIP package whose end records declare more than `MAX_PACKAGE_ENTRIES` entries, before JSZip reads its directory. A file whose end
 * records cannot be read is refused too: JSZip finds the end record by its own rules, and the entries it would then read are not counted.
 * @throws PayloadLimitError (413) for too many entries.
 * @throws ConversionFailedError (400) when the end records cannot be read.
 */
export function assertPackageEntryCount(input: Uint8Array, format: string, packageKind = 'ZIP package'): void {
  const count = declaredPackageEntries(input);
  if (count === undefined) throw new ConversionFailedError(`The ${format} file is not a valid ${packageKind}.`);
  if (count > MAX_PACKAGE_ENTRIES) {
    throw new PayloadLimitError(`The ${format} package holds ${count} entries, more than the ${MAX_PACKAGE_ENTRIES} that are read.`);
  }
}

/** Opens a ZIP package; anything that is not one is a typed 400 error naming the format, and one with too many entries a 413. */
export async function openPackage(input: Buffer | Uint8Array, format: string, packageKind = 'ZIP package'): Promise<JSZip> {
  assertPackageEntryCount(input, format, packageKind);
  try {
    return await JSZip.loadAsync(input);
  } catch {
    throw new ConversionFailedError(`The ${format} file is not a valid ${packageKind}.`);
  }
}

/**
 * Opens an Open Packaging Conventions package, which names every part once (ECMA-376 Part 2, 10.1.2.1). A package that
 * holds a part name twice has no single part to read: the ZIP reader keeps the last entry and drops the first, so
 * the cells or text it reads are the ones of whichever the writer put last. That is a typed 400 error.
 */
export async function openOpcPackage(input: Buffer | Uint8Array, format: string): Promise<JSZip> {
  const zip = await openPackage(input, format);
  const names = new Set<string>();
  for (const entry of readZipDirectory(Buffer.from(input.buffer, input.byteOffset, input.byteLength), { MAX_FILES: Number.MAX_SAFE_INTEGER }).entries) {
    if (names.has(entry.name)) throw new ConversionFailedError(`The ${format} package holds the part ${entry.name} more than once, so it has no single content to read.`);
    names.add(entry.name);
  }
  return zip;
}

/**
 * Reads one package entry as bytes, refusing one that declares more than `limit` bytes or inflates past it. A reader that
 * opens many entries of one package passes a `budget`, which every entry it reads is charged to.
 */
export async function readPackageEntry(zip: JSZip, entryPath: string, limit: number, what: string, budget?: InflateBudget): Promise<Buffer> {
  const entry = zip.file(entryPath);
  if (!entry) throw new ConversionFailedError(`The ${what} names "${entryPath}", which is not in the package.`);
  const declared = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
  if (declared !== undefined && declared > limit) {
    throw new PayloadLimitError(`"${entryPath}" declares ${declared} bytes, more than the ${limit} byte limit.`);
  }
  return readZipEntryBytes(entry, { maxBytes: limit, label: `"${entryPath}"`, budget });
}

/** The package path a manifest `href` names, relative to the directory of the file that holds it; never above the package root. */
export function resolvePackagePath(baseDirectory: string, href: string): string {
  let target = href.split('#')[0];
  try {
    target = decodeURIComponent(target);
  } catch {
    throw new ConversionFailedError(`The package reference "${href}" is not a valid URI.`);
  }
  const segments = (target.startsWith('/') ? target.slice(1) : `${baseDirectory}${target}`).split('/');
  const resolved: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (resolved.pop() === undefined) throw new ConversionFailedError(`The package reference "${href}" points outside the package.`);
    } else {
      resolved.push(segment);
    }
  }
  return resolved.join('/');
}
