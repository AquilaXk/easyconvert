import sharp from 'sharp';
import PDFDocument from 'pdfkit';
import JSZip from 'jszip';
import { ConversionOptions, ConversionResult } from '../types';

export function encodeBmp(raw: Buffer, width: number, height: number, channels: number): Buffer {
  const rowSize = width * 3;
  const padding = (4 - (rowSize % 4)) % 4;
  const stride = rowSize + padding;
  const pixelDataSize = stride * height;
  const fileSize = 54 + pixelDataSize;

  const buf = Buffer.alloc(fileSize);

  // BMP File Header (14 bytes)
  buf.write('BM', 0); // Signature
  buf.writeUInt32LE(fileSize, 2); // File size
  buf.writeUInt32LE(0, 6); // Reserved
  buf.writeUInt32LE(54, 10); // Offset to pixel data

  // DIB Header (BITMAPINFOHEADER - 40 bytes)
  buf.writeUInt32LE(40, 14); // Header size
  buf.writeInt32LE(width, 18); // Image width
  buf.writeInt32LE(height, 22); // Image height (positive = bottom-up)
  buf.writeUInt16LE(1, 26); // Planes
  buf.writeUInt16LE(24, 28); // Bits per pixel (24-bit RGB)
  buf.writeUInt32LE(0, 30); // Compression (BI_RGB uncompressed)
  buf.writeUInt32LE(pixelDataSize, 34); // Image data size
  buf.writeInt32LE(2835, 38); // Horizontal resolution (72 dpi)
  buf.writeInt32LE(2835, 42); // Vertical resolution (72 dpi)
  buf.writeUInt32LE(0, 46); // Colors in color table
  buf.writeUInt32LE(0, 50); // Important color count

  let offset = 54;
  for (let y = height - 1; y >= 0; y--) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * channels;
      const r = raw[idx];
      const g = raw[idx + 1];
      const b = raw[idx + 2];
      buf[offset++] = b; // BGR format
      buf[offset++] = g;
      buf[offset++] = r;
    }
    for (let p = 0; p < padding; p++) {
      buf[offset++] = 0;
    }
  }

  return buf;
}

export function decodeBmp(buf: Buffer): { raw: Buffer; width: number; height: number; channels: 4 } {
  if (buf.length < 54 || buf.toString('ascii', 0, 2) !== 'BM') {
    throw new Error('Invalid BMP file: missing BM header signature.');
  }

  const pixelOffset = buf.readUInt32LE(10);
  const width = buf.readInt32LE(18);
  const height = buf.readInt32LE(22);
  const bpp = buf.readUInt16LE(28);

  if (width <= 0 || height === 0) {
    throw new Error(`Invalid BMP dimensions: ${width}x${height}`);
  }

  const isBottomUp = height > 0;
  const absHeight = Math.abs(height);
  const rawRgba = Buffer.alloc(width * absHeight * 4);

  const rowSize = Math.floor((bpp * width + 31) / 32) * 4;

  for (let y = 0; y < absHeight; y++) {
    const srcY = isBottomUp ? absHeight - 1 - y : y;
    const rowOffset = pixelOffset + srcY * rowSize;

    for (let x = 0; x < width; x++) {
      const dstIdx = (y * width + x) * 4;

      if (bpp === 24) {
        const srcIdx = rowOffset + x * 3;
        rawRgba[dstIdx] = buf[srcIdx + 2]; // R
        rawRgba[dstIdx + 1] = buf[srcIdx + 1]; // G
        rawRgba[dstIdx + 2] = buf[srcIdx]; // B
        rawRgba[dstIdx + 3] = 255; // Alpha
      } else if (bpp === 32) {
        const srcIdx = rowOffset + x * 4;
        rawRgba[dstIdx] = buf[srcIdx + 2];
        rawRgba[dstIdx + 1] = buf[srcIdx + 1];
        rawRgba[dstIdx + 2] = buf[srcIdx];
        rawRgba[dstIdx + 3] = buf[srcIdx + 3];
      } else {
        // Fallback for 8-bit or unhandled bpp
        const srcIdx = rowOffset + Math.min(x, rowSize - 1);
        const val = buf[srcIdx] || 0;
        rawRgba[dstIdx] = val;
        rawRgba[dstIdx + 1] = val;
        rawRgba[dstIdx + 2] = val;
        rawRgba[dstIdx + 3] = 255;
      }
    }
  }

  return { raw: rawRgba, width, height: absHeight, channels: 4 };
}

export function encodeIco(pngBuffer: Buffer, width: number, height: number): Buffer {
  const icoHeader = Buffer.alloc(22);
  icoHeader.writeUInt16LE(0, 0); // Reserved, must be 0
  icoHeader.writeUInt16LE(1, 2); // 1 = ICO icon format
  icoHeader.writeUInt16LE(1, 4); // Number of images in icon

  const w = width >= 256 ? 0 : width;
  const h = height >= 256 ? 0 : height;

  icoHeader.writeUInt8(w, 6); // Width
  icoHeader.writeUInt8(h, 7); // Height
  icoHeader.writeUInt8(0, 8); // Color count
  icoHeader.writeUInt8(0, 9); // Reserved
  icoHeader.writeUInt16LE(1, 10); // Color planes
  icoHeader.writeUInt16LE(32, 12); // Bits per pixel
  icoHeader.writeUInt32LE(pngBuffer.length, 14); // Image size in bytes
  icoHeader.writeUInt32LE(22, 18); // Offset to image data (after 22-byte header)

  return Buffer.concat([icoHeader, pngBuffer]);
}

export function decodeIco(buf: Buffer): Buffer {
  if (buf.length < 22 || buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) {
    throw new Error('Invalid ICO file: missing ICO header.');
  }

  const count = buf.readUInt16LE(4);
  if (count === 0) throw new Error('Empty ICO file.');

  const imgSize = buf.readUInt32LE(14);
  const imgOffset = buf.readUInt32LE(18);

  if (imgOffset + imgSize > buf.length) {
    throw new Error('Corrupted ICO file: image data offset exceeds buffer size.');
  }

  return buf.subarray(imgOffset, imgOffset + imgSize);
}

export function encodeIcns(pngBuffer: Buffer): Buffer {
  const chunkHeader = Buffer.alloc(8);
  chunkHeader.write('ic08', 0, 4, 'ascii'); // 256x256 icon
  chunkHeader.writeUInt32BE(8 + pngBuffer.length, 4);

  const totalLength = 8 + 8 + pngBuffer.length;
  const icnsHeader = Buffer.alloc(8);
  icnsHeader.write('icns', 0, 4, 'ascii');
  icnsHeader.writeUInt32BE(totalLength, 4);

  return Buffer.concat([icnsHeader, chunkHeader, pngBuffer]);
}

export function decodeIcns(buf: Buffer): Buffer {
  if (buf.length < 16 || buf.toString('ascii', 0, 4) !== 'icns') {
    throw new Error('Invalid ICNS file: missing icns header.');
  }
  let offset = 8;
  while (offset + 8 <= buf.length) {
    const chunkType = buf.toString('ascii', offset, offset + 4);
    const chunkSize = buf.readUInt32BE(offset + 4);
    if (chunkSize <= 8 || offset + chunkSize > buf.length) break;

    const chunkData = buf.subarray(offset + 8, offset + chunkSize);
    if (
      (chunkData.length >= 8 && chunkData[0] === 0x89 && chunkData[1] === 0x50) ||
      (chunkData.length >= 3 && chunkData[0] === 0xff && chunkData[1] === 0xd8)
    ) {
      return chunkData;
    }
    offset += chunkSize;
  }
  const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const pngIdx = buf.indexOf(pngSig);
  if (pngIdx !== -1) {
    return buf.subarray(pngIdx);
  }
  return buf.subarray(8);
}

export function encodePsd(payload: Buffer, width: number, height: number): Buffer {
  const header = Buffer.alloc(26);
  header.write('8BPS', 0, 4, 'ascii');
  header.writeUInt16BE(1, 4); // version 1
  header.fill(0, 6, 12);
  header.writeUInt16BE(4, 12); // RGBA
  header.writeUInt32BE(height, 14);
  header.writeUInt32BE(width, 18);
  header.writeUInt16BE(8, 22);
  header.writeUInt16BE(3, 24); // RGB color

  const colorModeData = Buffer.alloc(4);
  const imageResources = Buffer.alloc(4);
  const layerInfo = Buffer.alloc(4);
  const comp = Buffer.alloc(2);

  return Buffer.concat([header, colorModeData, imageResources, layerInfo, comp, payload]);
}

export function encodePostscript(
  rgbBuffer: Buffer,
  width: number,
  height: number,
  isEps: boolean
): Buffer {
  const hex = rgbBuffer.toString('hex');
  const chunks: string[] = [];
  for (let i = 0; i < hex.length; i += 72) {
    chunks.push(hex.substring(i, i + 72));
  }
  const hexData = chunks.join('\n');

  const ps = `%!PS-Adobe-3.0${isEps ? ' EPSF-3.0' : ''}
%%BoundingBox: 0 0 ${width} ${height}
%%Pages: 1
%%LanguageLevel: 2
%%Creator: EasyConvert Image Engine
%%EndComments
gsave
0 0 translate
${width} ${height} scale
${width} ${height} 8 [${width} 0 0 -${height} 0 ${height}]
currentfile /ASCIIHexDecode filter
false 3 colorimage
${hexData} >
grestore
showpage
%%EOF
`;
  return Buffer.from(ps, 'utf-8');
}

export async function convertImage(
  inputBuffer: Buffer,
  targetFormat: string,
  options: ConversionOptions = {},
  originalFilename: string,
  sourceFormat?: string
): Promise<ConversionResult> {
  const baseName = originalFilename.replace(/\.[^/.]+$/, '');
  const fmt = targetFormat.toLowerCase();
  const src = (sourceFormat || '').toLowerCase();

  // Special case: Image to PDF
  if (fmt === 'pdf') {
    return convertImageToPdf(inputBuffer, options, baseName, src);
  }

  // Handle RAW camera inputs by checking for embedded JPEG preview
  let activeBuffer = inputBuffer;
  if (['3fr', 'crw', 'dcr', 'erf', 'mos', 'mrw', 'x3f'].includes(src) || src === 'raw') {
    const jpgSig = Buffer.from([0xff, 0xd8, 0xff]);
    const jpgIdx = activeBuffer.indexOf(jpgSig);
    if (jpgIdx !== -1) {
      activeBuffer = activeBuffer.subarray(jpgIdx);
    }
  }

  let pipeline: sharp.Sharp;

  // Handle BMP input decoding
  if (src === 'bmp' || activeBuffer.subarray(0, 2).toString('ascii') === 'BM') {
    const decoded = decodeBmp(activeBuffer);
    pipeline = sharp(decoded.raw, {
      raw: { width: decoded.width, height: decoded.height, channels: 4 },
    });
  } else if (
    src === 'ico' ||
    (activeBuffer.length >= 4 &&
      activeBuffer[0] === 0 &&
      activeBuffer[1] === 0 &&
      activeBuffer[2] === 1 &&
      activeBuffer[3] === 0)
  ) {
    const payload = decodeIco(activeBuffer);
    if (payload.subarray(0, 2).toString('ascii') === 'BM') {
      const decoded = decodeBmp(payload);
      pipeline = sharp(decoded.raw, {
        raw: { width: decoded.width, height: decoded.height, channels: 4 },
      });
    } else {
      pipeline = sharp(payload);
    }
  } else if (src === 'icns' || activeBuffer.subarray(0, 4).toString('ascii') === 'icns') {
    const payload = decodeIcns(activeBuffer);
    pipeline = sharp(payload);
  } else {
    pipeline = sharp(activeBuffer);
  }

  // Resize options
  if (options.width || options.height) {
    pipeline = pipeline.resize({
      width: options.width ? Number(options.width) : undefined,
      height: options.height ? Number(options.height) : undefined,
      fit: options.fit || 'contain',
      background: { r: 255, g: 255, b: 255, alpha: 0 },
    });
  }

  // Strip metadata if requested
  if (options.stripMetadata) {
    pipeline = pipeline.withMetadata({ orientation: undefined });
  }

  const quality = options.quality ? Math.max(1, Math.min(100, options.quality)) : 85;

  let outputBuffer: Buffer;
  let mimeType: string;

  switch (fmt) {
    case 'jpg':
    case 'jpeg':
      outputBuffer = await pipeline.jpeg({ quality, mozjpeg: true }).toBuffer();
      mimeType = 'image/jpeg';
      break;

    case 'png':
      outputBuffer = await pipeline.png({ compressionLevel: 8 }).toBuffer();
      mimeType = 'image/png';
      break;

    case 'webp':
      outputBuffer = await pipeline.webp({ quality }).toBuffer();
      mimeType = 'image/webp';
      break;

    case 'avif':
      outputBuffer = await pipeline.avif({ quality }).toBuffer();
      mimeType = 'image/avif';
      break;

    case 'tiff':
      outputBuffer = await pipeline.tiff({ quality }).toBuffer();
      mimeType = 'image/tiff';
      break;

    case 'gif':
      outputBuffer = await pipeline.gif().toBuffer();
      mimeType = 'image/gif';
      break;

    case 'bmp': {
      // Deterministic raw RGBA extraction and standard BMP binary generation
      const { data, info } = await pipeline
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      outputBuffer = encodeBmp(data, info.width, info.height, info.channels);
      mimeType = 'image/bmp';
      break;
    }

    case 'ico': {
      // Resize to valid icon dimension (up to 256x256) and package with ICONDIR header
      const icoPipeline = pipeline.clone().resize({
        width: Math.min(256, options.width || 256),
        height: Math.min(256, options.height || 256),
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      });
      const { data: pngBuf, info } = await icoPipeline.png().toBuffer({ resolveWithObject: true });
      outputBuffer = encodeIco(pngBuf, info.width, info.height);
      mimeType = 'image/x-icon';
      break;
    }

    case 'icns': {
      const icnsPipeline = pipeline.clone().resize({
        width: 256,
        height: 256,
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      });
      const pngBuf = await icnsPipeline.png().toBuffer();
      outputBuffer = encodeIcns(pngBuf);
      mimeType = 'image/x-icns';
      break;
    }

    case 'psd': {
      const { data: pngBuf, info } = await pipeline.png().toBuffer({ resolveWithObject: true });
      outputBuffer = encodePsd(pngBuf, info.width, info.height);
      mimeType = 'image/vnd.adobe.photoshop';
      break;
    }

    case 'eps':
    case 'ps': {
      const { data: rawRgb, info } = await pipeline
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      outputBuffer = encodePostscript(rawRgb, info.width, info.height, fmt === 'eps');
      mimeType = 'application/postscript';
      break;
    }

    case 'odd': {
      // OpenDocument Drawing XML package
      const zip = new JSZip();
      zip.file('mimetype', 'application/vnd.oasis.opendocument.graphics');
      zip.file(
        'content.xml',
        '<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"><office:body><office:drawing/></office:body></office:document-content>'
      );
      outputBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
      mimeType = 'application/vnd.oasis.opendocument.graphics';
      break;
    }

    case 'xps': {
      const zip = new JSZip();
      zip.file(
        '[Content_Types].xml',
        '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="fdseq" ContentType="application/vnd.ms-package.xps-fixeddocumentsequence+xml"/></Types>'
      );
      outputBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
      mimeType = 'application/oxps';
      break;
    }

    default:
      throw new Error(`Unsupported image target format: ${targetFormat}`);
  }

  return {
    buffer: outputBuffer,
    mimeType,
    filename: `${baseName}.${fmt}`,
    size: outputBuffer.length,
  };
}

async function convertImageToPdf(
  inputBuffer: Buffer,
  options: ConversionOptions,
  baseName: string,
  sourceFormat?: string
): Promise<ConversionResult> {
  let pipeline: sharp.Sharp;

  if (sourceFormat === 'bmp' || inputBuffer.subarray(0, 2).toString('ascii') === 'BM') {
    const decoded = decodeBmp(inputBuffer);
    pipeline = sharp(decoded.raw, {
      raw: { width: decoded.width, height: decoded.height, channels: 4 },
    });
  } else if (
    sourceFormat === 'ico' ||
    (inputBuffer.length >= 4 &&
      inputBuffer[0] === 0 &&
      inputBuffer[1] === 0 &&
      inputBuffer[2] === 1 &&
      inputBuffer[3] === 0)
  ) {
    const payload = decodeIco(inputBuffer);
    pipeline = sharp(payload);
  } else {
    pipeline = sharp(inputBuffer);
  }

  const metadata = await pipeline.metadata();
  const imgWidth = metadata.width || 595.28;
  const imgHeight = metadata.height || 841.89;

  // Convert to PNG buffer first to ensure pdfkit can embed it reliably
  const pngBuffer = await pipeline.png().toBuffer();

  return new Promise((resolve, reject) => {
    const isLandscape =
      options.orientation === 'landscape' || (imgWidth > imgHeight && !options.orientation);
    const doc = new PDFDocument({
      size: [
        isLandscape ? Math.max(imgWidth, imgHeight) : imgWidth,
        isLandscape ? Math.min(imgWidth, imgHeight) : imgHeight,
      ],
      margin: 0,
      layout: isLandscape ? 'landscape' : 'portrait',
    });

    const chunks: Buffer[] = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => {
      const buffer = Buffer.concat(chunks);
      resolve({
        buffer,
        mimeType: 'application/pdf',
        filename: `${baseName}.pdf`,
        size: buffer.length,
      });
    });
    doc.on('error', (err) => reject(err));

    doc.image(pngBuffer, 0, 0, {
      fit: [doc.page.width, doc.page.height],
      align: 'center',
      valign: 'center',
    });
    doc.end();
  });
}
