/**
 * Containers of DjVu written byte by byte from the layout djvulibre reads (libdjvu/IFFByteStream.cpp, DjVmDir.cpp): a `FORM:DJVU` page
 * that holds a size and nothing to decode, and the directories of bundled and indirect documents. They exercise the reading of
 * the structure, not the decoding of a picture; the pictures of the converter tests come from the djvulibre encoders.
 */

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

/** The `DIRM` chunk of a bundled document: flags, file count and one offset per file; the compressed names are left out. */
function bundledDirectory(offsets: readonly number[]): Buffer {
  const header = Buffer.alloc(3);
  header[0] = BUNDLE_FLAG | DIRECTORY_VERSION;
  header.writeUInt16BE(offsets.length, 1);
  return chunk('DIRM', Buffer.concat([header, ...offsets.map(u32)]));
}

/**
 * A bundled document of the `components` (each a whole `FORM` chunk). `listed` names the components by index, in directory order, and
 * may repeat one, which is how a directory points several entries at the same bytes.
 */
export function bundledDocument(components: readonly Buffer[], listed: readonly number[] = components.map((_, index) => index)): Buffer {
  const headerBytes = MAGIC.length + 'FORM'.length + 4 + 'DJVM'.length;
  const directorySize = bundledDirectory(listed.map(() => 0)).length;
  const starts: number[] = [];
  let next = headerBytes + directorySize;
  for (const component of components) {
    starts.push(next);
    next += component.length;
  }
  const directory = bundledDirectory(listed.map((index) => starts[index]));
  return Buffer.concat([MAGIC, form('DJVM', [directory, ...components])]);
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
