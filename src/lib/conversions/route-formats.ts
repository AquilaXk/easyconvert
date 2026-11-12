/**
 * Which route of the in-process converter takes a pair, in the order `convertFile` tries them: the archive engine first, then the
 * media engine. `engine-registry.ts` reads the same lists to say which engine a pair belongs to, so a route and its listing cannot differ.
 */

/** Targets the archive engine writes (and packs any file into). */
const ARCHIVE_ROUTE_TARGETS: ReadonlySet<string> = new Set(['zip', 'tar', 'gz', 'tgz', 'tar.gz', 'tar.bz2', 'tar.xz', 'tar.7z', '7z', 'rar', 'bz2', 'bz', 'tbz', 'tbz2']);

/** Archive sources of the engine beyond the registry's archive category. */
const ARCHIVE_ROUTE_SOURCES: ReadonlySet<string> = new Set([
  'ace', 'alz', 'arc', 'arj', 'bz', 'bz2', 'cab', 'cpio', 'deb', 'dmg', 'img', 'iso', 'jar', 'lha', 'lz', 'lzma', 'lzo', 'rpm',
  'rz', 'tar.7z', 'tar.bz', 'tar.bz2', 'tar.gz', 'tar.lzo', 'tar.xz', 'tar.z', 'tbz', 'tbz2', 'tz', 'tzo', 'z',
]);

/** Whether the archive engine converts this pair: an archive source, a source it reads, or a target it writes. */
export function isArchiveRoutePair(sourceCategory: string | undefined, source: string, target: string): boolean {
  return sourceCategory === 'archive' || ARCHIVE_ROUTE_TARGETS.has(target) || ARCHIVE_ROUTE_SOURCES.has(source);
}

/**
 * Targets the media engine writes. That engine runs FFmpeg when the program is installed and is not disabled, so the pairs it converts
 * belong to the `ffmpeg` engine even where the worker reaches them through the in-process converter.
 */
export const MEDIA_ROUTE_TARGETS: ReadonlySet<string> = new Set([
  'mp3', 'wav', 'aac', 'flac', 'ogg', 'opus', 'wma', 'm4a', 'aiff', 'aif', 'ac3', 'amr', 'au', 'caf', 'dss', 'm4b', 'oga', 'voc',
  'weba', 'mp4', 'webm', 'mkv', 'avi', 'mov', '3gp', '3gpp', '3g2', 'flv', 'm2ts', 'm4v', 'mod', 'mpeg', 'mpg', 'mts', 'mxf',
  'ogv', 'rm', 'rmvb', 'swf', 'ts', 'vob', 'wmv', 'wtv', 'cavs', 'dv', 'dvr',
]);

/** Whether a source of this category and this target are the media engine's (before the option-driven targets of a video: thumbnails, packaging, subtitle extraction). */
export function isMediaRoutePair(sourceCategory: string | undefined, target: string): boolean {
  return sourceCategory === 'audio' || sourceCategory === 'video' || MEDIA_ROUTE_TARGETS.has(target);
}
