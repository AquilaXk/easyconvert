import { ConversionOptions, ConversionResult, ConversionFailedError, UnsupportedOptionError, UnsupportedTargetError } from '../types';
import {
  FORMAT_REGISTRY,
  assertNotSpoofedFile,
  sniffMimeTypeFromMagicBytes,
  isFormatCompatibleWithMagicBytes,
} from '../registry';
import {
  convertImage,
  demosaicBayerCfa,
  decodeRawBayerSensor,
  type BayerPattern,
  type BayerSensorData,
} from './image';
import { convertDocument, extractTextFromPdf } from './document';
import { convertData } from './data';
import {
  convertMedia,
  packageHlsDashMedia,
  resampleAudioSinc,
  encodeWebmContainer,
  encodeOpusContainer,
  packageAuthenticOpusPages,
  encodeOggContainer,
  LOSSY_PSYCHOACOUSTIC_FORMATS,
  detectFfmpegEnvironment,
  type FfmpegEnvironmentInfo,
  checkFfmpeg,
} from './media';
import { assertPdfExportOptions, pdfaMetadata, resolvePdfAConformance } from './pdf-export-options';
import { convertOffice, formatSpreadsheetCellValue, parseBiff8Workbook, decodeRk } from './office';
import { buildOpenXpsPackage } from './openxps';
import {
  convertFont,
  convertFontToTrueType,
  convertFontToOpenTypeCff,
  cubicToQuadraticBezier,
  quadraticToCubicBezier,
} from './font';
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
  convertHwpDocument,
} from './hwp';
import {
  applyPdfWatermark,
  protectPdf,
  convertToPdfA,
} from './pdf-postprocess';
import {
  convertHwpx,
  parseHwpxDocument,
  buildHwpxContainer,
  isHwpxContainer,
  hwpxToHwp,
  hwpToHwpx,
  hwpxToMarkdown,
  markdownToHwpx,
  hwpxToPlainText,
} from './hwpx';
import {
  tessellateCadBuffer,
  tessellateCadText,
  splitNormalsByCreaseAngle,
  scaleMeshCoordinates,
  parseStepUnit,
  parseIgesUnit,
  CAD_UNIT_FACTORS_IN_MM,
  type TessellatedMesh,
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
  encodeFlacStream,
  BitWriter,
} from './media-encoder';
import {
  decodeAudioBuffer,
  decodeWav,
  decodeFlac,
  decodeMp3,
  decodeOgg,
  type DecodedAudio,
  BitReader,
} from './media-decoder';
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
  create7zArchiveAsync,
  extract7zArchive,
  decompressLzma,
  decompressLzma2,
  compressLzma,
  compressLzma2,
  type LzmaCompressOptions,
  type LzmaCompressResult,
  isSplitArchive,
  parseSplitArchivePart,
  stitchMultiVolumeArchive,
  splitArchive,
  type SplitArchivePartInfo,
  type StitchedArchiveResult,
  createVirtualSpannedStream,
  stitchMultiVolumeToDisk,
  VirtualSpannedStream,
  MultiVolumeBufferOverflowError,
  MAX_STITCH_BUFFER_SIZE,
  validateAndSortSplitParts,
  extractWithSpannedStream7z,
  type VirtualSpannedPartSource,
  type VirtualSpannedStreamOptions,
  type SpannedArchiveMetadata,
  compressWithZstdDict,
  decompressWithZstdDict,
  getPretrainedDictionary,
  DATA_DICTIONARY_JSON_CSV,
  OFFICE_XML_DICTIONARY,
  ZSTD_DICT_MAGIC,
  ZSTD_OFFICE_DICT_MAGIC,
  type ZstdDictOptions,
  ZstdDictionaryStreamCompressor,
  createZstdDictionaryTransformStream,
  type ZstdDictionaryStreamOptions,
  getUnrarBinaryPath,
  ARCHIVE_SECURITY_LIMITS,
  sanitizeArchivePath,
  crc32,
  write7zVarint,
  read7zVarint,
  compressXz,
  decompressXz,
  packXz,
  unpackXz,
  convertWithNative7z,
  getXzBinaryPath,
  get7zBinaryPath,
  inspectArchive,
  repairZipArchive,
  resolveArchiveEntryCollisions,
  matchArchiveGlob,
  validateMultiVolumeSequence,
} from './archive';

import { quantizeMedianCut, quantizeNeuQuant, encodeBmp8 } from './quantize';
import {
  performOcr,
  generateSearchablePdf,
  exportHocr,
  exportAlto,
  parseHocr,
  parseAlto,
  inspectPdfPagesTextDensity,
  performSmartMultiPagePdfOcr,
  createLosslessSandwichPdfFromPdf,
} from './ocr';
import {
  generateFb2FromText,
  generateHwpFromText,
  SpreadsheetFormulaEvaluator,
  SpreadsheetDagEngine,
  renderDrawingMlToSvg,
  parseDrawingMlShapes,
} from './office';

export {
  createZipArchive,
  createTarArchive,
  extractTarArchive,
  extractZipArchive,
  createRarArchive,
  extractRarArchive,
  create7zArchive,
  create7zArchiveAsync,
  extract7zArchive,
  convertArchive,
  convertToArchive,
  convertMedia,
  packageHlsDashMedia,
  convertOffice,
  parseBiff8Workbook,
  decodeRk,
  buildOpenXpsPackage,
  convertDocument,
  extractTextFromPdf,
  convertImage,
  convertData,
  convertFont,
  convertVectorCad,
  svgToDxf,
  convertHwp,
  convertHwpDocument,
  convertHwpx,
  parseHwpxDocument,
  buildHwpxContainer,
  isHwpxContainer,
  hwpxToHwp,
  hwpToHwpx,
  hwpxToMarkdown,
  markdownToHwpx,
  hwpxToPlainText,
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
  tessellateCadText,
  splitNormalsByCreaseAngle,
  scaleMeshCoordinates,
  parseStepUnit,
  parseIgesUnit,
  CAD_UNIT_FACTORS_IN_MM,
  type TessellatedMesh,
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
  encodeFlacStream,
  BitWriter,
  parseSvgPathToBezierPoints,
  quantizeMedianCut,
  quantizeNeuQuant,
  encodeBmp8,
  performOcr,
  generateSearchablePdf,
  exportHocr,
  exportAlto,
  parseHocr,
  parseAlto,
  inspectPdfPagesTextDensity,
  performSmartMultiPagePdfOcr,
  createLosslessSandwichPdfFromPdf,
  generateFb2FromText,
  generateHwpFromText,
  SpreadsheetFormulaEvaluator,
  SpreadsheetDagEngine,
  renderDrawingMlToSvg,
  parseDrawingMlShapes,
  decodeAudioBuffer,
  decodeWav,
  decodeFlac,
  decodeMp3,
  decodeOgg,
  decompressLzma,
  decompressLzma2,
  compressLzma,
  compressLzma2,
  type LzmaCompressOptions,
  type LzmaCompressResult,
  isSplitArchive,
  parseSplitArchivePart,
  stitchMultiVolumeArchive,
  splitArchive,
  type SplitArchivePartInfo,
  type StitchedArchiveResult,
  createVirtualSpannedStream,
  stitchMultiVolumeToDisk,
  VirtualSpannedStream,
  MultiVolumeBufferOverflowError,
  MAX_STITCH_BUFFER_SIZE,
  validateAndSortSplitParts,
  extractWithSpannedStream7z,
  type VirtualSpannedPartSource,
  type VirtualSpannedStreamOptions,
  type SpannedArchiveMetadata,
  compressWithZstdDict,
  decompressWithZstdDict,
  getPretrainedDictionary,
  DATA_DICTIONARY_JSON_CSV,
  OFFICE_XML_DICTIONARY,
  ZSTD_DICT_MAGIC,
  ZSTD_OFFICE_DICT_MAGIC,
  type ZstdDictOptions,
  ZstdDictionaryStreamCompressor,
  createZstdDictionaryTransformStream,
  type ZstdDictionaryStreamOptions,
  getUnrarBinaryPath,
  ARCHIVE_SECURITY_LIMITS,
  sanitizeArchivePath,
  crc32,
  write7zVarint,
  read7zVarint,
  compressXz,
  decompressXz,
  packXz,
  unpackXz,
  convertWithNative7z,
  getXzBinaryPath,
  get7zBinaryPath,
  inspectArchive,
  repairZipArchive,
  resolveArchiveEntryCollisions,
  matchArchiveGlob,
  validateMultiVolumeSequence,
  detectFfmpegEnvironment,
  type FfmpegEnvironmentInfo,
  BitReader,
  demosaicBayerCfa,
  decodeRawBayerSensor,
  type BayerPattern,
  type BayerSensorData,
  convertFontToTrueType,
  convertFontToOpenTypeCff,
  cubicToQuadraticBezier,
  quadraticToCubicBezier,
  resampleAudioSinc,
  encodeWebmContainer,
  encodeOpusContainer,
  packageAuthenticOpusPages,
  encodeOggContainer,
  LOSSY_PSYCHOACOUSTIC_FORMATS,
  ConversionFailedError,
  checkFfmpeg,
  formatSpreadsheetCellValue,
  sniffMimeTypeFromMagicBytes,
  isFormatCompatibleWithMagicBytes,
  assertNotSpoofedFile,
};

export * from './color-quantizer';
export * from './dla-engine';
export {
  adaptiveIncrementalBRepMesh,
  type AdaptiveDeflectionOptions,
  tessellateTrimmedFaceCDT,
  lawsonEdgeFlipHealing2D,
  inCircle2D,
  verifyWatertightManifoldMesh,
  HalfEdgeMesh,
  glueBRepTopologicalEdges,
  weldCoincidentVertices,
  buildLoopHierarchy,
  type LoopHierarchyNode,
  type TrimmedParametricFace,
  type Parametric2DPoint,
  type WeldOptions,
  type GlueBRepOptions,
  type HalfEdge,
  type MeshTopologyReport,
} from './cad-nurbs';

export {
  demosaicAmazeBayerCfa,
  demosaicAhdBayerCfa,
  applyIec61966SrgbGamma,
  inverseIec61966SrgbGamma,
  DEFAULT_D65_COLOR_MATRIX,
  STANDARD_ILLUMINANT_A_COLOR_MATRIX,
  STANDARD_ILLUMINANT_A_CCT,
  STANDARD_ILLUMINANT_D65_CCT,
  interpolateDualIlluminantColorMatrix,
  estimateCctFromWhiteBalance,
} from './image';

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
    throw new UnsupportedTargetError(
      `Cannot convert from ${srcDef.name} (.${src}) to target format .${tgt}. Available targets: ${srcDef.targetFormats.join(
        ', '
      )}`
    );
  }

  // Fail-closed verification against spoofed file extensions using initial-byte MIME magic sniffing
  if (options.validateMagicBytes) {
    assertNotSpoofedFile(inputBuffer, src, originalFilename);
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
    ].includes(tgt) ||
    (Boolean(options.thumbnail) && ['jpg', 'jpeg', 'png'].includes(tgt)) ||
    (options.subtitles?.mode === 'extract' && ['srt', 'vtt', 'ass'].includes(tgt)) ||
    Boolean(options.packaging) ||
    ['hls', 'dash'].includes(tgt)
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
  let res: ConversionResult;
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
      'hwpx',
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
    ['docx', 'xlsx', 'epub', 'pptx', 'odp', 'ods', 'odt', 'xls', 'key', 'numbers', 'pages', 'azw3', 'lrf', 'mobi', 'oeb', 'pdb', 'hwp', 'hwpx'].includes(tgt)
  ) {
    res = await convertOffice(inputBuffer, src, tgt, options, originalFilename);
  } else {
    // 7. Routing by source category
    switch (srcDef.category) {
      case 'image':
        res = await convertImage(inputBuffer, tgt, options, originalFilename, src);
        break;

      case 'document':
      default:
        res = await convertDocument(inputBuffer, src, tgt, options, originalFilename);
        break;
    }
  }

  // 8. PDF Post-Processing: PDF/A, Watermark, and Protection
  if (tgt === 'pdf' || res.filename?.endsWith('.pdf')) {
    await applyPdfPostProcessing(res, options);
  }

  return res;
}

/**
 * Rejects PDF output option combinations that cannot be honoured together. Callers run it before
 * converting so an incompatible request fails without spending conversion work.
 */
export function assertPdfPostProcessOptions(options: ConversionOptions): void {
  assertPdfExportOptions(options);
  if (resolvePdfAConformance(options) && options.protect) {
    // ISO 19005 forbids encryption in PDF/A files.
    throw new UnsupportedOptionError('PDF/A output cannot be encrypted; remove either the pdfa or the protect option.');
  }
}

/**
 * PDF post-processing shared by every conversion route: watermark, PDF/A, then protection.
 * Updates `result.buffer` and `result.size` in place; a result without a buffer is left untouched.
 */
export async function applyPdfPostProcessing(
  result: ConversionResult,
  options: ConversionOptions,
  /** `pdfaExported`: the PDF is already a PDF/A export of the requested level, so it is not converted again. */
  state: { pdfaExported?: boolean } = {}
): Promise<void> {
  if (!Buffer.isBuffer(result.buffer)) return;
  assertPdfPostProcessOptions(options);
  const pdfaLevel = state.pdfaExported ? null : resolvePdfAConformance(options);
  if (!options.watermark && !pdfaLevel && !options.protect) return;
  let pdf = result.buffer;
  // Watermark first: any edit after the PDF/A conversion would break conformance.
  if (options.watermark) {
    pdf = await applyPdfWatermark(pdf, options.watermark);
  }
  if (pdfaLevel) {
    const pdfaRes = await convertToPdfA(pdf, { ...options.pdfa, conformance: pdfaLevel });
    pdf = pdfaRes.buffer;
    result.metadata = { ...result.metadata, ...pdfaMetadata(pdfaRes.pdfaValidated, pdfaRes.conformanceLevel) };
  }
  if (options.protect) {
    pdf = await protectPdf(pdf, options.protect);
  }
  result.buffer = pdf;
  result.size = pdf.length;
}

export * from './page-range';
export * from './ctl';
export * from './pdf-postprocess';


