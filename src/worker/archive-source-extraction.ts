import fs from 'node:fs';
import path from 'node:path';
import { ARCHIVE_SECURITY_LIMITS, extractWithSpannedStream7z, matchArchiveGlob } from '../lib/conversions/archive';
import {
  UnreadableArchiveError,
  extractArchiveContained,
  readFirstTarBlock,
  type ContainedExtractionRequest,
  type ContainedTree,
} from '../lib/conversions/archive-extraction-safety';
import { LINK_TOLERANT_SOURCES, PACKAGE_SOURCES, extractPackagePayload } from '../lib/conversions/archive-package-payload';
import { memberNameFor } from '../lib/conversions/archive-stream';
import { classifyUnpacked } from '../lib/conversions/archive-stream-route';
import type { WorkerEngineOptions } from './worker-types';

export interface ExtractArchiveParams {
  p7zBin: string;
  inputPath: string;
  extractDir: string;
  tempDir: string;
  timeout: number;
  maxBuffer: number;
  /** The name the caller gave the archive; a refusal that asks for the next volume of a set names it by this. */
  archiveName?: string;
  options?: WorkerEngineOptions;
}

/** Compression wrappers that unpack to a single file: the tar or the one file the conversion packs. */
const COMPRESSED_STREAM_FORMATS = new Set([
  'gz', 'gzip', 'tgz', 'tar.gz',
  'bz2', 'bzip2', 'tbz2', 'tar.bz2',
  'xz', 'txz', 'tar.xz',
  'lzma', 'z', 'tar.z', 'tz',
]);

export interface SourceExtraction {
  entryCount: number;
  skippedLinks: string[];
  /** Alternate streams of the source (HFS+ attributes) that were not extracted. */
  alternateStreams: number;
  /** The directory holding the files to pack, when it is not the one the caller prepared (a package's payload). */
  root?: string;
  /** An empty tree is a valid result (a package that installs no files), not a failure to read. */
  mayBeEmpty?: boolean;
}

/**
 * Extracts the source archive into `extractDir` through the contained 7z pipeline (list, vet,
 * extract, re-verify). Throws a typed error for any unsafe, oversized or unreadable archive; it
 * never returns a partial result. A package (rpm, deb) is extracted to the files it installs.
 */
export async function extractSourceArchive(params: ExtractArchiveParams, src: string): Promise<SourceExtraction> {
  const { p7zBin, inputPath, extractDir, tempDir, timeout, maxBuffer, archiveName, options } = params;

  if (options?.archiveParts && options.archiveParts.length > 0) {
    // Multi-volume input is stitched to one seekable file so it is listed like any other archive.
    const spanned = await extractWithSpannedStream7z(options.archiveParts, extractDir, {
      timeoutMs: timeout,
      maxBuffer,
      password: options.password,
      skipLinks: options.skipLinks,
      collisionPolicy: options.collisionPolicy,
      signal: options.signal,
    });
    return { entryCount: spanned.entryCount, skippedLinks: spanned.skippedLinks, alternateStreams: spanned.alternateStreams };
  }

  const includePatterns = options?.entries && options.entries.length > 0 ? options.entries : undefined;
  const isWrapper = COMPRESSED_STREAM_FORMATS.has(src);
  const request: ContainedExtractionRequest = {
    p7zBin,
    archivePath: inputPath,
    extractDir,
    cwd: tempDir,
    timeoutMs: timeout,
    maxBuffer,
    limits: ARCHIVE_SECURITY_LIMITS,
    label: 'archive',
    archiveName,
    password: options?.password,
    // A wrapper holds one file, so a selection names members of the tar inside it and is applied there.
    includePatterns: isWrapper ? undefined : includePatterns,
    // Packages and disk images carry symbolic links as a matter of course; unless the caller decides, the links are left
    // out and reported, never followed and never a reason to refuse the whole archive.
    skipLinks: options?.skipLinks ?? LINK_TOLERANT_SOURCES.has(src),
    collisionPolicy: options?.collisionPolicy,
    signal: options?.signal,
  };
  if (PACKAGE_SOURCES.has(src)) {
    const payload = await extractPackagePayload(request, src === 'deb' ? 'deb' : 'rpm');
    const { entryCount, skippedLinks, alternateStreams } = payload.tree;
    return { entryCount, skippedLinks, alternateStreams, root: payload.root, mayBeEmpty: true };
  }
  const tree = await extractArchiveContained(request);
  if (isWrapper) return unwrapStreamPayload(request, tree, includePatterns);
  return { entryCount: tree.entryCount, skippedLinks: tree.skippedLinks, alternateStreams: tree.alternateStreams };
}

/**
 * What a compression wrapper holds, as the streamed route reads it (`streamToTar` in archive-stream.ts): the first block of
 * the unpacked file decides with `classifyUnpacked` whether it is a tar. A tar is extracted as the archive it is, through the
 * same listing, vetting and extraction as a tar source, with the request's policy, so the conversion packs its members and
 * not the tar as one file; one that fails to read is damaged, never an ordinary payload. Any other file is the one member,
 * named after the source without its last extension (`memberNameFor`), and the selection of entries is applied to that
 * name; a selection that leaves nothing leaves an empty tree. The ratio of the tar is measured against the upload. A
 * wrapper that did not unpack to exactly one file is not a shape this route knows, and is refused.
 */
async function unwrapStreamPayload(request: ContainedExtractionRequest, wrapper: ContainedTree, includePatterns: string[] | undefined): Promise<SourceExtraction> {
  if (wrapper.files.length !== 1) {
    throw new UnreadableArchiveError(`The compressed file unpacked to ${wrapper.files.length} files where one was expected.`);
  }
  const payload = wrapper.files[0].absPath;
  if (classifyUnpacked(readFirstTarBlock(payload)) === 'plain') {
    const memberName = memberNameFor(request.archiveName ?? '');
    const selected = matchArchiveGlob(memberName, includePatterns);
    if (selected) {
      const member = path.join(path.dirname(payload), memberName);
      if (member !== payload) fs.renameSync(payload, member);
    } else {
      fs.rmSync(payload, { force: true });
    }
    return { entryCount: selected ? 1 : 0, skippedLinks: wrapper.skippedLinks, alternateStreams: wrapper.alternateStreams };
  }
  const tarDir = `${request.extractDir}-tar`;
  fs.mkdirSync(tarDir);
  const tar = await extractArchiveContained({
    ...request,
    archivePath: payload,
    extractDir: tarDir,
    typeFlag: '-ttar',
    includePatterns,
    password: undefined,
    ratioBaseBytes: fs.statSync(request.archivePath).size,
  });
  fs.rmSync(payload, { force: true });
  return { entryCount: tar.entryCount, skippedLinks: tar.skippedLinks, alternateStreams: wrapper.alternateStreams + tar.alternateStreams, root: tarDir };
}
