import { ConversionOptions, ConversionResult } from '../types';
import { FORMAT_REGISTRY } from '../registry';
import { convertImage } from './image';
import { convertDocument, extractTextFromPdf } from './document';
import { convertData } from './data';
import { convertMedia } from './media';
import { convertOffice } from './office';
import { convertFont } from './font';
import { convertVectorCad, svgToDxf, parseSvgPathToBezierPoints } from './vector-cad';
import {
  convertHwp,
  parseHwpDocument,
  buildHwpCompoundFile,
  isCfbfContainer,
  parseCfbf,
  parseHwpRecords,
  buildHwpRecord,
  decodeHwpText,
  decompressHwpStream,
  HWP_TAGS,
} from './hwp';
import {
  tessellateCadBuffer,
  tessellateCurvesToMesh,
  evaluateBSplineSurface,
  evaluateBSplineCurve,
  evaluateCubicBezier,
  evaluateCubicBezierDerivative,
  adaptiveTessellateCubicBezier,
  evaluateQuadraticBezier,
  cubicBezierToBSpline,
  tessellateSvgArc,
  tessellateBSplineSurface,
  coxDeBoorBasis,
  coxDeBoorBasisDerivative,
  evaluateAllBasis,
  evaluateAllBasisDerivatives,
  parseStepEntities,
  extractStepPoint,
  expandKnotsWithMultiplicities,
  extractStepBSplineSurfaces,
  extractStepBSplineCurves,
  parseIgesBSplineSurfaces,
  parseIgesBSplineCurves,
} from './cad-nurbs';
import {
  encodePureMp3,
  encodePureH264Mp4,
  generateH264Sps,
  generateH264Pps,
  generateH264IdrSlice,
  generateH264NonIdrSlice,
  escapeH264Rbsp,
  BitWriter,
} from './media-encoder';
import { decodePdfHexString, unescapePdfString } from './pdf-utils';
import {
  convertArchive,
  convertToArchive,
  createZipArchive,
  createTarArchive,
  extractTarArchive,
  extractZipArchive,
  createRarArchive,
  extractRarArchive,
  create7zArchive,
  extract7zArchive,
} from './archive';

import { quantizeMedianCut, quantizeNeuQuant, encodeBmp8 } from './quantize';
import { performOcr, generateSearchablePdf } from './ocr';
import { generateFb2FromText, generateHwpFromText } from './office';

export {
  createZipArchive,
  createTarArchive,
  extractTarArchive,
  extractZipArchive,
  createRarArchive,
  extractRarArchive,
  create7zArchive,
  extract7zArchive,
  convertToArchive,
  convertMedia,
  convertOffice,
  convertDocument,
  extractTextFromPdf,
  convertImage,
  convertData,
  convertFont,
  convertVectorCad,
  svgToDxf,
  convertHwp,
  parseHwpDocument,
  buildHwpCompoundFile,
  buildHwpRecord,
  isCfbfContainer,
  parseCfbf,
  parseHwpRecords,
  decodeHwpText,
  decompressHwpStream,
  HWP_TAGS,
  tessellateCadBuffer,
  tessellateCurvesToMesh,
  evaluateBSplineSurface,
  evaluateBSplineCurve,
  evaluateCubicBezier,
  evaluateCubicBezierDerivative,
  adaptiveTessellateCubicBezier,
  evaluateQuadraticBezier,
  cubicBezierToBSpline,
  tessellateSvgArc,
  tessellateBSplineSurface,
  coxDeBoorBasis,
  coxDeBoorBasisDerivative,
  evaluateAllBasis,
  evaluateAllBasisDerivatives,
  parseStepEntities,
  extractStepPoint,
  expandKnotsWithMultiplicities,
  extractStepBSplineSurfaces,
  extractStepBSplineCurves,
  parseIgesBSplineSurfaces,
  parseIgesBSplineCurves,
  encodePureMp3,
  encodePureH264Mp4,
  generateH264Sps,
  generateH264Pps,
  generateH264IdrSlice,
  generateH264NonIdrSlice,
  escapeH264Rbsp,
  BitWriter,
  parseSvgPathToBezierPoints,
  decodePdfHexString,
  unescapePdfString,
  quantizeMedianCut,
  quantizeNeuQuant,
  encodeBmp8,
  performOcr,
  generateSearchablePdf,
  generateFb2FromText,
  generateHwpFromText,
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
  if (
    srcDef.category === 'archive' ||
    ['zip', 'tar', 'gz', 'tgz', 'tar.gz', 'tar.bz2', 'tar.xz', 'tar.7z', '7z', 'rar', 'bz2', 'bz', 'tbz', 'tbz2'].includes(tgt) ||
    [
      'ace',
      'alz',
      'arc',
      'arj',
      'bz',
      'bz2',
      'cab',
      'cpio',
      'deb',
      'dmg',
      'img',
      'iso',
      'jar',
      'lha',
      'lz',
      'lzma',
      'lzo',
      'rpm',
      'rz',
      'tar.7z',
      'tar.bz',
      'tar.bz2',
      'tar.gz',
      'tar.lzo',
      'tar.xz',
      'tar.z',
      'tbz',
      'tbz2',
      'tz',
      'tzo',
      'z',
    ].includes(src)
  ) {
    return convertArchive(inputBuffer, src, tgt, options, originalFilename);
  }

  // 2. Media (Audio & Video) routing
  if (
    srcDef.category === 'audio' ||
    srcDef.category === 'video' ||
    [
      'mp3',
      'wav',
      'aac',
      'flac',
      'ogg',
      'opus',
      'wma',
      'm4a',
      'aiff',
      'aif',
      'ac3',
      'amr',
      'au',
      'caf',
      'dss',
      'm4b',
      'oga',
      'voc',
      'weba',
      'mp4',
      'webm',
      'mkv',
      'avi',
      'mov',
      '3gp',
      '3gpp',
      '3g2',
      'flv',
      'm2ts',
      'm4v',
      'mod',
      'mpeg',
      'mpg',
      'mts',
      'mxf',
      'ogv',
      'rm',
      'rmvb',
      'swf',
      'ts',
      'vob',
      'wmv',
      'wtv',
      'cavs',
      'dv',
      'dvr',
    ].includes(tgt)
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
      [
        'eps',
        'ps',
        'dxf',
        'dwg',
        'step',
        'stp',
        'iges',
        'igs',
        'stl',
        'obj',
        'cgm',
        'cdr',
        'dwf',
        'emf',
        'sk',
        'sk1',
        'svgz',
        'vsd',
        'wmf',
      ].includes(src) ||
      ['dxf', 'dwg', 'step', 'stp', 'iges', 'igs', 'stl', 'obj', 'cgm', 'emf', 'wmf', 'svg'].includes(tgt))
  ) {
    return convertVectorCad(inputBuffer, src, tgt, options, originalFilename);
  }

  // 5. Data category routing (CSV, TSV, TAB, JSON, NDJSON, JSONL, YAML, XML)
  if (srcDef.category === 'data' || ['csv', 'tsv', 'tab', 'ndjson', 'jsonl', 'json', 'yaml', 'yml', 'xml'].includes(src)) {
    if (['ods', 'xlsx', 'xls'].includes(tgt)) {
      return convertOffice(inputBuffer, src, tgt, options, originalFilename);
    }
    return convertData(inputBuffer, src, tgt, options, originalFilename);
  }

  // 6. Office, Ebook, Presentation, and Spreadsheet container routing
  if (
    srcDef.category === 'ebook' ||
    srcDef.category === 'presentation' ||
    srcDef.category === 'spreadsheet' ||
    [
      'docx',
      'xlsx',
      'pptx',
      'epub',
      'mobi',
      'odp',
      'ods',
      'odt',
      'xls',
      'fb2',
      'cbz',
      'et',
      'hwp',
      'lwp',
      'pub',
      'odg',
      'odd',
      'htmlz',
      'txtz',
      'azw4',
      'cbc',
      'pml',
      'oeb',
      'pot',
      'potx',
      'pps',
      'ppsx',
      'ppt',
      'pptm',
      'dps',
      'key',
      'numbers',
      'pages',
    ].includes(src) ||
    ['docx', 'xlsx', 'epub', 'pptx', 'odp', 'ods', 'odt', 'xls', 'key', 'numbers', 'pages', 'azw3', 'lrf', 'mobi', 'oeb', 'pdb', 'hwp'].includes(tgt)
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
