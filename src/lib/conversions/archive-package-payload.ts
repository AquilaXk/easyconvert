import fs from 'node:fs';
import path from 'node:path';
import { decompressZstd } from './zstd';
import { SandboxedTimeoutError } from '../security/process-sandbox';
import { DecompressionLimitError } from '../types';
import {
  UnreadableArchiveError,
  extractArchiveContained,
  hasTarHeaderChecksum,
  readFirstTarBlock,
  removeDirectoryTree,
  unpackedBytesCap,
  unpackedBytesCapError,
  type ArchiveExtractionLimits,
  type ContainedExtractionRequest,
  type ContainedTree,
} from './archive-extraction-safety';
import { readRpmPackage, type RpmPackage } from './rpm-header';
import { strippedPayloadToCpio } from './rpm-stripped-payload';

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
 * A payload of stripped cpio headers (rpm 4.12 and later: `07070X` and a file index, with the names, modes and sizes in the
 * package header) is listed as empty by 7-Zip. Its own bytes are taken from the package, decompressed like any other
 * payload, and rewritten as an ordinary cpio from the header's file table (rpm-header.ts, rpm-stripped-payload.ts), which
 * then goes through the same listing, vetting and extraction.
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

const CPIO_MAGICS = new Set(['070701', '070702', '070707']);
const STRIPPED_CPIO_MAGIC = '07070X';
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
/** A cpio of stripped headers, which names nothing and is rewritten as a cpio before it is read. */
type StrippedKind = 'stripped';
type PayloadKind = ArchiveKind | StrippedKind | CompressionKind;

const COMPRESSION_MAGICS: ReadonlyArray<readonly [CompressionKind, Buffer]> = [
  ['zstd', ZSTD_MAGIC],
  ['gzip', GZIP_MAGIC],
  ['bzip2', BZIP2_MAGIC],
  ['xz', XZ_MAGIC],
];

/** 7-Zip's `-t` switch for the layers it decompresses, and for the archives in the payload. */
const SEVEN_ZIP_TYPE_FLAGS: Readonly<Record<Exclude<PayloadKind, 'zstd' | StrippedKind>, string>> = {
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

/** What an extracted payload stream is, from its first bytes; null when it is none of the payloads packages carry. */
function sniffPayload(file: string): PayloadKind | null {
  const head = readFirstTarBlock(file);
  const magic = head.toString('latin1', 0, CPIO_MAGIC_BYTES);
  if (CPIO_MAGICS.has(magic)) return 'cpio';
  if (magic === STRIPPED_CPIO_MAGIC) return 'stripped';
  // A tar header carries a checksum of itself, so it is told apart before the short magic numbers of the compressors.
  if (hasTarHeaderChecksum(file)) return 'tar';
  const compression = COMPRESSION_MAGICS.find(([, magic]) => head.length >= magic.length && head.subarray(0, magic.length).equals(magic));
  return compression === undefined ? null : compression[0];
}

/**
 * One byte budget and one deadline for a whole package. Each layer is vetted on its own, but the layers and the final
 * tree all sit on disk, so the bytes the package holds there at once are charged against the same bound a single-stream
 * archive gets (the size cap, or the larger of the ratio floor and 100 times the upload); a layer that has been removed is
 * credited back, so the peak is what counts, not the sum of everything ever written. The time it may take is fixed once:
 * every 7-Zip call gets what is left of it, never a fresh allowance.
 */
export class PackageRun {
  private spentBytes = 0;
  private readonly capBytes: number;
  private readonly deadline: number;

  constructor(
    private readonly request: ContainedExtractionRequest,
    readonly archiveBytes: number,
    private readonly now: () => number = Date.now
  ) {
    this.capBytes = unpackedBytesCap(archiveBytes, request.limits);
    this.deadline = now() + request.timeoutMs;
  }

  /** Counts bytes written to disk; past the bound the package is a bomb, however small each layer was. */
  charge(bytes: number): void {
    this.spentBytes += bytes;
    if (this.spentBytes > this.capBytes) throw unpackedBytesCapError(this.archiveBytes, this.request.limits);
  }

  /** Removes a layer that has been read (a file, or the directory it was extracted into) and credits its bytes back. */
  release(target: string, bytes: number): void {
    if (fs.lstatSync(target).isDirectory()) removeDirectoryTree(target);
    else fs.rmSync(target, { force: true });
    this.spentBytes = Math.max(0, this.spentBytes - bytes);
  }

  /** The request for the next 7-Zip step, with the time left of the package's deadline. */
  step(changes: Partial<ContainedExtractionRequest>): ContainedExtractionRequest {
    const remaining = this.deadline - this.now();
    if (remaining <= 0) throw new SandboxedTimeoutError(this.request.timeoutMs);
    return { ...this.request, ...changes, timeoutMs: remaining };
  }

  /** Bytes the package holds on disk at this moment, as charged. */
  get liveBytes(): number {
    return this.spentBytes;
  }

  get limits(): ArchiveExtractionLimits {
    return this.request.limits;
  }
}

/** Decompresses a Zstandard payload into `outDir` and returns the file; the output is capped by the archive size and ratio caps. */
export function decodeZstdPayload(run: PackageRun, compressed: string, outDir: string, layer: number): string {
  let decoded: Buffer;
  try {
    decoded = decompressZstd(fs.readFileSync(compressed), { maxOutputBytes: unpackedBytesCap(run.archiveBytes, run.limits) });
  } catch (err) {
    // The decoder stops at the bound, before it has produced (or reserved) what a bomb claims.
    if (err instanceof DecompressionLimitError) throw unpackedBytesCapError(run.archiveBytes, run.limits);
    throw err;
  }
  run.charge(decoded.length);
  const target = path.join(outDir, `${ZSTD_PAYLOAD_NAME}-${layer}`);
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

/** The file extension 7-Zip names the payload of each compression after (`x.xz` unpacks to `x`). */
const COMPRESSION_EXTENSIONS: Readonly<Record<Exclude<CompressionKind, 'zstd'>, string>> = { gzip: 'gz', bzip2: 'bz2', xz: 'xz' };

/**
 * Decompresses one compression layer into its own directory with 7-Zip and returns the single file it holds. The layer is
 * given the extension of its compression first, because 7-Zip lists the stream of a wrapper by that name.
 */
async function decompressLayer(run: PackageRun, layer: { file: string; kind: Exclude<CompressionKind, 'zstd'> }, layerDir: string): Promise<string> {
  fs.mkdirSync(layerDir);
  const extension = `.${COMPRESSION_EXTENSIONS[layer.kind]}`;
  const named = layer.file.endsWith(extension) ? layer.file : `${layer.file}${extension}`;
  if (named !== layer.file) fs.renameSync(layer.file, named);
  const tree = await extractArchiveContained(
    run.step({
      archivePath: named,
      extractDir: layerDir,
      typeFlag: SEVEN_ZIP_TYPE_FLAGS[layer.kind],
      includePatterns: undefined,
      ratioBaseBytes: run.archiveBytes,
      password: undefined,
      allowInternalHardLinks: false,
    })
  );
  run.charge(tree.totalBytes);
  if (tree.files.length !== 1) {
    throw new UnreadableArchiveError('Could not read the package: a compressed layer of its payload does not hold one stream.');
  }
  return tree.files[0].absPath;
}

interface PayloadStage {
  file: string;
  kind: PayloadKind | null;
  /** What to remove once the next layer exists: the directory or file this stage lives in. */
  disposable: string;
  /** What the stage holds on disk, credited back when it is removed. */
  bytes: number;
}

/** The cpio, tar or stripped cpio at the bottom of the compression layers. */
interface PayloadArchive {
  file: string;
  kind: ArchiveKind | StrippedKind;
  disposable: string;
  bytes: number;
}

/** An archive 7-Zip reads: a {@link PayloadArchive} that is not stripped. */
type ReadableArchive = PayloadArchive & { kind: ArchiveKind };

/**
 * Follows the compression layers of a payload stream down to the cpio or tar it carries. At most
 * MAX_COMPRESSION_LAYERS layers are decompressed; a stream that is still compressed after the last of them is refused
 * without a further decode. Each layer is removed as soon as the layer inside it exists.
 * Returns null when the stream is not a payload at all; throws when a layer cannot be read.
 */
async function openPayloadLayers(run: PackageRun, first: PayloadStage, workDir: string, keepFirst: boolean): Promise<PayloadArchive | null> {
  let current = first;
  for (let decoded = 0; ; decoded++) {
    if (current.kind === 'cpio' || current.kind === 'tar' || current.kind === 'stripped') {
      return { file: current.file, kind: current.kind, disposable: current.disposable, bytes: current.bytes };
    }
    if (current.kind === null || decoded === MAX_COMPRESSION_LAYERS) return null;
    const layerDir = path.join(workDir, `layer-${decoded}`);
    const next =
      current.kind === 'zstd'
        ? decodeZstdPayload(run, current.file, workDir, decoded)
        : await decompressLayer(run, { file: current.file, kind: current.kind }, layerDir); // NOSONAR S9382 sequential: each layer is the input of the next
    // An rpm's own extraction stays until the payload is known to be one: a package of a single file that merely looks
    // compressed is converted from it. A deb has no such fallback, so nothing keeps its extraction.
    if (!keepFirst || current.disposable !== first.disposable) run.release(current.disposable, current.bytes);
    current = { file: next, kind: sniffPayload(next), disposable: current.kind === 'zstd' ? next : layerDir, bytes: fs.statSync(next).size };
  }
}

/** The selected files of a package whose payload 7-Zip lists itself: the package is read again with the selection. */
async function extractSelection(request: ContainedExtractionRequest, run: PackageRun): Promise<PackagePayload> {
  const root = `${request.extractDir}-selected`;
  fs.mkdirSync(root);
  const tree = await extractArchiveContained(
    run.step({ extractDir: root, includePatterns: withDotSlashSpellings(request.includePatterns), allowInternalHardLinks: true })
  );
  run.charge(tree.totalBytes);
  return { tree, root };
}

/** The files 7-Zip listed itself are the payload; a package without any entry is one whose payload it could not list (a cpio with stripped headers, for one). */
async function listedPayload(request: ContainedExtractionRequest, outer: ContainedTree, run: PackageRun): Promise<PackagePayload> {
  if (outer.entryCount === 0) throw new UnreadableArchiveError('Could not read the package: its payload holds no entries 7-Zip can list.');
  return request.includePatterns === undefined ? { tree: outer, root: request.extractDir } : extractSelection(request, run);
}

const NOT_AN_ARCHIVE_PAYLOAD =
  'Could not read the package: its payload is not a cpio or tar archive, or is compressed with a method that is not supported.';

const RPM_OWN_PAYLOAD_NAME = 'payload.rpm-bytes';
const STRIPPED_CPIO_NAME = 'payload.rewritten.cpio';
const COPY_CHUNK_BYTES = 64 * 1024;

/** Copies `source` from `offset` to its end into `target`, in pieces, and returns the number of bytes copied. */
function copyTail(source: string, offset: number, target: string): number {
  const input = fs.openSync(source, 'r');
  const output = fs.openSync(target, 'w');
  try {
    const chunk = Buffer.alloc(COPY_CHUNK_BYTES);
    let position = offset;
    for (let read = fs.readSync(input, chunk, 0, chunk.length, position); read > 0; read = fs.readSync(input, chunk, 0, chunk.length, position)) {
      fs.writeSync(output, chunk, 0, read);
      position += read;
    }
    return position - offset;
  } finally {
    fs.closeSync(input);
    fs.closeSync(output);
  }
}

/**
 * The bytes of an rpm's own payload, for a package 7-Zip lists as empty: the payload follows the package header, so it is
 * the rest of the file (never larger than the upload, whose size the run has already charged for).
 */
function ownPayloadStage(run: PackageRun, request: ContainedExtractionRequest, payloadDir: string): { stage: PayloadStage; package: RpmPackage } {
  const pkg = readRpmPackage(request.archivePath, run.limits);
  fs.mkdirSync(payloadDir);
  const file = path.join(payloadDir, RPM_OWN_PAYLOAD_NAME);
  const bytes = copyTail(request.archivePath, pkg.payloadOffset, file);
  run.charge(bytes);
  return { stage: { file, kind: sniffPayload(file), disposable: file, bytes }, package: pkg };
}

/** Rewrites a stripped payload as an ordinary cpio from the file table of the package header; the stripped stream is removed. */
function rewriteStrippedPayload(run: PackageRun, request: ContainedExtractionRequest, archive: PayloadArchive, payloadDir: string, known: RpmPackage | undefined): ReadableArchive {
  const files = (known ?? readRpmPackage(request.archivePath, run.limits)).files();
  const output = path.join(payloadDir, STRIPPED_CPIO_NAME);
  strippedPayloadToCpio({ files, source: archive.file, output, charge: (bytes) => run.charge(bytes) });
  if (archive.disposable !== request.extractDir) run.release(archive.disposable, archive.bytes);
  return { file: output, kind: 'cpio', disposable: output, bytes: fs.statSync(output).size };
}

/**
 * Extracts the payload files of an rpm or deb into `request.extractDir` (or a sibling directory when the payload is a
 * layer inside the package). Throws a typed error for anything unsafe, oversized or unreadable; what the package writes
 * is bounded as a whole (see {@link PackageRun}), and layers are removed once the next one exists.
 */
export async function extractPackagePayload(request: ContainedExtractionRequest, format: 'rpm' | 'deb'): Promise<PackagePayload> {
  const run = new PackageRun(request, fs.statSync(request.archivePath).size);
  // The selection names files of the payload, so it cannot apply to the package's own layer.
  const outer = await extractArchiveContained(run.step({ includePatterns: undefined, allowInternalHardLinks: true }));
  run.charge(outer.totalBytes);
  const stream = payloadFile(outer);
  const payloadDir = `${request.extractDir}-payload`;
  // 7-Zip lists an rpm with no entry at all when it cannot read its payload as a cpio, which is what stripped headers are.
  const listsNothing = stream === null && format === 'rpm' && outer.entryCount === 0;
  if (stream === null && !listsNothing) {
    // A deb is only ever its members: without a `data.tar` there is no payload to convert.
    if (format === 'deb') throw new UnreadableArchiveError(NOT_AN_ARCHIVE_PAYLOAD);
    return listedPayload(request, outer, run);
  }

  const own = listsNothing ? ownPayloadStage(run, request, payloadDir) : undefined;
  if (own === undefined) fs.mkdirSync(payloadDir);
  const first: PayloadStage | null =
    own?.stage ?? (stream === null ? null : { file: stream, kind: sniffPayload(stream), disposable: request.extractDir, bytes: outer.totalBytes });
  // A package of one file that merely looks compressed is converted from it, so only an rpm's own extraction is kept.
  const opened = first === null || first.kind === null ? null : await openPayloadLayers(run, first, payloadDir, format === 'rpm' && own === undefined);
  if (opened === null) {
    // An rpm whose one file is not a payload is a package of that file; a deb has nothing else to be.
    if (format === 'deb') throw new UnreadableArchiveError(NOT_AN_ARCHIVE_PAYLOAD);
    return listedPayload(request, outer, run);
  }
  if (opened.kind === 'stripped' && format === 'deb') throw new UnreadableArchiveError(NOT_AN_ARCHIVE_PAYLOAD);
  const archive: ReadableArchive = opened.kind === 'stripped' ? rewriteStrippedPayload(run, request, opened, payloadDir, own?.package) : { ...opened, kind: opened.kind };

  if (archive.disposable !== request.extractDir && fs.existsSync(request.extractDir)) run.release(request.extractDir, outer.totalBytes);
  const filesDir = path.join(payloadDir, 'files');
  fs.mkdirSync(filesDir);
  const tree = await extractArchiveContained(
    run.step({
      archivePath: archive.file,
      extractDir: filesDir,
      typeFlag: SEVEN_ZIP_TYPE_FLAGS[archive.kind],
      includePatterns: withDotSlashSpellings(request.includePatterns),
      ratioBaseBytes: run.archiveBytes,
      password: undefined,
      allowInternalHardLinks: true,
    })
  );
  run.charge(tree.totalBytes);
  run.release(archive.disposable, archive.bytes);
  return { tree, root: filesDir };
}
