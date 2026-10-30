import fs from 'node:fs';
import { assertNotSpoofedFile as assertSignatureMatches, FileExtensionSpoofError, FORMAT_REGISTRY } from '../registry';
import { assertGzippedXmlRoot } from './gzipped-xml-root';
import { OBJECT_HEADER_BYTES, readObjectRange } from '../storage/object-header';
import type { IStorageBackend } from '../storage/oci-storage';
import {
  compoundFileVerdictFrom,
  compoundFileVerdictFromAsync,
  readCompoundFileRoot,
  readCompoundFileRootFrom,
  readCompoundFileRootFromAsync,
  type AsyncByteSource,
  type ByteSource,
  type CompoundFileRoot,
  type CompoundFileVerdict,
} from '../compound-file-kind';
import { OOXML_VARIANT_FAMILY } from '../conversions/ooxml-variants';
import { EncryptedOfficeDocumentError } from '../types';
import { COMPOUND_FILE_ONLY_EXTENSIONS } from '../format-signatures';

const OOXML_EXTENSIONS: ReadonlySet<string> = new Set(['docx', 'xlsx', 'pptx', 'potx', ...Object.keys(OOXML_VARIANT_FAMILY)]);
/** The two entries under the root of the compound file that holds an encrypted Office Open XML package ([MS-OFFCRYPTO] 2.1). */
const ENCRYPTED_PACKAGE_ENTRIES = ['ENCRYPTEDPACKAGE', 'ENCRYPTIONINFO'] as const;

function extensionOf(declared: string): string {
  return declared.toLowerCase().replace(/^\./, '').trim();
}

/**
 * A password-protected .docx, .xlsx or .pptx is not a ZIP package: Office wraps the encrypted package in a compound file, so the
 * signature rules call it a spoofed extension. It is the file the extension names, and the caller is told it is encrypted.
 */
function isOoxmlSpoof(error: unknown, declared: string): error is FileExtensionSpoofError {
  return error instanceof FileExtensionSpoofError && OOXML_EXTENSIONS.has(extensionOf(declared));
}

function encryptedPackageError(error: FileExtensionSpoofError, declared: string, root: CompoundFileRoot): Error {
  if (root.status !== 'read' || !ENCRYPTED_PACKAGE_ENTRIES.every((name) => root.names.has(name))) return error;
  return new EncryptedOfficeDocumentError(`The ${extensionOf(declared).toUpperCase()} file is encrypted or password protected, so its content cannot be read.`);
}

/**
 * The server side spoof check of a buffer that holds the start of a file: the signature rules of the registry, then the root
 * element of a gzipped XML format (`.svgz`, `.zabw`), which needs a decoder that the registry must not import. Every server
 * entry point that checks an upload calls this one, not the registry's `assertNotSpoofedFile`.
 */
export function assertNotSpoofedFile(buffer: Buffer | Uint8Array, declaredExtensionOrFormatId: string, filename?: string): void {
  try {
    assertSignatureMatches(buffer, declaredExtensionOrFormatId, filename);
  } catch (error) {
    throw isOoxmlSpoof(error, declaredExtensionOrFormatId) ? encryptedPackageError(error, declaredExtensionOrFormatId, readCompoundFileRoot(buffer)) : error;
  }
  assertGzippedXmlRoot(buffer, declaredExtensionOrFormatId, filename);
}

/**
 * The extension to read a directory for, when the first 64 KiB of a file cannot show the directory of a compound-only format
 * (`.sdw`, `.sdc`, `.sda`, `.shw`, `.qpw`) and the check must read the directory sectors where they lie in the file; undefined
 * otherwise. A header shorter than the window is the whole file.
 */
function compoundExtensionToRead(header: Uint8Array, declaredExtension: string): string | undefined {
  const ext = declaredExtension.toLowerCase().replace(/^\./, '').trim();
  return header.length === OBJECT_HEADER_BYTES && COMPOUND_FILE_ONLY_EXTENSIONS.has(ext) ? ext : undefined;
}

/** The file is whole here, so a root that is not of the declared kind, or that its bytes end before, is refused. */
function assertDirectoryVerdict(verdict: CompoundFileVerdict, ext: string, filename?: string): void {
  if (verdict === 'match') return;
  const nameStr = filename ? ` for file "${filename}"` : '';
  throw new FileExtensionSpoofError(
    `File spoofing rejected${nameStr}: the root of the compound file does not belong to declared format ".${ext}". Operation failed closed.`
  );
}

/**
 * The part of the spoof check for the compound-only formats that the first 64 KiB cannot decide: the directory of a larger file lies
 * past them, so it is read from the open file at the offsets of its sectors (bounded as `compound-file-kind` bounds it). Call it
 * after `assertNotSpoofedFile` has accepted `header`.
 */
function assertCompoundFileKindInFile(header: Uint8Array, declaredExtension: string, filename: string | undefined, fd: number): void {
  const ext = compoundExtensionToRead(header, declaredExtension);
  if (ext === undefined) return;
  assertDirectoryVerdict(compoundFileVerdictFrom(ext, fileSource(fd)), ext, filename);
}

function objectSource(storage: Pick<IStorageBackend, 'openReadStream'>, key: string, size: number): AsyncByteSource {
  return async (offset, length) => {
    if (offset >= size) return new Uint8Array(0);
    const bytes = await readObjectRange(storage, key, offset, Math.min(length, size - offset));
    if (!bytes) throw new Error('Stored object is unavailable. Operation failed closed.');
    return bytes;
  };
}

function fileSource(fd: number): ByteSource {
  return (offset, length) => {
    const bytes = Buffer.alloc(length);
    return bytes.subarray(0, fs.readSync(fd, bytes, 0, length, offset));
  };
}

/**
 * The same part of the spoof check for an object in a store (`stat` gave `size`), read by range requests. Every backend answers
 * `openReadStream` with a range, and the remote client refuses a store that does not honour one, so there is no backend that keeps
 * the window rule. Call it after `assertNotSpoofedFile` has accepted `header`.
 */
export async function assertCompoundFileKindInObject(
  storage: Pick<IStorageBackend, 'openReadStream'>,
  key: string,
  size: number,
  header: Uint8Array,
  declaredExtension: string,
  filename?: string
): Promise<void> {
  const ext = compoundExtensionToRead(header, declaredExtension);
  if (ext === undefined) return;
  assertDirectoryVerdict(await compoundFileVerdictFromAsync(ext, objectSource(storage, key, size)), ext, filename);
}

/** The whole spoof check of a stored object whose first 64 KiB are `header`: the signature rules, then the directory of a compound-only format read where it lies. */
export async function assertNotSpoofedObject(
  storage: Pick<IStorageBackend, 'openReadStream'>,
  key: string,
  size: number,
  header: Uint8Array,
  declaredExtension: string,
  filename?: string
): Promise<void> {
  try {
    assertNotSpoofedFile(header, declaredExtension, filename);
  } catch (error) {
    if (!isOoxmlSpoof(error, declaredExtension)) throw error;
    throw encryptedPackageError(error, declaredExtension, await readCompoundFileRootFromAsync(objectSource(storage, key, size)));
  }
  await assertCompoundFileKindInObject(storage, key, size, header, declaredExtension, filename);
}

/**
 * Asserts fail-closed that initial magic bytes of a file on disk match the declared format.
 * Only reads up to 64 KiB (65,536 bytes) header bytes without loading large files into memory; for the compound-only formats it reads
 * on, at most 256 blocks of 64 KiB, to the directory sectors that the header cannot show.
 */
export function assertNotSpoofedFilePath(
  filePath: string,
  declaredExtensionOrFormatId: string,
  filename?: string
): void {
  if (!fs.existsSync(filePath)) {
    console.error(`File not found on disk: "${filePath}". Operation failed closed.`);
    throw new Error('File not found on disk. Operation failed closed.');
  }
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    console.error(`Target path is not a regular file: "${filePath}". Operation failed closed.`);
    throw new Error('Target path is not a regular file. Operation failed closed.');
  }
  const nameStr = filename ? ` for file "${filename}"` : '';
  if (stat.size === 0) {
    const cleanExt = (declaredExtensionOrFormatId || '').toLowerCase().replace(/^\./, '').trim();
    throw new FileExtensionSpoofError(
      `File spoofing rejected${nameStr}: target file is empty (0 bytes), incompatible with declared format ".${cleanExt}". Operation failed closed.`
    );
  }
  const fd = fs.openSync(filePath, 'r');
  try {
    const headerBuf = Buffer.alloc(OBJECT_HEADER_BYTES);
    const bytesRead = fs.readSync(fd, headerBuf, 0, OBJECT_HEADER_BYTES, 0);
    const slice = bytesRead < OBJECT_HEADER_BYTES ? headerBuf.subarray(0, bytesRead) : headerBuf;

    let formatOrExt = declaredExtensionOrFormatId;
    if (formatOrExt.includes('/')) {
      const found = Object.values(FORMAT_REGISTRY).find((f) => f.mimeType === formatOrExt);
      if (found) {
        formatOrExt = found.extension;
      } else {
        const sub = formatOrExt.split('/').pop()?.toLowerCase().trim();
        formatOrExt = sub || 'bin';
      }
    }
    try {
      assertNotSpoofedFile(slice, formatOrExt, filename);
    } catch (error) {
      if (!isOoxmlSpoof(error, formatOrExt)) throw error;
      throw encryptedPackageError(error, formatOrExt, readCompoundFileRootFrom(fileSource(fd)));
    }
    assertCompoundFileKindInFile(slice, formatOrExt, filename, fd);
  } finally {
    fs.closeSync(fd);
  }
}
