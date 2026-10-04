import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import zlib from 'node:zlib';
import {
  ConversionOptions,
  ConversionResult,
  ConversionFailedError,
  ArchiveEncryptionUnavailableError,
  UnsupportedOptionError,
  ArchiveCollisionPolicy,
  ArchiveEntryMetadata,
  ArchiveInspectResponse,
  ArchiveEncryptedHeaderError,
  ArchiveEntryCollisionError,
} from '../types';
import { compressBzip2, decompressBzip2 } from './bzip2';
import { compressZstd, decompressZstd, ZSTD_MAGIC_LE } from './zstd';
import {
  compressLzma,
  compressLzma2,
  type LzmaCompressOptions,
  type LzmaCompressResult,
} from './lzma-encoder';
import {
  isSplitArchive,
  parseSplitArchivePart,
  stitchMultiVolumeArchive,
  splitArchive,
  type SplitArchivePartInfo,
  type StitchedArchiveResult,
  createVirtualSpannedStream,
  stitchMultiVolumeToDisk,
  VirtualSpannedStream,
  MultiVolumeBufferOverflowError,
  MAX_STITCH_BUFFER_SIZE,
  validateAndSortSplitParts,
  validateMultiVolumeSequence,
  type VirtualSpannedPartSource,
  type VirtualSpannedStreamOptions,
  type SpannedArchiveMetadata,
} from './archive-split';
import {
  executeSandboxedBinary,
  resolveSandboxedCommand,
  getSanitizedEnvironment,
} from '../security/process-sandbox';
import {
  compressWithZstdDict,
  decompressWithZstdDict,
  getPretrainedDictionary,
  DATA_DICTIONARY_JSON_CSV,
  OFFICE_XML_DICTIONARY,
  ZSTD_DICT_MAGIC,
  ZSTD_OFFICE_DICT_MAGIC,
  type ZstdDictOptions,
  ZstdDictionaryStreamCompressor,
  ZstdDictionaryStreamDecompressor,
  createZstdDictionaryTransformStream,
  createZstdDictionaryDecompressTransformStream,
  type ZstdDictionaryStreamOptions,
  type ZstdDictionaryDecompressOptions,
} from './zstd-dict';

export {
  compressZstd,
  decompressZstd,
  compressLzma,
  compressLzma2,
  type LzmaCompressOptions,
  type LzmaCompressResult,
  isSplitArchive,
  parseSplitArchivePart,
  stitchMultiVolumeArchive,
  splitArchive,
  type SplitArchivePartInfo,
  type StitchedArchiveResult,
  createVirtualSpannedStream,
  stitchMultiVolumeToDisk,
  VirtualSpannedStream,
  MultiVolumeBufferOverflowError,
  MAX_STITCH_BUFFER_SIZE,
  validateAndSortSplitParts,
  validateMultiVolumeSequence,
  type VirtualSpannedPartSource,
  type VirtualSpannedStreamOptions,
  type SpannedArchiveMetadata,
  compressWithZstdDict,
  decompressWithZstdDict,
  getPretrainedDictionary,
  DATA_DICTIONARY_JSON_CSV,
  OFFICE_XML_DICTIONARY,
  ZSTD_DICT_MAGIC,
  ZSTD_OFFICE_DICT_MAGIC,
  type ZstdDictOptions,
  ZstdDictionaryStreamCompressor,
  ZstdDictionaryStreamDecompressor,
  createZstdDictionaryTransformStream,
  createZstdDictionaryDecompressTransformStream,
  type ZstdDictionaryStreamOptions,
  type ZstdDictionaryDecompressOptions,
};

// Standard CRC32 table
const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC32_TABLE[i] = c >>> 0;
}

export function crc32(buf: Buffer | Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC32_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function rarHeaderCrc(headerWithoutCrc: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < headerWithoutCrc.length; i++) {
    c = CRC32_TABLE[(c ^ headerWithoutCrc[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) & 0xffff;
}

/**
 * Resolves entry collisions for archive creation based on the chosen collision policy.
 * - 'rename': appends a suffix (e.g., stem-1.ext, stem-2.ext) to conflicting files.
 * - 'error': throws ArchiveEntryCollisionError on any duplicate relative path.
 * - 'overwrite': keeps the last occurrence of the conflicting entry.
 */
export function resolveArchiveEntryCollisions(
  files: { filename: string; buffer: Buffer }[],
  policy: ArchiveCollisionPolicy = 'rename'
): { filename: string; buffer: Buffer }[] {
  if (files.length <= 1) return [...files];

  if (policy === 'overwrite') {
    const map = new Map<string, { filename: string; buffer: Buffer }>();
    for (const f of files) {
      const norm = f.filename.replace(/\\/g, '/');
      map.set(norm, { filename: norm, buffer: f.buffer });
    }
    return Array.from(map.values());
  }

  if (policy === 'error') {
    const seen = new Set<string>();
    for (const f of files) {
      const norm = f.filename.replace(/\\/g, '/');
      if (seen.has(norm)) {
        throw new ArchiveEntryCollisionError(
          `Archive entry collision detected for '${norm}' under collision policy 'error'.`
        );
      }
      seen.add(norm);
    }
    return [...files];
  }

  // policy === 'rename'
  const seen = new Set<string>();
  const result: { filename: string; buffer: Buffer }[] = [];

  for (const f of files) {
    const norm = f.filename.replace(/\\/g, '/');
    if (!seen.has(norm)) {
      seen.add(norm);
      result.push({ filename: norm, buffer: f.buffer });
      continue;
    }

    const ext = path.extname(norm);
    const dir = path.dirname(norm);
    const baseStem = path.basename(norm, ext);

    let counter = 1;
    let candidate = dir === '.' || dir === '' ? `${baseStem}-${counter}${ext}` : `${dir}/${baseStem}-${counter}${ext}`;
    while (seen.has(candidate)) {
      counter++;
      candidate = dir === '.' || dir === '' ? `${baseStem}-${counter}${ext}` : `${dir}/${baseStem}-${counter}${ext}`;
    }
    seen.add(candidate);
    result.push({ filename: candidate, buffer: f.buffer });
  }

  return result;
}

/**
 * Evaluates whether an archive entry path matches any of the provided glob patterns.
 * Supports exact paths, *, **, ?, and directory prefixes.
 */
export function matchArchiveGlob(filePath: string, patterns?: string[]): boolean {
  if (!patterns || patterns.length === 0) return true;
  const normalizedPath = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
  const baseName = path.basename(normalizedPath);

  for (const pattern of patterns) {
    if (!pattern) continue;
    const normPattern = pattern.replace(/\\/g, '/').replace(/^\/+/, '');

    if (normalizedPath === normPattern || baseName === normPattern) {
      return true;
    }

    const target = normPattern.includes('/') ? normalizedPath : baseName;

    const regexStr = '^' + normPattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '___GLOB_STAR_STAR___')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]')
      .replace(/___GLOB_STAR_STAR___/g, '.*') + '$';

    try {
      const regex = new RegExp(regexStr);
      if (regex.test(target) || regex.test(normalizedPath)) {
        return true;
      }
    } catch {}
  }

  return false;
}

function createEncryptedArchiveVia7z(
  files: { filename: string; buffer: Buffer }[],
  archiveName: string,
  archiveType: 'zip' | '7z',
  mimeType: string,
  password?: string,
  collisionPolicy?: ArchiveCollisionPolicy
): ConversionResult | null {
  const p7z = get7zBinaryPath();
  if (!p7z || !password) return null;
  if (/[\r\n\0]/.test(password)) {
    throw new ConversionFailedError('Archive password contains invalid newline or null characters.');
  }

  const resolvedFiles = resolveArchiveEntryCollisions(files, collisionPolicy || 'rename');
  const tmpDir = os.tmpdir();
  const token = crypto.randomBytes(8).toString('hex');
  const workDir = path.join(tmpDir, `easyconvert_${archiveType}_create_${Date.now()}_${token}`);
  const stagingDir = path.join(workDir, 'staging');
  fs.mkdirSync(stagingDir, { recursive: true });
  try {
    for (const f of resolvedFiles) {
      const safe = sanitizeArchivePath(f.filename) || path.basename(f.filename);
      const dest = path.join(stagingDir, safe);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, f.buffer);
    }
    const outPath = path.join(workDir, archiveName);
    const extraArgs = archiveType === '7z'
      ? ['-t7z', '-mhe=on', '-p']
      : ['-tzip', '-mem=AES256', '-p'];
    const resolved = resolveSandboxedCommand(p7z, ['a', '-y', ...extraArgs, outPath, '.'], {
      networkIsolated: true,
    });
    execFileSync(resolved.binary, resolved.args, {
      cwd: stagingDir,
      env: getSanitizedEnvironment({}, true),
      timeout: 60000,
      input: Buffer.from(`${password}\n${password}\n`),
    });
    const content = fs.readFileSync(outPath);
    return {
      buffer: content,
      mimeType,
      filename: archiveName,
      size: content.length,
    };
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
}

export async function createZipArchive(
  files: { filename: string; buffer: Buffer }[],
  options: ConversionOptions = {},
  archiveName = 'converted_files.zip'
): Promise<ConversionResult> {
  const resolvedFiles = resolveArchiveEntryCollisions(files, options.collisionPolicy || 'rename');
  if (options.password) {
    const p7z = get7zBinaryPath();
    if (!p7z) {
      throw new ArchiveEncryptionUnavailableError(
        'Archive encryption is unavailable: native 7z binary is required for encrypted ZIP archives.'
      );
    }
    const encRes = createEncryptedArchiveVia7z(
      resolvedFiles,
      archiveName,
      'zip',
      'application/zip',
      options.password,
      options.collisionPolicy
    );
    if (encRes) return encRes;
    throw new ArchiveEncryptionUnavailableError('Failed to create encrypted ZIP archive.');
  }

  const zip = new JSZip();

  for (const f of resolvedFiles) {
    zip.file(f.filename, f.buffer);
  }

  const compressionLevel = options.compressionLevel
    ? Math.max(1, Math.min(9, options.compressionLevel))
    : 6;

  const content = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: {
      level: compressionLevel,
    },
  });

  return {
    buffer: content,
    mimeType: 'application/zip',
    filename: archiveName,
    size: content.length,
  };
}

export const ARCHIVE_SECURITY_LIMITS = {
  MAX_FILES: 1000,
  MAX_UNCOMPRESSED_SIZE: 500 * 1024 * 1024, // 500MB limit
  MAX_RATIO: 100, // 100:1 compression ratio
};

/**
 * Normalizes and validates archive entry paths against Zip-Slip traversal.
 * Strips Windows drive letters, converts backslashes, collapses /./ and /../ segments.
 * Returns null if the resulting path escapes the extraction root or is invalid.
 */
export function sanitizeArchivePath(filename: string): string | null {
  const normalized = filename
    .replace(/^[a-zA-Z]:[\\/]+/, '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part !== '..' && part !== '.' && part.length > 0)
    .join('/');

  if (!normalized || normalized.startsWith('/') || normalized.includes('../')) {
    return null;
  }
  return normalized;
}

/**
 * Inspects PKZIP local file headers and central directory records for bit 0 or bit 6 encryption flags.
 */
export function isZipBufferEncrypted(buffer: Buffer): boolean {
  if (buffer.length < 30) return false;
  let pos = 0;
  while (pos + 30 <= buffer.length) {
    if (buffer[pos] === 0x50 && buffer[pos + 1] === 0x4b && buffer[pos + 2] === 0x03 && buffer[pos + 3] === 0x04) {
      const flags = buffer.readUInt16LE(pos + 6);
      if ((flags & 0x0041) !== 0) return true;
      const compSize = buffer.readUInt32LE(pos + 18);
      const fnLen = buffer.readUInt16LE(pos + 26);
      const extraLen = buffer.readUInt16LE(pos + 28);
      pos += 30 + fnLen + extraLen + compSize;
    } else {
      break;
    }
  }
  let cdPos = 0;
  while (cdPos + 46 <= buffer.length) {
    const nextCd = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), cdPos);
    if (nextCd === -1) break;
    const flags = buffer.readUInt16LE(nextCd + 8);
    if ((flags & 0x0041) !== 0) return true;
    const fnLen = buffer.readUInt16LE(nextCd + 28);
    const extraLen = buffer.readUInt16LE(nextCd + 30);
    const commentLen = buffer.readUInt16LE(nextCd + 32);
    cdPos = nextCd + 46 + fnLen + extraLen + commentLen;
  }
  return false;
}

export async function extractZipArchive(
  zipBuffer: Buffer,
  options: { password?: string; entries?: string[] } = {}
): Promise<{ filename: string; buffer: Buffer }[]> {
  if (options.password && /[\r\n\0]/.test(options.password)) {
    throw new ConversionFailedError('Archive password contains invalid newline or null characters.');
  }

  const isEncrypted = isZipBufferEncrypted(zipBuffer);
  if (isEncrypted) {
    if (!options.password) {
      throw new ConversionFailedError('ZIP archive is password protected. A password is required to extract.');
    }
    const p7z = get7zBinaryPath();
    if (p7z) {
      const tmpDir = os.tmpdir();
      const token = crypto.randomBytes(8).toString('hex');
      const workDir = path.join(tmpDir, `easyconvert_pw_${Date.now()}_${token}`);
      fs.mkdirSync(workDir, { recursive: true });
      try {
        const zipPath = path.join(workDir, 'archive.zip');
        fs.writeFileSync(zipPath, zipBuffer);
        const extractDir = path.join(workDir, 'out');
        fs.mkdirSync(extractDir, { recursive: true });
        try {
          const pwArgs = options.password ? ['-p'] : [];
          await executeSandboxedBinary(
            p7z,
            ['x', '-y', ...pwArgs, `-o${extractDir}`, zipPath],
            {
              cwd: workDir,
              timeoutMs: 60000,
              maxBuffer: ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE,
              networkIsolated: true,
              stdin: options.password ? Buffer.from(options.password + '\n') : undefined,
            }
          );
        } catch (err: any) {
          const msg = (err?.message || '') + (err?.stderr?.toString() || '');
          if (msg.includes('Wrong password') || msg.includes('Can not open encrypted') || msg.includes('Data Error')) {
            throw new ConversionFailedError('Invalid password for encrypted ZIP archive.');
          }
          throw new ConversionFailedError(`Failed to decrypt ZIP archive: ${err.message}`);
        }

        const results: { filename: string; buffer: Buffer }[] = [];
        let totalSize = 0;
        const readRec = (dir: string, prefix = '') => {
          for (const item of fs.readdirSync(dir)) {
            const full = path.join(dir, item);
            const rel = prefix ? `${prefix}/${item}` : item;
            const stat = fs.statSync(full);
            if (stat.isDirectory()) {
              readRec(full, rel);
            } else {
              if (!matchArchiveGlob(rel, options.entries)) {
                continue;
              }
              totalSize += stat.size;
              if (totalSize > ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE) {
                throw new ConversionFailedError(
                  `Archive bomb detected: uncompressed size exceeds limit of ${ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE} bytes (500MB)`
                );
              }
              results.push({ filename: rel, buffer: fs.readFileSync(full) });
            }
          }
        };
        readRec(extractDir);
        return results;
      } finally {
        try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
      }
    } else {
      throw new ConversionFailedError('Cannot extract encrypted ZIP archive: 7-Zip binary not available.');
    }
  }

  const zip = await JSZip.loadAsync(zipBuffer);
  const entries = Object.entries(zip.files).filter(([filename, f]) => !f.dir && matchArchiveGlob(filename, options.entries));

  if (entries.length > ARCHIVE_SECURITY_LIMITS.MAX_FILES) {
    throw new Error(
      `Archive bomb detected: file count (${entries.length}) exceeds limit of ${ARCHIVE_SECURITY_LIMITS.MAX_FILES}`
    );
  }

  const files: { filename: string; buffer: Buffer }[] = [];
  let totalUncompressedSize = 0;

  for (const [filename, file] of entries) {
    // Fast-path header check: if uncompressed size is recorded in header and exceeds limit
    const headerUncompressedSize = (file as any)._data?.uncompressedSize;
    if (
      typeof headerUncompressedSize === 'number' &&
      headerUncompressedSize > ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE
    ) {
      throw new Error(
        `Archive bomb detected: uncompressed size exceeds limit of ${ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE} bytes (500MB)`
      );
    }

    const chunks: Buffer[] = [];

    // Stream-check uncompressed chunks before full buffer allocation in V8 heap
    if (typeof (file as any).nodeStream === 'function') {
      await new Promise<void>((resolve, reject) => {
        const stream = (file as any).nodeStream('nodebuffer');
        let rejected = false;

        const fail = (err: Error) => {
          if (!rejected) {
            rejected = true;
            if (typeof stream.pause === 'function') stream.pause();
            if (typeof stream.destroy === 'function') stream.destroy();
            reject(err);
          }
        };

        stream.on('data', (chunk: Buffer) => {
          if (rejected) return;
          const chunkBuf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalUncompressedSize += chunkBuf.length;

          if (totalUncompressedSize > ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE) {
            fail(
              new Error(
                `Archive bomb detected: uncompressed size exceeds limit of ${ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE} bytes (500MB)`
              )
            );
            return;
          }

          if (
            zipBuffer.length > 0 &&
            totalUncompressedSize / zipBuffer.length > ARCHIVE_SECURITY_LIMITS.MAX_RATIO
          ) {
            fail(
              new Error(
                `Archive bomb detected: compression ratio (${(totalUncompressedSize / zipBuffer.length).toFixed(1)}:1) exceeds ${ARCHIVE_SECURITY_LIMITS.MAX_RATIO}:1 limit`
              )
            );
            return;
          }

          chunks.push(chunkBuf);
        });

        stream.on('error', (err: any) => {
          fail(err instanceof Error ? err : new Error(String(err)));
        });

        stream.on('end', () => {
          if (!rejected) resolve();
        });
      });
    } else {
      const buffer = await file.async('nodebuffer');
      totalUncompressedSize += buffer.length;

      if (totalUncompressedSize > ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE) {
        throw new Error(
          `Archive bomb detected: uncompressed size exceeds limit of ${ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE} bytes (500MB)`
        );
      }

      if (
        zipBuffer.length > 0 &&
        totalUncompressedSize / zipBuffer.length > ARCHIVE_SECURITY_LIMITS.MAX_RATIO
      ) {
        throw new Error(
          `Archive bomb detected: compression ratio (${(totalUncompressedSize / zipBuffer.length).toFixed(1)}:1) exceeds ${ARCHIVE_SECURITY_LIMITS.MAX_RATIO}:1 limit`
        );
      }

      chunks.push(buffer);
    }

    const buffer = Buffer.concat(chunks);

    // Zip-slip defense: sanitize path and strip leading / or drive letters or ..
    const sanitizedName = sanitizeArchivePath(filename);
    if (!sanitizedName) continue;

    files.push({ filename: sanitizedName, buffer });
  }

  return files;
}

export function createTarArchive(
  files: { filename: string; buffer: Buffer }[],
  options: ConversionOptions = {},
  archiveName = 'converted_files.tar'
): ConversionResult {
  if (options.password) {
    throw new UnsupportedOptionError('TAR archives do not support password encryption.');
  }
  const resolvedFiles = resolveArchiveEntryCollisions(files, options.collisionPolicy || 'rename');
  const blocks: Buffer[] = [];

  for (const file of resolvedFiles) {
    const header = Buffer.alloc(512);
    // name (100)
    header.write(file.filename.slice(0, 100), 0, 100, 'ascii');
    // mode (8)
    header.write('0000644\0', 100, 8, 'ascii');
    // uid (8)
    header.write('0000000\0', 108, 8, 'ascii');
    // gid (8)
    header.write('0000000\0', 116, 8, 'ascii');
    // size (12)
    const sizeOctal = file.buffer.length.toString(8).padStart(11, '0') + '\0';
    header.write(sizeOctal, 124, 12, 'ascii');
    // mtime (12)
    const mtimeOctal = Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0';
    header.write(mtimeOctal, 136, 12, 'ascii');
    // chksum placeholder (8 spaces)
    header.write('        ', 148, 8, 'ascii');
    // typeflag (1) regular file = '0'
    header.write('0', 156, 1, 'ascii');
    // magic (6) 'ustar\0'
    header.write('ustar\0', 257, 6, 'ascii');
    // version (2) '00'
    header.write('00', 263, 2, 'ascii');

    // Calculate checksum
    let chksum = 0;
    for (let i = 0; i < 512; i++) chksum += header[i];
    const chksumOctal = chksum.toString(8).padStart(6, '0') + '\0 ';
    header.write(chksumOctal, 148, 8, 'ascii');

    blocks.push(header);
    blocks.push(file.buffer);

    // Padding to 512 bytes
    const pad = (512 - (file.buffer.length % 512)) % 512;
    if (pad > 0) blocks.push(Buffer.alloc(pad));
  }

  // End of archive marker: two 512-byte zero blocks
  blocks.push(Buffer.alloc(1024));
  const buffer = Buffer.concat(blocks);

  return {
    buffer,
    mimeType: 'application/x-tar',
    filename: archiveName,
    size: buffer.length,
  };
}

export function extractTarArchive(
  tarBuffer: Buffer,
  options: { entries?: string[] } = {}
): { filename: string; buffer: Buffer }[] {
  const files: { filename: string; buffer: Buffer }[] = [];
  let offset = 0;
  let totalUncompressedSize = 0;

  while (offset + 512 <= tarBuffer.length) {
    if (files.length >= ARCHIVE_SECURITY_LIMITS.MAX_FILES) {
      throw new Error(
        `Archive bomb detected: file count exceeds limit of ${ARCHIVE_SECURITY_LIMITS.MAX_FILES}`
      );
    }

    const header = tarBuffer.subarray(offset, offset + 512);
    offset += 512;

    // Check for end of archive (all zeros)
    if (header.every((b) => b === 0)) break;

    const rawName = header.toString('ascii', 0, 100).replace(/\0.*$/, '').trim();
    if (!rawName) break;

    const sizeStr = header.toString('ascii', 124, 135).replace(/\0.*$/, '').trim();
    const size = parseInt(sizeStr, 8) || 0;

    totalUncompressedSize += size;
    if (totalUncompressedSize > ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE) {
      throw new Error(
        `Archive bomb detected: uncompressed size exceeds limit of ${ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE} bytes (500MB)`
      );
    }

    const pad = (512 - (size % 512)) % 512;
    const sanitizedName = sanitizeArchivePath(rawName);
    if (sanitizedName) {
      if (matchArchiveGlob(sanitizedName, options.entries)) {
        const fileBuf = tarBuffer.subarray(offset, offset + size);
        files.push({ filename: sanitizedName, buffer: Buffer.from(fileBuf) });
      }
    }
    offset += size + pad;
  }

  return files;
}

/**
 * @internal Creates a synthetic uncompressed RAR v2 archive buffer strictly for testing
 * archive splitting, stitching, and decompression. Production RAR creation is disabled per D8.
 */
export function buildSyntheticStoredRarBuffer(
  files: { filename: string; buffer: Buffer }[]
): Buffer {
  const blocks: Buffer[] = [];

  // 1. Marker block (7 bytes)
  blocks.push(Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]));

  // 2. Main archive header (type 0x73)
  const mainHeadData = Buffer.alloc(11);
  mainHeadData.writeUInt8(0x73, 0); // HEAD_TYPE
  mainHeadData.writeUInt16LE(0x0000, 1); // HEAD_FLAGS
  mainHeadData.writeUInt16LE(13, 3); // HEAD_SIZE = 2 (CRC) + 11 = 13
  mainHeadData.writeUInt16LE(0, 5); // RESERVED1
  mainHeadData.writeUInt32LE(0, 7); // RESERVED2

  const mainCrc = rarHeaderCrc(mainHeadData);
  const mainHead = Buffer.alloc(13);
  mainHead.writeUInt16LE(mainCrc, 0);
  mainHeadData.copy(mainHead, 2);
  blocks.push(mainHead);

  // 3. File headers and data for each file
  for (const file of files) {
    const filenameBuf = Buffer.from(file.filename, 'utf-8');
    const nameSize = filenameBuf.length;
    const headSize = 7 + 25 + nameSize; // 32 + nameSize

    const fileHeadData = Buffer.alloc(headSize - 2);
    fileHeadData.writeUInt8(0x74, 0); // HEAD_TYPE (FILE_HEAD)
    fileHeadData.writeUInt16LE(0x8000, 1); // HEAD_FLAGS (LHD_LONG_BLOCK: file data follows)
    fileHeadData.writeUInt16LE(headSize, 3); // HEAD_SIZE
    fileHeadData.writeUInt32LE(file.buffer.length, 5); // PACK_SIZE
    fileHeadData.writeUInt32LE(file.buffer.length, 9); // UNP_SIZE
    fileHeadData.writeUInt8(3, 13); // HOST_OS (Unix)
    fileHeadData.writeUInt32LE(crc32(file.buffer), 14); // FILE_CRC
    fileHeadData.writeUInt32LE(0x50000000, 18); // FTIME (standard DOS time)
    fileHeadData.writeUInt8(20, 22); // UNP_VER (2.0)
    fileHeadData.writeUInt8(0x30, 23); // METHOD (0x30 = STORE / uncompressed)
    fileHeadData.writeUInt16LE(nameSize, 24); // NAME_SIZE
    fileHeadData.writeUInt32LE(0x00000020, 26); // ATTR (archive file)
    filenameBuf.copy(fileHeadData, 30); // FILE_NAME

    const fileCrc = rarHeaderCrc(fileHeadData);
    const fileHead = Buffer.alloc(headSize);
    fileHead.writeUInt16LE(fileCrc, 0);
    fileHeadData.copy(fileHead, 2);

    blocks.push(fileHead);
    blocks.push(file.buffer);
  }

  // 4. End of archive block (type 0x7B)
  const endHeadData = Buffer.alloc(5);
  endHeadData.writeUInt8(0x7b, 0); // HEAD_TYPE (ENDARC_HEAD)
  endHeadData.writeUInt16LE(0x4000, 1); // HEAD_FLAGS
  endHeadData.writeUInt16LE(7, 3); // HEAD_SIZE
  const endCrc = rarHeaderCrc(endHeadData);
  const endHead = Buffer.alloc(7);
  endHead.writeUInt16LE(endCrc, 0);
  endHeadData.copy(endHead, 2);
  blocks.push(endHead);

  return Buffer.concat(blocks);
}

export function createRarArchive(
  files: { filename: string; buffer: Buffer }[],
  _options: ConversionOptions = {},
  _archiveName = 'converted_files.rar'
): ConversionResult {
  if (Array.isArray(files)) {
    throw new ConversionFailedError(
      "Target archive format 'rar' creation is not supported. RAR archive creation has been removed per D8; please use ZIP, 7z, or TAR."
    );
  }
  throw new ConversionFailedError(
    "Target archive format 'rar' creation is not supported. RAR archive creation has been removed per D8; please use ZIP, 7z, or TAR."
  );
}

let resolvedUnrarPath: string | null = null;
export function getUnrarBinaryPath(): string | null {
  if (resolvedUnrarPath !== null) return resolvedUnrarPath || null;
  const envPath = process.env.UNRAR_PATH;
  if (envPath && fs.existsSync(envPath)) {
    resolvedUnrarPath = envPath;
    return envPath;
  }
  const fixedLocations = [
    '/usr/bin/unrar',
    '/usr/local/bin/unrar',
    '/opt/homebrew/bin/unrar',
    '/bin/unrar',
    '/usr/bin/rar',
  ];
  for (const loc of fixedLocations) {
    if (fs.existsSync(loc)) {
      resolvedUnrarPath = loc;
      return loc;
    }
  }
  const whichBins = ['/usr/bin/which', '/bin/which'];
  for (const whichBin of whichBins) {
    if (fs.existsSync(whichBin)) {
      try {
        const out = execFileSync(whichBin, ['unrar'], { stdio: 'pipe' }).toString().trim();
        if (out && fs.existsSync(out)) {
          resolvedUnrarPath = out;
          return out;
        }
      } catch {}
    }
  }
  resolvedUnrarPath = '';
  return null;
}

export function extractRarArchive(
  rarBuffer: Buffer,
  options: { password?: string; entries?: string[] } = {}
): { filename: string; buffer: Buffer }[] {
  if (!rarBuffer || rarBuffer.length < 14) {
    throw new Error('Invalid RAR archive: buffer too small');
  }

  const isRar4 =
    rarBuffer[0] === 0x52 &&
    rarBuffer[1] === 0x61 &&
    rarBuffer[2] === 0x72 &&
    rarBuffer[3] === 0x21 &&
    rarBuffer[4] === 0x1a &&
    rarBuffer[5] === 0x07 &&
    rarBuffer[6] === 0x00;

  const isRar5 =
    rarBuffer[0] === 0x52 &&
    rarBuffer[1] === 0x61 &&
    rarBuffer[2] === 0x72 &&
    rarBuffer[3] === 0x21 &&
    rarBuffer[4] === 0x1a &&
    rarBuffer[5] === 0x07 &&
    rarBuffer[6] === 0x01 &&
    rarBuffer[7] === 0x00;

  if (!isRar4 && !isRar5) {
    throw new Error('Invalid RAR archive: signature mismatch');
  }

  if (options.password && /[\r\n\0]/.test(options.password)) {
    throw new ConversionFailedError('Archive password contains invalid newline or null characters.');
  }

  // If unrar binary is available on the system, execute under defensive limits
  const unrarBin = getUnrarBinaryPath();
  if (unrarBin) {
    const tmpDir = os.tmpdir();
    const token = crypto.randomBytes(8).toString('hex');
    const tmpFile = path.join(tmpDir, `easyconvert_rar_${Date.now()}_${token}.rar`);
    const extractDir = path.join(tmpDir, `easyconvert_rar_out_${Date.now()}_${token}`);
    fs.writeFileSync(tmpFile, rarBuffer);
    fs.mkdirSync(extractDir, { recursive: true });

    try {
      const pwArgs = options.password ? ['-p'] : ['-p-'];
      try {
        const resolved = resolveSandboxedCommand(unrarBin, ['x', '-inul', '-y', ...pwArgs, tmpFile, extractDir], {
          networkIsolated: true,
        });
        execFileSync(resolved.binary, resolved.args, {
          cwd: extractDir,
          env: getSanitizedEnvironment({}, true),
          timeout: 30000,
          maxBuffer: ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE,
          input: options.password ? Buffer.from(options.password + '\n') : undefined,
        });
      } catch (err: any) {
        const msg = (err?.message || '') + (err?.stderr?.toString() || '');
        if (msg.includes('password') || msg.includes('CRC error')) {
          throw new ConversionFailedError('Invalid password for encrypted RAR archive.');
        }
        throw err;
      }

      const extracted: { filename: string; buffer: Buffer }[] = [];
      let totalUncompressedSize = 0;

      function walkDir(dir: string, base: string) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          const relPath = base ? `${base}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            walkDir(fullPath, relPath);
          } else if (entry.isFile()) {
            if (extracted.length >= ARCHIVE_SECURITY_LIMITS.MAX_FILES) {
              throw new Error(`Archive bomb detected: file count exceeds limit of ${ARCHIVE_SECURITY_LIMITS.MAX_FILES}`);
            }
            const buf = fs.readFileSync(fullPath);
            totalUncompressedSize += buf.length;
            if (totalUncompressedSize > ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE) {
              throw new Error(`Archive bomb detected: uncompressed size exceeds limit of ${ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE} bytes (500MB)`);
            }
            if (rarBuffer.length > 0 && totalUncompressedSize / rarBuffer.length > ARCHIVE_SECURITY_LIMITS.MAX_RATIO) {
              throw new Error(`Archive bomb detected: compression ratio exceeds ${ARCHIVE_SECURITY_LIMITS.MAX_RATIO}:1 limit`);
            }
            const sanitized = sanitizeArchivePath(relPath);
            if (sanitized && matchArchiveGlob(sanitized, options.entries)) {
              extracted.push({ filename: sanitized, buffer: buf });
            }
          }
        }
      }

      walkDir(extractDir, '');
      return extracted;
    } catch (err) {
      if (err instanceof ConversionFailedError) {
        throw err;
      }
      if (err instanceof Error && err.message.includes('Archive bomb detected')) {
        throw err;
      }
      // If unrar execution failed on non-bomb error, fallback to stored extractor below
    } finally {
      try {
        if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
        if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true });
      } catch {}
    }
  }

  // Pure TypeScript parser for stored RAR archives with fail-closed validation
  if (isRar5) {
    throw new Error('Unsupported RAR format: RAR5 compressed archives require unrar decompressor');
  }

  const files: { filename: string; buffer: Buffer }[] = [];
  let offset = 7;
  let totalUncompressedSize = 0;

  while (offset + 7 <= rarBuffer.length) {
    const headType = rarBuffer[offset + 2];
    const headSize = rarBuffer.readUInt16LE(offset + 5);
    if (headSize < 7 || offset + headSize > rarBuffer.length) break;

    if (headType === 0x7b) {
      // ENDARC_HEAD
      break;
    }

    if (headType === 0x74 && offset + 32 <= rarBuffer.length) {
      if (files.length >= ARCHIVE_SECURITY_LIMITS.MAX_FILES) {
        throw new Error(`Archive bomb detected: file count exceeds limit of ${ARCHIVE_SECURITY_LIMITS.MAX_FILES}`);
      }

      const packSize = rarBuffer.readUInt32LE(offset + 7);
      const unpSize = rarBuffer.readUInt32LE(offset + 11);
      const fileCrc = rarBuffer.readUInt32LE(offset + 16);
      const method = rarBuffer[offset + 25];
      const nameSize = rarBuffer.readUInt16LE(offset + 26);

      if (unpSize > ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE) {
        throw new Error(
          `Archive bomb detected: uncompressed size exceeds limit of ${ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE} bytes (500MB)`
        );
      }

      // Enforce fail-closed verification: Method 0x30 is STORE (uncompressed)
      // Methods 0x31..0x35 are compressed and MUST NOT be sliced as raw corrupt data!
      if (method !== 0x30) {
        throw new Error(
          `Unsupported RAR compression method (0x${method.toString(16)}): unrar binary is required for compressed RAR archives`
        );
      }

      if (offset + 32 + nameSize <= rarBuffer.length) {
        const filename = rarBuffer.toString('utf-8', offset + 32, offset + 32 + nameSize);
        const sanitizedName = sanitizeArchivePath(filename);
        const dataOffset = offset + headSize;

        if (dataOffset + packSize > rarBuffer.length) {
          throw new Error('Corrupted RAR archive: truncated file data');
        }

        const fileBuf = Buffer.from(rarBuffer.subarray(dataOffset, dataOffset + packSize));

        // Verify CRC32
        const computedCrc = crc32(fileBuf);
        if (computedCrc !== fileCrc) {
          throw new Error(`Corrupted RAR archive: CRC mismatch for ${filename} (expected 0x${fileCrc.toString(16)}, got 0x${computedCrc.toString(16)})`);
        }

        totalUncompressedSize += fileBuf.length;
        if (totalUncompressedSize > ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE) {
          throw new Error(`Archive bomb detected: uncompressed size exceeds limit of ${ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE} bytes (500MB)`);
        }
        if (rarBuffer.length > 0 && totalUncompressedSize / rarBuffer.length > ARCHIVE_SECURITY_LIMITS.MAX_RATIO) {
          throw new Error(`Archive bomb detected: compression ratio exceeds ${ARCHIVE_SECURITY_LIMITS.MAX_RATIO}:1 limit`);
        }

        if (sanitizedName && matchArchiveGlob(sanitizedName, options.entries)) {
          files.push({ filename: sanitizedName, buffer: fileBuf });
        }
      }
      offset += headSize + packSize;
    } else {
      offset += headSize;
    }
  }

  return files;
}

// ============================================================================
// Pure TypeScript LZMA & LZMA2 Decompression Engine
// ============================================================================

export function decompressLzma(
  input: Buffer | Uint8Array,
  props: Buffer | Uint8Array,
  unpackSize: number
): Buffer {
  if (unpackSize === 0) {
    return Buffer.alloc(0);
  }

  if (props.length < 5) {
    throw new Error('Invalid LZMA properties header: expected at least 5 bytes');
  }

  const d = props[0];
  const lc = d % 9;
  const remainder = Math.floor(d / 9);
  const lp = remainder % 5;
  const pb = Math.floor(remainder / 5);

  let dictSize =
    ((props[1] |
      (props[2] << 8) |
      (props[3] << 16) |
      (props[4] << 24)) >>>
      0);
  if (dictSize < 4096) dictSize = 4096;

  if (unpackSize > ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE) {
    throw new Error(`Archive bomb detected: unpack size (${unpackSize}) exceeds limit of ${ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE} bytes`);
  }

  const outBuf = Buffer.alloc(unpackSize);
  let outPos = 0;
  let inPos = 0;

  function readByte(): number {
    return inPos < input.length ? input[inPos++] : 0;
  }

  // LZMA range decoder header: first byte is 0 (or ignored), then 4 bytes of initial code
  readByte();
  let code =
    (((readByte() << 24) |
      (readByte() << 16) |
      (readByte() << 8) |
      readByte()) >>>
      0);
  let range = 0xffffffff;

  function decodeBit(probs: Uint16Array, index: number): number {
    const prob = probs[index];
    const bound = (range >>> 11) * prob;
    if ((code >>> 0) < (bound >>> 0)) {
      range = bound >>> 0;
      probs[index] = (prob + ((2048 - prob) >>> 5)) & 0xffff;
      if (range < 0x01000000) {
        code = (((code << 8) | readByte()) >>> 0);
        range = ((range << 8) >>> 0);
      }
      return 0;
    } else {
      range = ((range - bound) >>> 0);
      code = ((code - bound) >>> 0);
      probs[index] = (prob - (prob >>> 5)) & 0xffff;
      if (range < 0x01000000) {
        code = (((code << 8) | readByte()) >>> 0);
        range = ((range << 8) >>> 0);
      }
      return 1;
    }
  }

  function decodeDirectBits(numBits: number): number {
    let res = 0;
    for (let i = 0; i < numBits; i++) {
      range >>>= 1;
      code = ((code - range) >>> 0);
      const t = (code >> 31) & 1;
      if (t !== 0) {
        code = ((code + range) >>> 0);
      }
      if (range < 0x01000000) {
        code = (((code << 8) | readByte()) >>> 0);
        range = ((range << 8) >>> 0);
      }
      res = (res << 1) | (1 - t);
    }
    return res >>> 0;
  }

  function decodeBitTree(probs: Uint16Array, offset: number, numBits: number): number {
    let m = 1;
    for (let i = 0; i < numBits; i++) {
      m = (m << 1) | decodeBit(probs, offset + m);
    }
    return m - (1 << numBits);
  }

  function decodeReverseBitTree(probs: Uint16Array, offset: number, numBits: number): number {
    let m = 1;
    let symbol = 0;
    for (let i = 0; i < numBits; i++) {
      const bit = decodeBit(probs, offset + m);
      m = (m << 1) | bit;
      symbol |= (bit << i);
    }
    return symbol;
  }

  // Model arrays
  const isMatch = new Uint16Array(12 * 16).fill(1024);
  const isRep = new Uint16Array(12).fill(1024);
  const isRepG0 = new Uint16Array(12).fill(1024);
  const isRepG1 = new Uint16Array(12).fill(1024);
  const isRepG2 = new Uint16Array(12).fill(1024);
  const isRep0Long = new Uint16Array(12 * 16).fill(1024);
  const posSlot = new Uint16Array(4 * 64).fill(1024);
  const specPos = new Uint16Array(128).fill(1024);
  const align = new Uint16Array(16).fill(1024);

  class LenDecoder {
    choice1 = new Uint16Array(1).fill(1024);
    choice2 = new Uint16Array(1).fill(1024);
    low = new Uint16Array(16 * 8).fill(1024);
    mid = new Uint16Array(16 * 8).fill(1024);
    high = new Uint16Array(256).fill(1024);

    decode(posState: number): number {
      if (decodeBit(this.choice1, 0) === 0) {
        return decodeBitTree(this.low, posState * 8, 3);
      }
      if (decodeBit(this.choice2, 0) === 0) {
        return 8 + decodeBitTree(this.mid, posState * 8, 3);
      }
      return 16 + decodeBitTree(this.high, 0, 8);
    }
  }

  const lenDecoder = new LenDecoder();
  const repLenDecoder = new LenDecoder();

  const numLitContexts = 1 << (lc + lp);
  const litProbs = new Uint16Array(numLitContexts * 0x300).fill(1024);

  let state = 0;
  let rep0 = 0;
  let rep1 = 0;
  let rep2 = 0;
  let rep3 = 0;

  const posStateMask = (1 << pb) - 1;

  while (outPos < unpackSize) {
    const posState = outPos & posStateMask;
    const isMatchIdx = (state << 4) + posState;

    if (decodeBit(isMatch, isMatchIdx) === 0) {
      // Literal
      const prevByte = outPos > 0 ? outBuf[outPos - 1] : 0;
      const litContext = (((outPos & ((1 << lp) - 1)) << lc) | (prevByte >> (8 - lc)));
      const baseIdx = litContext * 0x300;

      let symbol = 1;
      if (state >= 7) {
        let matchByte = outPos > rep0 ? outBuf[outPos - rep0 - 1] : 0;
        let matchMode = true;
        while (symbol < 0x100) {
          matchByte <<= 1;
          const matchBit = (matchByte >> 8) & 1;
          const probIdx = matchMode
            ? baseIdx + 0x100 + (matchBit << 8) + symbol
            : baseIdx + symbol;
          const bit = decodeBit(litProbs, probIdx);
          symbol = (symbol << 1) | bit;
          if (matchMode && bit !== matchBit) {
            matchMode = false;
          }
        }
      } else {
        while (symbol < 0x100) {
          symbol = (symbol << 1) | decodeBit(litProbs, baseIdx + symbol);
        }
      }

      outBuf[outPos++] = (symbol - 0x100) & 0xff;
      if (state < 4) {
        state = 0;
      } else if (state < 10) {
        state -= 3;
      } else {
        state -= 6;
      }
    } else {
      // Match or Rep
      let len = 0;
      if (decodeBit(isRep, state) === 1) {
        if (decodeBit(isRepG0, state) === 0) {
          if (decodeBit(isRep0Long, (state << 4) + posState) === 0) {
            // Short Rep
            state = state < 7 ? 9 : 11;
            outBuf[outPos] = outBuf[outPos - rep0 - 1];
            outPos++;
            continue;
          }
        } else {
          let dist = 0;
          if (decodeBit(isRepG1, state) === 0) {
            dist = rep1;
          } else {
            if (decodeBit(isRepG2, state) === 0) {
              dist = rep2;
            } else {
              dist = rep3;
              rep3 = rep2;
            }
            rep2 = rep1;
          }
          rep1 = rep0;
          rep0 = dist;
        }
        len = repLenDecoder.decode(posState) + 2;
        state = state < 7 ? 8 : 11;
      } else {
        // Simple match
        rep3 = rep2;
        rep2 = rep1;
        rep1 = rep0;
        len = lenDecoder.decode(posState) + 2;
        state = state < 7 ? 7 : 10;

        const lenToPosState = Math.min(len - 2, 3);
        const slot = decodeBitTree(posSlot, lenToPosState * 64, 6);
        if (slot >= 4) {
          const numDirectBits = (slot >> 1) - 1;
          rep0 = ((2 | (slot & 1)) << numDirectBits);
          if (slot < 14) {
            rep0 += decodeReverseBitTree(specPos, rep0 - slot - 1, numDirectBits);
          } else {
            rep0 += (decodeDirectBits(numDirectBits - 4) << 4);
            rep0 += decodeReverseBitTree(align, 0, 4);
          }
        } else {
          rep0 = slot;
        }
        if (rep0 === 0xffffffff) {
          break;
        }
      }

      if (rep0 >= outPos) {
        throw new Error(`Corrupted LZMA stream: rep distance ${rep0} exceeds available decoded data (${outPos})`);
      }

      const copyLen = Math.min(len, unpackSize - outPos);
      for (let i = 0; i < copyLen; i++) {
        outBuf[outPos] = outBuf[outPos - rep0 - 1];
        outPos++;
      }
    }
  }

  return outBuf.subarray(0, outPos);
}

export function decompressLzma2(
  input: Buffer | Uint8Array,
  props: Buffer | Uint8Array,
  unpackSize: number
): Buffer {
  const outBuf = Buffer.alloc(unpackSize);
  let outPos = 0;
  let inPos = 0;
  let curProps = Buffer.from([0x5d, 0, 0, 0, 0]);

  while (inPos < input.length && outPos < unpackSize) {
    const control = input[inPos++];
    if (control === 0) break; // EOS

    if (control === 1 || control === 2) {
      // Uncompressed chunk
      const chunkSize = ((input[inPos++] << 8) | input[inPos++]) + 1;
      for (let i = 0; i < chunkSize && inPos < input.length && outPos < unpackSize; i++) {
        outBuf[outPos++] = input[inPos++];
      }
    } else if (control >= 0x80) {
      // LZMA chunk
      const chunkUnpackSize = (((control & 0x1f) << 16) | (input[inPos++] << 8) | input[inPos++]) + 1;
      const chunkPackSize = ((input[inPos++] << 8) | input[inPos++]) + 1;

      const mode = (control >> 5) & 3;
      if (mode === 2 || mode === 3) {
        const propByte = input[inPos++];
        curProps = Buffer.from([propByte, 0, 0, 0, 0]);
      }

      const chunkData = input.subarray(inPos, inPos + chunkPackSize);
      inPos += chunkPackSize;

      const decoded = decompressLzma(chunkData, curProps, chunkUnpackSize);
      decoded.copy(outBuf, outPos);
      outPos += decoded.length;
    } else {
      break;
    }
  }

  return outBuf.subarray(0, outPos);
}

// ==========================================
// Native XZ & 7-Zip Toolchain Resolvers
// ==========================================
let resolvedXzPath: string | null = null;
export function getXzBinaryPath(): string | null {
  if (resolvedXzPath !== null) return resolvedXzPath || null;
  const fixedLocations = [
    '/usr/bin/xz',
    '/usr/local/bin/xz',
    '/opt/homebrew/bin/xz',
  ];
  for (const loc of fixedLocations) {
    if (fs.existsSync(loc)) {
      resolvedXzPath = loc;
      return loc;
    }
  }
  const whichBins = ['/usr/bin/which', '/bin/which'];
  for (const whichBin of whichBins) {
    if (fs.existsSync(whichBin)) {
      try {
        const out = execFileSync(whichBin, ['xz'], { stdio: 'pipe' }).toString().trim();
        if (out && fs.existsSync(out)) {
          resolvedXzPath = out;
          return out;
        }
      } catch {}
    }
  }
  resolvedXzPath = '';
  return null;
}

let resolved7zPath: string | null = null;
export function get7zBinaryPath(): string | null {
  const envOverride = process.env.P7ZIP_PATH ?? process.env.P7Z_PATH;
  if (envOverride !== undefined) {
    if (path.isAbsolute(envOverride) && fs.existsSync(envOverride)) {
      return envOverride;
    }
    return null;
  }
  if (resolved7zPath !== null) return resolved7zPath || null;
  const fixedLocations = [
    '/usr/bin/7z',
    '/usr/local/bin/7z',
    '/opt/homebrew/bin/7z',
    '/usr/bin/7za',
    '/usr/local/bin/7za',
    '/opt/homebrew/bin/7za',
    '/usr/bin/7zr',
    '/usr/local/bin/7zr',
    '/opt/homebrew/bin/7zr',
  ];
  for (const loc of fixedLocations) {
    if (fs.existsSync(loc)) {
      resolved7zPath = loc;
      return loc;
    }
  }
  const whichBins = ['/usr/bin/which', '/bin/which'];
  for (const whichBin of whichBins) {
    if (fs.existsSync(whichBin)) {
      for (const cmd of ['7z', '7za', '7zr']) {
        try {
          const out = execFileSync(whichBin, [cmd], { stdio: 'pipe' }).toString().trim();
          if (out && fs.existsSync(out)) {
            resolved7zPath = out;
            return out;
          }
        } catch {}
      }
    }
  }
  resolved7zPath = '';
  return null;
}

function encodeXzVarint(val: number): Buffer {
  const bytes: number[] = [];
  let v = val;
  while (v >= 0x80) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v & 0x7f);
  return Buffer.from(bytes);
}

/**
 * Pure TypeScript Authentic XZ Container Packager (The .xz File Format 1.1.0)
 */
export function packXz(uncompressed: Buffer): Buffer {
  const chunks: Buffer[] = [];
  const magic = Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]);
  const streamFlags = Buffer.from([0x00, 0x01]); // CRC32 check
  const flagsCrc = Buffer.alloc(4);
  flagsCrc.writeUInt32LE(crc32(streamFlags), 0);
  chunks.push(magic, streamFlags, flagsCrc);

  const bhNoCrc = Buffer.from([0x02, 0x00, 0x21, 0x01, 0x14, 0x00, 0x00, 0x00]);
  const bhCrc = Buffer.alloc(4);
  bhCrc.writeUInt32LE(crc32(bhNoCrc), 0);
  const blockHeader = Buffer.concat([bhNoCrc, bhCrc]);
  chunks.push(blockHeader);

  const lzma2 = compressLzma2(uncompressed);
  chunks.push(lzma2.buffer);

  const padLen = (4 - (lzma2.buffer.length % 4)) % 4;
  if (padLen > 0) chunks.push(Buffer.alloc(padLen, 0));

  const checkBuf = Buffer.alloc(4);
  checkBuf.writeUInt32LE(crc32(uncompressed), 0);
  chunks.push(checkBuf);

  const unpaddedSize = blockHeader.length + lzma2.buffer.length + 4;
  const idxIndicator = Buffer.from([0x00]);
  const numRecords = encodeXzVarint(1);
  const unpaddedVarint = encodeXzVarint(unpaddedSize);
  const uncompressedVarint = encodeXzVarint(uncompressed.length);
  const idxBody = Buffer.concat([idxIndicator, numRecords, unpaddedVarint, uncompressedVarint]);
  const idxPadLen = (4 - (idxBody.length % 4)) % 4;
  const idxPad = Buffer.alloc(idxPadLen, 0);
  const idxNoCrc = Buffer.concat([idxBody, idxPad]);
  const idxCrc = Buffer.alloc(4);
  idxCrc.writeUInt32LE(crc32(idxNoCrc), 0);
  const indexTotal = Buffer.concat([idxNoCrc, idxCrc]);
  chunks.push(indexTotal);

  const backwardSize = (indexTotal.length / 4) - 1;
  const footerBeforeCrc = Buffer.alloc(6);
  footerBeforeCrc.writeUInt32LE(backwardSize, 0);
  footerBeforeCrc[4] = streamFlags[0];
  footerBeforeCrc[5] = streamFlags[1];
  const footerCrc = Buffer.alloc(4);
  footerCrc.writeUInt32LE(crc32(footerBeforeCrc), 0);
  const footerMagic = Buffer.from([0x59, 0x5a]);
  chunks.push(footerCrc, footerBeforeCrc, footerMagic);

  return Buffer.concat(chunks);
}

/**
 * Pure TypeScript Authentic XZ Container Unpacker
 */
export function unpackXz(buf: Buffer): Buffer {
  if (buf.length < 32) throw new Error('Invalid XZ archive: buffer too small');
  const magic = Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]);
  if (!buf.subarray(0, 6).equals(magic)) throw new Error('Invalid XZ archive: magic number mismatch');

  const streamFlags = buf.subarray(6, 8);
  const expectedFlagsCrc = buf.readUInt32LE(8);
  if (crc32(streamFlags) !== expectedFlagsCrc) throw new Error('Invalid XZ archive: header CRC mismatch');

  const offset = 12;
  if (offset >= buf.length) throw new Error('Invalid XZ archive: truncated block header');
  const bhSizeEncoded = buf[offset];
  const bhSize = (bhSizeEncoded + 1) * 4;
  if (offset + bhSize > buf.length) throw new Error('Invalid XZ archive: truncated block header');
  const bhNoCrc = buf.subarray(offset, offset + bhSize - 4);
  const expectedBhCrc = buf.readUInt32LE(offset + bhSize - 4);
  if (crc32(bhNoCrc) !== expectedBhCrc) throw new Error('Invalid XZ archive: block header CRC mismatch');

  const lzma2Payload = buf.subarray(offset + bhSize);

  const footerMagic = buf.subarray(buf.length - 2);
  if (!footerMagic.equals(Buffer.from([0x59, 0x5a]))) throw new Error('Invalid XZ archive: footer magic mismatch');

  const footerBeforeCrc = buf.subarray(buf.length - 8, buf.length - 2);
  const expectedFooterCrc = buf.readUInt32LE(buf.length - 12);
  if (crc32(footerBeforeCrc) !== expectedFooterCrc) {
    throw new Error('Invalid XZ archive: footer CRC mismatch');
  }
  if (footerBeforeCrc[4] !== streamFlags[0] || footerBeforeCrc[5] !== streamFlags[1]) {
    throw new Error('Invalid XZ archive: stream flags mismatch between header and footer');
  }

  const backwardSize = buf.readUInt32LE(buf.length - 8);
  const indexSize = (backwardSize + 1) * 4;
  if (buf.length < 12 + indexSize + 12) throw new Error('Invalid XZ archive: invalid index size');
  const indexOffset = buf.length - 12 - indexSize;
  const indexBuf = buf.subarray(indexOffset, indexOffset + indexSize);

  const expectedIndexCrc = indexBuf.readUInt32LE(indexBuf.length - 4);
  const indexBodyNoCrc = indexBuf.subarray(0, indexBuf.length - 4);
  if (crc32(indexBodyNoCrc) !== expectedIndexCrc) {
    throw new Error('Invalid XZ archive: index CRC mismatch');
  }

  let idxCur = 1;
  while (idxCur < indexBuf.length) {
    const b = indexBuf[idxCur++];
    if ((b & 0x80) === 0) break;
  }
  while (idxCur < indexBuf.length) {
    const b = indexBuf[idxCur++];
    if ((b & 0x80) === 0) break;
  }
  let uncompressedSize = 0;
  let shift = 0;
  while (idxCur < indexBuf.length) {
    const b = indexBuf[idxCur++];
    uncompressedSize |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }

  const checkCrc = buf.readUInt32LE(indexOffset - 4);
  const props = Buffer.from([0x14]);
  const uncompressed = decompressLzma2(lzma2Payload, props, uncompressedSize || ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE);
  if (crc32(uncompressed) !== checkCrc) {
    throw new Error('Invalid XZ archive: payload CRC32 mismatch');
  }
  return uncompressed;
}

export function compressXz(inputBuffer: Buffer, options: ConversionOptions = {}): Buffer {
  const xzBin = getXzBinaryPath();
  if (xzBin) {
    try {
      const level = options.compressionLevel ? Math.max(0, Math.min(9, options.compressionLevel)) : 6;
      return execFileSync(xzBin, [`-${level}`, '-c', '-q'], {
        input: inputBuffer,
        maxBuffer: ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE,
      });
    } catch {}
  }
  return packXz(inputBuffer);
}

export function decompressXz(inputBuffer: Buffer): Buffer {
  if (inputBuffer.length < 32) {
    throw new Error('Invalid XZ archive: buffer too small');
  }
  const xzBin = getXzBinaryPath();
  if (xzBin) {
    try {
      return execFileSync(xzBin, ['-d', '-c', '-q'], {
        input: inputBuffer,
        maxBuffer: ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE,
      });
    } catch {}
  }
  return unpackXz(inputBuffer);
}

export function convertWithNative7z(
  inputBuffer: Buffer,
  sourceFormat: string,
  targetFormat: string,
  options: ConversionOptions = {},
  originalFilename = 'file'
): ConversionResult | null {
  const tgt = targetFormat.toLowerCase();
  if (options.password && /[\r\n\0]/.test(options.password)) {
    throw new ConversionFailedError('Archive password contains invalid newline or null characters.');
  }

  if (options.password && tgt !== 'zip' && tgt !== '7z') {
    throw new UnsupportedOptionError(`Target archive format '${tgt}' does not support password encryption.`);
  }

  const p7zBin = get7zBinaryPath();
  if (!p7zBin) {
    if (options.password) {
      throw new ArchiveEncryptionUnavailableError(
        'Archive encryption is unavailable: native 7z binary is required for encrypted archives.'
      );
    }
    return null;
  }

  // Delegate zstd dictionary-trained frames or custom zstd streams to authentic TS engine
  if (
    options.zstdDict ||
    sourceFormat.includes('zst') ||
    sourceFormat.includes('zstd') ||
    targetFormat.includes('zst') ||
    targetFormat.includes('zstd')
  ) {
    return null;
  }

  const src = sourceFormat.toLowerCase().trim();
  const baseName = originalFilename ? originalFilename.replace(/\.[^/.]+$/, '') : 'converted';

  const supportedExtract = new Set([
    'zip', '7z', 'rar', 'tar', 'gz', 'gzip', 'tgz', 'tar.gz',
    'bz2', 'bzip2', 'tbz2', 'tar.bz2', 'xz', 'txz', 'tar.xz',
  ]);

  const supportedTargets = new Set([
    '7z', 'zip', 'tar', 'tar.gz', 'tgz', 'tar.bz2', 'tbz2', 'tbz', 'tar.xz', 'txz',
  ]);

  if (!supportedTargets.has(tgt)) {
    return null;
  }

  const tmpDir = os.tmpdir();
  const token = crypto.randomBytes(8).toString('hex');
  const workDir = path.join(tmpDir, `easyconvert_7z_${Date.now()}_${token}`);
  fs.mkdirSync(workDir, { recursive: true });

  try {
    const inputExt = src.startsWith('tar.') ? src : (src.includes('.') ? src.split('.').pop()! : src);
    const inputPath = path.join(workDir, `input.${inputExt}`);
    fs.writeFileSync(inputPath, inputBuffer);

    const extractDir = path.join(workDir, 'extracted');
    fs.mkdirSync(extractDir, { recursive: true });

    if (options.password && /[\r\n\0]/.test(options.password)) {
      throw new ConversionFailedError('Archive password contains invalid newline or null characters.');
    }

    const pwExtractArgs = options.password ? ['-p'] : [];
    if (supportedExtract.has(src)) {
      try {
        const resolved = resolveSandboxedCommand(p7zBin, ['x', '-y', ...pwExtractArgs, `-o${extractDir}`, inputPath], {
          networkIsolated: true,
        });
        execFileSync(resolved.binary, resolved.args, {
          cwd: workDir,
          env: getSanitizedEnvironment({}, true),
          timeout: 60000,
          maxBuffer: ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE,
          input: options.password ? Buffer.from(options.password + '\n') : undefined,
        });
      } catch (err: any) {
        const msg = (err?.message || '') + (err?.stderr?.toString() || '');
        if (msg.includes('Wrong password') || msg.includes('Can not open encrypted') || msg.includes('Data Error')) {
          throw new ConversionFailedError(`Invalid password for encrypted ${src.toUpperCase()} archive.`);
        }
        throw err;
      }

      // If extracting a compressed tarball (tar.gz, tar.bz2, tar.xz, tgz, etc.), 7-Zip produces an intermediate .tar archive
      if (src.startsWith('tar.') || src === 'tgz' || src === 'tbz2' || src === 'tbz' || src === 'txz') {
        const intermediateTar = path.join(extractDir, 'input.tar');
        const intermediateNoExt = path.join(extractDir, 'input');
        const tarToExtract = fs.existsSync(intermediateTar) ? intermediateTar : (fs.existsSync(intermediateNoExt) ? intermediateNoExt : null);
        if (tarToExtract) {
          const rTarExt = resolveSandboxedCommand(p7zBin, ['x', '-y', `-o${extractDir}`, tarToExtract], {
            networkIsolated: true,
          });
          execFileSync(rTarExt.binary, rTarExt.args, {
            cwd: workDir,
            env: getSanitizedEnvironment({}, true),
            timeout: 60000,
            maxBuffer: ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE,
          });
          try { fs.unlinkSync(tarToExtract); } catch {}
        }
      }
    } else {
      const destPath = path.join(extractDir, originalFilename || `file.${src}`);
      fs.writeFileSync(destPath, inputBuffer);
    }

    const extractedFiles = fs.readdirSync(extractDir);
    if (extractedFiles.length === 0) return null;

    let totalExtractedSize = 0;
    const computeDirSize = (dir: string) => {
      for (const item of fs.readdirSync(dir)) {
        const full = path.join(dir, item);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
          computeDirSize(full);
        } else {
          totalExtractedSize += stat.size;
        }
      }
    };
    computeDirSize(extractDir);

    if (totalExtractedSize > ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE) {
      throw new ConversionFailedError(
        `Archive bomb detected: uncompressed size exceeds limit of ${ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE} bytes (500MB)`
      );
    }
    if (inputBuffer.length > 0 && totalExtractedSize / inputBuffer.length > ARCHIVE_SECURITY_LIMITS.MAX_RATIO) {
      throw new ConversionFailedError(
        `Archive bomb detected: compression ratio exceeds ${ARCHIVE_SECURITY_LIMITS.MAX_RATIO}:1 limit`
      );
    }


    const pwCreateArgs: string[] = [];
    if (options.password) {
      if (tgt === '7z') {
        pwCreateArgs.push('-mhe=on', '-p');
      } else if (tgt === 'zip') {
        pwCreateArgs.push('-mem=AES256', '-p');
      }
    }
    const pwCreateInput =
      options.password && (tgt === 'zip' || tgt === '7z')
        ? Buffer.from(`${options.password}\n${options.password}\n`)
        : undefined;
    const outputPath = path.join(workDir, `output.${tgt}`);
    if (tgt === 'tar.gz' || tgt === 'tgz') {
      const tarPath = path.join(workDir, 'archive.tar');
      const rTar = resolveSandboxedCommand(p7zBin, ['a', '-y', '-ttar', tarPath, '.'], { networkIsolated: true });
      execFileSync(rTar.binary, rTar.args, { cwd: extractDir, env: getSanitizedEnvironment({}, true), timeout: 60000 });
      const rGz = resolveSandboxedCommand(p7zBin, ['a', '-y', '-tgzip', outputPath, tarPath], { networkIsolated: true });
      execFileSync(rGz.binary, rGz.args, { cwd: workDir, env: getSanitizedEnvironment({}, true), timeout: 60000 });
    } else if (tgt === 'tar.bz2' || tgt === 'tbz2' || tgt === 'tbz') {
      const tarPath = path.join(workDir, 'archive.tar');
      const rTar = resolveSandboxedCommand(p7zBin, ['a', '-y', '-ttar', tarPath, '.'], { networkIsolated: true });
      execFileSync(rTar.binary, rTar.args, { cwd: extractDir, env: getSanitizedEnvironment({}, true), timeout: 60000 });
      const rBz = resolveSandboxedCommand(p7zBin, ['a', '-y', '-tbzip2', outputPath, tarPath], { networkIsolated: true });
      execFileSync(rBz.binary, rBz.args, { cwd: workDir, env: getSanitizedEnvironment({}, true), timeout: 60000 });
    } else if (tgt === 'tar.xz' || tgt === 'txz') {
      const tarPath = path.join(workDir, 'archive.tar');
      const rTar = resolveSandboxedCommand(p7zBin, ['a', '-y', '-ttar', tarPath, '.'], { networkIsolated: true });
      execFileSync(rTar.binary, rTar.args, { cwd: extractDir, env: getSanitizedEnvironment({}, true), timeout: 60000 });
      const rXz = resolveSandboxedCommand(p7zBin, ['a', '-y', '-txz', outputPath, tarPath], { networkIsolated: true });
      execFileSync(rXz.binary, rXz.args, { cwd: workDir, env: getSanitizedEnvironment({}, true), timeout: 60000 });
    } else if (tgt === '7z' || tgt === 'zip' || tgt === 'tar') {
      const rCreate = resolveSandboxedCommand(p7zBin, ['a', '-y', `-t${tgt}`, ...pwCreateArgs, outputPath, '.'], { networkIsolated: true });
      execFileSync(rCreate.binary, rCreate.args, {
        cwd: extractDir,
        env: getSanitizedEnvironment({}, true),
        timeout: 60000,
        input: pwCreateInput,
      });
    } else {
      return null;
    }

    if (!fs.existsSync(outputPath)) return null;
    const outputBuffer = fs.readFileSync(outputPath);

    let mime = 'application/octet-stream';
    if (tgt === 'zip') mime = 'application/zip';
    else if (tgt === '7z') mime = 'application/x-7z-compressed';
    else if (tgt === 'tar') mime = 'application/x-tar';
    else if (tgt === 'tar.gz' || tgt === 'tgz') mime = 'application/gzip';
    else if (tgt === 'tar.bz2' || tgt === 'tbz2' || tgt === 'tbz') mime = 'application/x-bzip-compressed-tar';
    else if (tgt === 'tar.xz' || tgt === 'txz') mime = 'application/x-xz-compressed-tar';

    return {
      buffer: outputBuffer,
      mimeType: mime,
      filename: `${baseName}.${tgt}`,
      size: outputBuffer.length,
    };
  } catch (err) {
    if (err instanceof ConversionFailedError) {
      throw err;
    }
    return null;
  } finally {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {}
  }
}

/**
 * Extracts a multi-volume split archive directly using Virtual Spanned Stream and 7-Zip CLI.
 * Attempts zero-disk stdin streaming extraction via `7z x -si{name}`, falling back to
 * zero-memory disk streaming spooling (`stitchMultiVolumeToDisk`) if seek-heavy container random access is required.
 */
export async function extractWithSpannedStream7z(
  parts: Array<string | VirtualSpannedPartSource | { filename: string; buffer: Buffer }>,
  extractDir: string,
  options: {
    timeoutMs?: number;
    maxBuffer?: number;
    password?: string;
  } = {}
): Promise<{ extractedFiles: string[]; totalBytes: number; baseFilename: string }> {
  const p7zBin = get7zBinaryPath();
  if (!p7zBin) {
    throw new Error('7-Zip binary (7z/7za/7zr) not found on system.');
  }

  const { sortedParts, metadata } = validateAndSortSplitParts(parts);
  const resolvedExtractDir = path.resolve(extractDir);
  if (!fs.existsSync(resolvedExtractDir)) {
    fs.mkdirSync(resolvedExtractDir, { recursive: true });
  }

  const timeoutMs = options.timeoutMs ?? 60000;
  const maxBuffer = options.maxBuffer ?? ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE;
  const passwordArgs = options.password ? ['-p'] : [];
  const formatMap: Record<string, string> = {
    tar: 'tar',
    zip: 'zip',
    '7z': '7z',
    rar: 'rar',
  };
  const typeFlag = formatMap[metadata.format] ? [`-t${formatMap[metadata.format]}`] : [];

  const isStreamableFormat = metadata.format === 'tar' || metadata.format === 'numeric';
  let extractionSuccess = false;

  // Strategy 1: Stdin streaming extraction via 7z x -si{baseFilename} for streamable archive formats
  if (isStreamableFormat) {
    try {
      const { stream } = createVirtualSpannedStream(sortedParts);
      await executeSandboxedBinary(
        p7zBin,
        ['x', '-y', `-si${metadata.baseFilename}`, ...typeFlag, `-o${resolvedExtractDir}`, ...passwordArgs],
        {
          cwd: resolvedExtractDir,
          stdin: stream,
          timeoutMs,
          maxBuffer,
          networkIsolated: true,
        }
      );
      extractionSuccess = true;
    } catch {
      extractionSuccess = false;
      // Clean partially extracted entries before fallback
      try {
        const existing = fs.readdirSync(resolvedExtractDir);
        for (const item of existing) {
          fs.rmSync(path.join(resolvedExtractDir, item), { recursive: true, force: true });
        }
      } catch {}
    }
  }

  // Strategy 2: If stdin streaming is not supported or rejected by container format (e.g. 7z/zip/rar central directories),
  // spool to temporary disk file in O(1) memory via stitchMultiVolumeToDisk
  if (!extractionSuccess) {
    const tmpDir = os.tmpdir();
    const uniqueSuffix = crypto.randomBytes(6).toString('hex');
    const tempDiskFile = path.join(tmpDir, `spanned_stitch_${Date.now()}_${uniqueSuffix}_${metadata.baseFilename}`);
    try {
      await stitchMultiVolumeToDisk(sortedParts, tempDiskFile);
      await executeSandboxedBinary(
        p7zBin,
        ['x', '-y', ...typeFlag, `-o${resolvedExtractDir}`, tempDiskFile, ...passwordArgs],
        {
          cwd: resolvedExtractDir,
          stdin: options.password ? Buffer.from(options.password + '\n') : undefined,
          timeoutMs,
          maxBuffer,
          networkIsolated: true,
        }
      );
    } finally {
      try {
        if (fs.existsSync(tempDiskFile)) {
          fs.unlinkSync(tempDiskFile);
        }
      } catch {}
    }
  }

  // Scan extracted files and enforce archive bomb limits
  const extractedFiles: string[] = [];
  let totalBytes = 0;

  const scanDir = (dir: string, prefix = '') => {
    for (const item of fs.readdirSync(dir)) {
      const fullPath = path.join(dir, item);
      const relPath = prefix ? `${prefix}/${item}` : item;
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        scanDir(fullPath, relPath);
      } else {
        extractedFiles.push(relPath);
        totalBytes += stat.size;
      }
    }
  };

  scanDir(resolvedExtractDir);

  if (totalBytes > ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE) {
    throw new ConversionFailedError(
      `Archive bomb detected: uncompressed size exceeds limit of ${ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE} bytes (500MB)`
    );
  }

  return {
    extractedFiles,
    totalBytes,
    baseFilename: metadata.baseFilename,
  };
}

export function write7zVarint(arr: number[], value: number): void {
  if (value < 0x80) {
    arr.push(value);
    return;
  }
  let extraBytes = 8;
  for (let i = 1; i <= 7; i++) {
    if (value < Math.pow(2, 7 * (i + 1))) {
      extraBytes = i;
      break;
    }
  }
  const firstByteMask = (0xff00 >> extraBytes) & 0xff;
  const highBits = Math.floor(value / Math.pow(2, extraBytes * 8)) & (0x7f >> extraBytes);
  arr.push(firstByteMask | highBits);
  let temp = value;
  for (let b = 0; b < extraBytes; b++) {
    arr.push(temp % 256);
    temp = Math.floor(temp / 256);
  }
}

export function read7zVarint(
  buf: Buffer | Uint8Array,
  offset: number
): { value: number; nextOffset: number } {
  if (offset >= buf.length) {
    return { value: 0, nextOffset: offset };
  }
  const firstByte = buf[offset++];
  let mask = 0x80;
  let value = 0;
  for (let i = 0; i < 8; i++) {
    if ((firstByte & mask) === 0) {
      const highPart = firstByte & (mask - 1);
      value += highPart * Math.pow(2, i * 8);
      return { value, nextOffset: offset };
    }
    if (offset >= buf.length) {
      return { value, nextOffset: offset };
    }
    value += buf[offset++] * Math.pow(2, i * 8);
    mask >>= 1;
  }
  return { value, nextOffset: offset };
}

// ============================================================================
// 7z Archive Creation with Authentic Compression
// ============================================================================

export function create7zArchive(
  files: { filename: string; buffer: Buffer }[],
  options: ConversionOptions = {},
  archiveName = 'converted_files.7z'
): ConversionResult {
  const resolvedFiles = resolveArchiveEntryCollisions(files, options.collisionPolicy || 'rename');
  files = resolvedFiles;
  if (options.password) {
    const p7z = get7zBinaryPath();
    if (!p7z) {
      throw new ArchiveEncryptionUnavailableError(
        'Archive encryption is unavailable: native 7z binary is required for encrypted 7z archives.'
      );
    }
    const encRes = createEncryptedArchiveVia7z(
      resolvedFiles,
      archiveName,
      '7z',
      'application/x-7z-compressed',
      options.password,
      options.collisionPolicy
    );
    if (encRes) return encRes;
    throw new ArchiveEncryptionUnavailableError('Failed to create encrypted 7z archive.');
  }

  const isCompressed = options.compressionLevel === undefined || options.compressionLevel > 0;
  const compressionLevel = options.compressionLevel ? Math.max(1, Math.min(9, options.compressionLevel)) : 6;

  let coderType: 'lzma' | 'lzma2' | 'deflate' | 'copy';
  if (options.archiveCoder) {
    coderType = options.archiveCoder;
  } else if (!isCompressed) {
    coderType = 'copy';
  } else {
    coderType = 'lzma2';
  }

  const isSolid = Boolean(options.solid && files.length > 1);

  const packBuffers: Buffer[] = [];
  const packSizes: number[] = [];
  const unpackSizes: number[] = [];
  const crcs: number[] = [];
  const fileProps: Buffer[] = [];

  let solidCrc = 0;
  let totalUnpackSize = 0;

  if (isSolid) {
    for (const f of files) {
      unpackSizes.push(f.buffer.length);
      crcs.push(crc32(f.buffer));
    }
    const solidBuffer = Buffer.concat(files.map(f => f.buffer));
    totalUnpackSize = solidBuffer.length;
    solidCrc = crc32(solidBuffer);

    if (coderType === 'lzma2') {
      const res = compressLzma2(solidBuffer, { level: compressionLevel });
      packBuffers.push(res.buffer);
      packSizes.push(res.buffer.length);
      fileProps.push(res.props);
    } else if (coderType === 'lzma') {
      const res = compressLzma(solidBuffer, { level: compressionLevel });
      packBuffers.push(res.buffer);
      packSizes.push(res.buffer.length);
      fileProps.push(res.props);
    } else if (coderType === 'deflate') {
      const deflated = zlib.deflateRawSync(solidBuffer, { level: compressionLevel });
      packBuffers.push(deflated);
      packSizes.push(deflated.length);
      fileProps.push(Buffer.alloc(0));
    } else {
      packBuffers.push(solidBuffer);
      packSizes.push(solidBuffer.length);
      fileProps.push(Buffer.alloc(0));
    }
  } else {
    for (const f of files) {
      unpackSizes.push(f.buffer.length);
      crcs.push(crc32(f.buffer));

      if (coderType === 'lzma2') {
        const res = compressLzma2(f.buffer, { level: compressionLevel });
        packBuffers.push(res.buffer);
        packSizes.push(res.buffer.length);
        fileProps.push(res.props);
      } else if (coderType === 'lzma') {
        const res = compressLzma(f.buffer, { level: compressionLevel });
        packBuffers.push(res.buffer);
        packSizes.push(res.buffer.length);
        fileProps.push(res.props);
      } else if (coderType === 'deflate') {
        const deflated = zlib.deflateRawSync(f.buffer, { level: compressionLevel });
        packBuffers.push(deflated);
        packSizes.push(deflated.length);
        fileProps.push(Buffer.alloc(0));
      } else {
        packBuffers.push(f.buffer);
        packSizes.push(f.buffer.length);
        fileProps.push(Buffer.alloc(0));
      }
    }
  }

  const packData = Buffer.concat(packBuffers);

  // Build NextHeader
  const nh: number[] = [];
  nh.push(0x01); // kHeader
  nh.push(0x04); // kMainStreamsInfo

  if (isSolid) {
    // kPackInfo
    nh.push(0x06); // kPackInfo
    nh.push(0x00); // packPos = 0
    write7zVarint(nh, 1); // numPackStreams = 1
    nh.push(0x09); // kSize
    write7zVarint(nh, packSizes[0]);
    nh.push(0x00); // kEnd (PackInfo)

    // kUnpackInfo
    nh.push(0x07); // kUnpackInfo
    nh.push(0x0b); // kFolder
    write7zVarint(nh, 1); // numFolders = 1
    nh.push(0x00); // external = 0
    nh.push(0x01); // numCoders = 1
    if (coderType === 'lzma2') {
      nh.push(0x21, 0x21, 0x01, 0x14);
    } else if (coderType === 'lzma') {
      const p = fileProps[0] && fileProps[0].length === 5 ? fileProps[0] : Buffer.from([0x5d, 0x00, 0x00, 0x01, 0x00]);
      nh.push(0x23, 0x03, 0x01, 0x01, 0x05, ...p);
    } else if (coderType === 'deflate') {
      nh.push(0x03, 0x04, 0x01, 0x08);
    } else {
      nh.push(0x01, 0x00);
    }

    nh.push(0x0c); // kCodersUnpackSize
    write7zVarint(nh, totalUnpackSize);

    nh.push(0x0a); // kCRC
    nh.push(0x01); // allAreDefined = 1
    nh.push(solidCrc & 0xff, (solidCrc >>> 8) & 0xff, (solidCrc >>> 16) & 0xff, (solidCrc >>> 24) & 0xff);
    nh.push(0x00); // kEnd (UnpackInfo)

    // kSubStreamsInfo
    nh.push(0x08); // kSubStreamsInfo
    nh.push(0x0d); // kNumUnpackStream
    write7zVarint(nh, files.length);

    nh.push(0x09); // kSize
    for (let i = 0; i < files.length - 1; i++) {
      write7zVarint(nh, unpackSizes[i]);
    }

    nh.push(0x0a); // kCRC
    nh.push(0x01); // allAreDefined = 1
    for (const c of crcs) {
      nh.push(c & 0xff, (c >>> 8) & 0xff, (c >>> 16) & 0xff, (c >>> 24) & 0xff);
    }
    nh.push(0x00); // kEnd (SubStreamsInfo)
    nh.push(0x00); // kEnd (MainStreamsInfo)
  } else {
    // kPackInfo
    nh.push(0x06); // kPackInfo
    nh.push(0x00); // packPos = 0
    write7zVarint(nh, files.length); // numPackStreams
    nh.push(0x09); // kSize
    for (const sz of packSizes) {
      write7zVarint(nh, sz);
    }
    nh.push(0x00); // kEnd (PackInfo)

    // kUnpackInfo
    nh.push(0x07); // kUnpackInfo
    nh.push(0x0b); // kFolder
    write7zVarint(nh, files.length); // numFolders
    nh.push(0x00); // external = 0
    for (let i = 0; i < files.length; i++) {
      nh.push(0x01); // numCoders = 1
      if (coderType === 'lzma2') {
        nh.push(0x21, 0x21, 0x01, 0x14);
      } else if (coderType === 'lzma') {
        const p = fileProps[i] && fileProps[i].length === 5 ? fileProps[i] : Buffer.from([0x5d, 0x00, 0x00, 0x01, 0x00]);
        nh.push(0x23, 0x03, 0x01, 0x01, 0x05, ...p);
      } else if (coderType === 'deflate') {
        nh.push(0x03, 0x04, 0x01, 0x08);
      } else {
        nh.push(0x01, 0x00);
      }
    }

    nh.push(0x0c); // kCodersUnpackSize
    for (const us of unpackSizes) {
      write7zVarint(nh, us);
    }

    nh.push(0x0a); // kCRC
    nh.push(0x01); // allAreDefined = 1
    for (const c of crcs) {
      nh.push(c & 0xff, (c >>> 8) & 0xff, (c >>> 16) & 0xff, (c >>> 24) & 0xff);
    }
    nh.push(0x00); // kEnd (UnpackInfo)
    nh.push(0x00); // kEnd (MainStreamsInfo)
  }

  // kFilesInfo
  nh.push(0x05); // kFilesInfo
  write7zVarint(nh, files.length); // numFiles
  nh.push(0x11); // kName (0x11 per standard 7z spec)

  const nameBufs: Buffer[] = [];
  for (const f of files) {
    nameBufs.push(Buffer.from(f.filename + '\0', 'utf16le'));
  }
  const allNames = Buffer.concat(nameBufs);
  write7zVarint(nh, allNames.length + 1);
  nh.push(0x00); // external = 0

  const nhPrefix = Buffer.from(nh);
  const nhBuffer = Buffer.concat([nhPrefix, allNames, Buffer.from([0x00, 0x00])]);

  const nextHeaderOffset = packData.length;
  const nextHeaderSize = nhBuffer.length;
  const nextHeaderCrc = crc32(nhBuffer);

  const startHeader = Buffer.alloc(32);
  startHeader.write('7z\xBC\xAF\x27\x1C', 0, 6, 'binary');
  startHeader.writeUInt8(0, 6);
  startHeader.writeUInt8(4, 7);
  startHeader.writeBigUInt64LE(BigInt(nextHeaderOffset), 12);
  startHeader.writeBigUInt64LE(BigInt(nextHeaderSize), 20);
  startHeader.writeUInt32LE(nextHeaderCrc, 28);

  const shCrc = crc32(startHeader.subarray(12, 32));
  startHeader.writeUInt32LE(shCrc, 8);

  const fullArchive = Buffer.concat([startHeader, packData, nhBuffer]);
  return {
    buffer: fullArchive,
    mimeType: 'application/x-7z-compressed',
    filename: archiveName,
    size: fullArchive.length,
  };
}

// ============================================================================
// 7z Archive Extraction with Authentic Decompression
// ============================================================================

interface SevenZipCoder {
  codecId: Buffer;
  properties: Buffer;
}

interface SevenZipFolder {
  coders: SevenZipCoder[];
  unpackSize: number;
  crc?: number;
  numUnpackStreams?: number;
  unpackSizes?: number[];
  unpackCrcs?: number[];
}

function decompress7zFolder(
  packSlice: Buffer,
  coder: SevenZipCoder,
  unpackSize: number
): Buffer {
  const id = coder.codecId;
  if (id.length === 1 && id[0] === 0x00) {
    // Copy
    return packSlice.subarray(0, unpackSize);
  }
  if (
    (id.length === 3 && id[0] === 0x04 && id[1] === 0x01 && (id[2] === 0x08 || id[2] === 0x09)) ||
    (id.length === 1 && id[0] === 0x04)
  ) {
    // Deflate
    return zlib.inflateRawSync(packSlice);
  }
  if (id.length === 3 && id[0] === 0x03 && id[1] === 0x01 && id[2] === 0x01) {
    // LZMA
    return decompressLzma(packSlice, coder.properties, unpackSize);
  }
  if (id.length === 1 && id[0] === 0x21) {
    // LZMA2
    return decompressLzma2(packSlice, coder.properties, unpackSize);
  }
  if (id.length === 3 && id[0] === 0x04 && id[1] === 0x02 && id[2] === 0x02) {
    // BZip2
    return decompressBzip2(packSlice);
  }
  throw new Error(`Unsupported 7z compression method: 0x${id.toString('hex')}`);
}

function decode7zEncodedHeader(sevenZipBuffer: Buffer, nh: Buffer): Buffer | null {
  try {
    let cur = 1;
    let packPos = 0;
    let packSize = 0;
    let unpackSize = 0;
    const coder: SevenZipCoder = { codecId: Buffer.from([0]), properties: Buffer.alloc(0) };

    while (cur < nh.length && nh[cur] !== 0x00) {
      const p = nh[cur++];
      if (p === 0x06) {
        // kPackInfo
        const packPosVar = read7zVarint(nh, cur);
        packPos = packPosVar.value;
        cur = packPosVar.nextOffset;
        const numStreams = read7zVarint(nh, cur);
        cur = numStreams.nextOffset;
        if (nh[cur++] === 0x09) {
          const sz = read7zVarint(nh, cur);
          packSize = sz.value;
          cur = sz.nextOffset;
        }
        while (cur < nh.length && nh[cur] !== 0x00) cur++;
        if (cur < nh.length && nh[cur] === 0x00) cur++;
      } else if (p === 0x07) {
        // kUnpackInfo
        while (cur < nh.length && nh[cur] !== 0x00) {
          const up = nh[cur++];
          if (up === 0x0b) {
            // kFolder
            const numF = read7zVarint(nh, cur);
            cur = numF.nextOffset;
            const ext = nh[cur++];
            if (ext === 0) {
              const numC = read7zVarint(nh, cur);
              cur = numC.nextOffset;
              const flags = nh[cur++];
              const idSz = flags & 0x0f;
              coder.codecId = Buffer.from(nh.subarray(cur, cur + idSz));
              cur += idSz;
              if ((flags & 0x20) !== 0) {
                const propSz = read7zVarint(nh, cur);
                cur = propSz.nextOffset;
                coder.properties = Buffer.from(nh.subarray(cur, cur + propSz.value));
                cur += propSz.value;
              }
            }
          } else if (up === 0x0c) {
            const sz = read7zVarint(nh, cur);
            unpackSize = sz.value;
            cur = sz.nextOffset;
          } else {
            break;
          }
        }
        if (cur < nh.length && nh[cur] === 0x00) cur++;
      } else {
        break;
      }
    }

    if (packSize > 0 && unpackSize > 0) {
      const packSlice = Buffer.from(sevenZipBuffer.subarray(32 + packPos, 32 + packPos + packSize));
      return decompress7zFolder(packSlice, coder, unpackSize);
    }
  } catch {}
  return null;
}

export function extract7zArchive(
  sevenZipBuffer: Buffer,
  options: { password?: string; entries?: string[] } = {}
): { filename: string; buffer: Buffer }[] {
  const files: { filename: string; buffer: Buffer }[] = [];
  if (sevenZipBuffer.length < 32) return files;

  if (
    sevenZipBuffer[0] !== 0x37 ||
    sevenZipBuffer[1] !== 0x7a ||
    sevenZipBuffer[2] !== 0xbc ||
    sevenZipBuffer[3] !== 0xaf ||
    sevenZipBuffer[4] !== 0x27 ||
    sevenZipBuffer[5] !== 0x1c
  ) {
    return files;
  }

  const nextHeaderOffset = Number(sevenZipBuffer.readBigUInt64LE(12));
  const nextHeaderSize = Number(sevenZipBuffer.readBigUInt64LE(20));
  const nextHeaderCrc = sevenZipBuffer.readUInt32LE(28);

  const startHeaderCrc = crc32(sevenZipBuffer.subarray(12, 32));
  if (startHeaderCrc !== sevenZipBuffer.readUInt32LE(8)) {
    return files;
  }

  const nhStart = 32 + nextHeaderOffset;
  if (nhStart + nextHeaderSize > sevenZipBuffer.length) {
    return files;
  }

  let nh = sevenZipBuffer.subarray(nhStart, nhStart + nextHeaderSize);
  if (crc32(nh) !== nextHeaderCrc) {
    return files;
  }

  // Handle kEncodedHeader (0x17)
  if (nh.length > 0 && nh[0] === 0x17) {
    const decodedNh = decode7zEncodedHeader(sevenZipBuffer, nh);
    if (decodedNh) {
      nh = decodedNh;
    }
  }

  // Parse kHeader
  let cur = 0;
  if (cur < nh.length && nh[cur] === 0x01) cur++; // skip kHeader (0x01)

  const folders: SevenZipFolder[] = [];
  const packSizes: number[] = [];
  const filenames: string[] = [];

  while (cur < nh.length && nh[cur] !== 0x00) {
    const propId = nh[cur++];

    if (propId === 0x04) {
      // kMainStreamsInfo
      while (cur < nh.length && nh[cur] !== 0x00) {
        const streamProp = nh[cur++];

        if (streamProp === 0x06) {
          // kPackInfo
          const packPosVar = read7zVarint(nh, cur);
          cur = packPosVar.nextOffset;
          const numStreamsVar = read7zVarint(nh, cur);
          cur = numStreamsVar.nextOffset;
          const streamCount = numStreamsVar.value;

          while (cur < nh.length && nh[cur] !== 0x00) {
            const packSub = nh[cur++];
            if (packSub === 0x09) {
              // kSize
              for (let s = 0; s < streamCount && cur < nh.length; s++) {
                const sz = read7zVarint(nh, cur);
                packSizes.push(sz.value);
                cur = sz.nextOffset;
              }
            } else if (packSub === 0x0a) {
              // kCRC
              const allDefined = nh[cur++];
              if (allDefined === 1) {
                cur += streamCount * 4;
              } else {
                cur += Math.ceil(streamCount / 8) + streamCount * 4;
              }
            } else {
              break;
            }
          }
          if (cur < nh.length && nh[cur] === 0x00) cur++;
        } else if (streamProp === 0x07) {
          // kUnpackInfo
          while (cur < nh.length && nh[cur] !== 0x00) {
            const unpackSub = nh[cur++];
            if (unpackSub === 0x0b) {
              // kFolder
              const numFoldersVar = read7zVarint(nh, cur);
              cur = numFoldersVar.nextOffset;
              const external = nh[cur++];
              if (external === 0) {
                for (let f = 0; f < numFoldersVar.value && cur < nh.length; f++) {
                  const numCodersVar = read7zVarint(nh, cur);
                  cur = numCodersVar.nextOffset;
                  const folderCoders: SevenZipCoder[] = [];

                  for (let c = 0; c < numCodersVar.value && cur < nh.length; c++) {
                    const flags = nh[cur++];
                    const idSize = flags & 0x0f;
                    const codecId = Buffer.from(nh.subarray(cur, cur + idSize));
                    cur += idSize;

                    if ((flags & 0x10) !== 0) {
                      const numIn = read7zVarint(nh, cur);
                      cur = numIn.nextOffset;
                      const numOut = read7zVarint(nh, cur);
                      cur = numOut.nextOffset;
                    }

                    let properties = Buffer.alloc(0);
                    if ((flags & 0x20) !== 0) {
                      const propSizeVar = read7zVarint(nh, cur);
                      cur = propSizeVar.nextOffset;
                      properties = Buffer.from(nh.subarray(cur, cur + propSizeVar.value));
                      cur += propSizeVar.value;
                    }

                    folderCoders.push({ codecId, properties });
                  }

                  folders.push({ coders: folderCoders, unpackSize: 0 });
                }
              }
            } else if (unpackSub === 0x0c) {
              // kCodersUnpackSize
              for (let f = 0; f < folders.length && cur < nh.length; f++) {
                const sz = read7zVarint(nh, cur);
                folders[f].unpackSize = sz.value;
                cur = sz.nextOffset;
              }
            } else if (unpackSub === 0x0a) {
              // kCRC
              const allDefined = nh[cur++];
              if (allDefined === 1) {
                for (let f = 0; f < folders.length && cur + 4 <= nh.length; f++) {
                  folders[f].crc = nh.readUInt32LE(cur);
                  cur += 4;
                }
              } else {
                const maskBytes = Math.ceil(folders.length / 8);
                cur += maskBytes + folders.length * 4;
              }
            } else {
              break;
            }
          }
          if (cur < nh.length && nh[cur] === 0x00) cur++;
        } else if (streamProp === 0x08) {
          // kSubStreamsInfo
          while (cur < nh.length && nh[cur] !== 0x00) {
            const subProp = nh[cur++];
            if (subProp === 0x0d) {
              // kNumUnpackStream
              for (let f = 0; f < folders.length && cur < nh.length; f++) {
                const num = read7zVarint(nh, cur);
                folders[f].numUnpackStreams = num.value;
                cur = num.nextOffset;
              }
            } else if (subProp === 0x09) {
              // kSize
              for (let f = 0; f < folders.length && cur < nh.length; f++) {
                const numStreams = folders[f].numUnpackStreams || 1;
                folders[f].unpackSizes = [];
                let sum = 0;
                for (let s = 0; s < numStreams - 1 && cur < nh.length; s++) {
                  const sz = read7zVarint(nh, cur);
                  folders[f].unpackSizes!.push(sz.value);
                  sum += sz.value;
                  cur = sz.nextOffset;
                }
                folders[f].unpackSizes!.push(Math.max(0, folders[f].unpackSize - sum));
              }
            } else if (subProp === 0x0a) {
              // kCRC
              cur++; // skip allDefined flag
              for (const folder of folders) {
                const numStreams = folder.numUnpackStreams || 1;
                folder.unpackCrcs = [];
                for (let s = 0; s < numStreams && cur + 4 <= nh.length; s++) {
                  folder.unpackCrcs.push(nh.readUInt32LE(cur));
                  cur += 4;
                }
              }
            } else {
              break;
            }
          }
          if (cur < nh.length && nh[cur] === 0x00) cur++;
        } else {
          break;
        }
      }
      if (cur < nh.length && nh[cur] === 0x00) cur++;
    } else if (propId === 0x05) {
      // kFilesInfo
      const numFilesVar = read7zVarint(nh, cur);
      cur = numFilesVar.nextOffset;
      const fileCount = numFilesVar.value;

      while (cur < nh.length && nh[cur] !== 0x00) {
        const fileProp = nh[cur++];
        if (fileProp === 0x11) {
          // kName (0x11 standard)
          const nameLen = read7zVarint(nh, cur);
          cur = nameLen.nextOffset;
          const external = nh[cur++];
          if (external === 0) {
            const rawNames = Buffer.from(nh.subarray(cur, cur + nameLen.value - 1));
            cur += nameLen.value - 1;

            let nameOffset = 0;
            while (nameOffset + 2 <= rawNames.length && filenames.length < fileCount) {
              let end = nameOffset;
              while (end + 2 <= rawNames.length && (rawNames[end] !== 0 || rawNames[end + 1] !== 0)) {
                end += 2;
              }
              if (end === nameOffset) break;
              const fn = rawNames.toString('utf16le', nameOffset, end);
              if (fn) filenames.push(fn);
              nameOffset = end + 2;
            }
          }
        } else {
          const propLen = read7zVarint(nh, cur);
          cur = propLen.nextOffset + propLen.value;
        }
      }
      if (cur < nh.length && nh[cur] === 0x00) cur++;
    } else {
      break;
    }
  }

  // Fallback: heuristic scan if structural parse yielded no filenames
  if (filenames.length === 0) {
    let nameIdx = -1;
    for (let i = 0; i < nh.length; i++) {
      if ((nh[i] === 0x11 || nh[i] === 0x05) && i + 2 < nh.length && (nh[i + 2] === 0x0e || nh[i + 2] === 0x11)) {
        nameIdx = i + 2;
        break;
      }
    }
    if (nameIdx !== -1) {
      let idx = nameIdx + 1;
      while (idx < nh.length && (nh[idx] & 0x80) !== 0) idx++;
      idx++;
      idx++;
      const rawNames = nh.subarray(idx);
      let nameOffset = 0;
      while (nameOffset + 2 <= rawNames.length) {
        let end = nameOffset;
        while (end + 2 <= rawNames.length && (rawNames[end] !== 0 || rawNames[end + 1] !== 0)) {
          end += 2;
        }
        if (end === nameOffset) break;
        const fn = rawNames.toString('utf16le', nameOffset, end);
        if (fn) filenames.push(fn);
        nameOffset = end + 2;
      }
    }
  }

  // Decompress each folder and extract files
  let packOffset = 32;
  let fileIdx = 0;
  let totalUncompressedSize = 0;

  for (let f = 0; f < folders.length; f++) {
    const folder = folders[f];
    const packSize = f < packSizes.length ? packSizes[f] : nextHeaderOffset - (packOffset - 32);
    if (packOffset + packSize > sevenZipBuffer.length) {
      throw new Error('Corrupted 7z archive: truncated pack stream');
    }

    const packSlice = Buffer.from(sevenZipBuffer.subarray(packOffset, packOffset + packSize));
    packOffset += packSize;

    // Decompress folder stream using primary coder
    const primaryCoder = folder.coders.length > 0 ? folder.coders[0] : { codecId: Buffer.from([0]), properties: Buffer.alloc(0) };
    const uncompressedData = decompress7zFolder(packSlice, primaryCoder, folder.unpackSize);

    if (uncompressedData.length !== folder.unpackSize) {
      throw new Error(`Corrupted 7z archive: unpack size mismatch (expected ${folder.unpackSize}, got ${uncompressedData.length})`);
    }

    if (folder.crc !== undefined) {
      const computedCrc = crc32(uncompressedData);
      if (computedCrc !== folder.crc) {
        throw new Error(`Corrupted 7z archive: CRC mismatch (expected 0x${folder.crc.toString(16)}, got 0x${computedCrc.toString(16)})`);
      }
    }

    totalUncompressedSize += uncompressedData.length;
    if (totalUncompressedSize > ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE) {
      throw new Error(`Archive bomb detected: uncompressed size exceeds limit of ${ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE} bytes (500MB)`);
    }
    if (sevenZipBuffer.length > 0 && totalUncompressedSize / sevenZipBuffer.length > ARCHIVE_SECURITY_LIMITS.MAX_RATIO) {
      throw new Error(`Archive bomb detected: compression ratio exceeds ${ARCHIVE_SECURITY_LIMITS.MAX_RATIO}:1 limit`);
    }

    // Distribute uncompressed folder data to files
    if (folder.unpackSizes && folder.unpackSizes.length > 0) {
      let subOffset = 0;
      for (let s = 0; s < folder.unpackSizes.length && fileIdx < filenames.length; s++) {
        if (files.length >= ARCHIVE_SECURITY_LIMITS.MAX_FILES) {
          throw new Error(`Archive bomb detected: file count exceeds limit of ${ARCHIVE_SECURITY_LIMITS.MAX_FILES}`);
        }
        const sz = folder.unpackSizes[s];
        const fileBuf = Buffer.from(uncompressedData.subarray(subOffset, subOffset + sz));
        subOffset += sz;

        if (folder.unpackCrcs?.[s] !== undefined) {
          if (crc32(fileBuf) !== folder.unpackCrcs[s]) {
            throw new Error(`Corrupted 7z archive: CRC mismatch for ${filenames[fileIdx]}`);
          }
        }

        const sanitizedName = sanitizeArchivePath(filenames[fileIdx++]);
        if (sanitizedName) {
          files.push({ filename: sanitizedName, buffer: fileBuf });
        }
      }
    } else {
      if (files.length >= ARCHIVE_SECURITY_LIMITS.MAX_FILES) {
        throw new Error(`Archive bomb detected: file count exceeds limit of ${ARCHIVE_SECURITY_LIMITS.MAX_FILES}`);
      }
      const fname = fileIdx < filenames.length ? filenames[fileIdx++] : `file_${f}`;
      const sanitizedName = sanitizeArchivePath(fname);
      if (sanitizedName) {
        files.push({ filename: sanitizedName, buffer: uncompressedData });
      }
    }
  }

  if (options.entries && options.entries.length > 0) {
    return files.filter((f) => matchArchiveGlob(f.filename, options.entries));
  }
  return files;
}

/**
 * Safely decompresses Gzip stream with real-time chunk-level threshold enforcement.
 * Eliminates upfront synchronous heap buffering to defend against gzip decompression bombs.
 */
export async function gunzipStreamingWithLimits(inputBuffer: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const gunzip = zlib.createGunzip();
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let destroyed = false;

    const cleanup = () => {
      chunks.length = 0;
    };

    gunzip.on('data', (chunk: Buffer) => {
      if (destroyed) return;
      totalBytes += chunk.length;

      // 1. Guard against absolute uncompressed size bomb
      if (totalBytes > ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE) {
        destroyed = true;
        cleanup();
        gunzip.destroy();
        return reject(
          new Error(
            `Archive bomb detected: uncompressed size exceeds limit of ${ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE} bytes (500MB)`
          )
        );
      }

      // 2. Guard against compression ratio bomb (evaluated beyond 1MB threshold)
      if (
        inputBuffer.length > 0 &&
        totalBytes > 1024 * 1024 &&
        totalBytes / inputBuffer.length > ARCHIVE_SECURITY_LIMITS.MAX_RATIO
      ) {
        destroyed = true;
        cleanup();
        gunzip.destroy();
        return reject(
          new Error(
            `Archive bomb detected: compression ratio exceeds ${ARCHIVE_SECURITY_LIMITS.MAX_RATIO}:1 limit`
          )
        );
      }

      chunks.push(chunk);
    });

    gunzip.on('end', () => {
      if (destroyed) return;
      // Final ratio check for smaller buffers
      if (
        inputBuffer.length > 0 &&
        totalBytes / inputBuffer.length > ARCHIVE_SECURITY_LIMITS.MAX_RATIO
      ) {
        cleanup();
        return reject(
          new Error(
            `Archive bomb detected: compression ratio exceeds ${ARCHIVE_SECURITY_LIMITS.MAX_RATIO}:1 limit`
          )
        );
      }
      resolve(Buffer.concat(chunks));
    });

    gunzip.on('error', (err) => {
      if (!destroyed) {
        cleanup();
        reject(err);
      }
    });

    gunzip.end(inputBuffer);
  });
}

let resolvedZipPath: string | null = null;
export function getZipBinaryPath(): string | null {
  const envOverride = process.env.ZIP_PATH;
  if (envOverride !== undefined) {
    if (path.isAbsolute(envOverride) && fs.existsSync(envOverride)) {
      return envOverride;
    }
    return null;
  }
  if (resolvedZipPath !== null) return resolvedZipPath || null;
  const fixedLocations = [
    '/usr/bin/zip',
    '/usr/local/bin/zip',
    '/opt/homebrew/bin/zip',
    '/bin/zip',
  ];
  for (const loc of fixedLocations) {
    if (fs.existsSync(loc)) {
      resolvedZipPath = loc;
      return loc;
    }
  }
  return null;
}

/**
 * Repairs a damaged or truncated ZIP archive.
 * First attempts sandboxed `zip -FF <in> --out <out> -q -y`.
 * Falls back to pure TypeScript Local File Header scanner that salvages all valid entries
 * and rebuilds an intact Central Directory structure.
 */
export async function repairZipArchive(
  zipBuffer: Buffer,
  _options: ConversionOptions = {}
): Promise<Buffer> {
  const zipBin = getZipBinaryPath();
  if (zipBin) {
    const tmpDir = os.tmpdir();
    const token = crypto.randomBytes(8).toString('hex');
    const workDir = path.join(tmpDir, `easyconvert_zip_repair_${Date.now()}_${token}`);
    fs.mkdirSync(workDir, { recursive: true });
    try {
      const inPath = path.join(workDir, 'corrupt.zip');
      const outPath = path.join(workDir, 'repaired.zip');
      fs.writeFileSync(inPath, zipBuffer);

      const resolved = resolveSandboxedCommand(zipBin, [inPath, '-FF', '--out', outPath, '-q'], {
        networkIsolated: true,
      });
      try {
        const out = execFileSync(resolved.binary, resolved.args, {
          cwd: workDir,
          env: getSanitizedEnvironment({}, true),
          timeout: 60000,
          input: Buffer.from('y\ny\ny\ny\n'),
        });
        if (fs.existsSync(outPath) && fs.statSync(outPath).size > 22) {
          const repaired = fs.readFileSync(outPath);
          try {
            if ((await extractZipArchive(repaired)).length > 0) {
              return repaired;
            }
          } catch {
            // Repaired zip is invalid or empty, fall through to pure TS recovery
          }
        }
      } catch {
        // Fall through to pure TS recovery
      }
    } finally {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
    }
  }

  // Pure TypeScript ZIP recovery:
  // Scans for Local File Header magic bytes (0x04034b50 / PK\x03\x04),
  // salvages recoverable uncompressed or deflated streams, and rebuilds Central Directory.
  const salvagedFiles: { filename: string; buffer: Buffer }[] = [];
  let pos = 0;
  while (pos + 30 <= zipBuffer.length) {
    if (
      zipBuffer[pos] === 0x50 &&
      zipBuffer[pos + 1] === 0x4b &&
      zipBuffer[pos + 2] === 0x03 &&
      zipBuffer[pos + 3] === 0x04
    ) {
      try {
        const compMethod = zipBuffer.readUInt16LE(pos + 8);
        const compSize = zipBuffer.readUInt32LE(pos + 18);
        const uncompSize = zipBuffer.readUInt32LE(pos + 22);
        const nameLen = zipBuffer.readUInt16LE(pos + 26);
        const extraLen = zipBuffer.readUInt16LE(pos + 28);

        const dataStart = pos + 30 + nameLen + extraLen;
        if (pos + 30 + nameLen <= zipBuffer.length && dataStart <= zipBuffer.length) {
          const rawName = zipBuffer.toString('utf-8', pos + 30, pos + 30 + nameLen);
          const cleanName = sanitizeArchivePath(rawName) || path.basename(rawName);

          let rawChunk: Buffer | null = null;
          if (compSize > 0 && dataStart + compSize <= zipBuffer.length) {
            rawChunk = zipBuffer.subarray(dataStart, dataStart + compSize);
          } else {
            const nextPk = zipBuffer.indexOf(Buffer.from([0x50, 0x4b]), dataStart);
            const endSlice = nextPk !== -1 ? nextPk : zipBuffer.length;
            rawChunk = zipBuffer.subarray(dataStart, endSlice);
          }

          if (cleanName && rawChunk && rawChunk.length > 0) {
            let uncompressed: Buffer | null = null;
            if (compMethod === 0) {
              uncompressed = Buffer.from(rawChunk);
            } else if (compMethod === 8) {
              try {
                uncompressed = zlib.inflateRawSync(rawChunk);
              } catch {
                for (let offset = rawChunk.length - 1; offset > 0 && !uncompressed; offset--) {
                  try {
                    uncompressed = zlib.inflateRawSync(rawChunk.subarray(0, offset));
                  } catch {}
                }
              }
            }
            if (uncompressed && (uncompSize === 0 || uncompressed.length === uncompSize || compSize === 0)) {
              salvagedFiles.push({ filename: cleanName, buffer: uncompressed });
              pos = dataStart + (compSize > 0 ? compSize : rawChunk.length);
              continue;
            }
          }
        }
      } catch {}
    }
    pos++;
  }

  if (salvagedFiles.length === 0) {
    throw new ConversionFailedError('ZIP archive repair failed: no recoverable file records found in buffer.');
  }

  const zip = new JSZip();
  for (const f of salvagedFiles) {
    zip.file(f.filename, f.buffer);
  }
  return await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function inspectZipBuffer(buffer: Buffer): ArchiveInspectResponse {
  if (buffer.length < 22) {
    throw new ConversionFailedError('Invalid ZIP archive: buffer too small');
  }

  let eocdOffset = -1;
  const maxScan = Math.min(buffer.length, 65535 + 22);
  const startScan = buffer.length - maxScan;
  for (let i = buffer.length - 22; i >= startScan; i--) {
    if (
      buffer[i] === 0x50 &&
      buffer[i + 1] === 0x4b &&
      buffer[i + 2] === 0x05 &&
      buffer[i + 3] === 0x06
    ) {
      eocdOffset = i;
      break;
    }
  }

  const entries: ArchiveEntryMetadata[] = [];
  let isEncryptedArchive = false;

  if (eocdOffset !== -1) {
    let cdOffset = buffer.readUInt32LE(eocdOffset + 16);

    // Check for Zip64 EOCD locator (0x07064b50)
    if (eocdOffset >= 20) {
      const locPos = eocdOffset - 20;
      if (
        buffer[locPos] === 0x50 &&
        buffer[locPos + 1] === 0x4b &&
        buffer[locPos + 2] === 0x06 &&
        buffer[locPos + 3] === 0x07
      ) {
        const zip64EocdOffset = Number(buffer.readBigUInt64LE(locPos + 8));
        if (
          zip64EocdOffset + 56 <= buffer.length &&
          buffer[zip64EocdOffset] === 0x50 &&
          buffer[zip64EocdOffset + 1] === 0x4b &&
          buffer[zip64EocdOffset + 2] === 0x06 &&
          buffer[zip64EocdOffset + 3] === 0x06
        ) {
          cdOffset = Number(buffer.readBigUInt64LE(zip64EocdOffset + 48));
        }
      }
    }

    let pos = cdOffset;
    while (
      pos + 46 <= buffer.length &&
      buffer[pos] === 0x50 &&
      buffer[pos + 1] === 0x4b &&
      buffer[pos + 2] === 0x01 &&
      buffer[pos + 3] === 0x02
    ) {
      const flags = buffer.readUInt16LE(pos + 8);
      const isEncrypted = (flags & 1) !== 0;
      if (isEncrypted) isEncryptedArchive = true;

      const modTime = buffer.readUInt16LE(pos + 12);
      const modDate = buffer.readUInt16LE(pos + 14);
      const year = ((modDate >> 9) & 0x7f) + 1980;
      const month = Math.max(0, Math.min(11, ((modDate >> 5) & 0x0f) - 1));
      const day = Math.max(1, Math.min(31, modDate & 0x1f));
      const hour = Math.min(23, (modTime >> 11) & 0x1f);
      const min = Math.min(59, (modTime >> 5) & 0x3f);
      const sec = Math.min(59, (modTime & 0x1f) * 2);
      const modifiedAt = new Date(Date.UTC(year, month, day, hour, min, sec)).toISOString();

      const crc = buffer.readUInt32LE(pos + 16);
      const crc32Str = crc.toString(16).padStart(8, '0');
      let compSize = buffer.readUInt32LE(pos + 20);
      let uncompSize = buffer.readUInt32LE(pos + 24);
      const fnLen = buffer.readUInt16LE(pos + 28);
      const extraLen = buffer.readUInt16LE(pos + 30);
      const commentLen = buffer.readUInt16LE(pos + 32);

      const nameStart = pos + 46;
      const nameEnd = nameStart + fnLen;
      const rawName = nameEnd <= buffer.length ? buffer.toString('utf-8', nameStart, nameEnd) : 'unknown';

      if (extraLen > 0 && nameEnd + extraLen <= buffer.length) {
        let extraPos = nameEnd;
        while (extraPos + 4 <= nameEnd + extraLen) {
          const headerId = buffer.readUInt16LE(extraPos);
          const dataSize = buffer.readUInt16LE(extraPos + 2);
          if (headerId === 0x0001 && extraPos + 4 + dataSize <= nameEnd + extraLen) {
            let offsetInZip64 = extraPos + 4;
            if (uncompSize === 0xffffffff && offsetInZip64 + 8 <= extraPos + 4 + dataSize) {
              uncompSize = Number(buffer.readBigUInt64LE(offsetInZip64));
              offsetInZip64 += 8;
            }
            if (compSize === 0xffffffff && offsetInZip64 + 8 <= extraPos + 4 + dataSize) {
              compSize = Number(buffer.readBigUInt64LE(offsetInZip64));
            }
            break;
          }
          extraPos += 4 + dataSize;
        }
      }

      const isDirectory = rawName.endsWith('/') || (buffer.readUInt32LE(pos + 38) & 0x10) !== 0;

      entries.push({
        name: rawName,
        uncompressedSize: uncompSize,
        compressedSize: compSize,
        isEncrypted,
        isDirectory,
        modifiedAt,
        crc32: crc32Str,
      });

      pos += 46 + fnLen + extraLen + commentLen;
    }
  } else {
    let pos = 0;
    while (pos + 30 <= buffer.length) {
      if (
        buffer[pos] === 0x50 &&
        buffer[pos + 1] === 0x4b &&
        buffer[pos + 2] === 0x03 &&
        buffer[pos + 3] === 0x04
      ) {
        const flags = buffer.readUInt16LE(pos + 6);
        const isEncrypted = (flags & 1) !== 0;
        if (isEncrypted) isEncryptedArchive = true;
        const crc = buffer.readUInt32LE(pos + 14);
        const compSize = buffer.readUInt32LE(pos + 18);
        const uncompSize = buffer.readUInt32LE(pos + 22);
        const nameLen = buffer.readUInt16LE(pos + 26);
        const extraLen = buffer.readUInt16LE(pos + 28);
        const name = pos + 30 + nameLen <= buffer.length ? buffer.toString('utf-8', pos + 30, pos + 30 + nameLen) : 'unknown';
        entries.push({
          name,
          uncompressedSize: uncompSize,
          compressedSize: compSize,
          isEncrypted,
          isDirectory: name.endsWith('/'),
          crc32: crc.toString(16).padStart(8, '0'),
        });
        pos += 30 + nameLen + extraLen + compSize;
      } else {
        pos++;
      }
    }
  }

  let totalUncompressedBytes = 0;
  let totalCompressedBytes = 0;
  for (const e of entries) {
    totalUncompressedBytes += e.uncompressedSize;
    totalCompressedBytes += e.compressedSize || 0;
  }

  return {
    format: 'zip',
    totalEntries: entries.length,
    totalUncompressedBytes,
    totalCompressedBytes,
    isEncrypted: isEncryptedArchive,
    entries,
  };
}

function inspectTarBuffer(buffer: Buffer, format = 'tar'): ArchiveInspectResponse {
  const entries: ArchiveEntryMetadata[] = [];
  let offset = 0;
  let totalUncompressedBytes = 0;

  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    offset += 512;

    if (header.every((b) => b === 0)) break;

    const rawName = header.toString('ascii', 0, 100).replace(/\0.*$/, '').trim();
    if (!rawName) break;

    const sizeStr = header.toString('ascii', 124, 135).replace(/\0.*$/, '').trim();
    const size = parseInt(sizeStr, 8) || 0;
    const mtimeStr = header.toString('ascii', 136, 147).replace(/\0.*$/, '').trim();
    const mtimeSec = parseInt(mtimeStr, 8) || 0;
    const modifiedAt = mtimeSec > 0 ? new Date(mtimeSec * 1000).toISOString() : undefined;

    const chksumStr = header.toString('ascii', 148, 155).replace(/\0.*$/, '').trim();
    const chksum = parseInt(chksumStr, 8) || 0;
    const crc32Str = chksum > 0 ? chksum.toString(16).padStart(8, '0') : undefined;

    const typeflag = String.fromCharCode(header[156]);
    const isDirectory = typeflag === '5' || rawName.endsWith('/');

    let fullName = rawName;
    const magic = header.toString('ascii', 257, 262);
    if (magic.startsWith('ustar')) {
      const prefix = header.toString('ascii', 345, 500).replace(/\0.*$/, '').trim();
      if (prefix) fullName = `${prefix}/${rawName}`;
    }

    entries.push({
      name: sanitizeArchivePath(fullName) || fullName,
      uncompressedSize: isDirectory ? 0 : size,
      compressedSize: isDirectory ? 0 : size,
      isEncrypted: false,
      isDirectory,
      modifiedAt,
      crc32: crc32Str,
    });

    totalUncompressedBytes += isDirectory ? 0 : size;
    const pad = (512 - (size % 512)) % 512;
    offset += size + pad;
  }

  return {
    format,
    totalEntries: entries.length,
    totalUncompressedBytes,
    totalCompressedBytes: totalUncompressedBytes,
    isEncrypted: false,
    entries,
  };
}

async function inspectArchiveVia7zCli(
  buffer: Buffer,
  format: '7z' | 'rar',
  p7z: string,
  password?: string
): Promise<ArchiveInspectResponse> {
  const tmpDir = os.tmpdir();
  const token = crypto.randomBytes(8).toString('hex');
  const workDir = path.join(tmpDir, `easyconvert_${format}_inspect_${Date.now()}_${token}`);
  fs.mkdirSync(workDir, { recursive: true });
  try {
    const archivePath = path.join(workDir, `archive.${format}`);
    fs.writeFileSync(archivePath, buffer);

    const pwArgs = password ? ['-p' + password] : ['-p-'];
    const resolved = resolveSandboxedCommand(p7z, ['l', '-slt', ...pwArgs, archivePath], {
      networkIsolated: true,
    });

    let stdoutStr = '';
    try {
      const out = execFileSync(resolved.binary, resolved.args, {
        cwd: workDir,
        env: getSanitizedEnvironment({}, true),
        timeout: 30000,
      });
      stdoutStr = out.toString('utf-8');
    } catch (err: any) {
      const errMsg = (err?.message || '') + (err?.stderr?.toString() || '') + (err?.stdout?.toString() || '');
      if (
        errMsg.includes('Enter password') ||
        errMsg.includes('Can not open encrypted') ||
        errMsg.includes('Cannot open encrypted') ||
        errMsg.includes('Data Error in encrypted archive') ||
        errMsg.includes('Wrong password')
      ) {
        throw new ArchiveEncryptedHeaderError('Archive header is encrypted and requires a password to inspect entries.');
      }
      throw new ConversionFailedError(`Failed to inspect ${format} archive: ${err.message}`);
    }

    if (stdoutStr.includes('Enter password (will not be echoed):')) {
      throw new ArchiveEncryptedHeaderError('Archive header is encrypted and requires a password to inspect entries.');
    }

    const entries: ArchiveEntryMetadata[] = [];
    const blocks = stdoutStr.split(/\r?\n\r?\n/);
    let isArchiveEncrypted = false;

    for (const block of blocks) {
      if (!block.includes('Path = ') || block.includes('Listing archive:')) continue;
      const lines = block.split(/\r?\n/);
      const record: Record<string, string> = {};
      for (const line of lines) {
        const eq = line.indexOf(' = ');
        if (eq !== -1) {
          record[line.slice(0, eq).trim()] = line.slice(eq + 3).trim();
        }
      }
      if (!record.Path || record.Path === archivePath) continue;

      const uncompSize = record.Size ? parseInt(record.Size, 10) : 0;
      const compSize = record['Packed Size'] ? parseInt(record['Packed Size'], 10) : undefined;
      const isEnc = record.Encrypted === '+';
      if (isEnc) isArchiveEncrypted = true;
      const isDir = record.Folder === '+' || (record.Attributes && record.Attributes.includes('D')) || record.Path.endsWith('/');
      const modTime = record.Modified || undefined;
      const crcHex = record.CRC || undefined;

      entries.push({
        name: sanitizeArchivePath(record.Path) || record.Path,
        uncompressedSize: uncompSize,
        compressedSize: compSize,
        isEncrypted: isEnc,
        isDirectory: Boolean(isDir),
        modifiedAt: modTime,
        crc32: crcHex ? crcHex.toLowerCase() : undefined,
      });
    }

    let totalUncompressedBytes = 0;
    let totalCompressedBytes = 0;
    for (const e of entries) {
      totalUncompressedBytes += e.uncompressedSize;
      totalCompressedBytes += e.compressedSize || 0;
    }

    return {
      format,
      totalEntries: entries.length,
      totalUncompressedBytes,
      totalCompressedBytes,
      isEncrypted: isArchiveEncrypted,
      entries,
    };
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
}

async function inspect7zBuffer(
  buffer: Buffer,
  password?: string
): Promise<ArchiveInspectResponse> {
  const p7z = get7zBinaryPath();
  if (p7z) {
    return await inspectArchiveVia7zCli(buffer, '7z', p7z, password);
  }

  // Pure TS fallback for 7z inspection
  if (buffer.length >= 32) {
    const nextHeaderOffset = Number(buffer.readBigUInt64LE(12));
    const nextHeaderSize = Number(buffer.readBigUInt64LE(20));
    const nhStart = 32 + nextHeaderOffset;
    if (nhStart + nextHeaderSize <= buffer.length) {
      const nh = buffer.subarray(nhStart, nhStart + nextHeaderSize);
      if (nh.length > 0 && nh[0] === 0x17) {
        for (let i = 0; i < nh.length - 4; i++) {
          if (nh[i] === 0x06 && nh[i + 1] === 0xf1 && nh[i + 2] === 0x07 && nh[i + 3] === 0x01) {
            throw new ArchiveEncryptedHeaderError('Archive header is encrypted and requires a password to inspect entries.');
          }
        }
      }
    }
  }

  const rawExtracted = extract7zArchive(buffer);
  const entries: ArchiveEntryMetadata[] = rawExtracted.map((f) => ({
    name: f.filename,
    uncompressedSize: f.buffer.length,
    compressedSize: f.buffer.length,
    isEncrypted: false,
    isDirectory: false,
    crc32: crc32(f.buffer).toString(16).padStart(8, '0'),
  }));

  const totalUncompressedBytes = entries.reduce((acc, e) => acc + e.uncompressedSize, 0);
  return {
    format: '7z',
    totalEntries: entries.length,
    totalUncompressedBytes,
    totalCompressedBytes: totalUncompressedBytes,
    isEncrypted: false,
    entries,
  };
}

async function inspectRarBuffer(
  buffer: Buffer,
  password?: string
): Promise<ArchiveInspectResponse> {
  // Fast byte-level inspection for RAR header encryption (MHD_PASSWORD flag)
  if (buffer.length >= 14) {
    const isRar4 =
      buffer[0] === 0x52 &&
      buffer[1] === 0x61 &&
      buffer[2] === 0x72 &&
      buffer[3] === 0x21 &&
      buffer[4] === 0x1a &&
      buffer[5] === 0x07 &&
      buffer[6] === 0x00;
    if (isRar4) {
      const headType = buffer[9];
      const headFlags = buffer.readUInt16LE(10);
      if (headType === 0x73 && (headFlags & 0x0080) !== 0 && !password) {
        throw new ArchiveEncryptedHeaderError(
          'Archive header is encrypted and requires a password to inspect entries.'
        );
      }
    }
  }

  const p7z = get7zBinaryPath();
  if (p7z) {
    return await inspectArchiveVia7zCli(buffer, 'rar', p7z, password);
  }

  // Pure TS fallback for RAR inspection
  if (buffer.length < 14) {
    throw new ConversionFailedError('Invalid RAR archive: buffer too small');
  }

  let offset = 7;
  if (offset + 7 <= buffer.length) {
    const headType = buffer[offset + 2];
    const headFlags = buffer.readUInt16LE(offset + 3);
    const headSize = buffer.readUInt16LE(offset + 5);
    if (headType === 0x73) {
      if ((headFlags & 0x0080) !== 0) {
        throw new ArchiveEncryptedHeaderError('Archive header is encrypted and requires a password to inspect entries.');
      }
      offset += headSize;
    }
  }

  const entries: ArchiveEntryMetadata[] = [];
  let isArchiveEncrypted = false;

  while (offset + 7 <= buffer.length) {
    const headType = buffer[offset + 2];
    const headFlags = buffer.readUInt16LE(offset + 3);
    const headSize = buffer.readUInt16LE(offset + 5);
    if (headSize < 7 || offset + headSize > buffer.length) break;

    if (headType === 0x7b) {
      break;
    }

    if (headType === 0x74 && offset + 32 <= buffer.length) {
      const packSize = buffer.readUInt32LE(offset + 7);
      const unpSize = buffer.readUInt32LE(offset + 11);
      const fileCrc = buffer.readUInt32LE(offset + 16);
      const nameSize = buffer.readUInt16LE(offset + 26);
      const isEnc = (headFlags & 0x0004) !== 0;
      if (isEnc) isArchiveEncrypted = true;

      const nameStart = offset + 32;
      const rawName = nameStart + nameSize <= buffer.length
        ? buffer.toString('utf-8', nameStart, nameStart + nameSize)
        : 'unknown';

      entries.push({
        name: sanitizeArchivePath(rawName) || rawName,
        uncompressedSize: unpSize,
        compressedSize: packSize,
        isEncrypted: isEnc,
        isDirectory: rawName.endsWith('/'),
        crc32: fileCrc.toString(16).padStart(8, '0'),
      });

      offset += headSize + packSize;
    } else {
      offset += headSize;
    }
  }

  const totalUncompressedBytes = entries.reduce((acc, e) => acc + e.uncompressedSize, 0);
  const totalCompressedBytes = entries.reduce((acc, e) => acc + (e.compressedSize || 0), 0);

  return {
    format: 'rar',
    totalEntries: entries.length,
    totalUncompressedBytes,
    totalCompressedBytes,
    isEncrypted: isArchiveEncrypted,
    entries,
  };
}

export async function inspectArchive(
  archiveBuffer: Buffer,
  options: { filename?: string; password?: string } = {}
): Promise<ArchiveInspectResponse> {
  if (!archiveBuffer || archiveBuffer.length === 0) {
    throw new ConversionFailedError('Archive buffer is empty.');
  }

  // 1. ZIP
  if (
    archiveBuffer.length >= 4 &&
    archiveBuffer[0] === 0x50 &&
    archiveBuffer[1] === 0x4b &&
    (archiveBuffer[2] === 0x03 || archiveBuffer[2] === 0x05 || archiveBuffer[2] === 0x07)
  ) {
    return inspectZipBuffer(archiveBuffer);
  }

  // 2. 7z
  if (
    archiveBuffer.length >= 6 &&
    archiveBuffer[0] === 0x37 &&
    archiveBuffer[1] === 0x7a &&
    archiveBuffer[2] === 0xbc &&
    archiveBuffer[3] === 0xaf &&
    archiveBuffer[4] === 0x27 &&
    archiveBuffer[5] === 0x1c
  ) {
    return await inspect7zBuffer(archiveBuffer, options.password);
  }

  // 3. RAR
  if (
    archiveBuffer.length >= 7 &&
    archiveBuffer[0] === 0x52 &&
    archiveBuffer[1] === 0x61 &&
    archiveBuffer[2] === 0x72 &&
    archiveBuffer[3] === 0x21 &&
    archiveBuffer[4] === 0x1a &&
    archiveBuffer[5] === 0x07
  ) {
    return await inspectRarBuffer(archiveBuffer, options.password);
  }

  // 4. Compressed TAR wrappers: GZ, BZ2, ZST, XZ
  if (archiveBuffer.length >= 2 && archiveBuffer[0] === 0x1f && archiveBuffer[1] === 0x8b) {
    try {
      const decompressed = zlib.gunzipSync(archiveBuffer);
      return inspectTarBuffer(decompressed, 'tar.gz');
    } catch {
      throw new ConversionFailedError('Failed to decompress gzip archive.');
    }
  }

  if (archiveBuffer.length >= 3 && archiveBuffer[0] === 0x42 && archiveBuffer[1] === 0x5a && archiveBuffer[2] === 0x68) {
    try {
      const decompressed = decompressBzip2(archiveBuffer);
      return inspectTarBuffer(decompressed, 'tar.bz2');
    } catch {
      throw new ConversionFailedError('Failed to decompress bzip2 archive.');
    }
  }

  if (archiveBuffer.length >= 4 && archiveBuffer.subarray(0, 4).equals(ZSTD_MAGIC_LE)) {
    try {
      const decompressed = decompressZstd(archiveBuffer);
      return inspectTarBuffer(decompressed, 'tar.zst');
    } catch {
      throw new ConversionFailedError('Failed to decompress zstd archive.');
    }
  }

  // 5. TAR
  if (archiveBuffer.length >= 512) {
    const magic = archiveBuffer.toString('ascii', 257, 262);
    if (magic.startsWith('ustar') || options.filename?.endsWith('.tar')) {
      return inspectTarBuffer(archiveBuffer, 'tar');
    }
  }

  const hint = options.filename ? path.extname(options.filename).toLowerCase() : '';
  if (hint === '.zip') return inspectZipBuffer(archiveBuffer);
  if (hint === '.7z') return await inspect7zBuffer(archiveBuffer, options.password);
  if (hint === '.rar') return await inspectRarBuffer(archiveBuffer, options.password);
  if (hint === '.tar') return inspectTarBuffer(archiveBuffer, 'tar');

  throw new ConversionFailedError('Unsupported or unrecognized archive format for inspection.');
}

export async function convertArchive(
  inputBuffer: Buffer,
  sourceFormat: string,
  targetFormat: string,
  options: ConversionOptions = {},
  originalFilename: string
): Promise<ConversionResult> {
  let effectiveBuffer = inputBuffer;
  let effectiveSourceFormat = sourceFormat.toLowerCase();
  let effectiveFilename = originalFilename;

  // Stitch multi-volume archive parts if provided in options or if part sequence detected
  const multiParts = options.archiveParts;
  if (multiParts && Array.isArray(multiParts) && multiParts.length > 0) {
    const stitched = stitchMultiVolumeArchive(multiParts);
    effectiveBuffer = stitched.buffer;
    effectiveFilename = stitched.baseFilename;
    effectiveSourceFormat = stitched.format || effectiveSourceFormat;
  } else if (isSplitArchive(originalFilename)) {
    const stitched = stitchMultiVolumeArchive([{ filename: originalFilename, buffer: inputBuffer }]);
    effectiveBuffer = stitched.buffer;
    effectiveFilename = stitched.baseFilename;
    effectiveSourceFormat = stitched.format || effectiveSourceFormat;
  }

  const baseName = effectiveFilename.replace(/\.[^/.]+$/, '');
  const src = effectiveSourceFormat;
  const tgt = targetFormat.toLowerCase();

  if (options.repair) {
    if (src !== 'zip' && tgt !== 'zip') {
      throw new UnsupportedOptionError('Archive repair mode is only supported for ZIP archives.');
    }
    const repairedBuffer = await repairZipArchive(effectiveBuffer, options);
    return {
      buffer: repairedBuffer,
      mimeType: 'application/zip',
      filename: `${baseName}.zip`,
      size: repairedBuffer.length,
    };
  }

  if (options.password && /[\r\n\0]/.test(options.password)) {
    throw new ConversionFailedError('Archive password contains invalid newline or null characters.');
  }

  if (options.password && tgt !== 'zip' && tgt !== '7z') {
    throw new UnsupportedOptionError(`Target archive format '${tgt}' does not support password encryption.`);
  }

  // Attempt native 7-Zip acceleration hook if explicitly enabled in options
  if (options.useNative7z) {
    const native7zRes = convertWithNative7z(effectiveBuffer, src, tgt, options, effectiveFilename);
    if (native7zRes) {
      if (options.splitVolumeBytes && options.splitVolumeBytes > 0) {
        const parts = splitArchive(native7zRes.buffer, native7zRes.filename, options.splitVolumeBytes);
        return {
          ...native7zRes,
          parts,
        };
      }
      return native7zRes;
    }
  }

  // 1. Extract files from source if it is an archive
  let files: { filename: string; buffer: Buffer }[] = [];
  if (src === 'zip') {
    const hasZipMagic =
      effectiveBuffer.length >= 4 &&
      effectiveBuffer[0] === 0x50 &&
      effectiveBuffer[1] === 0x4b;
    try {
      files = await extractZipArchive(effectiveBuffer, options);
    } catch (err) {
      throw new ConversionFailedError(
        `Failed to extract ZIP archive '${effectiveFilename}': ${err instanceof Error ? err.message : String(err)}`
      );
    }
  } else if (src === 'tar') {
    try {
      files = extractTarArchive(effectiveBuffer, options);
    } catch (err) {
      throw new ConversionFailedError(
        `Failed to extract TAR archive '${effectiveFilename}': ${err instanceof Error ? err.message : String(err)}`
      );
    }
  } else if (src === 'gz' || src === 'tgz' || src === 'tar.gz') {
    try {
      const uncompressed = await gunzipStreamingWithLimits(effectiveBuffer);
      if (src === 'tgz' || src === 'tar.gz' || uncompressed.subarray(257, 262).toString('ascii') === 'ustar') {
        files = extractTarArchive(uncompressed, options);
      } else {
        files = [{ filename: baseName, buffer: uncompressed }];
      }
    } catch (err) {
      throw new ConversionFailedError(
        `Failed to decompress GZIP archive '${effectiveFilename}': ${err instanceof Error ? err.message : String(err)}`
      );
    }
  } else if (src === 'tar.bz2' || src === 'tbz2' || src === 'tbz' || src === 'bz2' || src === 'bz') {
    try {
      const uncompressed = decompressBzip2(effectiveBuffer);
      if (uncompressed.length > ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE) {
        throw new Error(
          `Archive bomb detected: uncompressed size exceeds limit of ${ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE} bytes (500MB)`
        );
      }
      if (effectiveBuffer.length > 0 && uncompressed.length / effectiveBuffer.length > ARCHIVE_SECURITY_LIMITS.MAX_RATIO) {
        throw new Error(
          `Archive bomb detected: compression ratio exceeds ${ARCHIVE_SECURITY_LIMITS.MAX_RATIO}:1 limit`
        );
      }
      if (src === 'tar.bz2' || src === 'tbz2' || src === 'tbz' || uncompressed.subarray(257, 262).toString('ascii') === 'ustar') {
        files = extractTarArchive(uncompressed, options);
      } else {
        files = [{ filename: baseName, buffer: uncompressed }];
      }
    } catch (err) {
      throw new ConversionFailedError(
        `Failed to decompress BZIP2 archive '${effectiveFilename}': ${err instanceof Error ? err.message : String(err)}`
      );
    }
  } else if (src === 'rar') {
    try {
      files = extractRarArchive(effectiveBuffer, options);
      if (options.entries && options.entries.length > 0) {
        files = files.filter((f) => matchArchiveGlob(f.filename, options.entries));
      }
    } catch (err: any) {
      throw new ConversionFailedError(
        `Failed to extract RAR archive '${effectiveFilename}': ${err?.message || String(err)}`
      );
    }
  } else if (src === '7z' || src === 'tar.7z') {
    try {
      files = extract7zArchive(effectiveBuffer, options);
    } catch (err: any) {
      throw new ConversionFailedError(
        `Failed to extract 7z archive '${effectiveFilename}': ${err?.message || String(err)}`
      );
    }
  } else if (src === 'zst' || src === 'zstd' || src === 'tar.zst') {
    let uncompressed: Buffer;
    if (options.zstdDict) {
      const dict =
        typeof options.zstdDict === 'string' && (options.zstdDict === 'office' || options.zstdDict === 'data')
          ? getPretrainedDictionary(options.zstdDict)
          : DATA_DICTIONARY_JSON_CSV;
      uncompressed = decompressWithZstdDict(effectiveBuffer, dict);
    } else if (
      effectiveBuffer.length >= 13 &&
      effectiveBuffer.subarray(0, 4).equals(ZSTD_MAGIC_LE) &&
      (effectiveBuffer[4] & 0x03) === 3
    ) {
      const fcsFlag = (effectiveBuffer[4] >> 6) & 0x03;
      const fcsBytes = fcsFlag === 0 ? 1 : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8;
      if (effectiveBuffer.length >= 5 + fcsBytes + 4) {
        const dictId = effectiveBuffer.readUInt32LE(5 + fcsBytes);
        if (dictId === ZSTD_DICT_MAGIC) {
          uncompressed = decompressWithZstdDict(effectiveBuffer, DATA_DICTIONARY_JSON_CSV);
        } else {
          uncompressed = decompressZstd(effectiveBuffer);
        }
      } else {
        uncompressed = decompressZstd(effectiveBuffer);
      }
    } else {
      uncompressed = decompressZstd(effectiveBuffer);
    }
    if (uncompressed.length > ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE) {
      throw new Error(
        `Archive bomb detected: uncompressed size exceeds limit of ${ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE} bytes (500MB)`
      );
    }
    if (effectiveBuffer.length > 0 && uncompressed.length / effectiveBuffer.length > ARCHIVE_SECURITY_LIMITS.MAX_RATIO) {
      throw new Error(
        `Archive bomb detected: compression ratio exceeds ${ARCHIVE_SECURITY_LIMITS.MAX_RATIO}:1 limit`
      );
    }
    if (src === 'tar.zst' || uncompressed.subarray(257, 262).toString('ascii') === 'ustar') {
      files = extractTarArchive(uncompressed, options);
    } else {
      files = [{ filename: baseName, buffer: uncompressed }];
    }
  } else if (src === 'tar.xz' || src === 'txz' || src === 'xz') {
    try {
      const uncompressed = decompressXz(effectiveBuffer);
      if (uncompressed.length > ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE) {
        throw new Error(
          `Archive bomb detected: uncompressed size exceeds limit of ${ARCHIVE_SECURITY_LIMITS.MAX_UNCOMPRESSED_SIZE} bytes (500MB)`
        );
      }
      if (effectiveBuffer.length > 0 && uncompressed.length / effectiveBuffer.length > ARCHIVE_SECURITY_LIMITS.MAX_RATIO) {
        throw new Error(
          `Archive bomb detected: compression ratio exceeds ${ARCHIVE_SECURITY_LIMITS.MAX_RATIO}:1 limit`
        );
      }
      if (src === 'tar.xz' || src === 'txz' || uncompressed.subarray(257, 262).toString('ascii') === 'ustar') {
        files = extractTarArchive(uncompressed, options);
      } else {
        files = [{ filename: baseName, buffer: uncompressed }];
      }
    } catch (err) {
      throw new ConversionFailedError(
        `Failed to decompress XZ archive '${effectiveFilename}': ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  const ARCHIVE_CONTAINER_FORMATS = new Set([
    'zip',
    'tar',
    'gz',
    'tgz',
    'tar.gz',
    'bz2',
    'tar.bz2',
    'tbz',
    'tbz2',
    '7z',
    'tar.7z',
    'rar',
    'zst',
    'zstd',
    'tar.zst',
    'xz',
    'txz',
    'tar.xz',
  ]);
  function isValidEmptyArchive(format: string, buffer: Buffer): boolean {
    if (format === 'zip') {
      return buffer.length >= 22 && buffer[0] === 0x50 && buffer[1] === 0x4b;
    }
    if (format === 'tar') {
      return buffer.length >= 512 && buffer.subarray(0, 512).every((b) => b === 0);
    }
    return false;
  }

  if (files.length === 0) {
    if (isValidEmptyArchive(src, effectiveBuffer)) {
      // Valid empty archive: retain files = [] so empty target archive is generated
    } else if (ARCHIVE_CONTAINER_FORMATS.has(src)) {
      throw new ConversionFailedError(
        `Failed to extract any files from source archive '${effectiveFilename}' (corrupt or invalid archive format)`
      );
    } else {
      files = [{ filename: effectiveFilename, buffer: effectiveBuffer }];
    }
  }

  let result: ConversionResult;

  // 2. Target TAR.GZ or TGZ
  if (tgt === 'tar.gz' || tgt === 'tgz') {
    const tarResult = createTarArchive(files, options, `${baseName}.tar`);
    const gzipped = zlib.gzipSync(tarResult.buffer, {
      level: options.compressionLevel ? Math.max(1, Math.min(9, options.compressionLevel)) : 6,
    });
    result = {
      buffer: gzipped,
      mimeType: 'application/gzip',
      filename: `${baseName}.${tgt}`,
      size: gzipped.length,
    };
  } else if (tgt === 'tar.bz2' || tgt === 'tbz2' || tgt === 'tbz') {
    // 3. Target TAR.BZ2 or TBZ2 or TBZ
    const tarResult = createTarArchive(files, options, `${baseName}.tar`);
    const bz2Buffer = compressBzip2(tarResult.buffer);
    result = {
      buffer: bz2Buffer,
      mimeType: 'application/x-bzip-compressed-tar',
      filename: `${baseName}.${tgt}`,
      size: bz2Buffer.length,
    };
  } else if (tgt === 'bz2' || tgt === 'bz') {
    // 3.1 Target BZ2
    const rawToCompress = files.length === 1 ? files[0].buffer : effectiveBuffer;
    const bz2Buffer = compressBzip2(rawToCompress);
    result = {
      buffer: bz2Buffer,
      mimeType: 'application/x-bzip2',
      filename: `${effectiveFilename}.${tgt}`,
      size: bz2Buffer.length,
    };
  } else if (tgt === '7z' || tgt === 'tar.7z') {
    // 4. Target 7Z
    result = create7zArchive(files, options, `${baseName}.${tgt}`);
  } else if (tgt === 'rar') {
    // 5. Target RAR
    throw new ConversionFailedError(
      "Target archive format 'rar' creation is not supported. RAR archive creation has been removed per D8; please use ZIP, 7z, or TAR."
    );
  } else if (tgt === 'tar') {
    // 6. Target TAR
    result = createTarArchive(files, options, `${baseName}.tar`);
  } else if (tgt === 'gz') {
    // 7. Target GZ
    const rawToCompress = files.length === 1 ? files[0].buffer : effectiveBuffer;
    const gzipped = zlib.gzipSync(rawToCompress, {
      level: options.compressionLevel ? Math.max(1, Math.min(9, options.compressionLevel)) : 6,
    });
    result = {
      buffer: gzipped,
      mimeType: 'application/gzip',
      filename: `${effectiveFilename}.gz`,
      size: gzipped.length,
    };
  } else if (tgt === 'tar.zst') {
    // 7.1 Target TAR.ZST
    const tarResult = createTarArchive(files, options, `${baseName}.tar`);
    let zstdBuffer: Buffer;
    if (options.zstdDict) {
      const dict =
        typeof options.zstdDict === 'string' && (options.zstdDict === 'office' || options.zstdDict === 'data')
          ? getPretrainedDictionary(options.zstdDict)
          : DATA_DICTIONARY_JSON_CSV;
      zstdBuffer = compressWithZstdDict(tarResult.buffer, dict);
    } else {
      zstdBuffer = compressZstd(tarResult.buffer);
    }
    result = {
      buffer: zstdBuffer,
      mimeType: 'application/x-zstd-compressed-tar',
      filename: `${baseName}.${tgt}`,
      size: zstdBuffer.length,
    };
  } else if (tgt === 'zst' || tgt === 'zstd') {
    // 7.2 Target ZST / ZSTD
    const rawToCompress = files.length === 1 ? files[0].buffer : effectiveBuffer;
    let zstdBuffer: Buffer;
    if (options.zstdDict) {
      const dict =
        typeof options.zstdDict === 'string' && (options.zstdDict === 'office' || options.zstdDict === 'data')
          ? getPretrainedDictionary(options.zstdDict)
          : DATA_DICTIONARY_JSON_CSV;
      zstdBuffer = compressWithZstdDict(rawToCompress, dict);
    } else {
      zstdBuffer = compressZstd(rawToCompress);
    }
    result = {
      buffer: zstdBuffer,
      mimeType: 'application/zstd',
      filename: `${effectiveFilename}.${tgt}`,
      size: zstdBuffer.length,
    };
  } else if (tgt === 'tar.xz' || tgt === 'txz') {
    // 7.3 Target TAR.XZ / TXZ
    const tarResult = createTarArchive(files, options, `${baseName}.tar`);
    const xzBuffer = compressXz(tarResult.buffer, options);
    result = {
      buffer: xzBuffer,
      mimeType: 'application/x-xz-compressed-tar',
      filename: `${baseName}.${tgt}`,
      size: xzBuffer.length,
    };
  } else if (tgt === 'xz') {
    // 7.4 Target XZ
    const rawToCompress = files.length === 1 ? files[0].buffer : effectiveBuffer;
    const xzBuffer = compressXz(rawToCompress, options);
    result = {
      buffer: xzBuffer,
      mimeType: 'application/x-xz',
      filename: `${effectiveFilename}.${tgt}`,
      size: xzBuffer.length,
    };
  } else if (tgt === 'zip') {
    // 8. Target ZIP
    result = await createZipArchive(files, options, `${baseName}.zip`);
  } else {
    throw new ConversionFailedError(
      `Unsupported archive target format '${targetFormat}': foreign formats must not silently fall back to ZIP.`
    );
  }

  // 9. Split Archive Volume Generation (Multi-Volume)
  if (options.splitVolumeBytes && options.splitVolumeBytes > 0) {
    const parts = splitArchive(result.buffer, result.filename, options.splitVolumeBytes);
    return {
      ...result,
      parts,
    };
  }

  return result;
}

export async function convertToArchive(
  inputBuffer: Buffer,
  options: ConversionOptions = {},
  originalFilename: string
): Promise<ConversionResult> {
  const baseName = originalFilename.replace(/\.[^/.]+$/, '');
  return createZipArchive(
    [{ filename: originalFilename, buffer: inputBuffer }],
    options,
    `${baseName}.zip`
  );
}
