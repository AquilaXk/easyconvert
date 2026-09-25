import { ConversionOptions, ConversionResult } from '../types';
import { FORMAT_REGISTRY } from '../registry';
import { convertImage } from './image';
import { convertDocument } from './document';
import { convertData } from './data';
import { convertMedia } from './media';
import { convertOffice } from './office';
import { convertFont } from './font';
import { convertVectorCad } from './vector-cad';
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
  convertMedia,
  convertOffice,
  convertDocument,
  convertImage,
  convertData,
  convertFont,
  convertVectorCad,
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

  // 1. Archive routing (including archive sources or archive targets)
  if (srcDef.category === 'archive' || tgt === 'zip' || tgt === 'tar' || tgt === 'gz' || tgt === 'tgz') {
    return convertArchive(inputBuffer, src, tgt, options, originalFilename);
  }

  // 2. Media (Audio & Video) routing
  if (
    srcDef.category === 'audio' ||
    srcDef.category === 'video' ||
    ['mp3', 'wav', 'aac', 'flac', 'ogg', 'mp4', 'webm', 'mkv', 'avi', 'mov'].includes(tgt)
  ) {
    return convertMedia(inputBuffer, src, tgt, options, originalFilename);
  }

  // 3. Font routing
  if (srcDef.category === 'font' || ['woff', 'woff2', 'ttf', 'otf', 'eot', 'svgfont'].includes(tgt)) {
    return convertFont(inputBuffer, src, tgt, options, originalFilename);
  }

  // 4. Vector & CAD routing (including EPS and PS)
  if (
    src !== 'pdf' &&
    (srcDef.category === 'vector' ||
      srcDef.category === 'cad' ||
      ['eps', 'ps', 'dxf', 'dwg', 'step', 'stp', 'iges', 'igs', 'stl', 'obj'].includes(src) ||
      ['dxf', 'dwg', 'step', 'stp', 'iges', 'igs', 'stl', 'obj'].includes(tgt))
  ) {
    return convertVectorCad(inputBuffer, src, tgt, options, originalFilename);
  }

  // 5. Data category routing (CSV, TSV, TAB, JSON, NDJSON, JSONL, YAML, XML)
  if (srcDef.category === 'data' || ['csv', 'tsv', 'tab', 'ndjson', 'jsonl', 'json', 'yaml', 'yml', 'xml'].includes(src)) {
    return convertData(inputBuffer, src, tgt, options, originalFilename);
  }

  // 6. Office, Ebook, Presentation, and Spreadsheet container routing
  if (
    srcDef.category === 'ebook' ||
    srcDef.category === 'presentation' ||
    srcDef.category === 'spreadsheet' ||
    ['docx', 'xlsx', 'pptx', 'epub', 'mobi', 'odp', 'ods', 'odt', 'xls', 'fb2', 'cbz'].includes(src) ||
    ['docx', 'xlsx', 'epub', 'pptx', 'odp', 'ods', 'odt', 'xls'].includes(tgt)
  ) {
    return convertOffice(inputBuffer, src, tgt, options, originalFilename);
  }

  // 7. Routing by source category
  switch (srcDef.category) {
    case 'image':
      return convertImage(inputBuffer, tgt, options, originalFilename, src);

    case 'document':
      return convertDocument(inputBuffer, src, tgt, options, originalFilename);

    default:
      return convertDocument(inputBuffer, src, tgt, options, originalFilename);
  }
}
