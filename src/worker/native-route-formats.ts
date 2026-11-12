import type { EngineId } from '../lib/conversions/engine-ids';
import { isSvgPageTarget } from './svg-page-encoders';

/**
 * The format tables of the worker's native routes, read by `executeWorkerConversion` to decide which route a pair takes and by
 * `engine-registry.ts` to say which engine a pair belongs to (docs/policy-decisions.md, entry 267), so the two cannot differ.
 */

/**
 * Archive extraction and re-packaging formats supported by 7-Zip CLI.
 */
export const ARCHIVE_EXTRACT_FORMATS: ReadonlySet<string> = new Set([
  'zip', '7z', 'rar', 'tar', 'gz', 'gzip', 'tgz', 'tar.gz',
  'bz2', 'bzip2', 'tbz2', 'tar.bz2', 'xz', 'txz', 'tar.xz',
  'iso', 'deb', 'rpm', 'cab', 'wim', 'arj', 'cpio', 'lzh', 'zstd', 'zst',
  // Sources the in-process archive engine leaves to this engine (NATIVE_SEVEN_ZIP_SOURCES in archive.ts).
  'dmg', 'img', 'lha', 'lzma', 'z', 'tar.z', 'tz',
]);

export const ARCHIVE_TARGET_FORMATS: ReadonlySet<string> = new Set([
  'zip', '7z', 'tar', 'gz', 'gzip', 'tgz', 'tar.gz',
  'bz2', 'bzip2', 'tbz2', 'tar.bz2', 'xz', 'txz', 'tar.xz',
]);

/**
 * Image formats supported by Poppler pdftoppm.
 */
export const POPPLER_IMAGE_FORMATS: ReadonlySet<string> = new Set(['png', 'jpg', 'jpeg', 'tiff', 'tif', 'ppm']);

/**
 * Raster targets written by the in-process image encoders: Poppler renders each page to PNG and the encoder
 * takes the picture from there, the way the camera RAW route hands its decoded image to the same encoders.
 */
export const ENCODED_RASTER_TARGETS: ReadonlySet<string> = new Set(['avif', 'bmp', 'gif', 'ico', 'odd', 'psd', 'webp']);
/** PostScript targets: Poppler's pdftops writes them from the PDF. */
export const POSTSCRIPT_TARGETS: ReadonlySet<string> = new Set(['eps', 'ps']);
export const SVG_FORMAT = 'svg';
export const HTML_TARGET = 'html';

/** Every target a PDF turns into with native tools: Poppler images and SVG, the encoded rasters, PostScript, DXF and the metafiles. */
export function isPdfChainTarget(tgt: string): boolean {
  return (
    POPPLER_IMAGE_FORMATS.has(tgt) ||
    tgt === SVG_FORMAT ||
    ENCODED_RASTER_TARGETS.has(tgt) ||
    POSTSCRIPT_TARGETS.has(tgt) ||
    isSvgPageTarget(tgt)
  );
}

/** Targets that package the original camera file instead of rendering its pixels. */
export const RAW_PACKAGING_TARGETS: ReadonlySet<string> = new Set(['zip']);

/**
 * Camera RAW formats LibRaw's distribution build cannot open and that are decoded in-process from the
 * real sensor data instead: Sigma X3F (Foveon) and Raspberry Pi frames (a JPEG followed by a "BRCM" Bayer dump).
 */
export const IN_PROCESS_RAW_SENSOR_FORMATS: ReadonlySet<string> = new Set(['x3f', 'raw']);

/** SVG drawings written as PDF: librsvg draws the vectors and the text, so the page stays a vector page. */
export const SVG_SOURCE = 'svg';

/** Formats LibreOffice also writes back out: a drawing template is saved again as a normalised template (.otg). */
export const OFFICE_NATIVE_RESAVE_FORMATS: ReadonlySet<string> = new Set(['odd']);
/** A presentation LibreOffice can only read: its HTML is the text of the PDF it renders. */
export const PRESENTATION_HTML_SOURCES: ReadonlySet<string> = new Set(['key']);
export const MEDIA_FORMATS: ReadonlySet<string> = new Set(['mp4', 'mkv', 'avi', 'mov', 'webm', 'mp3', 'wav', 'aac', 'ogg', 'opus', 'flac', 'm4a', 'wma']);

export const ILLUSTRATOR_FORMAT = 'ai';
export const PDF_SOURCE_FORMAT = 'pdf';

/** The sources of each program that draws the pages of a source no other engine can (the routes of `engines.ts` add the renderer). */
export const FIXED_PAGE_SOURCES: Readonly<Record<Extract<EngineId, 'ghostscript' | 'ghostxps' | 'djvulibre'>, ReadonlySet<string>>> = {
  ghostscript: new Set(['eps', 'ps']),
  ghostxps: new Set(['xps', 'oxps']),
  djvulibre: new Set(['djvu', 'djv']),
};

/** The engine whose fixed-page route draws a source, or undefined for a source that has none. */
export function fixedPageEngineOf(src: string): keyof typeof FIXED_PAGE_SOURCES | undefined {
  return (Object.keys(FIXED_PAGE_SOURCES) as Array<keyof typeof FIXED_PAGE_SOURCES>).find((engine) => FIXED_PAGE_SOURCES[engine].has(src));
}
