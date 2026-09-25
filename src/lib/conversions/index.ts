import { ConversionOptions, ConversionResult } from '../types';
import { FORMAT_REGISTRY } from '../registry';
import { convertImage } from './image';
import { convertDocument } from './document';
import { convertData } from './data';
import {
  convertArchive,
  convertToArchive,
  createZipArchive,
  createTarArchive,
  extractTarArchive,
  extractZipArchive,
} from './archive';

export {
  createZipArchive,
  createTarArchive,
  extractTarArchive,
  extractZipArchive,
  convertToArchive,
};

export async function convertFile(
  inputBuffer: Buffer,
  sourceFormat: string,
  targetFormat: string,
  options: ConversionOptions = {},
  originalFilename: string
): Promise<ConversionResult> {
  const src = sourceFormat.toLowerCase().replace(/^\./, '').trim();
  const tgt = targetFormat.toLowerCase().replace(/^\./, '').trim();

  if (!inputBuffer || inputBuffer.length === 0) {
    throw new Error('Conversion payload is empty. File buffer has 0 bytes.');
  }

  const srcDef = FORMAT_REGISTRY[src];
  if (!srcDef) {
    throw new Error(`Unsupported source format: "${sourceFormat}". Please check available formats.`);
  }

  // Verify that the requested conversion is allowed in registry
  if (!srcDef.targetFormats.includes(tgt)) {
    throw new Error(
      `Cannot convert from ${srcDef.name} (.${src}) to target format .${tgt}. Available targets: ${srcDef.targetFormats.join(
        ', '
      )}`
    );
  }

  // Archive routing (including archive sources or archive targets)
  if (srcDef.category === 'archive' || tgt === 'zip' || tgt === 'tar' || tgt === 'gz') {
    return convertArchive(inputBuffer, src, tgt, options, originalFilename);
  }

  // Routing by source category
  switch (srcDef.category) {
    case 'image':
      return convertImage(inputBuffer, tgt, options, originalFilename, src);

    case 'document':
      return convertDocument(inputBuffer, src, tgt, options, originalFilename);

    case 'data':
      return convertData(inputBuffer, src, tgt, options, originalFilename);

    default:
      throw new Error(`Category "${srcDef.category}" has no registered conversion handler.`);
  }
}
