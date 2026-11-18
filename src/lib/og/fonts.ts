import fs from 'node:fs';
import path from 'node:path';
import { encodeSfnt, parseCmapTable, parseFontToSfnt, type ParsedFont } from '@/lib/conversions/font';

/**
 * Instantiates static Regular (400) and Bold (700) SFNT faces from the vendored `EasyConvert Sans`
 * WOFF2 variable fonts (`EasyConvertSans-latin.woff2` + `EasyConvertSans-hangul.woff2`, SIL OFL 1.1)
 * once per process for `next/og` (`vercel/satori`).
 *
 * Satori's bundled `opentype.js` requires static TrueType/OpenType outlines without `fvar`/`gvar`.
 * We pin `wght=400` and `wght=700` via `harfbuzz-subset.wasm` (already shipped in `harfbuzzjs`) and
 * cache the resulting `ArrayBuffer`s in memory so subsequent card renders allocate zero font buffers.
 * In `Dockerfile.web` (`web` and `webslim`), `src/` is omitted and the two subsetted WOFF2 files live
 * in `.next/static/media/*.woff2` from `next/font/local`.
 */

export interface OgFontDescriptor {
  name: string;
  data: ArrayBuffer;
  weight: 400 | 700;
  style: 'normal';
}

const FAMILY_NAME = 'EasyConvert Sans';
const HB_TAG_WGHT = (0x77 << 24) | (0x67 << 16) | (0x68 << 8) | 0x74;
const HB_MEMORY_MODE_WRITABLE = 2;
const ASCII_CAPITAL_A = 0x0041;

interface HarfBuzzSubsetExports {
  memory: WebAssembly.Memory;
  malloc(size: number): number;
  free(ptr: number): void;
  hb_blob_create(data: number, length: number, mode: number, userData: number, destroy: number): number;
  hb_blob_destroy(blob: number): void;
  hb_blob_get_length(blob: number): number;
  hb_blob_get_data(blob: number, lengthPtr: number): number;
  hb_face_create(blob: number, index: number): number;
  hb_face_destroy(face: number): void;
  hb_face_reference_blob(face: number): number;
  hb_subset_input_create_or_fail(): number;
  hb_subset_input_destroy(input: number): void;
  hb_subset_input_keep_everything(input: number): void;
  hb_subset_input_pin_axis_location(input: number, face: number, axisTag: number, axisValue: number): number;
  hb_subset_or_fail(source: number, input: number): number;
}

function loadParsedFontPair(): { latin: ParsedFont; hangul: ParsedFont } {
  const srcFontDir = path.join(process.cwd(), 'src', 'app', 'fonts');
  const latinSrcPath = path.join(srcFontDir, 'EasyConvertSans-latin.woff2');
  const hangulSrcPath = path.join(srcFontDir, 'EasyConvertSans-hangul.woff2');
  if (fs.existsSync(latinSrcPath) && fs.existsSync(hangulSrcPath)) {
    return {
      latin: parseFontToSfnt(fs.readFileSync(latinSrcPath), 'woff2', FAMILY_NAME),
      hangul: parseFontToSfnt(fs.readFileSync(hangulSrcPath), 'woff2', FAMILY_NAME),
    };
  }

  const builtMediaDir = path.join(process.cwd(), '.next', 'static', 'media');
  const candidates = fs
    .readdirSync(builtMediaDir)
    .filter((name) => name.endsWith('.woff2'))
    .map((name) => parseFontToSfnt(fs.readFileSync(path.join(builtMediaDir, name)), 'woff2', FAMILY_NAME))
    .filter((font) => font.fontFamily === FAMILY_NAME && Boolean(font.tables.cmap));

  const latin = candidates.find((font) => parseCmapTable(font.tables.cmap.data).has(ASCII_CAPITAL_A));
  const hangul = candidates.find((font) => !parseCmapTable(font.tables.cmap.data).has(ASCII_CAPITAL_A));
  if (!latin || !hangul) {
    throw new Error('EasyConvert Sans WOFF2 faces were not found in src/app/fonts or .next/static/media.');
  }
  return { latin, hangul };
}

function resolveHarfBuzzSubsetWasmPath(): string {
  return path.join(process.cwd(), 'node_modules', 'harfbuzzjs', 'dist', 'harfbuzz-subset.wasm');
}

function pinAxisWeight(sfnt: Buffer, weight: 400 | 700, exp: HarfBuzzSubsetExports): ArrayBuffer {
  const ptr = exp.malloc(sfnt.length);
  if (!ptr) throw new Error('harfbuzz-subset malloc failed');
  let blob = 0;
  let face = 0;
  let input = 0;
  let subsetFace = 0;
  let outBlob = 0;
  try {
    new Uint8Array(exp.memory.buffer, ptr, sfnt.length).set(sfnt);
    blob = exp.hb_blob_create(ptr, sfnt.length, HB_MEMORY_MODE_WRITABLE, 0, 0);
    face = exp.hb_face_create(blob, 0);
    input = exp.hb_subset_input_create_or_fail();
    if (!input) throw new Error('hb_subset_input_create_or_fail returned null');
    exp.hb_subset_input_keep_everything(input);
    exp.hb_subset_input_pin_axis_location(input, face, HB_TAG_WGHT, weight);
    subsetFace = exp.hb_subset_or_fail(face, input);
    if (!subsetFace) throw new Error(`hb_subset_or_fail failed for weight ${weight}`);

    outBlob = exp.hb_face_reference_blob(subsetFace);
    const outLen = exp.hb_blob_get_length(outBlob);
    const outPtr = exp.hb_blob_get_data(outBlob, 0);
    return new Uint8Array(exp.memory.buffer, outPtr, outLen).slice().buffer;
  } finally {
    if (outBlob) exp.hb_blob_destroy(outBlob);
    if (subsetFace) exp.hb_face_destroy(subsetFace);
    if (input) exp.hb_subset_input_destroy(input);
    if (face) exp.hb_face_destroy(face);
    if (blob) exp.hb_blob_destroy(blob);
    exp.free(ptr);
  }
}

let cachedFontsPromise: Promise<OgFontDescriptor[]> | null = null;

export function loadOgFonts(): Promise<OgFontDescriptor[]> {
  if (!cachedFontsPromise) {
    const pending: Promise<OgFontDescriptor[]> = (async (): Promise<OgFontDescriptor[]> => {
      const wasmBytes = fs.readFileSync(resolveHarfBuzzSubsetWasmPath());
      const { instance } = await WebAssembly.instantiate(wasmBytes, {});
      const exp = instance.exports as unknown as HarfBuzzSubsetExports;

      const { latin, hangul } = loadParsedFontPair();
      const latinSfnt = encodeSfnt(latin);
      const hangulSfnt = encodeSfnt(hangul);

      return [
        { name: FAMILY_NAME, data: pinAxisWeight(latinSfnt, 400, exp), weight: 400, style: 'normal' },
        { name: FAMILY_NAME, data: pinAxisWeight(latinSfnt, 700, exp), weight: 700, style: 'normal' },
        { name: FAMILY_NAME, data: pinAxisWeight(hangulSfnt, 400, exp), weight: 400, style: 'normal' },
        { name: FAMILY_NAME, data: pinAxisWeight(hangulSfnt, 700, exp), weight: 700, style: 'normal' },
      ];
    })().catch((err) => {
      cachedFontsPromise = null;
      throw err;
    });
    cachedFontsPromise = pending;
  }
  return cachedFontsPromise;
}
