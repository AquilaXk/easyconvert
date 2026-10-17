import fs from 'node:fs';
import path from 'node:path';
import { decompressZstd } from './zstd';
import {
  UnreadableArchiveError,
  extractArchiveContained,
  hasTarHeaderChecksum,
  unpackedBytesCap,
  type ContainedExtractionRequest,
  type ContainedTree,
} from './archive-extraction-safety';

/**
 * The files of a software package are its payload, not the compressed stream that carries it.
 *
 * An rpm holds a cpio and a deb holds a tar (`data.tar`), usually compressed. 7-Zip opens the package, decompresses the
 * payload when it knows the compression, and then either lists the files (an uncompressed cpio) or hands out the payload
 * as one file. Converting the package to another archive means converting the files it installs, so that file is read as
 * the archive it is, through the same listing, vetting and extraction as any other source. A layer 7-Zip leaves
 * compressed is decompressed first: with 7-Zip when it is gzip, bzip2 or xz, in process when it is Zstandard (modern
 * Fedora and Debian packages), within the archive's size and ratio caps.
 *
 * Every layer is vetted before anything is written: names, links, special files, entry count and the size and ratio caps
 * (the ratio is always measured against the package the caller uploaded, never against an inner layer).
 */

export const PACKAGE_SOURCES: ReadonlySet<string> = new Set(['rpm', 'deb']);

/**
 * Sources that carry symbolic links as a matter of course (every package and installer image has some): unless the caller
 * says otherwise their links are left out of the conversion and reported in `skippedLinks`, because refusing the archive
 * would refuse nearly every real one. Other archives keep the opt-in `skipLinks`.
 */
export const LINK_TOLERANT_SOURCES: ReadonlySet<string> = new Set([...PACKAGE_SOURCES, 'dmg', 'img', 'iso', 'cpio']);

const FIRST_BLOCK_BYTES = 512;
const CPIO_MAGICS = new Set(['070701', '070702', '070707']);
const CPIO_MAGIC_BYTES = 6;
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);
const BZIP2_MAGIC = Buffer.from('BZh', 'latin1');
const XZ_MAGIC = Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]);
/** Compression layers read before the payload must be a cpio or tar; real packages have one. */
const MAX_COMPRESSION_LAYERS = 3;
/** A deb's payload is its `data.tar` member (7-Zip names it so after decompressing it, or keeps the compression suffix). */
const DEB_DATA_MEMBER = /^data\.tar(\.[^/]+)?$/;
const ZSTD_PAYLOAD_NAME = 'payload.zstd-decoded';

type ArchiveKind = 'cpio' | 'tar';
type CompressionKind = 'zstd' | 'gzip' | 'bzip2' | 'xz';
type PayloadKind = ArchiveKind | CompressionKind;

const COMPRESSION_MAGICS: ReadonlyArray<readonly [CompressionKind, Buffer]> = [
  ['zstd', ZSTD_MAGIC],
  ['gzip', GZIP_MAGIC],
  ['bzip2', BZIP2_MAGIC],
  ['xz', XZ_MAGIC],
];

/** 7-Zip's `-t` switch for the layers it decompresses, and for the archives in the payload. */
const SEVEN_ZIP_TYPE_FLAGS: Readonly<Record<Exclude<PayloadKind, 'zstd'>, string>> = {
  cpio: '-tcpio',
  tar: '-ttar',
  gzip: '-tgzip',
  bzip2: '-tbzip2',
  xz: '-txz',
};

export interface PackagePayload {
  tree: ContainedTree;
  /** The directory holding the payload files (the request's own, or the one the payload was extracted into). */
  root: string;
}

function readFirstBlock(file: string): Buffer {
  const fd = fs.openSync(file, 'r');
  try {
    const block = Buffer.alloc(FIRST_BLOCK_BYTES);
    return block.subarray(0, fs.readSync(fd, block, 0, FIRST_BLOCK_BYTES, 0));
  } finally {
    fs.closeSync(fd);
  }
}

/** What an extracted payload stream is, from its first bytes; null when it is none of the payloads packages carry. */
function sniffPayload(file: string): PayloadKind | null {
  const head = readFirstBlock(file);
  if (CPIO_MAGICS.has(head.toString('latin1', 0, CPIO_MAGIC_BYTES))) return 'cpio';
  // A tar header carries a checksum of itself, so it is told apart before the short magic numbers of the compressors.
  if (hasTarHeaderChecksum(file)) return 'tar';
  const compression = COMPRESSION_MAGICS.find(([, magic]) => head.length >= magic.length && head.subarray(0, magic.length).equals(magic));
  return compression === undefined ? null : compression[0];
}

/** Decompresses a Zstandard payload into `outDir` and returns the file; the output is capped by the archive size and ratio caps. */
function decodeZstdPayload(request: ContainedExtractionRequest, compressed: string, archiveBytes: number, outDir: string): string {
  const decoded = decompressZstd(fs.readFileSync(compressed), { maxOutputBytes: unpackedBytesCap(archiveBytes, request.limits) });
  const target = path.join(outDir, ZSTD_PAYLOAD_NAME);
  fs.writeFileSync(target, decoded);
  return target;
}

/**
 * The file 7-Zip handed out as the package's payload stream: an rpm's only entry, or the `data.tar` of a deb that also lists
 * its control member, at the top level. Anything else is a payload 7-Zip listed itself (the files, under directories).
 */
function payloadFile(tree: ContainedTree): string | null {
  const topLevelOnly = tree.entryCount === tree.files.length && tree.files.every((file) => !file.relPath.includes('/'));
  if (!topLevelOnly) return null;
  if (tree.files.length === 1) return tree.files[0].absPath;
  const dataMembers = tree.files.filter((file) => DEB_DATA_MEMBER.test(file.relPath));
  return dataMembers.length === 1 ? dataMembers[0].absPath : null;
}

/**
 * Archive members are named `./path` in a cpio and a tar written by the package tools, and 7-Zip matches a selection
 * pattern against that name as it is. A pattern a caller wrote without the prefix means the same file, so both spellings
 * are given.
 */
function withDotSlashSpellings(patterns: string[] | undefined): string[] | undefined {
  return patterns?.flatMap((pattern) => (pattern.startsWith('./') ? [pattern] : [pattern, `./${pattern}`]));
}

/** Decompresses one compression layer into its own directory with 7-Zip and returns the single file it holds. */
async function decompressLayer(
  request: ContainedExtractionRequest,
  layer: { file: string; kind: Exclude<CompressionKind, 'zstd'> },
  layerDir: string,
  ratioBaseBytes: number
): Promise<string> {
  fs.mkdirSync(layerDir);
  const tree = await extractArchiveContained({
    ...request,
    archivePath: layer.file,
    extractDir: layerDir,
    typeFlag: SEVEN_ZIP_TYPE_FLAGS[layer.kind],
    includePatterns: undefined,
    ratioBaseBytes,
    password: undefined,
    allowInternalHardLinks: false,
  });
  if (tree.files.length !== 1 || tree.entryCount !== 1) {
    throw new UnreadableArchiveError('Could not read the package: a compressed layer of its payload does not hold one stream.');
  }
  return tree.files[0].absPath;
}

/**
 * Follows the compression layers of a payload stream down to the cpio or tar it carries.
 * Returns null when the stream is not a payload at all; throws when a layer cannot be read.
 */
async function openPayloadLayers(
  request: ContainedExtractionRequest,
  first: { file: string; kind: PayloadKind },
  workDir: string,
  archiveBytes: number
): Promise<{ file: string; kind: ArchiveKind } | null> {
  let current: { file: string; kind: PayloadKind | null } = first;
  for (let layer = 0; layer < MAX_COMPRESSION_LAYERS; layer++) {
    if (current.kind === 'cpio' || current.kind === 'tar') return { file: current.file, kind: current.kind };
    if (current.kind === null) return null;
    const next =
      current.kind === 'zstd'
        ? decodeZstdPayload(request, current.file, archiveBytes, workDir)
        : await decompressLayer(request, { file: current.file, kind: current.kind }, path.join(workDir, `layer-${layer}`), archiveBytes);
    current = { file: next, kind: sniffPayload(next) };
  }
  return null;
}

/** The selected files of a package whose payload 7-Zip lists itself: the package is read again with the selection. */
async function extractSelection(request: ContainedExtractionRequest): Promise<PackagePayload> {
  const root = `${request.extractDir}-selected`;
  fs.mkdirSync(root);
  const tree = await extractArchiveContained({
    ...request,
    extractDir: root,
    includePatterns: withDotSlashSpellings(request.includePatterns),
    allowInternalHardLinks: true,
  });
  return { tree, root };
}

/** The files 7-Zip listed itself are the payload; a package without any entry is one whose payload it could not list (a cpio with stripped headers, for one). */
async function listedPayload(request: ContainedExtractionRequest, outer: ContainedTree): Promise<PackagePayload> {
  if (outer.entryCount === 0) throw new UnreadableArchiveError('Could not read the package: its payload holds no entries 7-Zip can list.');
  return request.includePatterns === undefined ? { tree: outer, root: request.extractDir } : extractSelection(request);
}

const NOT_AN_ARCHIVE_PAYLOAD =
  'Could not read the package: its payload is not a cpio or tar archive, or is compressed with a method that is not supported.';

/**
 * Extracts the payload files of an rpm or deb into `request.extractDir` (or a sibling directory when the payload is a
 * layer inside the package). Throws a typed error for anything unsafe, oversized or unreadable.
 */
export async function extractPackagePayload(request: ContainedExtractionRequest, format: 'rpm' | 'deb'): Promise<PackagePayload> {
  const archiveBytes = fs.statSync(request.archivePath).size;
  // The selection names files of the payload, so it cannot apply to the package's own layer.
  const outer = await extractArchiveContained({ ...request, includePatterns: undefined, allowInternalHardLinks: true });
  const stream = payloadFile(outer);
  if (stream === null) {
    // A deb is only ever its members: without a `data.tar` there is no payload to convert.
    if (format === 'deb') throw new UnreadableArchiveError(NOT_AN_ARCHIVE_PAYLOAD);
    return listedPayload(request, outer);
  }

  const payloadDir = `${request.extractDir}-payload`;
  fs.mkdirSync(payloadDir);
  const firstKind = sniffPayload(stream);
  const archive = firstKind === null ? null : await openPayloadLayers(request, { file: stream, kind: firstKind }, payloadDir, archiveBytes);
  if (archive === null) {
    // An rpm whose one file is not a payload is a package of that file; a deb has nothing else to be.
    if (format === 'deb') throw new UnreadableArchiveError(NOT_AN_ARCHIVE_PAYLOAD);
    return listedPayload(request, outer);
  }

  const filesDir = path.join(payloadDir, 'files');
  fs.mkdirSync(filesDir);
  const tree = await extractArchiveContained({
    ...request,
    archivePath: archive.file,
    extractDir: filesDir,
    typeFlag: SEVEN_ZIP_TYPE_FLAGS[archive.kind],
    includePatterns: withDotSlashSpellings(request.includePatterns),
    ratioBaseBytes: archiveBytes,
    password: undefined,
    allowInternalHardLinks: true,
  });
  return { tree, root: filesDir };
}
