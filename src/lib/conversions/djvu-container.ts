import { ConversionFailedError, CorruptStreamError, PayloadLimitError } from '../types';
import { MAX_DOCUMENT_INFLATE_BYTES } from './bounded-inflate';
import { assertInputPixels } from './image-input-limits';

/**
 * The structure of a DjVu file that has to be known before `ddjvu` (djvulibre 3.5.28) is started: whether it is the file
 * alone or names other files, how many pages it holds and how large each is. The layout is the IFF85 container of
 * djvulibre (libdjvu/IFFByteStream.cpp `get_chunk`, lines 168 to 300): the magic `AT&T`, then chunks of a 4 byte id, a
 * 4 byte big-endian size and the data, padded to an even length; `FORM`, `LIST`, `PROP` and `CAT ` carry a second 4 byte
 * id, counted in their size. A chunk that ends past its parent is corrupt (`IFFByteStream.corrupt_mangled`, line 243).
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
 */

const MAGIC = 'AT&T';
const FORM = 'FORM';
const TYPE_PAGE = 'DJVU';
const TYPE_DOCUMENT = 'DJVM';
const TYPE_INCLUDE = 'DJVI';
const DIRECTORY_CHUNK = 'DIRM';
const OLD_DIRECTORY_CHUNK = 'DIR0';
const INFO_CHUNK = 'INFO';
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
/** `DjVuInfo::decode` (libdjvu/DjVuInfo.cpp line 96): width and height are the first two big-endian 16 bit numbers of the chunk. */
const INFO_BYTES = 5;
const INFO_HEIGHT_OFFSET = 2;
/** `DjVmDir::decode` (libdjvu/DjVmDir.cpp lines 212 to 262): a flags byte, the file count as 16 bits, then one 32 bit offset per file. */
const DIRECTORY_BUNDLE_FLAG = 0x80;
const DIRECTORY_VERSION_MASK = 0x7f;
/** `DjVmDir::version` (libdjvu/DjVmDir.cpp line 232 `ver>version`): a directory of a later version is an error. */
const DIRECTORY_MAX_VERSION = 1;
const DIRECTORY_FILE_COUNT_OFFSET = 1;
const DIRECTORY_OFFSETS_START = 3;
const DIRECTORY_OFFSET_BYTES = 4;
const MAX_INT32 = 0x7fffffff;

/**
 * Pages one document may hold: the document page limit of the other fixed page chain that writes a PDF (`XPS_MAX_PAGES`, src/lib/conversions/office/xps-reader.ts line
 * 25). The directory counts its files in 16 bits (DjVmDir.cpp line 239), 65,535 at most.
 */
export const DJVU_MAX_PAGES = 10_000;
/**
 * The largest file taken, the inflate budget of one document. The program holds file offsets and sizes as `int`
 * (libdjvu/DjVmDir.h `offset`, `size`), so a file past 2 GiB is beyond it whatever the limit here.
 */
export const DJVU_MAX_INPUT_BYTES = MAX_DOCUMENT_INFLATE_BYTES;

export interface DjvuPageSize {
  readonly width: number;
  readonly height: number;
}

export interface DjvuDocumentLayout {
  /** The pages in the order of the directory; the pixel size each declares in its `INFO` chunk. */
  readonly pages: readonly DjvuPageSize[];
  /** Whether the pages sit in a bundle (`FORM:DJVM`) and not in a single `FORM:DJVU`. */
  readonly bundled: boolean;
}

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

/** The data of the chunks of a composite chunk, whose data starts with the 4 byte type. */
function* childChunks(bytes: Uint8Array, form: Chunk): Generator<Chunk> {
  let offset = form.start + ID_BYTES;
  while (offset + CHUNK_HEADER_BYTES <= form.end) {
    const child = chunkAt(bytes, offset, form.end);
    yield child;
    offset = child.end + (child.end & 1);
  }
}

function pageSize(bytes: Uint8Array, info: Chunk, label: string): DjvuPageSize {
  if (info.end - info.start < INFO_BYTES) throw new CorruptStreamError(`The DjVu file is damaged: the INFO chunk of ${label} is shorter than ${INFO_BYTES} bytes.`);
  const width = u16(bytes, info.start);
  const height = u16(bytes, info.start + INFO_HEIGHT_OFFSET);
  if (width === 0 || height === 0) throw new CorruptStreamError(`The DjVu file is damaged: ${label} declares an empty page (${width} by ${height} pixels).`);
  assertInputPixels(width, height);
  return { width, height };
}

/** A page is a `FORM:DJVU` whose first chunk is its `INFO` chunk (DjVu v3 specification, section 3.1.2). */
function pageOf(bytes: Uint8Array, form: Chunk, label: string): DjvuPageSize {
  const first = childChunks(bytes, form).next();
  if (first.done || first.value.id !== INFO_CHUNK) throw new CorruptStreamError(`The DjVu file is damaged: ${label} does not start with an INFO chunk.`);
  return pageSize(bytes, first.value, label);
}

/** The first chunk of `form` that names another file, found without building an object per chunk: a hostile page is up to 32 million chunks. */
function firstFileReference(bytes: Uint8Array, form: Chunk): string | undefined {
  let offset = form.start + ID_BYTES;
  while (offset + CHUNK_HEADER_BYTES <= form.end) {
    const end = offset + CHUNK_HEADER_BYTES + u32(bytes, offset + ID_BYTES);
    if (end > form.end) throw new CorruptStreamError('The DjVu file is damaged: a chunk is longer than the chunk that holds it.');
    const id = bytes[offset] === FILE_REFERENCE_FIRST_BYTE_I || bytes[offset] === FILE_REFERENCE_FIRST_BYTE_N ? idAt(bytes, offset) : '';
    if (FILE_REFERENCE_CHUNKS.has(id)) return id;
    offset = end + (end & 1);
  }
  return undefined;
}

function readSinglePage(bytes: Uint8Array, form: Chunk): DjvuDocumentLayout {
  const reference = firstFileReference(bytes, form);
  if (reference !== undefined) {
    throw new ConversionFailedError(
      `The DjVu page names another file (a ${reference} chunk). Only a document that holds all its pages in the one file is converted; convert it into a bundled document first (djvmcvt -b).`
    );
  }
  return { pages: [pageOf(bytes, form, 'the page')], bundled: false };
}

function readDirectoryOffsets(bytes: Uint8Array, directory: Chunk): number[] {
  const length = directory.end - directory.start;
  if (length < DIRECTORY_OFFSETS_START) throw new CorruptStreamError('The DjVu file is damaged: the DIRM chunk is shorter than its header.');
  const flags = bytes[directory.start];
  if ((flags & DIRECTORY_VERSION_MASK) > DIRECTORY_MAX_VERSION) throw new CorruptStreamError('The DjVu file uses a newer document directory than this converter reads.');
  if ((flags & DIRECTORY_BUNDLE_FLAG) === 0) {
    throw new ConversionFailedError(
      'The DjVu document is indirect: its pages are separate files next to the index. Only a bundled document, with all pages in the one file, is converted (djvmcvt -b makes one).'
    );
  }
  const files = u16(bytes, directory.start + DIRECTORY_FILE_COUNT_OFFSET);
  if (files === 0) throw new CorruptStreamError('The DjVu document lists no files.');
  if (length < DIRECTORY_OFFSETS_START + files * DIRECTORY_OFFSET_BYTES) throw new CorruptStreamError('The DjVu file is damaged: the DIRM chunk is shorter than the offsets of its files.');
  const offsets: number[] = [];
  for (let index = 0; index < files; index++) {
    const offset = u32(bytes, directory.start + DIRECTORY_OFFSETS_START + index * DIRECTORY_OFFSET_BYTES);
    if (offset === 0 || offset > MAX_INT32) throw new CorruptStreamError('The DjVu file is damaged: a file of the directory has no valid offset in the bundle.');
    offsets.push(offset);
  }
  return offsets;
}

function readBundle(bytes: Uint8Array, form: Chunk): DjvuDocumentLayout {
  const first = childChunks(bytes, form).next();
  if (first.done) throw new CorruptStreamError('The DjVu document holds no directory.');
  if (first.value.id === OLD_DIRECTORY_CHUNK) {
    throw new ConversionFailedError('The DjVu document uses the obsolete DIR0 directory of the first DjVu releases, which is not converted.');
  }
  if (first.value.id !== DIRECTORY_CHUNK) throw new CorruptStreamError('The DjVu file is damaged: a DJVM form does not start with its DIRM chunk.');
  const offsets = readDirectoryOffsets(bytes, first.value);
  const sizes = new Map<number, DjvuPageSize | null>();
  const pages: DjvuPageSize[] = [];
  for (const offset of offsets) {
    let size = sizes.get(offset);
    if (size === undefined) {
      const component = chunkAt(bytes, offset, form.end);
      const type = component.end - component.start >= ID_BYTES ? idAt(bytes, component.start) : '';
      if (component.id !== FORM) throw new CorruptStreamError('The DjVu file is damaged: a file of the directory is not a FORM chunk.');
      size = type === TYPE_PAGE ? pageOf(bytes, component, `page ${pages.length + 1}`) : null;
      sizes.set(offset, size);
    }
    if (size !== null) {
      if (pages.length >= DJVU_MAX_PAGES) throw new PayloadLimitError(`The DjVu document has more than ${DJVU_MAX_PAGES} pages.`);
      pages.push(size);
    }
  }
  if (pages.length === 0) throw new CorruptStreamError('The DjVu document holds no page.');
  return { pages, bundled: true };
}

/**
 * Reads the layout of a DjVu file and refuses what the converter must not hand to `ddjvu`: a file that is not DjVu, a
 * truncated one, a document that names other files, a page without a size or past the pixel limit of the image
 * inputs, and a document over the page limit.
 */
export function readDjvuDocument(bytes: Uint8Array): DjvuDocumentLayout {
  if (bytes.length > DJVU_MAX_INPUT_BYTES) throw new PayloadLimitError(`The DjVu file is larger than ${DJVU_MAX_INPUT_BYTES} bytes.`);
  if (bytes.length < FILE_HEADER_BYTES || idAt(bytes, 0) !== MAGIC || idAt(bytes, MAGIC.length) !== FORM) {
    throw new CorruptStreamError('The file is not a DjVu document: it does not start with the AT&TFORM signature.');
  }
  const form = chunkAtFileStart(bytes);
  const type = idAt(bytes, form.start);
  if (type === TYPE_PAGE) return readSinglePage(bytes, form);
  if (type === TYPE_DOCUMENT) return readBundle(bytes, form);
  if (type === TYPE_INCLUDE) throw new CorruptStreamError('The file holds shared DjVu data (FORM:DJVI), not a page or a document.');
  throw new CorruptStreamError(`The file is not a DjVu page or document (FORM:${type}).`);
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
