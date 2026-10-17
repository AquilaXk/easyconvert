/**
 * Signature rules for formats that share their first bytes with a wider family, kept apart from the registry so that its
 * magic-byte gate stays a table: a gzip member holds compressed SVG as well as any other compressed file, and a PostScript
 * program is an Adobe Illustrator file when it carries Illustrator's prolog. The functions only read the bytes they are given.
 *
 * The variants mirror the open signature databases: freedesktop shared-mime-info (`freedesktop.org.xml.in`), the libmagic
 * rules (`magic/Magdir`) and Apache Tika (`tika-mimetypes.xml`). Where a rule is named in a comment, that project's entry
 * is the source of the byte pattern; where they disagree with the format specification, the specification decides.
 */


/**
 * How many leading bytes of a file the spoof check reads (and the storage layer hands it): enough for every rule here. A
 * buffer of exactly this length may be the start of a longer file; a shorter one is the whole file.
 */
export const HEADER_WINDOW_BYTES = 64 * 1024;

/** Whether `buf` holds the bytes of `prefix` at `offset`. */
export function startsWithBytes(buf: Uint8Array, prefix: readonly number[], offset = 0): boolean {
  return prefix.every((byte, index) => buf[offset + index] === byte);
}

/** The prolog is ASCII; every byte maps to one character, whatever the rest of the file holds. */
const LATIN1 = new TextDecoder('latin1');

/**
 * Gzip members that hold an XML document, by extension, and the element that document opens with: compressed SVG
 * (`svgz`) and compressed AbiWord (`zabw`). shared-mime-info lists both as a gzip file by name only (and `<abiword` at
 * offset 0 to 256 for the plain `.abw`). This module only tells that the bytes are a gzip member; reading the inflated head
 * for the root element needs a decoder, which is the job of the server side gate (`security/file-guard`), because the
 * registry is imported by the browser components and the edge engines.
 */
const GZIPPED_XML_ROOT: Readonly<Record<string, string>> = { svgz: 'svg', zabw: 'abiword' };

function isGzippedXmlExtension(ext: string): boolean {
  return Object.hasOwn(GZIPPED_XML_ROOT, ext);
}

/** The root element that the gzip member under the name `ext` must hold; undefined for a name that is not a gzipped XML format. */
export function gzippedXmlRootOf(ext: string): string | undefined {
  return isGzippedXmlExtension(ext) ? GZIPPED_XML_ROOT[ext] : undefined;
}

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

const UTF8_BOM = [0xef, 0xbb, 0xbf];
/** XML prolog items before the root element: processing instruction (declaration), comment, doctype. */
const XML_PROLOG_ITEMS: readonly { open: string; close: string }[] = [
  { open: '<?', close: '?>' },
  { open: '<!--', close: '-->' },
];
const DOCTYPE_OPEN = '<!doctype';
const ELEMENT_NAME = /^<([A-Za-z_][\w.-]*)[\s/>]/;

/** Index after the doctype that opens at `from`, past its internal subset when it has one; -1 when it is not closed. */
function skipDoctype(text: string, from: number): number {
  const subsetOpen = text.indexOf('[', from);
  const declarationEnd = text.indexOf('>', from);
  if (subsetOpen === -1 || (declarationEnd !== -1 && declarationEnd < subsetOpen)) return declarationEnd === -1 ? -1 : declarationEnd + 1;
  const subsetEnd = text.indexOf(']', subsetOpen);
  const end = subsetEnd === -1 ? -1 : text.indexOf('>', subsetEnd);
  return end === -1 ? -1 : end + 1;
}

/** Index after the prolog item (declaration, comment or doctype) at `at`, or -1 when none starts there or it is not closed. */
function skipPrologItem(text: string, at: number): number {
  for (const { open, close } of XML_PROLOG_ITEMS) {
    if (!text.startsWith(open, at)) continue;
    const end = text.indexOf(close, at + open.length);
    return end === -1 ? -1 : end + close.length;
  }
  return text.slice(at, at + DOCTYPE_OPEN.length).toLowerCase() === DOCTYPE_OPEN ? skipDoctype(text, at) : -1;
}

/**
 * The name of the root element of an XML document, in lower case, read from its head; undefined when the head is not XML
 * markup or ends inside the prolog. Only a byte order mark, white space, a declaration, comments and a doctype may come first.
 */
export function xmlRootElementName(head: Uint8Array): string | undefined {
  const start = startsWithBytes(head, UTF8_BOM) ? UTF8_BOM.length : 0;
  const text = LATIN1.decode(head.subarray(start));
  let at = 0;
  for (;;) {
    while (at < text.length && /\s/.test(text[at])) at++;
    const next = skipPrologItem(text, at);
    if (next === -1) break;
    at = next;
  }
  return ELEMENT_NAME.exec(text.slice(at))?.[1].toLowerCase();
}

/**
 * Whether a buffer whose first bytes are a gzip signature may carry the extension `ext`. A gzipped XML name also needs a
 * well-formed member header here; its root element is checked by the server side gate.
 */
export function isGzipFamilyCompatible(ext: string, buf: Uint8Array): boolean {
  return GZIP_EXTENSIONS.has(ext) || (isGzippedXmlExtension(ext) && hasGzipMemberHeader(buf));
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
  return ext === ILLUSTRATOR_EXTENSION && ILLUSTRATOR_MARKERS.test(LATIN1.decode(buf.subarray(0, ILLUSTRATOR_PROLOG_BYTES)));
}

/**
 * Raw AAC in ADTS frames (`.aac`) may open with an ID3v2 tag (ID3v2.4 section 3.1: "ID3", version, revision, flags and a
 * synchsafe size that excludes the 10-byte header and the optional 10-byte footer). libmagic and shared-mime-info read the
 * frame after the tag (`audio/x-hx-aac-adts`, `audio/aac`); the same is done here.
 */
export const ID3_MAGIC = [0x49, 0x44, 0x33];
const ID3_HEADER_BYTES = 10;
const ID3_FOOTER_BYTES = 10;
const ID3_FLAGS_OFFSET = 5;
const ID3_FOOTER_FLAG = 0x10;
const ID3_SIZE_OFFSET = 6;
const ID3_SIZE_BYTES = 4;
const ID3_SYNCHSAFE_BITS = 7;
const ID3_SYNCHSAFE_BYTE_LIMIT = 0x80;
const ID3_MAJOR_VERSIONS: ReadonlySet<number> = new Set([2, 3, 4]);
const ID3_REVISION_INVALID = 0xff;
/** ADTS (ISO/IEC 13818-7 section 6.2): a 12-bit syncword and layer bits 00; libmagic matches `beshort&0xFFF6 == 0xFFF0`. */
const ADTS_SYNC_BYTE = 0xff;
const ADTS_SYNC_MASK = 0xf6;
const ADTS_SYNC_VALUE = 0xf0;

/** Where the payload after an ID3v2 tag starts, or undefined when the buffer does not open with a well-formed ID3v2 header. */
function id3v2PayloadOffset(buf: Uint8Array): number | undefined {
  const isId3 = buf.length >= ID3_HEADER_BYTES && startsWithBytes(buf, ID3_MAGIC);
  if (!isId3 || !ID3_MAJOR_VERSIONS.has(buf[3]) || buf[4] === ID3_REVISION_INVALID) return undefined;
  let size = 0;
  for (let index = 0; index < ID3_SIZE_BYTES; index++) {
    const byte = buf[ID3_SIZE_OFFSET + index];
    if (byte >= ID3_SYNCHSAFE_BYTE_LIMIT) return undefined;
    size = (size << ID3_SYNCHSAFE_BITS) | byte;
  }
  const footer = buf[ID3_FLAGS_OFFSET] & ID3_FOOTER_FLAG ? ID3_FOOTER_BYTES : 0;
  return ID3_HEADER_BYTES + size + footer;
}

/** Whether an ADTS frame header starts at `offset`; a byte past the end of the buffer reads as undefined and never matches. */
export function isAdtsFrameAt(buf: Uint8Array, offset: number): boolean {
  return buf[offset] === ADTS_SYNC_BYTE && (buf[offset + 1] & ADTS_SYNC_MASK) === ADTS_SYNC_VALUE;
}

/**
 * What follows the ID3v2 tag at the start of the buffer: an ADTS frame, bytes of another kind, or nothing to see because the
 * tag (cover art makes it large) runs past a full header window. A buffer shorter than the window is the whole file, so a tag
 * that ends with no frame behind it leaves nothing: 'other'. Undefined when the buffer does not open with an ID3v2 tag.
 */
export function id3v2Payload(buf: Uint8Array): 'adts' | 'other' | 'beyond-window' | undefined {
  const offset = id3v2PayloadOffset(buf);
  if (offset === undefined) return undefined;
  if (offset + 1 >= buf.length) return buf.length >= HEADER_WINDOW_BYTES ? 'beyond-window' : 'other';
  return isAdtsFrameAt(buf, offset) ? 'adts' : 'other';
}

/**
 * Formats that exist only as OLE2 compound files (Compound File Binary Format, [MS-CFB]): StarWriter, StarCalc and StarDraw
 * documents, Corel Presentations shows and Quattro Pro 9 workbooks. shared-mime-info and Tika tell them apart by the CLSID of
 * the root storage, but that CLSID differs between versions of one format (StarOffice 3 to 5 write different ones) and the
 * root directory may lie past the header window, so the container signature is what the check can rely on.
 */
export const COMPOUND_FILE_ONLY_EXTENSIONS: ReadonlySet<string> = new Set(['sdw', 'sdc', 'sda', 'shw', 'qpw']);

/** Container signatures that the registry reads in more than one place. */
export const CFBF_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/** AAC in ADTS frames behind an ID3v2 tag. */
export function sniffAacContainer(buf: Uint8Array): 'audio/aac' | undefined {
  return id3v2Payload(buf) === 'adts' ? 'audio/aac' : undefined;
}

/**
 * Formats that open with a fixed byte string no other kind shares, by the MIME type the registry sniffs for them (the
 * signatures of the format specifications, as listed by shared-mime-info and libmagic). The executable signatures (ELF, DOS
 * and Windows PE) are the security gate of the spoof check.
 */
const FIXED_SIGNATURES: readonly { mime: string; prefix: readonly number[] }[] = [
  { mime: 'image/png', prefix: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'application/pdf', prefix: [0x25, 0x50, 0x44, 0x46] },
  { mime: 'image/jpeg', prefix: [0xff, 0xd8, 0xff] },
  { mime: 'image/gif', prefix: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61] },
  { mime: 'image/gif', prefix: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61] },
  { mime: 'image/tiff', prefix: [0x49, 0x49, 0x2a, 0x00] },
  { mime: 'image/tiff', prefix: [0x49, 0x49, 0x2b, 0x00] },
  { mime: 'image/tiff', prefix: [0x4d, 0x4d, 0x00, 0x2a] },
  { mime: 'image/tiff', prefix: [0x4d, 0x4d, 0x00, 0x2b] },
  { mime: 'application/x-7z-compressed', prefix: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] },
  { mime: 'application/gzip', prefix: [0x1f, 0x8b] },
  { mime: 'application/x-bzip2', prefix: [0x42, 0x5a, 0x68] },
  { mime: 'application/zstd', prefix: [0x28, 0xb5, 0x2f, 0xfd] },
  { mime: 'application/vnd.rar', prefix: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07] },
  { mime: 'audio/flac', prefix: [0x66, 0x4c, 0x61, 0x43] },
  { mime: 'audio/ogg', prefix: [0x4f, 0x67, 0x67, 0x53] },
  { mime: 'application/vnd.apache.parquet', prefix: [0x50, 0x41, 0x52, 0x31] },
  { mime: 'application/postscript', prefix: [0x25, 0x21, 0x50, 0x53] },
  { mime: 'application/x-elf', prefix: [0x7f, 0x45, 0x4c, 0x46] },
  { mime: 'application/x-dosexec', prefix: [0x4d, 0x5a] },
];

/** The MIME type of the first fixed signature the buffer opens with; undefined when it opens with none. */
export function sniffFixedSignature(buf: Uint8Array): string | undefined {
  return FIXED_SIGNATURES.find(({ prefix }) => startsWithBytes(buf, prefix))?.mime;
}

/**
 * Whether `ext` names a format with no signature but its container's, and the bytes (sniffed as `sniffed`, undefined when
 * no signature matched) are not that container: a gzip member of XML (`.svgz`, `.zabw`) or a compound file (see above).
 */
export function lacksOwnSignature(ext: string, sniffed: string | undefined): boolean {
  if (isGzippedXmlExtension(ext)) return sniffed !== 'application/gzip';
  return COMPOUND_FILE_ONLY_EXTENSIONS.has(ext) && sniffed === undefined;
}
