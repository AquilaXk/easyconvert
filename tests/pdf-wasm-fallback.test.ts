import { copyFile, mkdtemp, readdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PDF_WASM_DECODER_MAX_BYTES } from '../src/lib/conversions/pdf-text-types';
import { cappedDecoderOptions, withMemoryMaximum } from '../src/lib/conversions/pdf-wasm-memory';
import { pdfjsDataUrl } from '../src/lib/conversions/pdfjs-data';
import { buildPdf } from './helpers/pdf-craft';

/**
 * A decoder module that cannot be loaded must give a picture of null, not a decoder without the memory maximum. pdf.js answers
 * a module that fails to load by importing `${wasmUrl}jbig2_nowasm_fallback.js` (or the OpenJPEG file), the JavaScript build of
 * the decoder, whose heap may grow to 2 GiB (`#instantiateWasm` and `#getJsModule`, pdf.worker.mjs 15545-15575 of pdfjs-dist
 * 6.3.289). The reader gives pdf.js a `wasmUrl` below the decoder folder that holds nothing (`cappedDecoderOptions`).
 */

const PINNED_PDFJS_VERSION = '6.3.289';
const WASM_PAGE_BYTES = 64 * 1024;
const DECODERS = ['jbig2.wasm', 'openjpeg.wasm'];
const FALLBACKS = ['jbig2_nowasm_fallback.js', 'openjpeg_nowasm_fallback.js'];
/** ImageMagick's Group 4 coding of a 64 x 32 page with a black rectangle (see pdf-picture-decoders.test.ts). */
const G4_RECTANGLE = Buffer.from('ff3306bfffffffff8fff001001', 'hex');
const WIDTH = 64;
const HEIGHT = 32;
const PACKED_BYTES = (WIDTH / 8) * HEIGHT;

const realFolder = pdfjsDataUrl('wasm') as string;
const temporaryFolders: string[] = [];

afterAll(async () => {
  await Promise.all(temporaryFolders.map((folder) => rm(folder, { recursive: true, force: true })));
});

/** A copy of the decoder folder in which `jbig2.wasm` is a module with no memory, which no memory maximum can be set on. */
async function folderWithUnpatchableJbig2(): Promise<string> {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'pdf-wasm-fallback-'));
  temporaryFolders.push(folder);
  for (const name of await readdir(realFolder)) await copyFile(path.join(realFolder, name), path.join(folder, name));
  await writeFile(path.join(folder, 'jbig2.wasm'), Buffer.from('0061736d01000000', 'hex'));
  return `${folder}${path.sep}`;
}

function ccittPdf(): Buffer {
  return buildPdf(
    [
      { id: 1, dict: '/Type /Catalog /Pages 2 0 R' },
      { id: 2, dict: '/Type /Pages /Kids [3 0 R] /Count 1' },
      { id: 3, dict: '/Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /XObject << /Im0 6 0 R >> >>' },
      { id: 4, stream: Buffer.from('q 64 0 0 32 72 700 cm /Im0 Do Q', 'latin1') },
      { id: 6, dict: `/Type /XObject /Subtype /Image /Width ${WIDTH} /Height ${HEIGHT} /BitsPerComponent 1 /ColorSpace /DeviceGray /Filter /CCITTFaxDecode /DecodeParms << /K -1 /Columns ${WIDTH} /Rows ${HEIGHT} >>`, stream: G4_RECTANGLE },
    ],
    1
  ).buffer;
}

interface PdfJsForTest {
  OPS: { paintImageXObject: number };
  getDocument(options: Record<string, unknown>): {
    promise: Promise<{ getPage(number: number): Promise<{ getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[][] }>; objs: { get(id: string, callback: (image: { data?: Uint8Array } | null) => void): void } }> }>;
    destroy(): Promise<void>;
  };
}

/** The pixels pdf.js gives for the one picture of `ccittPdf()` when it is told `options`; null when the picture has none. */
async function pictureBytes(options: { wasmUrl: string | undefined; BinaryDataFactory: unknown }): Promise<number | null> {
  const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as PdfJsForTest;
  const task = pdfjs.getDocument({ data: new Uint8Array(ccittPdf()), ...options, isEvalSupported: false, useSystemFonts: false, disableFontFace: true, verbosity: 0 });
  try {
    const page = await (await task.promise).getPage(1);
    const list = await page.getOperatorList();
    const id = list.argsArray[list.fnArray.indexOf(pdfjs.OPS.paintImageXObject)][0] as string;
    const image = await new Promise<{ data?: Uint8Array } | null>((resolve) => page.objs.get(id, resolve));
    return image?.data?.length ?? null;
  } finally {
    await task.destroy();
  }
}

describe('the decoder modules of the pinned pdfjs-dist', () => {
  it('are the version the memory maximum was written for, and both take the memory maximum', async () => {
    const manifest = JSON.parse(await readFile(path.join(realFolder, '..', 'package.json'), 'utf8')) as { version: string };
    // A new pdfjs-dist needs this check, policy entry 101 and pdf-wasm-memory.ts read again against its decoders.
    expect(manifest.version).toBe(PINNED_PDFJS_VERSION);
    const pages = PDF_WASM_DECODER_MAX_BYTES / WASM_PAGE_BYTES;
    for (const name of DECODERS) {
      const patched = withMemoryMaximum(new Uint8Array(await readFile(path.join(realFolder, name))), pages);
      const compiled = await WebAssembly.compile(Uint8Array.from(patched));
      const imports: Record<string, Record<string, () => number>> = {};
      for (const { module: moduleName, name: field } of WebAssembly.Module.imports(compiled)) (imports[moduleName] ??= {})[field] = () => 0;
      const { exports } = await WebAssembly.instantiate(compiled, imports);
      const memory = Object.values(exports).find((value): value is WebAssembly.Memory => value instanceof WebAssembly.Memory) as WebAssembly.Memory;
      const initialPages = memory.buffer.byteLength / WASM_PAGE_BYTES;
      expect(() => memory.grow(pages - initialPages + 1), name).toThrow(RangeError);
    }
  });
});

describe('the wasmUrl pdf.js is given', () => {
  it('holds neither JavaScript fallback of the decoders, which the decoder folder itself holds', async () => {
    const { wasmUrl } = cappedDecoderOptions(realFolder);
    for (const name of FALLBACKS) {
      await expect(access(path.join(realFolder, name)), `${name} in the decoder folder`).resolves.toBeUndefined();
      await expect(access(`${wasmUrl}${name}`), `${name} below the wasmUrl`).rejects.toThrow();
    }
  });
});

describe('a decoder module that cannot take the memory maximum', () => {
  it('gives the picture no data, where the same module with the folder as wasmUrl decodes it in the JavaScript fallback', async () => {
    const folder = await folderWithUnpatchableJbig2();
    const options = cappedDecoderOptions(folder);
    expect(await pictureBytes(options)).toBeNull();
    // The control: the fallback the old option let pdf.js reach, to show that the module above is what failed.
    expect(await pictureBytes({ ...options, wasmUrl: folder })).toBe(PACKED_BYTES);
  });
});
