import { crc32 } from './crc32';
import type { ArchiveExtractionLimits } from './archive-extraction-safety';
import { unpackWrapperSource } from './archive-wrapper-sources';
import type { ArchiveInspectResponse } from '../types';

/**
 * What `inspectArchive` tells apart by the first bytes of an upload, and the listing of the single-stream lzip and lzop
 * files, which 7-Zip does not open: a tar inside is listed by its members, any other payload is the one file it holds.
 */

/** What the per-format inspectors return; `inspectArchive` adds the extractability report. */
export type InspectionBody = Omit<ArchiveInspectResponse, 'extractable' | 'unextractableReasons'>;

const ZIP_MAGIC = [0x50, 0x4b];
const ZIP_RECORD_KINDS = new Set([0x03, 0x05, 0x07]);
const SEVEN_ZIP_MAGIC = [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c];
const RAR_MAGIC = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07];
const RAR_MIN_BYTES = RAR_MAGIC.length + 1;
const LZIP_MAGIC = Buffer.from('LZIP', 'latin1');
const LZOP_MAGIC = Buffer.from([0x89, 0x4c, 0x5a, 0x4f, 0x00, 0x0d, 0x0a, 0x1a, 0x0a]);
const LZ_EXTENSION = /\.(?:lz|lzo)$/i;
/** The name an inspected lzip or lzop file gets for its one stream when the caller gave no file name. */
const UNNAMED_STREAM = 'data';

const startsWith = (buffer: Buffer, magic: readonly number[]): boolean => buffer.length >= magic.length && magic.every((byte, i) => buffer[i] === byte);

/** A ZIP local file header, central directory record or end-of-archive record at the start. */
export const isZipArchive = (buffer: Buffer): boolean => startsWith(buffer, ZIP_MAGIC) && buffer.length >= 4 && ZIP_RECORD_KINDS.has(buffer[2]);

export const isSevenZipArchive = (buffer: Buffer): boolean => startsWith(buffer, SEVEN_ZIP_MAGIC);

export const isRarArchive = (buffer: Buffer): boolean => buffer.length >= RAR_MIN_BYTES && startsWith(buffer, RAR_MAGIC);

/** `lz` for a lzip file and `lzo` for a lzop file, told by the first bytes; null for any other bytes. */
export function sniffLzSource(archive: Buffer): 'lz' | 'lzo' | null {
  if (archive.subarray(0, LZIP_MAGIC.length).equals(LZIP_MAGIC)) return 'lz';
  return archive.subarray(0, LZOP_MAGIC.length).equals(LZOP_MAGIC) ? 'lzo' : null;
}

/** The name of the file inside a lzip or lzop file that is not a tar: the upload's own name without the compression suffix. */
function lzStreamName(filename: string | undefined): string {
  const leaf = filename?.split(/[\\/]/).pop() ?? '';
  const name = leaf.replace(LZ_EXTENSION, '');
  return name === '' ? UNNAMED_STREAM : name;
}

/**
 * Lists a lzip or lzop file within the same size and ratio caps the conversion applies to it. A tar inside is listed by
 * `inspectTar`; any other payload is one entry named like the upload, with its size and CRC-32.
 */
export function inspectLzSource(
  buffer: Buffer,
  source: 'lz' | 'lzo',
  filename: string | undefined,
  limits: ArchiveExtractionLimits,
  inspectTar: (tar: Buffer, format: string) => InspectionBody
): InspectionBody {
  const unpacked = unpackWrapperSource(source, buffer, limits);
  if (unpacked.isTar) return inspectTar(unpacked.payload, `tar.${source}`);
  const size = unpacked.payload.length;
  return {
    format: source,
    totalEntries: 1,
    totalUncompressedBytes: size,
    totalCompressedBytes: buffer.length,
    isEncrypted: false,
    entries: [
      {
        name: lzStreamName(filename),
        uncompressedSize: size,
        compressedSize: buffer.length,
        isEncrypted: false,
        isDirectory: false,
        crc32: crc32(unpacked.payload).toString(16).padStart(8, '0'),
      },
    ],
  };
}
