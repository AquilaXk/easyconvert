import { DecompressionLimitError } from '../types';
import {
  exceedsArchiveRatio,
  unpackedBytesCap,
  unpackedBytesCapError,
  type ArchiveExtractionLimits,
} from './archive-extraction-safety';
import { classifyUnpacked } from './archive-stream-route';
import { decompressBzip2 } from './bzip2';
import { decompressLzip } from './lzip';
import { decompressLzop } from './lzop';

/**
 * The single-stream sources the in-process engine decompresses itself: bzip2 (`bz2`, `bz` and the tarballs `tar.bz2`, `tbz2`,
 * `tbz`, `tar.bz`), lzip (`lz`) and lzop (`lzo` and the tarballs `tar.lzo`, `tzo`; 7-Zip reads neither). Each unpacks to one
 * payload, which is a tar to extract when the name says tarball or the payload looks like one, and the single file otherwise.
 */
const BZIP2_TARBALL_SOURCES: ReadonlySet<string> = new Set(['tar.bz2', 'tbz2', 'tbz', 'tar.bz']);
const BZIP2_SOURCES: ReadonlySet<string> = new Set([...BZIP2_TARBALL_SOURCES, 'bz2', 'bz']);
const LZIP_SOURCES: ReadonlySet<string> = new Set(['lz']);
const LZOP_SOURCES: ReadonlySet<string> = new Set(['lzo', 'tar.lzo', 'tzo']);
const LZOP_TARBALL_SOURCES: ReadonlySet<string> = new Set(['tar.lzo', 'tzo']);


/** A payload read as a tar when its first block is a tar header: the `ustar` magic, or a valid header checksum (a v7 tar). */
function looksLikeTar(payload: Buffer): boolean {
  return classifyUnpacked(payload) !== 'plain';
}

export function isWrapperSource(src: string): boolean {
  return BZIP2_SOURCES.has(src) || LZIP_SOURCES.has(src) || LZOP_SOURCES.has(src);
}

export interface UnpackedWrapper {
  payload: Buffer;
  /** The payload is a tar archive to extract rather than a file to pack as it is. */
  isTar: boolean;
  /** Names the compression in error messages. */
  label: string;
}

function bzip2Payload(src: string, archive: Buffer, limits: ArchiveExtractionLimits): UnpackedWrapper {
  const payload = decompressBzip2(archive, limits.MAX_UNCOMPRESSED_SIZE);
  if (payload.length > limits.MAX_UNCOMPRESSED_SIZE) {
    throw new DecompressionLimitError(
      `Archive bomb detected: uncompressed size exceeds limit of ${limits.MAX_UNCOMPRESSED_SIZE} bytes (500MB)`
    );
  }
  if (exceedsArchiveRatio(payload.length, archive.length, limits.MAX_RATIO)) {
    throw new DecompressionLimitError(`Archive bomb detected: compression ratio exceeds ${limits.MAX_RATIO}:1 limit`);
  }
  return { payload, isTar: BZIP2_TARBALL_SOURCES.has(src) || looksLikeTar(payload), label: 'BZIP2' };
}

/** lzip and lzop output is bounded by the archive size and ratio caps, as the other single-stream wrappers are. */
function lzPayload(src: string, archive: Buffer, limits: ArchiveExtractionLimits): UnpackedWrapper {
  const cap = unpackedBytesCap(archive.length, limits);
  const lzip = LZIP_SOURCES.has(src);
  let payload: Buffer;
  try {
    payload = lzip ? decompressLzip(archive, cap) : decompressLzop(archive, cap);
  } catch (err) {
    if (err instanceof DecompressionLimitError) throw unpackedBytesCapError(archive.length, limits);
    throw err;
  }
  return { payload, isTar: LZOP_TARBALL_SOURCES.has(src) || looksLikeTar(payload), label: lzip ? 'LZIP' : 'LZOP' };
}

/** Decompresses a bzip2, lzip or lzop source; failures are typed (bomb, corrupt stream). */
export function unpackWrapperSource(src: string, archive: Buffer, limits: ArchiveExtractionLimits): UnpackedWrapper {
  return BZIP2_SOURCES.has(src) ? bzip2Payload(src, archive, limits) : lzPayload(src, archive, limits);
}
