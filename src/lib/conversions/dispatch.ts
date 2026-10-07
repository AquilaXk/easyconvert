import fs from 'node:fs';
import { FORMAT_REGISTRY } from '../registry';
import {
  ComplexScriptRequiresNativeEngineError,
  EngineUnavailableError,
  OcrEngineUnavailableError,
  OcrLanguageUnavailableError,
  RawEngineRequiredError,
  UnsupportedTargetError,
} from '../types';
import { applyPdfPostProcessing, assertPdfPostProcessOptions, verifyPdfA } from './index';
import { directPdfAExportConformance, pdfaMetadata, resolvePdfAConformance } from './pdf-export-options';
import { assertConversionOptionsObject } from './options-guard';
import {
  executeWorkerConversion,
  type WorkerConversionResult,
  type WorkerEngineOptions,
  type WorkerVfsPayload,
} from '../../worker/engines';

/**
 * Pairs that only a native engine converts: the in-process engine has no code path for them.
 * LibreOffice converts between Office formats and, chained with Poppler, renders Office
 * documents to raster images; Poppler renders PDF to SVG. When the native engine is missing,
 * these pairs fail with EngineUnavailableError instead of falling back to the in-process engine.
 */
const NATIVE_ENGINE_ONLY_PAIRS: ReadonlySet<string> = new Set([
  'doc->jpg', 'doc->png', 'doc->rtf',
  'eps->avif', 'eps->bmp', 'eps->dxf', 'eps->eps', 'eps->gif', 'eps->jpg', 'eps->pdf', 'eps->png', 'eps->ps', 'eps->svg', 'eps->tiff', 'eps->webp',
  'docx->doc', 'docx->jpg', 'docx->png', 'docx->rtf',
  'key->html', 'key->pdf', 'key->pptx',
  'odd->avif', 'odd->bmp', 'odd->eps', 'odd->gif', 'odd->ico', 'odd->jpg', 'odd->odd', 'odd->pdf', 'odd->png', 'odd->ps', 'odd->psd', 'odd->tiff', 'odd->webp',
  'odg->bmp', 'odg->jpg', 'odg->pdf', 'odg->png',
  'odp->jpg', 'odp->png', 'odp->ppt',
  'ods->jpg', 'ods->png',
  'odt->doc', 'odt->jpg', 'odt->png', 'odt->rtf',
  'pdf->svg',
  'ps->avif', 'ps->bmp', 'ps->dxf', 'ps->eps', 'ps->gif', 'ps->jpg', 'ps->pdf', 'ps->png', 'ps->ps', 'ps->svg', 'ps->tiff', 'ps->webp',
  'ppt->jpg', 'ppt->odp', 'ppt->png',
  'pptx->jpg', 'pptx->png', 'pptx->ppt',
  'rtf->doc', 'rtf->jpg', 'rtf->png',
  'xls->jpg', 'xls->png',
  'xlsx->jpg', 'xlsx->png',
]);

const PDF_FORMAT = 'pdf';
const IN_PROCESS_ENGINE: WorkerConversionResult['engineUsed'] = 'internal-fallback';

function normalizeFormat(format: string): string {
  return format.toLowerCase().replace(/^\./, '').trim();
}

/** Whether a pair can only be converted by a native engine. */
export function requiresNativeEngine(sourceFormat: string, targetFormat: string): boolean {
  return NATIVE_ENGINE_ONLY_PAIRS.has(`${normalizeFormat(sourceFormat)}->${normalizeFormat(targetFormat)}`);
}

/**
 * Targets the registry does not list for a video source but the native media engine produces when
 * the request carries the task option that selects them: thumbnails (`thumbnail`), streaming
 * packaging (`packaging`) and subtitle extraction (`subtitles.mode === 'extract'`).
 */
const THUMBNAIL_TARGETS: ReadonlySet<string> = new Set(['jpg', 'jpeg', 'png']);
const PACKAGING_TARGETS: ReadonlySet<string> = new Set(['hls', 'dash']);
const SUBTITLE_EXTRACT_TARGETS: ReadonlySet<string> = new Set(['srt', 'vtt', 'ass']);
const VIDEO_CATEGORY = 'video';

/** Whether the request selects an option-driven media target the registry does not list. */
function isTaskDrivenMediaTarget(src: string, tgt: string, options: WorkerEngineOptions): boolean {
  if (FORMAT_REGISTRY[src]?.category !== VIDEO_CATEGORY) return false;
  if (THUMBNAIL_TARGETS.has(tgt)) return Boolean(options.thumbnail);
  if (PACKAGING_TARGETS.has(tgt)) return Boolean(options.packaging);
  if (SUBTITLE_EXTRACT_TARGETS.has(tgt)) return options.subtitles?.mode === 'extract';
  return false;
}

function assertAdvertised(src: string, tgt: string, options: WorkerEngineOptions): void {
  const def = FORMAT_REGISTRY[src];
  if (def?.targetFormats.includes(tgt) || isTaskDrivenMediaTarget(src, tgt, options)) return;
  throw new UnsupportedTargetError(`Unsupported conversion from .${src} to .${tgt}: the pair is not offered`);
}

/**
 * Engine-missing conditions that engines raise as other typed errors surface as
 * EngineUnavailableError (HTTP 503): complex-script rendering needs LibreOffice, OCR needs
 * Tesseract, camera RAW sensor decoding needs LibRaw (`dcraw_emu`). A missing OCR language stays a client error.
 */
function toEngineUnavailable(err: unknown): unknown {
  if (err instanceof ComplexScriptRequiresNativeEngineError) {
    return new EngineUnavailableError('soffice', err.message);
  }
  if (err instanceof RawEngineRequiredError) {
    return new EngineUnavailableError('dcraw_emu', err.message);
  }
  if (err instanceof OcrEngineUnavailableError && !(err instanceof OcrLanguageUnavailableError)) {
    return new EngineUnavailableError('tesseract', err.message);
  }
  return err;
}

/** Reads a native engine's temporary output into memory and deletes the file. */
function materialize(result: WorkerConversionResult): WorkerConversionResult {
  const filePath = result.filePath;
  if (!filePath) return result;
  const buffer = result.buffer;
  fs.rmSync(filePath, { force: true });
  return { ...result, buffer, size: buffer.length, filePath: undefined };
}

/** Engines that are LibreOffice: their PDF export can write PDF/A in the same pass. */
const SOFFICE_ENGINES: ReadonlySet<string> = new Set(['native-soffice', 'native-soffice-pool']);

/**
 * Applies watermark, PDF/A and protection to PDF output a native engine produced. The in-process
 * engine already applies them inside convertFile, so its output is never processed twice.
 *
 * An Office export LibreOffice already wrote as PDF/A skips the Draw round trip, which re-encodes
 * images and drops the outline and links; its identification and validation are checked instead.
 */
async function postProcessNativePdf(
  result: WorkerConversionResult,
  tgt: string,
  options: WorkerEngineOptions
): Promise<WorkerConversionResult> {
  if (tgt !== PDF_FORMAT || result.engineUsed === IN_PROCESS_ENGINE) return result;
  const exportedAs = SOFFICE_ENGINES.has(result.engineUsed) ? directPdfAExportConformance(options) : null;
  const needsPostProcessing = Boolean(options.watermark || resolvePdfAConformance(options) || options.protect);
  if (!needsPostProcessing && !exportedAs) return result;
  const processed: WorkerConversionResult = { ...result, buffer: result.buffer };
  await applyPdfPostProcessing(processed, options, { pdfaExported: exportedAs !== null });
  if (exportedAs) {
    const verdict = await verifyPdfA(processed.buffer, exportedAs);
    processed.metadata = { ...processed.metadata, ...pdfaMetadata(verdict.pdfaValidated, verdict.conformanceLevel) };
  }
  if (processed.filePath) {
    fs.writeFileSync(processed.filePath, processed.buffer);
  }
  return processed;
}

/**
 * Single conversion dispatcher for every entry point (sync and batch APIs, graph executor,
 * queue workers).
 *
 * Tries the native engine route when the pair has one and the engine is installed, otherwise
 * the in-process engine. A pair only a native engine converts never falls back: a missing
 * engine raises EngineUnavailableError. A pair the registry does not offer is rejected first.
 *
 * Buffer input with no requested output path returns the result in memory, so no temporary
 * engine output stays on disk.
 */
export async function dispatchConversion(
  input: Buffer | WorkerVfsPayload,
  sourceFormat: string,
  targetFormat: string,
  options: WorkerEngineOptions = {},
  originalFilename = 'file'
): Promise<WorkerConversionResult> {
  assertConversionOptionsObject(options);
  const src = normalizeFormat(sourceFormat);
  const tgt = normalizeFormat(targetFormat);
  assertAdvertised(src, tgt, options);
  if (tgt === PDF_FORMAT) {
    assertPdfPostProcessOptions(options);
  }

  const workerOptions: WorkerEngineOptions = requiresNativeEngine(src, tgt)
    ? { ...options, inProcessFallback: false }
    : options;
  let converted: WorkerConversionResult;
  try {
    converted = await executeWorkerConversion(input, src, tgt, workerOptions, originalFilename);
  } catch (err) {
    throw toEngineUnavailable(err);
  }
  const result = await postProcessNativePdf(converted, tgt, options);

  const keepOnDisk = !Buffer.isBuffer(input) || Boolean(options.zeroHeap) || Boolean((options as { outputPath?: string }).outputPath);
  return keepOnDisk ? result : materialize(result);
}
