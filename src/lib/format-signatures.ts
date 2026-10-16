/**
 * Signature rules for formats that share their first bytes with a wider family, kept apart from the registry so that its
 * magic-byte gate stays a table: a gzip member holds compressed SVG as well as any other compressed file, and a PostScript
 * program is an Adobe Illustrator file when it carries Illustrator's prolog. The functions only read the bytes they are given.
 */

/** Compressed SVG: a gzip member (RFC 1952) holding an SVG document. */
const SVGZ_EXTENSION = 'svgz';
/** Names that a gzip member may carry. */
const GZIP_EXTENSIONS: ReadonlySet<string> = new Set(['gz', 'tgz', 'gzip', 'tar.gz']);
/** gzip member header (RFC 1952 section 2.3): ID1, ID2, compression method, flags, then MTIME, XFL and OS. */
const GZIP_HEADER_BYTES = 10;
const GZIP_DEFLATE_METHOD = 8;
const GZIP_METHOD_OFFSET = 2;
const GZIP_FLAGS_OFFSET = 3;
/** FLG bits 5 to 7 are reserved and must be zero (RFC 1952 section 2.3.1). */
const GZIP_RESERVED_FLAGS = 0xe0;

/**
 * True when the buffer opens with a well-formed gzip member header: the deflate method and no reserved flag. The stream
 * itself is inflated, bounded, where the file is read and refused there when it is not an SVG; this check only keeps a
 * stream that no gzip reader accepts from passing as compressed SVG.
 */
function hasGzipMemberHeader(buf: Uint8Array): boolean {
  return buf.length >= GZIP_HEADER_BYTES && buf[GZIP_METHOD_OFFSET] === GZIP_DEFLATE_METHOD && (buf[GZIP_FLAGS_OFFSET] & GZIP_RESERVED_FLAGS) === 0;
}

/** Whether a buffer whose first bytes are a gzip signature may carry the extension `ext`. */
export function isGzipFamilyCompatible(ext: string, buf: Uint8Array): boolean {
  return GZIP_EXTENSIONS.has(ext) || (ext === SVGZ_EXTENSION && hasGzipMemberHeader(buf));
}

/** Adobe Illustrator artwork: PDF-compatible files (the default since CS) open with `%PDF`; versions 3 to 8 are PostScript. */
const ILLUSTRATOR_EXTENSION = 'ai';
const POSTSCRIPT_EXTENSIONS: ReadonlySet<string> = new Set(['ps', 'eps']);
/** The Illustrator header comments and procedure sets sit in the PostScript prolog, near the start of the file. */
const ILLUSTRATOR_PROLOG_BYTES = 8192;
/** `%%Creator: Adobe Illustrator`, the `%AI<n>_...` format comments, or the `Adobe_Illustrator_AI<n>` procedure set. */
const ILLUSTRATOR_MARKERS = /%%Creator:\s*Adobe Illustrator|%AI\d+_|Adobe_Illustrator_AI\d/;

/** Whether a buffer whose first bytes are `%!PS` may carry the extension `ext`. */
export function isPostScriptCompatible(ext: string, buf: Uint8Array): boolean {
  if (POSTSCRIPT_EXTENSIONS.has(ext)) return true;
  return ext === ILLUSTRATOR_EXTENSION && ILLUSTRATOR_MARKERS.test(Buffer.from(buf.subarray(0, ILLUSTRATOR_PROLOG_BYTES)).toString('latin1'));
}
