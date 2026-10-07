import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { assertEncodedImageWithinLimit, openLimitedSharp, rethrowInputPixelLimit } from './image-input-limits';
import {
  ConversionOptions,
  OcrLanguageUnavailableError,
  ConversionFailedError,
  OcrEngineUnavailableError,
  OcrPreprocessError,
  HocrExportOptions,
  AltoExportOptions,
  OcrPageDecision,
  PdfPageAnalysis,
} from '../types';
import {
  createLosslessSandwichPdfFromImage,
  createLosslessSandwichPdfFromPdf,
  parseTesseractBlocks,
  sortLineBlocksTopological,
  detectColumnGutters,
  ColumnGutter,
  OcrBBox,
  OcrWord,
  OcrLineBlock,
  OcrResult,
  OcrPageResult,
} from './ocr-pdf-combiner';
import { extractRasterImagesFromPdf } from './pdf-rasterizer';
import { fallbackReadsMore, ocrFallbackPageSegMode, ocrSegmentationFor } from './ocr-config';
import { recognizeWithCli } from './ocr-cli';
import { runPdfTextJob } from './pdf-text-geometry';
import { mapOcrResultToSource } from './ocr-geometry';
import { calibrateOcrResult, characterWeightedConfidence, type OcrEnginePath } from './ocr-calibration';
import { mapWithConcurrency, ocrPageConcurrency } from './ocr-page-batch';
import {
  OCR_PREPROCESS_STEPS,
  preprocessOcrImage,
  type OcrPreprocessResult,
  type OcrPreprocessSteps,
} from './ocr-preprocess';
import { getSharedOcrWorkerPool, shutdownSharedOcrWorkerPool } from './ocr-worker-pool';

export type { ColumnGutter, OcrBBox, OcrWord, OcrLineBlock, OcrResult, OcrPageResult };
export {
  sortLineBlocksTopological,
  detectColumnGutters,
  createLosslessSandwichPdfFromPdf,
};
export {
  exportHocr,
  exportAlto,
  parseHocr,
  parseAlto,
  unescapeXml,
} from './ocr-export';

function countWords(text: string | null | undefined): number {
  return (text || '').split(/\s+/).filter(Boolean).length;
}

/** Terminates pooled OCR workers; call on process shutdown. */
export const shutdownOcrWorkerPool = shutdownSharedOcrWorkerPool;

/**
 * Optical Character Recognition (OCR) Engine
 * Powered by authentic WebAssembly inference (Tesseract.js) and native Tesseract CLI.
 * Strictly fail-closed without geometric fallback or fabricated glyph classification.
 * Word and page confidences are calibrated probabilities where a table exists (see ocr-calibration.ts).
 *
 * `steps` selects the page preparation steps and is internal: callers never pass it from user
 * options, and the default is OCR_PREPROCESS_STEPS. Tests and measurements use it to score a
 * step against the same page without it.
 */
export async function performOcr(
  imageBuffer: Buffer,
  language: string = 'auto',
  steps: OcrPreprocessSteps = OCR_PREPROCESS_STEPS
): Promise<OcrResult> {
  const recognized = await recognizePage(imageBuffer, language, steps);
  return calibrateOcrResult(recognized.result, recognized.enginePath);
}

/**
 * Recognizes the pages of a PDF side by side, up to `concurrency` at once (by default the number of
 * pooled workers, capped at OCR_MAX_INFLIGHT_PAGES), and returns the results in the order of `pages`.
 * The first failure stops further pages from starting and is rethrown.
 */
export function recognizePdfPages(
  pages: ReadonlyArray<{ buffer: Buffer }>,
  language: string | undefined,
  concurrency: number = ocrPageConcurrency()
): Promise<OcrResult[]> {
  return mapWithConcurrency(pages, concurrency, (page) => performOcr(page.buffer, language));
}

/** A page as the engine read it, with word scores still raw, and the engine path that produced it. */
export interface RecognizedPage {
  result: OcrResult;
  enginePath: OcrEnginePath;
}

/**
 * Recognizes one page and returns the engine's raw scores. `performOcr` calibrates them, and the
 * calibration tables are fitted on this output, so it is exported. `enginePath: 'cli'` skips the
 * WebAssembly engine and reads the page with the native tool.
 */
export async function recognizePage(
  imageBuffer: Buffer,
  language: string = 'auto',
  steps: OcrPreprocessSteps = OCR_PREPROCESS_STEPS,
  enginePath?: OcrEnginePath
): Promise<RecognizedPage> {
  const langMap: Record<string, string> = {
    auto: 'eng',
    en: 'eng',
    eng: 'eng',
    ko: 'kor',
    kor: 'kor',
    de: 'deu',
    deu: 'deu',
    fr: 'fra',
    fra: 'fra',
    es: 'spa',
    spa: 'spa',
    ja: 'jpn',
    jpn: 'jpn',
    jpn_vert: 'jpn_vert',
    ja_vert: 'jpn_vert',
    zh: 'chi_sim',
    chi_sim: 'chi_sim',
    chi_sim_vert: 'chi_sim_vert',
    zh_vert: 'chi_sim_vert',
    zh_sim_vert: 'chi_sim_vert',
    chi_tra: 'chi_tra',
    zh_tra: 'chi_tra',
    chi_tra_vert: 'chi_tra_vert',
    zh_tra_vert: 'chi_tra_vert',
  };
  const normalizedLang = (language || 'auto').toLowerCase().replace(/-/g, '_');
  const tesseractLang = langMap[normalizedLang];
  if (!tesseractLang) {
    throw new OcrLanguageUnavailableError(
      `Unsupported or unrecognized OCR language: '${language}'. Supported languages: ${Object.keys(langMap).join(', ')}.`
    );
  }

  // 1. Locate local or system pre-downloaded traineddata for zero-network offline inference
  const candidateDirs = [
    ...(process.env.TESSDATA_PREFIX ? [process.env.TESSDATA_PREFIX] : []),
    process.cwd(),
    '/usr/share/tesseract-ocr/5/tessdata',
    '/usr/share/tesseract-ocr/4.00/tessdata',
    '/usr/share/tessdata',
    '/opt/homebrew/share/tessdata',
    '/usr/local/share/tessdata',
  ];

  let localLangPath: string | undefined;
  let isGzip = false;
  for (const dir of candidateDirs) {
    const candidateGz = path.join(dir, `${tesseractLang}.traineddata.gz`);
    const candidateRaw = path.join(dir, `${tesseractLang}.traineddata`);
    if (fs.existsSync(candidateGz)) {
      localLangPath = dir;
      isGzip = true;
      break;
    }
    if (fs.existsSync(candidateRaw)) {
      localLangPath = dir;
      isGzip = false;
      break;
    }
  }

  if (!localLangPath) {
    throw new OcrLanguageUnavailableError(
      `OCR language '${language}' (${tesseractLang}.traineddata) is not available locally.`
    );
  }

  // Decode with sharp and hand the pixels over as an uncompressed Netpbm image: the OCR reader
  // opens fewer formats (no AVIF, HEIF, SVG or many TIFF variants) than the decoder, and a PNG
  // would be compressed here only to be decompressed again. EXIF orientation is applied first, so
  // text is recognized as displayed, and the page is prepared for recognition (see
  // ocr-preprocess.ts), which both engines below then read.
  let prepared: OcrPreprocessResult;
  await assertEncodedImageWithinLimit(imageBuffer);
  try {
    prepared = await preprocessOcrImage(imageBuffer, steps);
  } catch (err) {
    rethrowInputPixelLimit(err);
    if (err instanceof OcrPreprocessError || err instanceof OcrEngineUnavailableError) throw err;
    throw new ConversionFailedError('Invalid image: the OCR input could not be decoded.');
  }
  const ocrInput = prepared.image;
  // Segmentation follows the page as submitted: an enlarged label is still a label. Its text rows
  // are counted on the prepared image, which scaling and binarization leave in the same number.
  const inputHeight = prepared.geometry.sourceHeight;
  const inputTextRows = prepared.textRows;

  // 2. Try High-Performance WebAssembly Inference Engine (Tesseract.js)
  if (enginePath !== 'cli') {
    try {
      const { pageSegMode, engineMode } = ocrSegmentationFor(tesseractLang);
      const ret = await getSharedOcrWorkerPool().run(
        {
          langs: tesseractLang,
          langPath: localLangPath,
          gzip: isGzip,
          engineMode,
          parameters: { tessedit_pageseg_mode: pageSegMode },
        },
        async (recognize, recognizeWith) => {
          const imageMode = ocrSegmentationFor(tesseractLang, inputHeight, inputTextRows).pageSegMode;
          if (imageMode !== pageSegMode) {
            return recognizeWith({ tessedit_pageseg_mode: imageMode }, ocrInput, {}, { blocks: true });
          }
          const first = await recognize(ocrInput, {}, { blocks: true });
          const fallbackMode = ocrFallbackPageSegMode(tesseractLang);
          if (!fallbackMode || countWords(first.data.text) > 0) return first;
          // Automatic segmentation finds no text block in very small images; read them as one block.
          const retry = await recognizeWith(
            { tessedit_pageseg_mode: fallbackMode },
            ocrInput,
            {},
            { blocks: true }
          );
          return fallbackReadsMore(0, countWords(retry.data.text)) ? retry : first;
        }
      );

      if (ret && ret.data) {
        const fullText = (ret.data.text || '').trim();
        const imgWidth = prepared.geometry.outputWidth;
        const imgHeight = prepared.geometry.outputHeight;
        const { lines: recognizedLines, lineBlocks, wordMerge } = parseTesseractBlocks(
          ret.data.blocks,
          imgWidth,
          imgHeight,
          tesseractLang
        );
        const words = fullText.split(/\s+/).filter(Boolean);
        const result = mapOcrResultToSource(
          {
            text: fullText,
            confidence: characterWeightedConfidence(lineBlocks),
            wordCount: words.length,
            lines: recognizedLines.length > 0 ? recognizedLines : (fullText ? fullText.split('\n') : []),
            lineBlocks,
            imageWidth: imgWidth,
            imageHeight: imgHeight,
            language: tesseractLang,
            wordMerge,
          },
          prepared.geometry
        );
        return { result, enginePath: 'wasm' };
      }
    } catch (err: any) {
      if (err instanceof OcrEngineUnavailableError || err instanceof OcrLanguageUnavailableError) {
        throw err;
      }
      // Fall back to system native CLI if Tesseract.js fails
    }
  }

  // 3. Try System Native Tesseract CLI if available
  const tesseractCandidates = ['/usr/bin/tesseract', '/usr/local/bin/tesseract', '/opt/homebrew/bin/tesseract'];
  const tesseractCli = tesseractCandidates.find((p) => fs.existsSync(p));
  if (tesseractCli) {
    const result = mapOcrResultToSource(
      await recognizeWithCli({
        cliPath: tesseractCli,
        tessdataDir: localLangPath,
        tesseractLang,
        image: ocrInput,
        imageHeight: inputHeight,
        textRows: inputTextRows,
      }),
      prepared.geometry
    );
    return { result, enginePath: 'cli' };
  }

  throw new OcrEngineUnavailableError(
    `OCR engine (Tesseract) is unavailable or failed to execute for language '${language}'.`
  );
}

/**
 * Synthesizes a true Searchable PDF by embedding invisible text matching
 * word and line coordinates (3 Tr, Tz, Tm), enabling native text selection,
 * copying, and Ctrl+F searching with 100% metadata preservation.
 */
export async function generateSearchablePdf(
  scannedImageBuffer: Buffer,
  ocrResult: OcrResult,
  options: ConversionOptions = {},
  title = 'Searchable Document'
): Promise<Buffer> {
  return createLosslessSandwichPdfFromImage(await uprightImage(scannedImageBuffer), ocrResult, options, title);
}

/** EXIF orientation value for pixels that are already stored upright. */
const EXIF_ORIENTATION_UPRIGHT = 1;

/**
 * PDF image embedding ignores EXIF orientation, while OCR coordinates refer to the displayed
 * image. A rotated photo is re-encoded upright so the page and its text layer line up.
 */
async function uprightImage(imageBuffer: Buffer): Promise<Buffer> {
  await assertEncodedImageWithinLimit(imageBuffer);
  const { orientation } = await sharp(imageBuffer).metadata();
  if (!orientation || orientation === EXIF_ORIENTATION_UPRIGHT) {
    return imageBuffer;
  }
  return openLimitedSharp(imageBuffer).rotate().png().toBuffer();
}

/**
 * Inspects each page of a PDF document for existing digital text layer density, on the PDF text worker
 * thread and under its wall-clock deadline.
 */
export async function inspectPdfPagesTextDensity(
  pdfBuffer: Buffer,
  densityThreshold: number = 15
): Promise<PdfPageAnalysis[]> {
  return (await runPdfTextJob(pdfBuffer, { densityThreshold, geometry: 'none' })).analyses;
}

/**
 * Smart Multi-Page OCR Engine with selective page skipping:
 * - In 'skip_text' mode (default): skips OCR on pages that already contain extractable
 *   digital text; OCRs only scanned/raster pages.
 * - In 'force' / 'redo' mode: rasterizes and OCRs all pages unconditionally.
 * - Assembles a lossless searchable PDF preserving original digital vector pages
 *   while injecting sandwich invisible text layers only for the OCR'd scanned pages.
 */

/**
 * Evaluates whether each page in a PDF should be OCR'd or skipped based on
 * existing text density and selected OCR mode.
 */
export function evaluatePageOcrDecisions(
  pageAnalyses: PdfPageAnalysis[],
  ocrMode: string = 'skip_text'
): { pageDecisions: OcrPageDecision[]; pagesNeedingOcr: number[] } {
  const isForced = ocrMode === 'force' || ocrMode === 'redo';
  const pageDecisions: OcrPageDecision[] = [];
  const pagesNeedingOcr: number[] = [];

  for (const pa of pageAnalyses) {
    const shouldSkip = !isForced && pa.hasTextLayer;
    const reason: 'has_text' | 'forced' | 'no_text' = isForced
      ? 'forced'
      : pa.hasTextLayer
      ? 'has_text'
      : 'no_text';

    pageDecisions.push({
      pageNumber: pa.pageNumber,
      skipped: shouldSkip,
      reason,
      textDensity: pa.charCount,
      wordCount: pa.wordCount,
    });

    if (!shouldSkip) {
      pagesNeedingOcr.push(pa.pageNumber);
    }
  }

  return { pageDecisions, pagesNeedingOcr };
}

/**
 * Assembles a unified OcrResult combining OCR-recognized pages with
 * native vector text pages.
 */
export function assembleCombinedOcrResult(
  pageOcrResults: Map<number, OcrResult>,
  pageAnalyses: PdfPageAnalysis[],
  fallbackText: string = '',
  fallbackConfidence: number | null = null
): OcrResult {
  if (pageAnalyses.length === 0) {
    const lines = fallbackText ? fallbackText.split('\n').filter(Boolean) : [];
    return {
      text: fallbackText,
      confidence: fallbackConfidence ?? 0.9,
      wordCount: fallbackText ? fallbackText.split(/\s+/).filter(Boolean).length : 0,
      lines,
      lineBlocks: [],
      imageWidth: 612,
      imageHeight: 792,
    };
  }

  const combinedPages: OcrPageResult[] = [];
  const allTexts: string[] = [];
  const allLines: string[] = [];
  let totalConfidence = 0;
  let confCount = 0;
  let totalWordCount = 0;

  for (const pa of pageAnalyses) {
    const ocr = pageOcrResults.get(pa.pageNumber);
    if (ocr) {
      combinedPages.push({
        pageNumber: pa.pageNumber,
        width: ocr.imageWidth || pa.width,
        height: ocr.imageHeight || pa.height,
        text: ocr.text,
        confidence: ocr.confidence,
        lineBlocks: ocr.lineBlocks || [],
        lines: ocr.lines,
        language: ocr.language,
      });
      allTexts.push(ocr.text);
      allLines.push(...ocr.lines);
      if (ocr.confidence !== null) {
        totalConfidence += ocr.confidence;
        confCount++;
      }
      totalWordCount += ocr.wordCount;
    } else {
      const lines = pa.text ? pa.text.split('\n').filter(Boolean) : [];
      combinedPages.push({
        pageNumber: pa.pageNumber,
        width: pa.width,
        height: pa.height,
        text: pa.text,
        confidence: 1.0,
        lineBlocks: [],
        lines,
      });
      allTexts.push(pa.text);
      allLines.push(...lines);
      totalConfidence += 1.0;
      confCount++;
      totalWordCount += pa.wordCount;
    }
  }

  return {
    text: allTexts.join('\n\n').trim(),
    confidence: confCount > 0 ? totalConfidence / confCount : null,
    wordCount: totalWordCount,
    lines: allLines,
    lineBlocks: combinedPages.flatMap((p) => p.lineBlocks),
    imageWidth: pageAnalyses[0]?.width || 612,
    imageHeight: pageAnalyses[0]?.height || 792,
    pages: combinedPages,
    language: combinedPages.find((p) => p.language)?.language,
  };
}

/**
 * Smart Multi-Page OCR Engine with selective page skipping:
 * - In 'skip_text' mode (default): skips OCR on pages that already contain extractable
 *   digital text; OCRs only scanned/raster pages.
 * - In 'force' / 'redo' mode: rasterizes and OCRs all pages unconditionally.
 * - Assembles a lossless searchable PDF preserving original digital vector pages
 *   while injecting sandwich invisible text layers only for the OCR'd scanned pages.
 */
export async function performSmartMultiPagePdfOcr(
  pdfBuffer: Buffer,
  options: ConversionOptions = {}
): Promise<{
  buffer: Buffer;
  pageDecisions: OcrPageDecision[];
  ocrResults: Map<number, OcrResult>;
  combinedOcrResult: OcrResult;
}> {
  const ocrMode = options.ocrMode || 'skip_text';
  const densityThreshold = options.ocrDensityThreshold || 15;
  const pageAnalyses = await inspectPdfPagesTextDensity(pdfBuffer, densityThreshold);
  const { pageDecisions, pagesNeedingOcr } = evaluatePageOcrDecisions(pageAnalyses, ocrMode);

  const pageOcrResults = new Map<number, OcrResult>();
  if (pagesNeedingOcr.length > 0) {
    const rasterImages = await extractRasterImagesFromPdf(
      pdfBuffer,
      options.dpi || 300,
      new Set(pagesNeedingOcr)
    );

    const recognized = await recognizePdfPages(rasterImages, options.ocrLanguage);
    for (const [index, img] of rasterImages.entries()) {
      const ocr = recognized[index];
      if (ocr) {
        const existing = pageOcrResults.get(img.pageNumber);
        if (!existing) {
          pageOcrResults.set(img.pageNumber, ocr);
        } else {
          pageOcrResults.set(img.pageNumber, {
            text: `${existing.text}\n\n${ocr.text}`.trim(),
            confidence:
              existing.confidence !== null && ocr.confidence !== null
                ? (existing.confidence + ocr.confidence) / 2
                : (existing.confidence ?? ocr.confidence),
            wordCount: existing.wordCount + ocr.wordCount,
            lines: [...existing.lines, ...ocr.lines],
            lineBlocks: [...(existing.lineBlocks || []), ...(ocr.lineBlocks || [])],
            imageWidth: Math.max(existing.imageWidth || 0, img.width),
            imageHeight: (existing.imageHeight || 0) + img.height,
          });
        }
      }
    }
  }

  const finalPdfBuffer =
    pageOcrResults.size > 0
      ? await createLosslessSandwichPdfFromPdf(pdfBuffer, pageOcrResults)
      : pdfBuffer;

  const combinedOcrResult = assembleCombinedOcrResult(pageOcrResults, pageAnalyses);

  return {
    buffer: finalPdfBuffer,
    pageDecisions,
    ocrResults: pageOcrResults,
    combinedOcrResult,
  };
}

