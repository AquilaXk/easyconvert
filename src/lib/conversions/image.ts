import sharp from 'sharp';
import PDFDocument from 'pdfkit';
import { ConversionOptions, ConversionResult } from '../types';

export async function convertImage(
  inputBuffer: Buffer,
  targetFormat: string,
  options: ConversionOptions = {},
  originalFilename: string
): Promise<ConversionResult> {
  const baseName = originalFilename.replace(/\.[^/.]+$/, '');
  const fmt = targetFormat.toLowerCase();

  // Special case: Image to PDF
  if (fmt === 'pdf') {
    return convertImageToPdf(inputBuffer, options, baseName);
  }

  let pipeline = sharp(inputBuffer);

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
    case 'bmp':
    case 'ico':
      // sharp does not write bmp/ico directly, output as png formatted buffer or jpeg
      outputBuffer = await pipeline.png().toBuffer();
      mimeType = fmt === 'ico' ? 'image/x-icon' : 'image/bmp';
      break;
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
  baseName: string
): Promise<ConversionResult> {
  const metadata = await sharp(inputBuffer).metadata();
  const imgWidth = metadata.width || 595.28;
  const imgHeight = metadata.height || 841.89;

  // Convert to PNG buffer first to ensure pdfkit can embed it reliably
  const pngBuffer = await sharp(inputBuffer).png().toBuffer();

  return new Promise((resolve, reject) => {
    const isLandscape = options.orientation === 'landscape' || (imgWidth > imgHeight && !options.orientation);
    const doc = new PDFDocument({
      size: [isLandscape ? Math.max(imgWidth, imgHeight) : imgWidth, isLandscape ? Math.min(imgWidth, imgHeight) : imgHeight],
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
