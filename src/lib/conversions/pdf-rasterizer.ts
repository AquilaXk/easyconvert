import sharp from 'sharp';
import { extractEmbeddedImageFromPdf } from './pdf-utils';

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

/**
 * Extracts embedded raster images from PDF pages using pdfjs-dist.
 * Safely decodes arbitrary PDF compression filters (JBIG2, Flate, DCT, JPX, CCITT Fax)
 * and rasterizes images at up to 300 DPI for high-precision OCR inference.
 */
export async function extractRasterImagesFromPdf(
  pdfBuffer: Buffer,
  targetDpi: number = 300
): Promise<ExtractedPdfImage[]> {
  const images: ExtractedPdfImage[] = [];

  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(pdfBuffer),
      useSystemFonts: true,
      disableFontFace: true,
      verbosity: 0,
    });

    const doc = await loadingTask.promise;

    for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
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

  // If pdfjs found no images, fallback to raw embedded image extractor
  if (images.length === 0) {
    const fallbackImg = extractEmbeddedImageFromPdf(pdfBuffer);
    if (fallbackImg) {
      try {
        const meta = await sharp(fallbackImg).metadata();
        const pngBuf = await sharp(fallbackImg)
          .withMetadata({ density: targetDpi })
          .png()
          .toBuffer();
        images.push({
          pageNumber: 1,
          buffer: pngBuf,
          width: meta.width || 800,
          height: meta.height || 600,
        });
      } catch {
        // Fallback image unreadable
      }
    }
  }

  return images;
}
