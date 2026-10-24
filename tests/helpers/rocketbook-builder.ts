import zlib from 'node:zlib';

/**
 * Hand-written RocketBook (.rb) container builder for tests. The layout is the one the MobileRead format page names
 * (a container of named pages) and the two real files of the Open Preservation Foundation corpus show when their bytes
 * are read with a hex dump and Python's zlib: a 14-byte signature, the table-of-contents offset at byte 24, the file
 * size at byte 28, a table of 44-byte entries (32-byte name, size, offset, flags) and the pages. It shares no code with
 * the reader under test: text pages are deflated here with Node's zlib in 4096-byte chunks, like the pages of the real files.
 */

export const ROCKETBOOK_SIGNATURE = Buffer.from([0xb0, 0x0c, 0xb0, 0x0c, 0x02, 0x00, 0x4e, 0x55, 0x56, 0x4f, 0x00, 0x00, 0x00, 0x00]);

const FIXED_HEADER_BYTES = 0x128;
const TOC_ENTRY_BYTES = 44;
const NAME_BYTES = 32;
const TOC_OFFSET_FIELD = 24;
const SIZE_FIELD = 28;
const CHUNK_BYTES = 4096;

export const FLAG_PLAIN = 0;
export const FLAG_ENCRYPTED = 1;
export const FLAG_INFO = 2;
export const FLAG_DEFLATED = 8;

export interface RocketBookPage {
  name: string;
  flags: number;
  /** The bytes stored for the page, as laid out in the file. */
  data: Buffer;
  /** Overrides the size the table of contents states; the stored bytes are unchanged. */
  statedSize?: number;
  /** Overrides the offset the table of contents states. */
  statedOffset?: number;
}

export interface RocketBookOptions {
  /** Overrides the file size the header states. */
  statedFileSize?: number;
  /** Overrides the page count the table of contents states. */
  statedPageCount?: number;
  /** Leaves out the last bytes of the file after the header has been written. */
  truncateBy?: number;
}

/** The deflated chunks of a text page: chunk count, total size, the size of every chunk, then the chunks. */
export function deflatedText(text: Buffer, chunkBytes = CHUNK_BYTES): Buffer {
  const chunks: Buffer[] = [];
  for (let at = 0; at < text.length; at += chunkBytes) chunks.push(zlib.deflateSync(text.subarray(at, at + chunkBytes), { level: 9 }));
  return deflatedChunks(chunks, text.length);
}

/** A text page from chunks that are already deflated, with the uncompressed size the page states. */
export function deflatedChunks(chunks: readonly Buffer[], statedTextBytes: number): Buffer {
  const head = Buffer.alloc(8 + 4 * chunks.length);
  head.writeUInt32LE(chunks.length, 0);
  head.writeUInt32LE(statedTextBytes, 4);
  chunks.forEach((chunk, index) => head.writeUInt32LE(chunk.length, 8 + 4 * index));
  return Buffer.concat([head, ...chunks]);
}

export function infoPage(lines: readonly string[]): RocketBookPage {
  return { name: 'info.info', flags: FLAG_INFO, data: Buffer.from(`${lines.join('\n')}\n`, 'utf-8') };
}

export function htmlPage(name: string, html: Buffer | string): RocketBookPage {
  const bytes = typeof html === 'string' ? Buffer.from(html, 'latin1') : html;
  return { name, flags: FLAG_DEFLATED, data: deflatedText(bytes) };
}

export function imagePage(name: string, data: Buffer): RocketBookPage {
  return { name, flags: FLAG_PLAIN, data };
}

export function buildRocketBook(pages: readonly RocketBookPage[], options: RocketBookOptions = {}): Buffer {
  const tableBytes = 4 + pages.length * TOC_ENTRY_BYTES;
  const header = Buffer.alloc(FIXED_HEADER_BYTES);
  ROCKETBOOK_SIGNATURE.copy(header, 0);
  header.writeUInt32LE(FIXED_HEADER_BYTES, TOC_OFFSET_FIELD);

  const table = Buffer.alloc(tableBytes);
  table.writeUInt32LE(options.statedPageCount ?? pages.length, 0);
  let offset = FIXED_HEADER_BYTES + tableBytes;
  pages.forEach((page, index) => {
    const at = 4 + index * TOC_ENTRY_BYTES;
    Buffer.from(page.name, 'utf-8').copy(table, at, 0, NAME_BYTES);
    table.writeUInt32LE(page.statedSize ?? page.data.length, at + NAME_BYTES);
    table.writeUInt32LE(page.statedOffset ?? offset, at + NAME_BYTES + 4);
    table.writeUInt32LE(page.flags, at + NAME_BYTES + 8);
    offset += page.data.length;
  });

  const file = Buffer.concat([header, table, ...pages.map((page) => page.data)]);
  file.writeUInt32LE(options.statedFileSize ?? file.length, SIZE_FIELD);
  return options.truncateBy === undefined ? file : file.subarray(0, file.length - options.truncateBy);
}

/** A small valid book: an info page, one text page and the title index page the real files carry. */
export function simpleRocketBook(html: string, info: readonly string[] = ['TYPE=2', 'TITLE=Probe title', 'AUTHOR=Probe Author']): Buffer {
  return buildRocketBook([infoPage(info), htmlPage('index.html', html), { name: 'index.hidx', flags: FLAG_PLAIN, data: Buffer.from(' ') }]);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** A grey PNG of `size` by `size` pixels, written chunk by chunk from the PNG specification. */
export function greyPng(size = 4): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 0;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size, 0x80)]);
  return Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', header), pngChunk('IDAT', zlib.deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))), pngChunk('IEND', Buffer.alloc(0))]);
}
