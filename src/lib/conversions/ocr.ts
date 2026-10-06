import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import {
  ConversionOptions,
  OcrLanguageUnavailableError,
  ConversionFailedError,
  OcrEngineUnavailableError,
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
import { ocrSegmentationFor } from './ocr-config';
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

/** Terminates pooled OCR workers; call on process shutdown. */
export const shutdownOcrWorkerPool = shutdownSharedOcrWorkerPool;

/**
 * Optical Character Recognition (OCR) Engine
 * Powered by authentic WebAssembly inference (Tesseract.js) and native Tesseract CLI.
 * Strictly fail-closed without geometric fallback or fabricated glyph classification.
 */
export async function performOcr(
  imageBuffer: Buffer,
  language: string = 'auto'
): Promise<OcrResult> {
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

  // Decode with sharp and re-encode as PNG: the OCR reader opens fewer formats (no AVIF, HEIF,
  // SVG or many TIFF variants) than the decoder, so it only ever receives a lossless PNG. EXIF
  // orientation is applied first, so text is recognized as displayed.
  let ocrInput: Buffer;
  try {
    ocrInput = await sharp(imageBuffer).rotate().png().toBuffer();
  } catch {
    throw new ConversionFailedError('Invalid image: the OCR input could not be decoded.');
  }

  // 2. Try High-Performance WebAssembly Inference Engine (Tesseract.js)
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
      (recognize) => recognize(ocrInput, {}, { blocks: true })
    );

    if (ret && ret.data) {
      const fullText = (ret.data.text || '').trim();
      const meta = await sharp(ocrInput).metadata().catch(() => ({ width: 800, height: 600 }));
      const imgWidth = meta.width || 800;
      const imgHeight = meta.height || 600;
      const { lines: recognizedLines, lineBlocks } = parseTesseractBlocks(ret.data.blocks, imgWidth, imgHeight);

      const words = fullText.split(/\s+/).filter(Boolean);

      // Compute authentic mean word confidence across recognized blocks/words
      let totalConf = 0;
      let confCount = 0;
      if (Array.isArray((ret.data as any).words) && (ret.data as any).words.length > 0) {
        for (const w of (ret.data as any).words) {
          if (typeof w.confidence === 'number' && !isNaN(w.confidence)) {
            totalConf += w.confidence;
            confCount++;
          }
        }
      } else if (Array.isArray(lineBlocks) && lineBlocks.length > 0) {
        for (const block of lineBlocks) {
          if (Array.isArray(block.words)) {
            for (const w of block.words) {
              const wConf = (w as any).confidence;
              if (typeof wConf === 'number' && !isNaN(wConf)) {
                totalConf += wConf;
                confCount++;
              }
            }
          }
        }
      }

      const meanConf =
        confCount > 0
          ? totalConf / confCount / 100
          : typeof ret.data.confidence === 'number'
          ? ret.data.confidence / 100
          : null;

      return {
        text: fullText,
        confidence: meanConf,
        wordCount: words.length,
        lines: recognizedLines.length > 0 ? recognizedLines : (fullText ? fullText.split('\n') : []),
        lineBlocks,
        imageWidth: imgWidth,
        imageHeight: imgHeight,
      };
    }
  } catch (err: any) {
    if (err instanceof OcrEngineUnavailableError || err instanceof OcrLanguageUnavailableError) {
      throw err;
    }
    // Fall back to system native CLI if Tesseract.js fails
  }

  // 3. Try System Native Tesseract CLI if available
  const tesseractCandidates = ['/usr/bin/tesseract', '/usr/local/bin/tesseract', '/opt/homebrew/bin/tesseract'];
  const tesseractCli = tesseractCandidates.find((p) => fs.existsSync(p));
  if (tesseractCli) {
    const tmpIn = path.join(os.tmpdir(), `ocr_cli_in_${crypto.randomUUID()}.png`);
    const tmpOutBase = path.join(os.tmpdir(), `ocr_cli_out_${crypto.randomUUID()}`);
    try {
      fs.writeFileSync(tmpIn, ocrInput);
      const { pageSegMode, engineMode } = ocrSegmentationFor(tesseractLang);
      const cliArgs = [
        '--tessdata-dir', localLangPath, tmpIn, tmpOutBase,
        '-l', tesseractLang, '--psm', pageSegMode, '--oem', String(engineMode),
      ];
      execFileSync(tesseractCli, cliArgs, {
        stdio: ['ignore', 'ignore', 'pipe'],
        timeout: 15000,
      });
      const outTxtPath = `${tmpOutBase}.txt`;
      if (fs.existsSync(outTxtPath)) {
        const cliText = fs.readFileSync(outTxtPath, 'utf-8').trim();
        fs.unlinkSync(outTxtPath);
        const meta = await sharp(ocrInput).metadata().catch(() => ({ width: 800, height: 600 }));
        const lines = cliText ? cliText.split('\n').map((l) => l.trim()).filter(Boolean) : [];
        return {
          text: cliText,
          confidence: null,
          wordCount: cliText ? cliText.split(/\s+/).filter(Boolean).length : 0,
          lines,
          lineBlocks: [],
          imageWidth: meta.width || 800,
          imageHeight: meta.height || 600,
        };
      }
    } catch (err: any) {
      // CLI failed
    } finally {
      try {
        if (fs.existsSync(tmpIn)) fs.unlinkSync(tmpIn);
      } catch {}
    }
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
  const { orientation } = await sharp(imageBuffer).metadata();
  if (!orientation || orientation === EXIF_ORIENTATION_UPRIGHT) {
    return imageBuffer;
  }
  return sharp(imageBuffer).rotate().png().toBuffer();
}

/**
 * Inspects each page of a PDF document for existing digital text layer density.
 */
export async function inspectPdfPagesTextDensity(
  pdfBuffer: Buffer,
  densityThreshold: number = 15
): Promise<PdfPageAnalysis[]> {
  const analyses: PdfPageAnalysis[] = [];
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
    const view = page.view || [0, 0, 612, 792];
    const width = Math.abs(view[2] - view[0]);
    const height = Math.abs(view[3] - view[1]);

    const textContent = await page.getTextContent();
    const strings = (textContent.items || []).map((it: any) => it.str || '');
    const pageText = strings.join(' ').trim();
    const charCount = pageText.replace(/\s+/g, '').length;
    const wordCount = pageText.split(/\s+/).filter(Boolean).length;
    const hasTextLayer = charCount >= densityThreshold;

    analyses.push({
      pageNumber: pageNum,
      width,
      height,
      charCount,
      wordCount,
      hasTextLayer,
      text: pageText,
    });
  }

  return analyses;
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

    for (const img of rasterImages) {
      const ocr = await performOcr(img.buffer, options.ocrLanguage);
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

