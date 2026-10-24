import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PDF_WASM_DECODER_MAX_BYTES } from './pdf-text-types';

/**
 * The files pdf.js asks for (CMaps, standard fonts, WebAssembly modules), read as its `NodeBinaryDataFactory` reads them
 * (pdf.mjs of pdfjs-dist 6.3.289, `BaseBinaryDataFactory.fetch` lines 15582-15603 and `node_utils_fetchData` 16133-16137),
 * with one change: the picture decoders `jbig2.wasm` and `openjpeg.wasm` get a memory maximum of PDF_WASM_DECODER_MAX_BYTES
 * instead of the 2 GiB they are built with (`-s MAXIMUM_MEMORY=2GB`, compile.sh of pdf.js.jbig2 and pdf.js.openjpeg).
 *
 * A decoder's memory lives outside the thread's heap, so `resourceLimits` does not bound it. With a lower maximum a decode
 * that would grow past it gets no memory: the module's `emscripten_resize_heap` catches the failed `grow` and malloc returns
 * null (pdf.worker.mjs lines 15387-15411). OpenJPEG then reports an error, PDFium's JBIG2 code aborts, and either way the
 * decode throws and pdf.js gives the picture as null, as for any picture it cannot decode.
 *
 * When a module cannot be loaded (the file is unreadable, or its memory maximum cannot be lowered) pdf.js does not give up: its
 * `#instantiateWasm` catches the error and imports `${wasmUrl}jbig2_nowasm_fallback.js` or `openjpeg_nowasm_fallback.js`, the
 * JavaScript builds of the decoders, whose heap may grow to 2 GiB (`getJsModule` and `#instantiateWasm`, pdf.worker.mjs
 * 15545-15575). No option turns that off (`useWasm: false` selects the same files). The factory reads the modules from the real
 * folder itself, so the `wasmUrl` pdf.js is given can name a folder that does not exist (`cappedDecoderOptions`): the import
 * then fails, pdf.js has no decoder and the picture is null. pdf.js reads `wasmUrl` itself for nothing else here: its ICC colour
 * module is switched off when pdf.js does not fetch in the worker, as with any factory but its DOM one (`QCMS.setOptions`,
 * pdf.worker.mjs 8514-8523; `getDocument`, pdf.mjs 22004).
 */

const DECODER_FILES = new Set(['jbig2.wasm', 'openjpeg.wasm']);
const WASM_PAGE_BYTES = 64 * 1024;
const WASM_HEADER_BYTES = 8;
const MEMORY_SECTION = 5;
const LIMITS_HAS_MAXIMUM = 0x01;
const LEB_PAYLOAD_BITS = 7;
const LEB_PAYLOAD_MASK = 0x7f;
const LEB_CONTINUE = 0x80;

type BinaryKind = 'cMapUrl' | 'standardFontDataUrl' | 'wasmUrl';

const ERROR_NAMES: Record<BinaryKind, string> = { cMapUrl: 'CMap', standardFontDataUrl: 'font', wasmUrl: 'wasm' };

/** An unsigned LEB128 integer at `at`, and where it ends. */
function readLeb(bytes: Uint8Array, at: number): { value: number; end: number } {
  let value = 0;
  let shift = 0;
  let cursor = at;
  let byte: number;
  do {
    if (cursor >= bytes.length) throw new Error('WebAssembly module ends inside an integer');
    byte = bytes[cursor++];
    value += (byte & LEB_PAYLOAD_MASK) * 2 ** shift;
    shift += LEB_PAYLOAD_BITS;
  } while ((byte & LEB_CONTINUE) !== 0);
  return { value, end: cursor };
}

/**
 * `module` with the maximum of its one memory set to `maxPages`, written in the bytes the old maximum took (a padded LEB128
 * integer, which the binary format allows), so no section length changes.
 * @throws Error when the module defines no memory with a maximum, or the new maximum does not fit those bytes.
 */
export function withMemoryMaximum(module: Uint8Array, maxPages: number): Uint8Array {
  const patched = Uint8Array.from(module);
  let at = WASM_HEADER_BYTES;
  while (at < patched.length) {
    const id = patched[at];
    const size = readLeb(patched, at + 1);
    if (id === MEMORY_SECTION) {
      const count = readLeb(patched, size.end);
      const flags = readLeb(patched, count.end);
      const minimum = readLeb(patched, flags.end);
      if (count.value !== 1 || (flags.value & LIMITS_HAS_MAXIMUM) === 0) throw new Error('WebAssembly module has no memory maximum to lower');
      const maximum = readLeb(patched, minimum.end);
      const width = maximum.end - minimum.end;
      if (maxPages < minimum.value || maxPages >= 2 ** (LEB_PAYLOAD_BITS * width)) throw new Error(`a memory maximum of ${maxPages} pages does not fit the module`);
      for (let index = 0; index < width; index++) {
        const payload = Math.floor(maxPages / 2 ** (LEB_PAYLOAD_BITS * index)) & LEB_PAYLOAD_MASK;
        patched[minimum.end + index] = index < width - 1 ? payload | LEB_CONTINUE : payload;
      }
      return patched;
    }
    at = size.end + size.value;
  }
  throw new Error('WebAssembly module defines no memory');
}

/** The folder, below the real decoder folder, that `cappedDecoderOptions` names as pdf.js's `wasmUrl`; it is never created. */
const UNAVAILABLE_FOLDER = 'without-javascript-fallback';

/** The `BinaryDataFactory` the text reader passes to pdf.js's `getDocument`. */
export class CappedDecoderDataFactory {
  private readonly urls: Record<BinaryKind, string | null>;

  constructor({ cMapUrl = null, standardFontDataUrl = null, wasmUrl = null }: { cMapUrl?: string | null; standardFontDataUrl?: string | null; wasmUrl?: string | null }) {
    this.urls = { cMapUrl, standardFontDataUrl, wasmUrl };
  }

  async fetch({ kind, filename }: { kind: BinaryKind; filename: string }): Promise<Uint8Array> {
    const base = this.urls[kind];
    if (!base) throw new Error(`Ensure that the \`${kind}\` API parameter is provided.`);
    const url = `${base}${filename}`;
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(url));
    } catch {
      throw new Error(`Unable to load ${ERROR_NAMES[kind]} data at: ${url}`);
    }
    return kind === 'wasmUrl' && DECODER_FILES.has(filename) ? withMemoryMaximum(bytes, PDF_WASM_DECODER_MAX_BYTES / WASM_PAGE_BYTES) : bytes;
  }
}

/**
 * The `wasmUrl` and `BinaryDataFactory` options of `getDocument` for the decoder folder `wasmFolder` (with its trailing separator):
 * the factory reads the folder, and pdf.js is given a `wasmUrl` below it that holds nothing, so that a module that fails to load
 * has no JavaScript fallback to be replaced by.
 */
export function cappedDecoderOptions(wasmFolder: string | undefined): { wasmUrl: string | undefined; BinaryDataFactory: typeof CappedDecoderDataFactory } {
  if (wasmFolder === undefined) return { wasmUrl: undefined, BinaryDataFactory: CappedDecoderDataFactory };
  class FolderDecoderDataFactory extends CappedDecoderDataFactory {
    constructor(urls: { cMapUrl?: string | null; standardFontDataUrl?: string | null }) {
      super({ ...urls, wasmUrl: wasmFolder });
    }
  }
  return { wasmUrl: `${wasmFolder}${UNAVAILABLE_FOLDER}${path.sep}`, BinaryDataFactory: FolderDecoderDataFactory };
}
