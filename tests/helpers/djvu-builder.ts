/**
 * Containers of DjVu written byte by byte from the layout djvulibre reads (libdjvu/IFFByteStream.cpp, DjVmDir.cpp): a `FORM:DJVU` page
 * that holds a size and nothing to decode, and the directories of bundled and indirect documents. They exercise the reading of
 * the structure, not the decoding of a picture; the pictures of the converter tests come from the djvulibre encoders and from the
 * chunks of real documents (`maskedPageOf`).
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { requireOracleTool } from './differential-oracle';

const MAGIC = Buffer.from('AT&T', 'latin1');
const BUNDLE_FLAG = 0x80;
const DIRECTORY_VERSION = 1;
const INFO_VERSION_MINOR = 24;
const INFO_DPI = 300;
const INFO_GAMMA = 22;

function u32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

function padded(data: Buffer): Buffer {
  return data.length % 2 === 1 ? Buffer.concat([data, Buffer.alloc(1)]) : data;
}

/** A chunk: id, big-endian size, data, and a pad byte to an even length. */
export function chunk(id: string, data: Buffer): Buffer {
  return padded(Buffer.concat([Buffer.from(id, 'latin1'), u32(data.length), data]));
}

/** A composite chunk of `type` (`DJVU`, `DJVM`, `DJVI`) around `children`, without the file magic. */
export function form(type: string, children: readonly Buffer[]): Buffer {
  return chunk('FORM', Buffer.concat([Buffer.from(type, 'latin1'), ...children]));
}

/** The 10 byte INFO chunk of a page: size, version, resolution, gamma and flags (libdjvu/DjVuInfo.cpp `decode`). */
export function infoChunk(width: number, height: number): Buffer {
  const data = Buffer.alloc(10);
  data.writeUInt16BE(width, 0);
  data.writeUInt16BE(height, 2);
  data[4] = INFO_VERSION_MINOR;
  data.writeUInt16LE(INFO_DPI, 6);
  data[8] = INFO_GAMMA;
  return chunk('INFO', data);
}

/** A `FORM:DJVU` page of the size, with the extra chunks after its INFO chunk. */
export function pageForm(width: number, height: number, extra: readonly Buffer[] = []): Buffer {
  return form('DJVU', [infoChunk(width, height), ...extra]);
}

/** A single page file: the magic and the page. */
export function singlePage(width: number, height: number, extra: readonly Buffer[] = []): Buffer {
  return Buffer.concat([MAGIC, pageForm(width, height, extra)]);
}

/** The name of a file as the `INCL` chunk of a page holds it. */
export function includeChunk(name: string): Buffer {
  return chunk('INCL', Buffer.from(name, 'latin1'));
}

/** What the directory says about a file of a bundle: whether it is a page, an include, thumbnails or shared annotations (`DjVmDir::File::FILE_TYPE`). */
export type BundleKind = 'include' | 'page' | 'thumbnails' | 'annotation';

/** A file of the directory: the component it points at (an index into the components, so that several files can share bytes), its kind and its strings. */
export interface BundleEntry {
  readonly component: number;
  readonly kind: BundleKind;
  readonly id: string;
  readonly name?: string;
  readonly title?: string;
}

export interface BundleOptions {
  /** Version 0 of the directory stores the sizes in the clear and has no sizes in the compressed tail (DjVmDir.cpp `decode`, lines 224 to 262). */
  readonly version?: 0 | 1;
  /** The offsets of the files as laid out, to be replaced by the directory's own, for the files whose offset lies. */
  readonly offsets?: (laidOut: readonly number[]) => number[];
}

const FILE_TYPE: Readonly<Record<BundleKind, number>> = { include: 0, page: 1, thumbnails: 2, annotation: 3 };
/** `DjVmDir::File::FLAGS_1` and `FLAGS_0` (libdjvu/DjVmDir.h lines 334 and 335). */
const HAS_NAME = 0x80;
const HAS_TITLE = 0x40;
const IS_PAGE_0 = 1;
const HAS_NAME_0 = 2;
const HAS_TITLE_0 = 4;
const FORM_DATA_SIZE_AT = 4;
const CHUNK_HEADER_BYTES = 8;

/** A file of the bundle as written: the size the directory records is that of the `FORM` chunk without its pad byte. */
function componentBytes(form: Buffer): Buffer {
  return form.subarray(0, CHUNK_HEADER_BYTES + form.readUInt32BE(FORM_DATA_SIZE_AT));
}

function u24(value: number): Buffer {
  return u32(value).subarray(1);
}

function entryFlags(entry: BundleEntry, version: 0 | 1): number {
  if (version === 0) return (entry.kind === 'page' ? IS_PAGE_0 : 0) | (entry.name === undefined ? 0 : HAS_NAME_0) | (entry.title === undefined ? 0 : HAS_TITLE_0);
  return FILE_TYPE[entry.kind] | (entry.name === undefined ? 0 : HAS_NAME) | (entry.title === undefined ? 0 : HAS_TITLE);
}

function entryStrings(entry: BundleEntry): Buffer {
  return Buffer.from([entry.id, entry.name, entry.title].filter((text) => text !== undefined).map((text) => `${text}\0`).join(''), 'utf-8');
}

/** BZZ, the compression of the tail of the directory, from the encoder of djvulibre. */
function bzzEncode(data: Buffer): Buffer {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'djvu-bzz-'));
  try {
    fs.writeFileSync(path.join(dir, 'in'), data);
    execFileSync(requireOracleTool('bzz'), ['-e', path.join(dir, 'in'), path.join(dir, 'out')]);
    return fs.readFileSync(path.join(dir, 'out'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The `DIRM` chunk of a bundle: flags, count and offsets (and sizes, in version 0) in the clear, then the BZZ tail of sizes, flags and strings. */
function bundledDirectory(entries: readonly BundleEntry[], offsets: readonly number[], sizes: readonly number[], version: 0 | 1): Buffer {
  const header = Buffer.from([BUNDLE_FLAG | version, entries.length >> 8, entries.length & 0xff]);
  const clear = entries.map((_, index) => Buffer.concat([u32(offsets[index]), version === 0 ? u24(sizes[index]) : Buffer.alloc(0)]));
  const sizeBytes = version === 0 ? [] : sizes.map(u24);
  const tail = Buffer.concat([...sizeBytes, Buffer.from(entries.map((entry) => entryFlags(entry, version))), ...entries.map(entryStrings)]);
  return chunk('DIRM', Buffer.concat([header, ...clear, bzzEncode(tail)]));
}

/**
 * A bundled document as djvulibre writes one (`DjVmDoc::write`): the `DIRM` directory with its BZZ compressed tail, then the
 * components one after another, each padded to an even length. `entries` list the files of the directory; two entries may
 * point at one component. The bytes need `bzz` of djvulibre.
 */
export function bundledDocument(components: readonly Buffer[], entries: readonly BundleEntry[], options: BundleOptions = {}): Buffer {
  const version = options.version ?? DIRECTORY_VERSION;
  const bytes = components.map(componentBytes);
  const headerBytes = MAGIC.length + 'FORM'.length + 4 + 'DJVM'.length;
  const sizes = entries.map((entry) => bytes[entry.component].length);
  const directorySize = bundledDirectory(entries, entries.map(() => 0), sizes, version).length;
  const starts: number[] = [];
  let next = headerBytes + directorySize;
  for (const component of bytes) {
    starts.push(next);
    next += component.length + (component.length % 2);
  }
  const laidOut = entries.map((entry) => starts[entry.component]);
  const directory = bundledDirectory(entries, options.offsets?.(laidOut) ?? laidOut, sizes, version);
  return Buffer.concat([MAGIC, form('DJVM', [directory, ...bytes.map(padded)])]);
}

/** A file of a bundle that is its own component: the `FORM` bytes and what the directory says of it. */
export type BundleFile = Omit<BundleEntry, 'component'> & { readonly form: Buffer };

/** A bundle of the files in order, each its own component. */
export function bundleOf(files: readonly BundleFile[], options: BundleOptions = {}): Buffer {
  return bundledDocument(
    files.map((file) => file.form),
    files.map(({ form: _form, ...entry }, index) => ({ ...entry, component: index })),
    options
  );
}

/** An indirect document: a directory that names `names` as files next to it, with no flag for a bundle and no offsets. */
export function indirectDocument(names: readonly string[]): Buffer {
  const header = Buffer.from([DIRECTORY_VERSION, names.length >> 8, names.length & 0xff]);
  return Buffer.concat([MAGIC, form('DJVM', [chunk('DIRM', Buffer.concat([header, Buffer.from(names.join('\0'), 'latin1')]))])]);
}

/** A document whose first chunk is the `DIR0` of the first DjVu releases. */
export function oldBundledDocument(): Buffer {
  return Buffer.concat([MAGIC, form('DJVM', [chunk('DIR0', Buffer.alloc(8))])]);
}

const WAVELET_CHUNK = 'BG44';
const MAGIC_AND_FORM_HEADER_BYTES = 16;

/** A chunk of a file: its id and its data, without the header and the pad byte. */
export interface FileChunk {
  readonly id: string;
  readonly data: Buffer;
}

/** The chunks of a single-form DjVu file that a djvulibre program wrote (a page, or a shared file of an indirect document), in order. */
export function chunksOf(djvuFile: Buffer): FileChunk[] {
  const chunks: FileChunk[] = [];
  let offset = MAGIC_AND_FORM_HEADER_BYTES;
  while (offset + CHUNK_HEADER_BYTES <= djvuFile.length) {
    const size = djvuFile.readUInt32BE(offset + FORM_DATA_SIZE_AT);
    chunks.push({ id: djvuFile.toString('latin1', offset, offset + 4), data: djvuFile.subarray(offset + CHUNK_HEADER_BYTES, offset + CHUNK_HEADER_BYTES + size) });
    offset += CHUNK_HEADER_BYTES + size + (size % 2);
  }
  return chunks;
}

/** The chunks of `id` in a single-form DjVu file, each as a chunk to put in another form. */
export function chunksOfId(djvuFile: Buffer, id: string): Buffer[] {
  return chunksOf(djvuFile)
    .filter((entry) => entry.id === id)
    .map((entry) => chunk(id, entry.data));
}

/**
 * The wavelet chunks of a picture that `c44` of djvulibre wrote (a `FORM:DJVU` page with its `BG44` chunks) as a file of
 * their own: a `FORM:PM44` for a colour picture or a `FORM:BM44` for a grey one (DjVu v3 specification, "IW44 files"). The
 * chunk type is the form type. A page that is a lone wavelet picture has no `INFO` chunk: its size is in the first chunk.
 */
export function waveletForm(type: 'PM44' | 'BM44', djvuFile: Buffer): Buffer {
  return form(
    type,
    chunksOf(djvuFile)
      .filter((entry) => entry.id === WAVELET_CHUNK)
      .map((entry) => chunk(type, entry.data))
  );
}

/** A page whose JB2 mask needs the shape dictionary of a shared file: its `INFO` and `Sjbz` chunks, and the `Djbz` chunk of that file. */
export interface MaskedPage {
  readonly info: Buffer;
  readonly mask: Buffer;
  readonly dictionary: Buffer;
}

/**
 * The first page of a bundled document whose masks share dictionaries, split by `djvmcvt -i` into the page and its shared files.
 * `page` and `dictionaryFile` are the names in the split directory (`p0001.djvu` and `dict0020.iff` of the DjVu encoder of 2005).
 */
export function maskedPageOf(document: string, page: string, dictionaryFile: string): MaskedPage {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'djvu-masked-'));
  try {
    execFileSync(requireOracleTool('djvmcvt'), ['-i', document, dir, 'index.djvu']);
    const pageFile = fs.readFileSync(path.join(dir, page));
    const [info] = chunksOfId(pageFile, 'INFO');
    const [mask] = chunksOfId(pageFile, 'Sjbz');
    const [dictionary] = chunksOfId(fs.readFileSync(path.join(dir, dictionaryFile)), 'Djbz');
    return { info, mask, dictionary };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A bundle of the masked page including i0, and `levels` shared files of which each includes the next two, so that a search that
 * visits a file once for each path visits Fibonacci-many. With `withDictionary`, i0 also includes the shared file of the dictionary
 * after the chain, so the search reaches it last; without, the dictionary is missing and the mask cannot be decoded.
 */
export function maskOverChain(page: MaskedPage, levels: number, withDictionary: boolean): Buffer {
  const files: BundleFile[] = [{ form: form('DJVU', [page.info, includeChunk('i0'), page.mask]), kind: 'page', id: 'page' }];
  for (let level = 0; level < levels; level++) {
    const next = [level + 1, level + 2].filter((target) => target < levels).map((target) => includeChunk(`i${target}`));
    const dictionary = level === 0 && withDictionary ? [includeChunk('d')] : [];
    files.push({ form: form('DJVI', [...next, ...dictionary]), kind: 'include', id: `i${level}` });
  }
  if (withDictionary) files.push({ form: form('DJVI', [page.dictionary]), kind: 'include', id: 'd' });
  return bundleOf(files);
}
