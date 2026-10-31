import { ConversionFailedError, CorruptStreamError, PayloadLimitError } from '../types';
import { MAX_DOCUMENT_INFLATE_BYTES } from './bounded-inflate';

/**
 * What of a DjVu file is read here, before `ddjvu` (djvulibre 3.5.28) is started: whether the file is the document alone or
 * names other files. The pages, their sizes and their count are not read here; `djvused` of the same package reports them
 * (djvu-report.ts), because the pages of a document are what its directory flags say they are (`DjVmDir::decode`,
 * libdjvu/DjVmDir.cpp lines 212 to 262, `is_page()`), and the directory lists its flags, sizes and names in a BZZ compressed
 * tail. A page is a `FORM:DJVU`, `FORM:BM44` or `FORM:PM44` whatever the form type of the component next to it says.
 *
 * The layout is the IFF85 container of djvulibre (libdjvu/IFFByteStream.cpp `get_chunk`, lines 168 to 300): the magic
 * `AT&T`, then chunks of a 4 byte id, a 4 byte big-endian size and the data, padded to an even length; `FORM`, `LIST`, `PROP`
 * and `CAT ` carry a second 4 byte id, counted in their size. A chunk that ends past its parent is corrupt
 * (`IFFByteStream.corrupt_mangled`, line 243).
 *
 * What the program reads besides the given file is decided by the kind of document (libdjvu/DjVuDocument.cpp
 * `init_thread`, from line 307, and `request_data`, lines 1443 to 1535):
 *  - a bundled `FORM:DJVM` (the `DIRM` chunk has the bundle flag) reads its components only from the bundle: a URL outside
 *    it throws `DjVuDocument.URL_outside` and an id the directory does not list `DjVuDocument.file_outside`;
 *  - an indirect `FORM:DJVM` and a `FORM:DJVU` page are read together with the files they name, from the directory of the
 *    given file (`DataPool::create(url)`, line 1531): the `DIRM` ids of the first, the `INCL` and `NDIR` chunks of the
 *    second. The program rejects a name with a slash, a backslash or a colon (DjVuFile.cpp `process_incl_chunk`, line
 *    571), but a plain name is read, and it is read as a DjVu file whatever the name says.
 * So only a bundled document is accepted, and a single page that names no other file: the program reads nothing but the
 * given file, whatever sits next to it. The old bundled form (`DIR0`, DjVuDocument.cpp line 364) is refused too: it has no
 * directory with the bundle flag, and djvulibre itself only reads it (no writer of it is in libdjvu or tools).
 *
 * The offsets of the files of a bundle and the files they include are left to djvulibre: `djvused` opens them in the sandbox
 * before `ddjvu` starts (djvu-render.ts).
 */

const MAGIC = 'AT&T';
const FORM = 'FORM';
const TYPE_PAGE = 'DJVU';
const TYPE_DOCUMENT = 'DJVM';
const TYPE_INCLUDE = 'DJVI';
const DIRECTORY_CHUNK = 'DIRM';
const OLD_DIRECTORY_CHUNK = 'DIR0';
/** Chunks that name another file of a single page: the shared data it includes and the pages of an old indexed document. */
const FILE_REFERENCE_CHUNKS: ReadonlySet<string> = new Set(['INCL', 'NDIR']);
const FILE_REFERENCE_FIRST_BYTE_I = 0x49;
const FILE_REFERENCE_FIRST_BYTE_N = 0x4e;

const ID_BYTES = 4;
const SIZE_BYTES = 4;
/** A chunk header (id, size), and the `FORM` header (id, size, type). */
const CHUNK_HEADER_BYTES = ID_BYTES + SIZE_BYTES;
const FORM_HEADER_BYTES = CHUNK_HEADER_BYTES + ID_BYTES;
/** The magic precedes the first chunk of a file only. */
const FILE_HEADER_BYTES = MAGIC.length + FORM_HEADER_BYTES;
/** `DjVmDir::decode` (libdjvu/DjVmDir.cpp lines 212 to 262): a flags byte (the bundle flag, then the version in 7 bits) and the file count as 16 bits. */
const DIRECTORY_BUNDLE_FLAG = 0x80;
const DIRECTORY_VERSION_MASK = 0x7f;
/** `DjVmDir::version` (libdjvu/DjVmDir.cpp line 232 `ver>version`): a directory of a later version is an error. */
const DIRECTORY_MAX_VERSION = 1;
const DIRECTORY_FILE_COUNT_OFFSET = 1;
const DIRECTORY_HEADER_BYTES = 3;

/**
 * Pages one document may hold: the document page limit of the other fixed page chain that writes a PDF (`XPS_MAX_PAGES`,
 * src/lib/conversions/office/xps-reader.ts line 25). `djvused` counts them (djvu-report.ts); the directory counts its files in 16
 * bits (DjVmDir.cpp line 239), 65,535 at most.
 */
export const DJVU_MAX_PAGES = 10_000;
/**
 * Files one directory may list: the pages and as many shared files again. djvulibre reads a directory in time that grows with
 * the square of its files (`djvused -e n` takes 0.6 s for 5,000, 2.5 s for 10,000, 9.5 s for 20,000 and 102 s for 65,535 files,
 * measured with 3.5.29 on Apple silicon; 9.1 s for 20,000 with 3.5.28 on the arm64 test VM), so the count is read from the header before any program is started.
 */
export const DJVU_MAX_DIRECTORY_FILES = 2 * DJVU_MAX_PAGES;
/**
 * The largest file taken, the inflate budget of one document. The program holds file offsets and sizes as `int`
 * (libdjvu/DjVmDir.h `offset`, `size`), so a file past 2 GiB is beyond it whatever the limit here.
 */
export const DJVU_MAX_INPUT_BYTES = MAX_DOCUMENT_INFLATE_BYTES;

interface Chunk {
  readonly id: string;
  /** Offset of the data, and of the byte after it. */
  readonly start: number;
  readonly end: number;
}

function idAt(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

function u32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function u16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

/** The chunk whose header starts at `offset`, which must end within `limit`. */
function chunkAt(bytes: Uint8Array, offset: number, limit: number): Chunk {
  if (offset + CHUNK_HEADER_BYTES > limit) throw new CorruptStreamError('The DjVu file is damaged: a chunk header runs past the end of its parent.');
  const start = offset + CHUNK_HEADER_BYTES;
  const size = u32(bytes, offset + ID_BYTES);
  if (size > limit - start) throw new CorruptStreamError('The DjVu file is damaged: a chunk is longer than the chunk that holds it.');
  return { id: idAt(bytes, offset), start, end: start + size };
}

/** The first chunk of a composite chunk, whose data starts with the 4 byte type. */
function firstChild(bytes: Uint8Array, form: Chunk): Chunk | undefined {
  const offset = form.start + ID_BYTES;
  return offset + CHUNK_HEADER_BYTES <= form.end ? chunkAt(bytes, offset, form.end) : undefined;
}

/**
 * The id of the first chunk of the page that names another file, read without building an object per chunk: a hostile page is
 * up to 32 million chunks.
 */
function fileReferenceOf(bytes: Uint8Array, form: Chunk): string | undefined {
  let offset = form.start + ID_BYTES;
  while (offset + CHUNK_HEADER_BYTES <= form.end) {
    const end = offset + CHUNK_HEADER_BYTES + u32(bytes, offset + ID_BYTES);
    if (end > form.end) throw new CorruptStreamError('The DjVu file is damaged: a chunk is longer than the chunk that holds it.');
    const firstByte = bytes[offset];
    if (firstByte === FILE_REFERENCE_FIRST_BYTE_I || firstByte === FILE_REFERENCE_FIRST_BYTE_N) {
      const id = idAt(bytes, offset);
      if (FILE_REFERENCE_CHUNKS.has(id)) return id;
    }
    offset = end + (end & 1);
  }
  return undefined;
}

function checkSinglePage(bytes: Uint8Array, form: Chunk): void {
  const reference = fileReferenceOf(bytes, form);
  if (reference !== undefined) {
    throw new ConversionFailedError(
      `The DjVu page names another file (a ${reference} chunk). Only a document that holds all its pages in the one file is converted; convert it into a bundled document first (djvmcvt -b).`
    );
  }
}

/** The header of the directory chunk: a bundle of a version djvulibre reads, listing at least one and at most `DJVU_MAX_DIRECTORY_FILES` files. */
function checkDirectoryHeader(bytes: Uint8Array, directory: Chunk): void {
  if (directory.end - directory.start < DIRECTORY_HEADER_BYTES) throw new CorruptStreamError('The DjVu file is damaged: the DIRM chunk is shorter than its header.');
  const flags = bytes[directory.start];
  const version = flags & DIRECTORY_VERSION_MASK;
  if (version > DIRECTORY_MAX_VERSION) throw new CorruptStreamError('The DjVu file uses a newer document directory than this converter reads.');
  if ((flags & DIRECTORY_BUNDLE_FLAG) === 0) {
    throw new ConversionFailedError(
      'The DjVu document is indirect: its pages are separate files next to the index. Only a bundled document, with all pages in the one file, is converted (djvmcvt -b makes one).'
    );
  }
  const files = u16(bytes, directory.start + DIRECTORY_FILE_COUNT_OFFSET);
  if (files === 0) throw new CorruptStreamError('The DjVu document lists no files.');
  if (files > DJVU_MAX_DIRECTORY_FILES) throw new PayloadLimitError(`The DjVu directory lists ${files} files; at most ${DJVU_MAX_DIRECTORY_FILES} are converted.`);
}

function checkBundle(bytes: Uint8Array, form: Chunk): void {
  const first = firstChild(bytes, form);
  if (first === undefined) throw new CorruptStreamError('The DjVu document holds no directory.');
  if (first.id === OLD_DIRECTORY_CHUNK) {
    throw new ConversionFailedError('The DjVu document uses the obsolete DIR0 directory of the first DjVu releases, which is not converted.');
  }
  if (first.id !== DIRECTORY_CHUNK) throw new CorruptStreamError('The DjVu file is damaged: a DJVM form does not start with its DIRM chunk.');
  checkDirectoryHeader(bytes, first);
}

/** The top `FORM` chunk; the file may not end before it does (`IFFByteStream` reads to its end: "Unexpected End Of File"). */
function chunkAtFileStart(bytes: Uint8Array): Chunk {
  const size = u32(bytes, MAGIC.length + ID_BYTES);
  const start = MAGIC.length + CHUNK_HEADER_BYTES;
  if (size < ID_BYTES || size > bytes.length - start) {
    throw new CorruptStreamError(`The DjVu file is truncated or damaged: its FORM chunk declares ${size} bytes and the file holds ${bytes.length - start}.`);
  }
  return { id: FORM, start, end: start + size };
}

/**
 * Refuses what the converter must not hand to `ddjvu` on the bytes alone: a file that is not DjVu, a file over the input
 * limit, a truncated one, a document that names other files, and a directory of more files than are taken.
 */
export function checkDjvuContainer(bytes: Uint8Array): void {
  if (bytes.length > DJVU_MAX_INPUT_BYTES) throw new PayloadLimitError(`The DjVu file is larger than ${DJVU_MAX_INPUT_BYTES} bytes.`);
  if (bytes.length < FILE_HEADER_BYTES || idAt(bytes, 0) !== MAGIC || idAt(bytes, MAGIC.length) !== FORM) {
    throw new CorruptStreamError('The file is not a DjVu document: it does not start with the AT&TFORM signature.');
  }
  const form = chunkAtFileStart(bytes);
  const type = idAt(bytes, form.start);
  if (type === TYPE_PAGE) return checkSinglePage(bytes, form);
  if (type === TYPE_DOCUMENT) return checkBundle(bytes, form);
  if (type === TYPE_INCLUDE) throw new CorruptStreamError('The file holds shared DjVu data (FORM:DJVI), not a page or a document.');
  throw new CorruptStreamError(`The file is not a DjVu page or document (FORM:${type}).`);
}
