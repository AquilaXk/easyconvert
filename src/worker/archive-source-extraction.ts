import { ARCHIVE_SECURITY_LIMITS, extractWithSpannedStream7z } from '../lib/conversions/archive';
import { extractArchiveContained } from '../lib/conversions/archive-extraction-safety';
import { LINK_TOLERANT_SOURCES, PACKAGE_SOURCES, extractPackagePayload } from '../lib/conversions/archive-package-payload';
import type { WorkerEngineOptions } from './worker-types';

export interface ExtractArchiveParams {
  p7zBin: string;
  inputPath: string;
  extractDir: string;
  tempDir: string;
  timeout: number;
  maxBuffer: number;
  options?: WorkerEngineOptions;
}

/** Compression wrappers that unpack to a single tar, which is repackaged without being extracted. */
const COMPRESSED_STREAM_FORMATS = new Set([
  'gz', 'gzip', 'tgz', 'tar.gz',
  'bz2', 'bzip2', 'tbz2', 'tar.bz2',
  'xz', 'txz', 'tar.xz',
  'lzma', 'z', 'tar.z', 'tz',
]);

export interface SourceExtraction {
  entryCount: number;
  skippedLinks: string[];
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
  const { p7zBin, inputPath, extractDir, tempDir, timeout, maxBuffer, options } = params;

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
    return { entryCount: spanned.entryCount, skippedLinks: spanned.skippedLinks };
  }

  const includePatterns = options?.entries && options.entries.length > 0 ? options.entries : undefined;
  const request = {
    p7zBin,
    archivePath: inputPath,
    extractDir,
    cwd: tempDir,
    timeoutMs: timeout,
    maxBuffer,
    limits: ARCHIVE_SECURITY_LIMITS,
    label: 'archive',
    password: options?.password,
    includePatterns,
    // Packages and disk images carry symbolic links as a matter of course; unless the caller decides, the links are left
    // out and reported, never followed and never a reason to refuse the whole archive.
    skipLinks: options?.skipLinks ?? LINK_TOLERANT_SOURCES.has(src),
    collisionPolicy: options?.collisionPolicy,
    validateNestedTar: COMPRESSED_STREAM_FORMATS.has(src),
    signal: options?.signal,
  };
  if (PACKAGE_SOURCES.has(src)) {
    const payload = await extractPackagePayload(request, src === 'deb' ? 'deb' : 'rpm');
    return { entryCount: payload.tree.entryCount, skippedLinks: payload.tree.skippedLinks, root: payload.root, mayBeEmpty: true };
  }
  const tree = await extractArchiveContained(request);
  return { entryCount: tree.entryCount, skippedLinks: tree.skippedLinks };
}
