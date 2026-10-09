import fs from 'node:fs';
import os from 'node:os';
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
  OcrEngineFallback,
} from './ocr-pdf-combiner';
import { openPdfPageRenderer } from './pdf-page-render';
import { OcrWorkBudget } from './ocr-work-budget';
import {
  fallbackReadsMore,
  OCR_ALTERNATIVE_MIN_EVIDENCE_GAIN,
  OCR_PSM_AUTO,
  ocrBandsAllowedFor,
  OCR_ALTERNATIVE_TRIGGER_QUALITY,
  ocrFallbackPageSegMode,
  ocrSegmentationFor,
} from './ocr-config';
import { recognizeWithCli, type OcrEngineMarkupFormat } from './ocr-cli';
import { rethrowSandboxUnavailable } from '../security/process-sandbox';
import { describeEngineError, recoverableWasmFailure } from './ocr-engine-failure';
import { locateLanguageData, locateLanguagesData } from './ocr-language-data';
import { OCR_AUTO_LANGUAGE, resolveOcrLanguages } from './ocr-languages';
import { runPdfTextJob } from './pdf-text-geometry';
import { mapOcrResultToSource, orientedSize, trimOverreachingWords, type OcrQuarterTurn } from './ocr-geometry';
import {
  decideOrientation,
  languageForScript,
  OSD_LANGUAGE,
  OSD_MIN_QUALITY_GAIN,
  OSD_SUSPECT_QUALITY,
  readOrientation,
  type OcrOrientation,
} from './ocr-osd';
import { resolveImageDpi } from './ocr-dpi';
import { hasPngSignature, planPngPassthrough } from './pdf-image-passthrough';
import {
  calibrateOcrResult,
  characterWeightedConfidence,
  confidenceWeightedCharacters,
  type OcrEnginePath,
} from './ocr-calibration';
import { mapWithConcurrency, ocrPageConcurrency } from './ocr-page-batch';
import {
  OCR_PREPROCESS_STEPS,
  OCR_UNEVEN_BACKGROUND_RATIO,
  preprocessOcrImage,
  type OcrPreprocessResult,
  type OcrPreprocessSteps,
} from './ocr-preprocess';
import { mergeBandReadings, OCR_BAND_MAX_BANDS, planBands, sliceNetpbmRows, type BandReading, type OcrBand } from './ocr-bands';
import {
  getSharedOcrWorkerPool,
  OCR_POOL_MAX_WORKERS_PER_KEY,
  shutdownSharedOcrWorkerPool,
  type OcrWorkerPool,
  type OcrWorkerSpec,
} from './ocr-worker-pool';

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
  steps: OcrPreprocessSteps = OCR_PREPROCESS_STEPS,
  detectOrientation?: boolean,
  parallelBands?: boolean
): Promise<OcrResult> {
  const recognized = await recognizePage(imageBuffer, language, { steps, detectOrientation, parallelBands });
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
  concurrency: number = ocrPageConcurrency(),
  detectOrientation?: boolean
): Promise<OcrResult[]> {
  return mapWithConcurrency(pages, concurrency, (page) =>
    // Several pages are read side by side, one engine run each, so a page is not also cut into bands.
    performOcr(page.buffer, language, OCR_PREPROCESS_STEPS, detectOrientation, pages.length < 2)
  );
}

/**
 * Targets that carry the paragraph and block structure of a page. Reading a page in bands can change that
 * structure, so these targets read each page whole.
 */
export const STRUCTURED_OCR_TARGETS: ReadonlySet<string> = new Set(['hocr', 'alto']);

export interface RenderedPdfOcrOptions {
  /** Resolution the pages are rendered at; OCR_DEFAULT_DPI when unset, at most OCR_MAX_DPI. */
  dpi?: number;
  language?: string;
  detectOrientation?: boolean;
  /** Also read each page's engine markup (see readEngineMarkup); it is kept on the page's result as `engineMarkup`. */
  engineMarkup?: OcrEngineMarkupFormat;
  /** Passed to the page reading (see OcrRecognitionOptions.parallelBands); `false` reads each page whole. */
  parallelBands?: boolean;
}

/**
 * Recognizes the pages of a PDF as they are displayed: each requested page is rendered (Poppler, at the requested
 * resolution, with /Rotate, the CropBox, masks and clipping applied), recognized and released, so only the pages
 * in flight are held. The result of a page is in the pixels of its render, and records how they relate to the PDF
 * page (`pageRender`) so a text layer can be placed on it. Without Poppler the request fails with an
 * OcrEngineUnavailableError (503); pages are never read from the image objects they contain instead.
 * @throws OcrWorkLimitError (413) when rendering and reading the pages takes longer than the document's work budget
 * (ocr-work-budget.ts); no page is returned then, since a partial document would read as a complete one.
 */
export async function recognizeRenderedPdfPages(
  pdf: Buffer,
  pages: ReadonlySet<number> | undefined,
  options: RenderedPdfOcrOptions = {}
): Promise<Map<number, OcrResult>> {
  const renderer = await openPdfPageRenderer(pdf, pages, options.dpi);
  try {
    const indices = renderer.plan.pageNumbers.map((_, index) => index);
    // With several pages the pages run side by side and each is read whole; bands are for a lone page.
    const bandsAllowed = indices.length < 2 && options.parallelBands !== false;
    const budget = new OcrWorkBudget(indices.length);
    const recognized = await mapWithConcurrency(indices, ocrPageConcurrency(), async (index) => {
      budget.assertWithinBudget();
      const rendered = await renderer.render(index);
      budget.assertWithinBudget();
      const result = await performOcr(rendered.image, options.language, OCR_PREPROCESS_STEPS, options.detectOrientation, bandsAllowed);
      const engineMarkup = options.engineMarkup ? await readEngineMarkup(rendered.image, options.language, options.engineMarkup) : undefined;
      budget.pageRead();
      return { pageNumber: rendered.pageNumber, result: { ...result, pageRender: rendered.page, ...(engineMarkup ? { engineMarkup } : {}) } };
    });
    return new Map(recognized.map((entry) => [entry.pageNumber, entry.result]));
  } finally {
    await renderer.close();
  }
}

/**
 * The native engine's own hOCR or ALTO of a page, for checking the product exports against it. The page is read
 * as submitted (EXIF orientation applied, nothing else prepared), so its boxes are in the pixels of `imageBuffer`.
 * It needs the tesseract command line and the language data; without them the request is an
 * OcrEngineUnavailableError (503), never a markup written by this project and passed off as the engine's.
 */
export async function readEngineMarkup(
  imageBuffer: Buffer,
  language: string | undefined,
  format: OcrEngineMarkupFormat
): Promise<{ format: OcrEngineMarkupFormat; content: string }> {
  const requested = resolveOcrLanguages(language);
  const data = locateLanguagesData(language || OCR_AUTO_LANGUAGE, requested.traineddata);
  await assertEncodedImageWithinLimit(imageBuffer);
  const cli = findTesseractCli();
  if (!cli) {
    throw new OcrEngineUnavailableError('The engine markup (ocrEngineMarkup) needs the tesseract command line, which is not installed.');
  }
  const asSubmitted = await preprocessOcrImage(imageBuffer, { rescale: false, deskew: false, binarize: false });
  const read = await recognizeWithCli({
    cliPath: cli,
    tessdataDir: data.dir,
    tesseractLang: requested.joined,
    image: asSubmitted.image,
    imageHeight: orientedSize(asSubmitted.geometry)[1],
    textRows: asSubmitted.textRows,
    engineMarkup: format,
  });
  if (!read.engineMarkup) throw new OcrEngineUnavailableError('The tesseract command line wrote no markup.');
  return read.engineMarkup;
}

/** A page as the engine read it, with word scores still raw, and the engine path that produced it. */
export interface RecognizedPage {
  result: OcrResult;
  enginePath: OcrEnginePath;
  /** How the page was prepared for the reading that was kept. */
  preparation?: {
    binarized: boolean;
    unevenBackground: number;
    /** Engine runs the reading took: 1 for a page read whole, more for a page read in bands. */
    bands: number;
  };
}

export interface OcrRecognitionOptions {
  /** Page preparation steps; the default is OCR_PREPROCESS_STEPS. */
  steps?: OcrPreprocessSteps;
  /** `cli` skips the WebAssembly engine and reads the page with the native tool. */
  enginePath?: OcrEnginePath;
  /**
   * Whether to find the page's orientation and script first. Left out it runs when the `osd` data is
   * installed and is skipped, with the skip recorded, when it is not; `true` demands it and fails
   * with OcrEngineUnavailableError (503) when the data or engine is missing; `false` switches it off.
   */
  detectOrientation?: boolean;
  /**
   * Whether a page of plain text lines may be cut into bands that separate engine workers read side by side (see
   * ocr-bands.ts). On unless `false`; tests and measurements switch it off to read the same page whole.
   */
  parallelBands?: boolean;
}

const TESSERACT_CLI_CANDIDATES = ['/usr/bin/tesseract', '/usr/local/bin/tesseract', '/opt/homebrew/bin/tesseract'];

function findTesseractCli(): string | undefined {
  return TESSERACT_CLI_CANDIDATES.find((candidate) => fs.existsSync(candidate));
}

/**
 * Reads the page's orientation and script. A failure is recorded as `unavailable` and the page is
 * recognized as it is, unless detection was demanded, when the failure is raised.
 */
async function detectPageOrientation(
  imageBuffer: Buffer,
  demanded: boolean
): Promise<{ orientation: OcrOrientation; quarterTurn: OcrQuarterTurn }> {
  const unavailable = { orientation: { status: 'unavailable', rotationApplied: 0 } as OcrOrientation, quarterTurn: 0 as OcrQuarterTurn };
  const data = locateLanguageData(OSD_LANGUAGE);
  if (!data) {
    if (demanded) {
      throw new OcrEngineUnavailableError(
        `Orientation detection needs the '${OSD_LANGUAGE}' OCR data (${OSD_LANGUAGE}.traineddata), which is not available locally.`
      );
    }
    return unavailable;
  }
  try {
    const reading = await readOrientation(imageBuffer, { tessdataDir: data.dir, gzip: data.gzip, cliPath: findTesseractCli() });
    return decideOrientation(reading);
  } catch (err) {
    rethrowSandboxUnavailable(err);
    if (demanded) throw err;
    return unavailable;
  }
}

/**
 * Recognizes one page and returns the engine's raw scores. `performOcr` calibrates them, and the
 * calibration tables are fitted on this output, so it is exported.
 */
export async function recognizePage(
  imageBuffer: Buffer,
  language: string = 'auto',
  options: OcrRecognitionOptions = {}
): Promise<RecognizedPage> {
  const { steps = OCR_PREPROCESS_STEPS, enginePath, detectOrientation, parallelBands } = options;
  const requested = resolveOcrLanguages(language);
  const requestedLanguage = requested.joined;
  const requestedData = locateLanguagesData(language || OCR_AUTO_LANGUAGE, requested.traineddata);

  await assertEncodedImageWithinLimit(imageBuffer);
  if (detectOrientation === true) assertOrientationDetectable();
  // What the page declares about its size, for the searchable PDF; undeclared is recorded as assumed.
  const imageDpi = resolveImageDpi(imageBuffer);
  const finish = (page: RecognizedPage, orientation: OcrOrientation): RecognizedPage => ({
    ...page,
    result: { ...page.result, orientation, imageDpi },
  });

  const attempt = (quarterTurn: OcrQuarterTurn, tesseractLang: string, languageData: LanguageData) =>
    recognizeAttempt({ imageBuffer, steps, quarterTurn, tesseractLang, languageData, enginePath, language, parallelBands });
  const first = await attempt(0, requestedLanguage, requestedData);
  if (detectOrientation === false) return finish(first, { status: 'disabled', rotationApplied: 0 });
  if (!looksMisread(first.result)) return finish(first, { status: 'not-needed', rotationApplied: 0 });

  // The page reads badly, so it may be sideways, upside down or in another script: look at it. The
  // engine's turn is kept only when reading again scores better, so a doubtful reading costs
  // time and never a page that was read correctly.
  const detection = await detectPageOrientation(imageBuffer, detectOrientation === true);
  const scriptLanguage = requested.auto ? languageForScript(detection.orientation) : null;
  const scriptData = scriptLanguage === null ? undefined : locateLanguageData(scriptLanguage);
  const switchTo = scriptLanguage !== null && scriptData && scriptLanguage !== requestedLanguage ? scriptLanguage : null;
  if (detection.quarterTurn === 0 && switchTo === null) return finish(first, detection.orientation);
  let second: RecognizedPage;
  try {
    second = await attempt(
      detection.quarterTurn,
      switchTo ?? requestedLanguage,
      switchTo === null ? requestedData : (scriptData as LanguageData)
    );
  } catch (err) {
    rethrowSandboxUnavailable(err);
    if (detectOrientation === true) throw err;
    return finish(first, { ...detection.orientation, status: 'unavailable', rotationApplied: 0 });
  }
  if (readingQuality(second.result) >= readingQuality(first.result) + OSD_MIN_QUALITY_GAIN) {
    return finish(second, switchTo === null ? detection.orientation : { ...detection.orientation, languageFromScript: switchTo });
  }
  return finish(first, { ...detection.orientation, status: 'not-better', rotationApplied: 0 });
}

interface LanguageData {
  dir: string;
  gzip: boolean;
}

/** How well a page was read, 0..1: the mean raw word score weighted by characters; 0 when no word was read. */
function readingQuality(result: OcrResult): number {
  return characterWeightedConfidence(result.lineBlocks ?? []) ?? 0;
}

/** Whether a first reading is poor enough that the page may be turned or in another script. */
function looksMisread(result: OcrResult): boolean {
  return readingQuality(result) < OSD_SUSPECT_QUALITY;
}

/** Detection demanded for every page needs its data now, not after the first page was read. */
function assertOrientationDetectable(): void {
  if (!locateLanguageData(OSD_LANGUAGE)) {
    throw new OcrEngineUnavailableError(
      `Orientation detection needs the '${OSD_LANGUAGE}' OCR data (${OSD_LANGUAGE}.traineddata), which is not available locally.`
    );
  }
}

interface RecognitionAttempt {
  imageBuffer: Buffer;
  steps: OcrPreprocessSteps;
  /** Clockwise turn given to the page before it is prepared. */
  quarterTurn: OcrQuarterTurn;
  tesseractLang: string;
  languageData: LanguageData;
  enginePath?: OcrEnginePath;
  /** The language as the request named it, for messages. */
  language: string;
  parallelBands?: boolean;
}

/**
 * Reads the page prepared with rescaling and levelling only, and looks for a better preparation only when that
 * reading calls for it: the page is unevenly lit (one threshold cannot separate its ink from its paper
 * everywhere, and the recognizer reads confident words from the lit part and nothing from the rest) or the
 * reading is poor. The alternatives are the page as submitted (enlarging blurred, noisy text can cost more than
 * it gains) and the page binarized (a hard threshold can destroy small or blurred strokes). An alternative is
 * kept only when it recognizes at least as much confident text as the reading so far, so a good page is never
 * read twice and a page that an alternative would only damage keeps its first reading.
 */
async function recognizeAttempt(attempt: RecognitionAttempt): Promise<RecognizedPage> {
  const { steps } = attempt;
  const plain = await readPreparedPage(attempt, { ...steps, binarize: false });
  const needed =
    plain.prepared.unevenBackground >= OCR_UNEVEN_BACKGROUND_RATIO || readingQuality(plain.page.result) < OCR_ALTERNATIVE_TRIGGER_QUALITY;
  if (!needed) return plain.page;
  const alternatives: OcrPreprocessSteps[] = [];
  if (plain.prepared.applied.rescale) alternatives.push({ ...steps, rescale: false, binarize: false });
  if (steps.binarize && plain.prepared.binarizable) alternatives.push(steps);
  let best = plain;
  let bestEvidence = readingEvidence(plain.page.result);
  for (const alternative of alternatives) {
    const candidate = await readPreparedPage(attempt, alternative);
    const evidence = readingEvidence(candidate.page.result);
    if (evidence >= bestEvidence * OCR_ALTERNATIVE_MIN_EVIDENCE_GAIN) {
      best = candidate;
      bestEvidence = evidence;
    }
  }
  return best.page;
}

/** How much of a page was read, and how well: confident characters recognized (see confidenceWeightedCharacters). */
function readingEvidence(result: OcrResult): number {
  return confidenceWeightedCharacters(result.lineBlocks ?? []);
}

/** Prepares the page (turned by `quarterTurn`) with `steps` and reads it with the WebAssembly engine, then the native tool. */
async function readPreparedPage(
  attempt: RecognitionAttempt,
  steps: OcrPreprocessSteps
): Promise<{ page: RecognizedPage; prepared: OcrPreprocessResult }> {
  const { imageBuffer, quarterTurn, tesseractLang, enginePath, language } = attempt;
  const localLangPath = attempt.languageData.dir;
  const isGzip = attempt.languageData.gzip;

  // Decode with sharp and hand the pixels over as an uncompressed Netpbm image: the OCR reader
  // opens fewer formats (no AVIF, HEIF, SVG or many TIFF variants) than the decoder, and a PNG
  // would be compressed here only to be decompressed again. EXIF orientation is applied first, so
  // text is recognized as displayed, and the page is prepared for recognition (see
  // ocr-preprocess.ts), which both engines below then read.
  let prepared: OcrPreprocessResult;
  try {
    prepared = await preprocessOcrImage(imageBuffer, steps, quarterTurn);
  } catch (err) {
    rethrowInputPixelLimit(err);
    if (err instanceof OcrPreprocessError || err instanceof OcrEngineUnavailableError) throw err;
    throw new ConversionFailedError('Invalid image: the OCR input could not be decoded.');
  }
  const ocrInput = prepared.image;
  // Segmentation follows the page as submitted: an enlarged label is still a label. Its text rows
  // are counted on the prepared image, which scaling and binarization leave in the same number.
  const inputHeight = orientedSize(prepared.geometry)[1];
  const inputTextRows = prepared.textRows;

  // 2. Try High-Performance WebAssembly Inference Engine (Tesseract.js)
  let fallback: OcrEngineFallback | undefined;
  let bandsRead = 1;
  if (enginePath !== 'cli') {
    try {
      const { pageSegMode, engineMode } = ocrSegmentationFor(tesseractLang);
      const spec: OcrWorkerSpec = {
        langs: tesseractLang,
        langPath: localLangPath,
        gzip: isGzip,
        engineMode,
        parameters: { tessedit_pageseg_mode: pageSegMode },
      };
      const pool = getSharedOcrWorkerPool();
      const imageMode = ocrSegmentationFor(tesseractLang, inputHeight, inputTextRows).pageSegMode;
      // A page of plain text lines is read in bands by as many idle workers as there are, instead of by one.
      const bands =
        attempt.parallelBands === false ||
        !ocrBandsAllowedFor(tesseractLang) ||
        imageMode !== OCR_PSM_AUTO ||
        pageSegMode !== OCR_PSM_AUTO
          ? null
          : planPageBands(pool, spec, prepared);
      const banded = bands ? await recognizeInBands(pool, spec, ocrInput, bands) : null;
      if (banded) bandsRead = bands?.length ?? 1;
      const ret = banded ?? await pool.run(
        spec,
        async (recognize, recognizeWith) => {
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
        const result = trimOverreachingWords(mapOcrResultToSource(
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
        ));
        return { page: withPreparation({ result, enginePath: 'wasm' }, prepared, localLangPath, bandsRead), prepared };
      }
    } catch (err: unknown) {
      if (err instanceof OcrEngineUnavailableError || err instanceof OcrLanguageUnavailableError) {
        throw err;
      }
      // Only a failure of the WebAssembly runtime itself is answered by the native tool, and the answer is recorded.
      const reason = recoverableWasmFailure(err);
      if (reason === null) {
        throw new OcrEngineUnavailableError(`The OCR WebAssembly engine failed: ${describeEngineError(err)}.`);
      }
      fallback = { from: 'wasm', to: 'cli', reason };
    }
  }

  // 3. Try System Native Tesseract CLI if available
  const tesseractCli = findTesseractCli();
  if (tesseractCli) {
    const result = trimOverreachingWords(
      mapOcrResultToSource(
        await recognizeWithCli({
          cliPath: tesseractCli,
          tessdataDir: localLangPath,
          tesseractLang,
          image: ocrInput,
          imageHeight: inputHeight,
          textRows: inputTextRows,
        }),
        prepared.geometry
      )
    );
    const page = withPreparation({ result, enginePath: 'cli' }, prepared, localLangPath, 1);
    return { page: fallback ? { ...page, result: { ...page.result, engineFallback: fallback } } : page, prepared };
  }

  throw new OcrEngineUnavailableError(
    `OCR engine (Tesseract) is unavailable or failed to execute for language '${language}'.`
  );
}

function withPreparation(
  page: RecognizedPage,
  prepared: OcrPreprocessResult,
  languageDataDirectory: string,
  bands: number
): RecognizedPage {
  return {
    ...page,
    result: { ...page.result, languageDataDirectory },
    preparation: { binarized: prepared.applied.binarize, unevenBackground: prepared.unevenBackground, bands },
  };
}

/**
 * The bands a prepared page is cut into for the workers that are idle now, or null to read it whole. A page that
 * would be cut but finds fewer than two idle workers is read whole and starts the missing workers for the pages
 * after it.
 */
function planPageBands(pool: OcrWorkerPool, spec: OcrWorkerSpec, prepared: OcrPreprocessResult): OcrBand[] | null {
  if (!prepared.ink) return null;
  const { profile, lineHeightPx } = prepared.ink;
  const wanted = Math.min(OCR_BAND_MAX_BANDS, os.availableParallelism(), OCR_POOL_MAX_WORKERS_PER_KEY);
  if (planBands(profile, lineHeightPx, wanted) === null) return null;
  const idle = pool.idleWorkers(spec);
  if (idle < 2) {
    pool.warm(spec, wanted);
    return null;
  }
  return planBands(profile, lineHeightPx, Math.min(idle, wanted));
}

/**
 * Reads the bands of a page side by side, one worker each, and returns the reading of the page. Null when the bands
 * hold no word: the page is then read whole, with the single-block retry that a page without text gets.
 */
async function recognizeInBands(
  pool: OcrWorkerPool,
  spec: OcrWorkerSpec,
  page: Buffer,
  bands: readonly OcrBand[]
): Promise<{ data: BandReading } | null> {
  const readings = await Promise.all(
    bands.map((band) =>
      pool.run(spec, async (recognize) => {
        const read = await recognize(sliceNetpbmRows(page, band.top, band.bottom), {}, { blocks: true });
        return { text: read.data.text ?? '', blocks: read.data.blocks };
      })
    )
  );
  const merged = mergeBandReadings(bands, readings);
  return countWords(merged.text) > 0 ? { data: merged } : null;
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
  const page = await uprightImage(scannedImageBuffer);
  // A PNG page goes into the PDF as its own compressed rows (and a bitonal one as CCITT G4) instead of being decoded
  // and compressed again; a page the plan cannot cover is decoded as before.
  const imagePlan = hasPngSignature(page) ? planPngPassthrough(page) : null;
  return createLosslessSandwichPdfFromImage(page, ocrResult, options, title, imagePlan);
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
    // Nothing was analysed, so the page size and the confidence are unknown, not assumed.
    return {
      text: fallbackText,
      confidence: fallbackConfidence,
      wordCount: fallbackText ? fallbackText.split(/\s+/).filter(Boolean).length : 0,
      lines,
      lineBlocks: [],
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
        source: ocr.source ?? 'ocr',
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
      // A page that kept its digital text was not recognized, so it has no recognition confidence.
      combinedPages.push({
        pageNumber: pa.pageNumber,
        width: pa.width,
        height: pa.height,
        text: pa.text,
        confidence: null,
        source: 'text-layer',
        lineBlocks: [],
        lines,
      });
      allTexts.push(pa.text);
      allLines.push(...lines);
      totalWordCount += pa.wordCount;
    }
  }

  return {
    text: allTexts.join('\n\n').trim(),
    confidence: confCount > 0 ? totalConfidence / confCount : null,
    wordCount: totalWordCount,
    lines: allLines,
    lineBlocks: combinedPages.flatMap((p) => p.lineBlocks),
    imageWidth: pageAnalyses[0]?.width,
    imageHeight: pageAnalyses[0]?.height,
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

  const pageOcrResults =
    pagesNeedingOcr.length > 0
      ? await recognizeRenderedPdfPages(pdfBuffer, new Set(pagesNeedingOcr), {
          dpi: options.dpi,
          language: options.ocrLanguage,
          detectOrientation: options.ocrDetectOrientation,
        })
      : new Map<number, OcrResult>();

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

