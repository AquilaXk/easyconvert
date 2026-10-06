import sharp from 'sharp';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ConversionFailedError } from '../types';
import { InputPixelLimitError, assertInputPixels, maxInputPixels } from './image-input-limits';
import { readEnclosingDictionary, readWindowEntries, type DictionaryValue, type EnclosingDictionary } from './pdf-image-dictionary';

// pdfjs-dist needs Promise.withResolvers and ArrayBuffer.prototype.transferToFixedLength, which Node.js 20 lacks.
import './pdfjs-node-compat';

export interface ExtractedPdfImage {
  pageNumber: number;
  buffer: Buffer;
  width: number;
  height: number;
}

function unpack1bpp(packed: Uint8Array, width: number, height: number, inverse: boolean = false): Uint8Array {
  const unpacked = new Uint8Array(width * height);
  const rowBytes = Math.ceil(width / 8);
  for (let y = 0; y < height; y++) {
    const rowOffset = y * rowBytes;
    const targetOffset = y * width;
    for (let x = 0; x < width; x++) {
      const byteVal = packed[rowOffset + (x >> 3)];
      const bit = (byteVal >> (7 - (x & 7))) & 1;
      const isWhite = inverse ? bit === 0 : bit === 1;
      unpacked[targetOffset + x] = isWhite ? 255 : 0;
    }
  }
  return unpacked;
}

/** Bytes before and after an image marker that are searched for the dimensions of its dictionary. */
const IMAGE_DICTIONARY_WINDOW_BYTES = 4096;
/** Most image markers one PDF may hold; a document with more is refused instead of scanned. */
export const MAX_PDF_IMAGE_MARKERS = 5000;
/** Longest run of white space tolerated between the tokens the scan reads. */
const MAX_TOKEN_GAP = 16;

/** Regular expression for a PDF name, accepting the `#xx` escape (ISO 32000-1 7.3.5) for any character. */
function pdfName(word: string): string {
  const chars = [...word].map((char) => {
    const hex = (char.codePointAt(0) ?? 0).toString(16).padStart(2, '0');
    const nibbles = [...hex].map((nibble) => `[${nibble.toLowerCase()}${nibble.toUpperCase()}]`).join('');
    return `(?:${char}|#${nibbles})`;
  });
  return `/${chars.join('')}(?![A-Za-z0-9#])`;
}

const GAP = String.raw`\s{0,${MAX_TOKEN_GAP}}`;
const REQUIRED_GAP = String.raw`\s{1,${MAX_TOKEN_GAP}}`;
const IMAGE_MARKER_PATTERN = new RegExp(`${pdfName('Subtype')}${GAP}${pdfName('Image')}`, 'g');
/** `N G obj <integer> endobj`: the objects an indirect image dimension can point to. */
const INTEGER_OBJECT_PATTERN = new RegExp(
  String.raw`(?<![0-9])(\d{1,10})${REQUIRED_GAP}\d{1,5}${REQUIRED_GAP}obj${REQUIRED_GAP}(\d{1,10})${REQUIRED_GAP}endobj`,
  'g'
);

function unreadableDimensions(): ConversionFailedError {
  return new ConversionFailedError('Invalid PDF: the dimensions of an embedded image could not be read, so its size cannot be checked.');
}

/** The numbers of the integer objects of `text`, found in one linear pass. */
function integerObjects(text: string): Map<number, number> {
  const objects = new Map<number, number>();
  for (const match of text.matchAll(INTEGER_OBJECT_PATTERN)) objects.set(Number(match[1]), Number(match[2]));
  return objects;
}

/** One dimension of an image dictionary entry: a number, or a reference to an integer object. */
function entryDimension(entry: DictionaryValue | undefined, resolve: () => Map<number, number>): number {
  if (entry?.kind === 'number') return entry.value;
  const referenced = entry?.kind === 'reference' ? resolve().get(entry.objectNumber) : undefined;
  if (referenced === undefined) throw unreadableDimensions();
  return referenced;
}

/**
 * Refuses a PDF whose image XObjects declare more pixels than the input limit. Image XObjects are stream
 * objects, which a PDF never packs into an object stream, so their dictionaries are readable as plain text
 * and the check needs no decode. The size is read from the dictionary that holds the `/Subtype /Image`: its
 * own top-level `/Width` and `/Height` (the last of a repeated key, as a PDF reader takes it), never those of
 * a nested dictionary or of a neighbouring image. A marker that is not a key of any dictionary here (inside a
 * string or comment, in stream data, or without the start of its object in view) is checked against the top-level
 * Width and Height of its window; a window with none of its own, as when only a nested decoy is in view, is
 * refused as unreadable. A dictionary that cannot be delimited within the window, or whose dimensions are
 * missing or not plain integers, cannot be checked and is refused. Every scan is bounded by the window, and the
 * marker count is capped. Inline images, which have no dictionary to scan, are caught by pdfjs's own limit (see
 * `extractRasterImagesFromPdf`).
 */
function assertPdfImagesWithinLimit(pdfBuffer: Buffer): void {
  const text = pdfBuffer.toString('latin1');
  let integers: Map<number, number> | undefined;
  const resolve = (): Map<number, number> => {
    integers ??= integerObjects(text);
    return integers;
  };
  let markers = 0;
  for (const marker of text.matchAll(IMAGE_MARKER_PATTERN)) {
    markers++;
    if (markers > MAX_PDF_IMAGE_MARKERS) {
      throw new ConversionFailedError(`Invalid PDF: it holds more than ${MAX_PDF_IMAGE_MARKERS} images, which is over what a conversion accepts.`);
    }
    const at = marker.index ?? 0;
    const windowStart = Math.max(0, at - IMAGE_DICTIONARY_WINDOW_BYTES);
    const windowEnd = Math.min(text.length, at + IMAGE_DICTIONARY_WINDOW_BYTES);
    const objectAt = text.slice(windowStart, at).lastIndexOf('obj');
    // Without the start of its object in the window the dictionary cannot be delimited; the window maximum applies.
    const dictionary: EnclosingDictionary =
      objectAt === -1 ? { status: 'inert' } : readEnclosingDictionary(text, windowStart + objectAt + 'obj'.length, at, windowEnd);
    if (dictionary.status === 'undelimited') throw unreadableDimensions();
    if (dictionary.status === 'found') {
      assertInputPixels(entryDimension(dictionary.entries.get('Width'), resolve), entryDimension(dictionary.entries.get('Height'), resolve));
      continue;
    }
    // The start of the dictionary is out of view: only keys that are the window's own count, not those of the
    // dictionaries nested in it, and a window without its own Width and Height cannot be checked.
    const own = readWindowEntries(text, windowStart, windowEnd);
    assertInputPixels(entryDimension(own.get('Width'), resolve), entryDimension(own.get('Height'), resolve));
  }
}

/** pdfjs verbosity level that reports warnings (VerbosityLevel.WARNINGS). */
const PDFJS_WARNINGS_VERBOSITY = 1;
const PDFJS_WARNING_PREFIX = 'Warning: ';
const PDFJS_IMAGE_DROPPED_MESSAGE = 'Image exceeded maximum allowed size and was removed';

interface PdfjsRun {
  droppedImages: number;
}

/** The extraction that the current asynchronous call chain belongs to, so concurrent extractions are told apart. */
const pdfjsRun = new AsyncLocalStorage<PdfjsRun>();
let pdfjsWarningsRouted = false;

/**
 * pdfjs reports an image it skips because of `maxImageSize` only as a warning on `console.warn`. This installs,
 * once, a pass-through wrapper that counts that warning for the extraction whose call chain raised it and
 * swallows every other pdfjs warning of that extraction (they were silent at verbosity 0 before). Output
 * outside an extraction is forwarded untouched.
 */
function routePdfjsWarnings(): void {
  if (pdfjsWarningsRouted) return;
  pdfjsWarningsRouted = true;
  const forward = console.warn.bind(console);
  console.warn = (...args: unknown[]): void => {
    const run = pdfjsRun.getStore();
    const message = typeof args[0] === 'string' ? args[0] : '';
    if (run && message.startsWith(PDFJS_WARNING_PREFIX)) {
      if (message.includes(PDFJS_IMAGE_DROPPED_MESSAGE)) run.droppedImages++;
      return;
    }
    forward(...args);
  };
}

/**
 * Extracts embedded raster images from PDF pages using pdfjs-dist.
 * Safely decodes arbitrary PDF compression filters (JBIG2, Flate, DCT, JPX, CCITT Fax)
 * and rasterizes images at up to 300 DPI for high-precision OCR inference.
 */
export async function extractRasterImagesFromPdf(
  pdfBuffer: Buffer,
  targetDpi: number = 300,
  targetPageNumbers?: Set<number> | number[]
): Promise<ExtractedPdfImage[]> {
  assertPdfImagesWithinLimit(pdfBuffer);
  routePdfjsWarnings();
  const run: PdfjsRun = { droppedImages: 0 };
  const images = await pdfjsRun.run(run, () => decodePdfImages(pdfBuffer, targetDpi, targetPageNumbers));
  // pdfjs skips an image over `maxImageSize` without decoding it; an image that is skipped is refused, not lost.
  if (run.droppedImages > 0) throw new InputPixelLimitError(maxInputPixels());
  return images;
}

/** Wait for pdfjs to hand over an image object it is still decoding; a stuck decode yields null. */
const PDFJS_IMAGE_WAIT_MS = 5000;

/** The decoded image object the operator at `index` paints, or null when it paints none. */
async function paintedImageObject(pdfjs: any, page: any, opList: any, index: number): Promise<any> {
  const fn = opList.fnArray[index];
  if (fn === pdfjs.OPS.paintImageXObject) {
    const imgName = opList.argsArray[index][0];
    return Promise.race([
      new Promise<any>((resolve) => page.objs.get(imgName, resolve)),
      new Promise<any>((resolve) => setTimeout(() => resolve(null), PDFJS_IMAGE_WAIT_MS)),
    ]);
  }
  if (fn === pdfjs.OPS.paintInlineImageXObject) {
    return opList.argsArray[index][0];
  }
  return null;
}

/** pdfjs image kinds (ImageKind): 1 is 1-bit gray, 2 is RGB, 3 is RGBA. */
const IMAGE_KIND_GRAYSCALE_1BPP = 1;
const IMAGE_KIND_RGB_24BPP = 2;
const IMAGE_KIND_RGBA_32BPP = 3;

/** The raw samples of a decoded pdfjs image object and how many channels each pixel has. */
function rawSamplesOf(imgObj: any, width: number, height: number): { rawData: Buffer; channels: 1 | 3 | 4 } {
  const bytes = (): Buffer => Buffer.from(imgObj.data.buffer, imgObj.data.byteOffset, imgObj.data.byteLength);
  if (imgObj.kind === IMAGE_KIND_GRAYSCALE_1BPP) {
    // 1 bit per pixel: CCITT / JBIG2 bilevel
    const packed = new Uint8Array(imgObj.data.buffer, imgObj.data.byteOffset, imgObj.data.byteLength);
    const unpacked = unpack1bpp(packed, width, height);
    return { rawData: Buffer.from(unpacked.buffer, unpacked.byteOffset, unpacked.byteLength), channels: 1 };
  }
  if (imgObj.kind === IMAGE_KIND_RGB_24BPP) return { rawData: bytes(), channels: 3 };
  if (imgObj.kind === IMAGE_KIND_RGBA_32BPP) return { rawData: bytes(), channels: 4 };
  // Infer the channels from the byte length
  const totalPixels = width * height;
  const byteLength = imgObj.data.byteLength;
  if (byteLength === totalPixels) return { rawData: bytes(), channels: 1 };
  if (byteLength === totalPixels * 4) return { rawData: bytes(), channels: 4 };
  return { rawData: bytes(), channels: 3 };
}

/** Extracts one decoded image object as a PNG at the target density, or undefined when the object holds no pixels. */
async function imageObjectToPng(imgObj: any, pageNumber: number, targetDpi: number): Promise<ExtractedPdfImage | undefined> {
  if (!imgObj?.data || !imgObj.width || !imgObj.height) return undefined;
  const { width, height } = imgObj;
  assertInputPixels(width, height);
  const { rawData, channels } = rawSamplesOf(imgObj, width, height);
  // Normalize density to target DPI (e.g. 300 DPI) for OCR fidelity
  const buffer = await sharp(rawData, { raw: { width, height, channels } })
    .withMetadata({ density: targetDpi })
    .png()
    .toBuffer();
  return { pageNumber, buffer, width, height };
}

/** The error the OCR caller sees for a failure of pdfjs, classified by what its message says went wrong. */
function ocrFailureOf(err: any): Error {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  if (err?.name === 'PasswordException' || lower.includes('password') || lower.includes('encrypt')) {
    return new Error(`PDF OCR failed: Document is password-protected or encrypted: ${msg}`);
  }
  const damaged = ['filter', 'corrupt', 'invalid', 'stream', 'format', 'syntax'];
  if (damaged.some((word) => lower.includes(word))) {
    return new Error(`PDF OCR failed: Unsupported compression filter or invalid PDF stream: ${msg}`);
  }
  return new Error(`PDF OCR failed: Unable to decode PDF raster images: ${msg}`);
}

async function decodePdfImages(
  pdfBuffer: Buffer,
  targetDpi: number,
  targetPageNumbers: Set<number> | number[] | undefined
): Promise<ExtractedPdfImage[]> {
  const images: ExtractedPdfImage[] = [];

  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(pdfBuffer),
      useSystemFonts: true,
      disableFontFace: true,
      verbosity: PDFJS_WARNINGS_VERBOSITY,
      maxImageSize: maxInputPixels(),
    });

    const doc = await loadingTask.promise;
    const pageFilter = targetPageNumbers
      ? (targetPageNumbers instanceof Set ? targetPageNumbers : new Set(targetPageNumbers))
      : null;

    for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
      if (pageFilter && !pageFilter.has(pageNum)) {
        continue;
      }
      const page = await doc.getPage(pageNum);
      const opList = await page.getOperatorList();

      for (let i = 0; i < opList.fnArray.length; i++) {
        const imgObj = await paintedImageObject(pdfjs, page, opList, i);
        const extracted = await imageObjectToPng(imgObj, pageNum, targetDpi);
        if (extracted) images.push(extracted);
      }
    }
  } catch (err: any) {
    if (err instanceof InputPixelLimitError) throw err;
    throw ocrFailureOf(err);
  }

  return images;
}
