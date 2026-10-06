import sharp from 'sharp';
import { InputPixelLimitError, assertInputPixels, maxInputPixels } from './image-input-limits';

// Polyfill Promise.withResolvers for Node.js < 22 / 20.13 environments required by pdfjs-dist
if (typeof (Promise as any).withResolvers === 'undefined') {
  (Promise as any).withResolvers = function <T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: any) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

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

/** Bytes around an image XObject marker that are searched for its dictionary. */
const IMAGE_DICTIONARY_WINDOW_BYTES = 2048;
const IMAGE_SUBTYPE_PATTERN = /\/Subtype\s*\/Image\b/g;
const OBJECT_START_PATTERN = /\d+\s+\d+\s+obj\b/g;
const IMAGE_WIDTH_PATTERN = /\/Width\s+(\d{1,10})\b/;
const IMAGE_HEIGHT_PATTERN = /\/Height\s+(\d{1,10})\b/;

/**
 * Refuses a PDF whose image XObjects declare more pixels than the input limit. Image XObjects are stream
 * objects, which a PDF never packs into an object stream, so their dictionaries are readable as plain text
 * and the check needs no decode. pdfjs is additionally told the same limit (`maxImageSize`), which makes it
 * skip, without decoding, any image this scan cannot see (inline images, obfuscated names).
 */
function assertPdfImagesWithinLimit(pdfBuffer: Buffer): void {
  const text = pdfBuffer.toString('latin1');
  for (const marker of text.matchAll(IMAGE_SUBTYPE_PATTERN)) {
    const at = marker.index ?? 0;
    const windowStart = Math.max(0, at - IMAGE_DICTIONARY_WINDOW_BYTES);
    const before = text.slice(windowStart, at);
    let objectStart = 0;
    for (const start of before.matchAll(OBJECT_START_PATTERN)) objectStart = start.index ?? 0;
    const dictionary = text.slice(windowStart + objectStart, at + IMAGE_DICTIONARY_WINDOW_BYTES);
    const streamAt = dictionary.indexOf('stream');
    const header = streamAt === -1 ? dictionary : dictionary.slice(0, streamAt);
    const width = IMAGE_WIDTH_PATTERN.exec(header);
    const height = IMAGE_HEIGHT_PATTERN.exec(header);
    if (width && height) assertInputPixels(Number(width[1]), Number(height[1]));
  }
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
  const images: ExtractedPdfImage[] = [];

  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(pdfBuffer),
      useSystemFonts: true,
      disableFontFace: true,
      verbosity: 0,
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
        const fn = opList.fnArray[i];
        let imgObj: any = null;

        if (fn === pdfjs.OPS.paintImageXObject) {
          const imgName = opList.argsArray[i][0];
          imgObj = await Promise.race([
            new Promise<any>((resolve) => page.objs.get(imgName, resolve)),
            new Promise<any>((resolve) => setTimeout(() => resolve(null), 5000)),
          ]);
        } else if (fn === pdfjs.OPS.paintInlineImageXObject) {
          imgObj = opList.argsArray[i][0];
        }

        if (imgObj && imgObj.data && imgObj.width && imgObj.height) {
          const { width, height } = imgObj;
          assertInputPixels(width, height);
          let rawData: Buffer;
          let channels: 1 | 3 | 4 = 3;

          if (imgObj.kind === 1) {
            // GRAYSCALE_1BPP (1 bit per pixel: CCITT / JBIG2 bilevel)
            const srcBytes = new Uint8Array(imgObj.data.buffer, imgObj.data.byteOffset, imgObj.data.byteLength);
            const unpacked = unpack1bpp(srcBytes, width, height);
            rawData = Buffer.from(unpacked.buffer, unpacked.byteOffset, unpacked.byteLength);
            channels = 1;
          } else if (imgObj.kind === 2) {
            // RGB_24BPP
            rawData = Buffer.from(imgObj.data.buffer, imgObj.data.byteOffset, imgObj.data.byteLength);
            channels = 3;
          } else if (imgObj.kind === 3) {
            // RGBA_32BPP
            rawData = Buffer.from(imgObj.data.buffer, imgObj.data.byteOffset, imgObj.data.byteLength);
            channels = 4;
          } else {
            // Infer channels from byte length
            const totalPixels = width * height;
            const byteLen = imgObj.data.byteLength;
            if (byteLen === totalPixels) {
              channels = 1;
            } else if (byteLen === totalPixels * 4) {
              channels = 4;
            } else {
              channels = 3;
            }
            rawData = Buffer.from(imgObj.data.buffer, imgObj.data.byteOffset, imgObj.data.byteLength);
          }

          // Normalize density to target DPI (e.g. 300 DPI) for OCR fidelity
          const pngBuf = await sharp(rawData, {
            raw: {
              width,
              height,
              channels,
            },
          })
            .withMetadata({ density: targetDpi })
            .png()
            .toBuffer();

          images.push({
            pageNumber: pageNum,
            buffer: pngBuf,
            width,
            height,
          });
        }
      }
    }
  } catch (err: any) {
    if (err instanceof InputPixelLimitError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    const lower = msg.toLowerCase();
    if (
      err?.name === 'PasswordException' ||
      lower.includes('password') ||
      lower.includes('encrypt')
    ) {
      throw new Error(`PDF OCR failed: Document is password-protected or encrypted: ${msg}`);
    }
    if (
      lower.includes('filter') ||
      lower.includes('corrupt') ||
      lower.includes('invalid') ||
      lower.includes('stream') ||
      lower.includes('format') ||
      lower.includes('syntax')
    ) {
      throw new Error(`PDF OCR failed: Unsupported compression filter or invalid PDF stream: ${msg}`);
    }
    throw new Error(`PDF OCR failed: Unable to decode PDF raster images: ${msg}`);
  }

  return images;
}
