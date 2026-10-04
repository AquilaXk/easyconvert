import fs from 'node:fs';
import { FORMAT_REGISTRY } from '../registry';
import { UnsupportedTargetError } from '../types';
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
  'docx->doc', 'docx->jpg', 'docx->png', 'docx->rtf',
  'odp->jpg', 'odp->png', 'odp->ppt',
  'ods->jpg', 'ods->png',
  'odt->doc', 'odt->jpg', 'odt->png', 'odt->rtf',
  'pdf->svg',
  'ppt->jpg', 'ppt->odp', 'ppt->png',
  'pptx->jpg', 'pptx->png', 'pptx->ppt',
  'rtf->doc', 'rtf->jpg', 'rtf->png',
  'xls->jpg', 'xls->png',
  'xlsx->jpg', 'xlsx->png',
]);

function normalizeFormat(format: string): string {
  return format.toLowerCase().replace(/^\./, '').trim();
}

/** Whether a pair can only be converted by a native engine. */
export function requiresNativeEngine(sourceFormat: string, targetFormat: string): boolean {
  return NATIVE_ENGINE_ONLY_PAIRS.has(`${normalizeFormat(sourceFormat)}->${normalizeFormat(targetFormat)}`);
}

function assertAdvertised(src: string, tgt: string): void {
  const def = FORMAT_REGISTRY[src];
  if (!def?.targetFormats.includes(tgt)) {
    throw new UnsupportedTargetError(`Unsupported conversion from .${src} to .${tgt}: the pair is not offered`);
  }
}

/** Reads a native engine's temporary output into memory and deletes the file. */
function materialize(result: WorkerConversionResult): WorkerConversionResult {
  const filePath = result.filePath;
  if (!filePath) return result;
  const buffer = result.buffer;
  fs.rmSync(filePath, { force: true });
  return { ...result, buffer, size: buffer.length, filePath: undefined };
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
  const src = normalizeFormat(sourceFormat);
  const tgt = normalizeFormat(targetFormat);
  assertAdvertised(src, tgt);

  const workerOptions: WorkerEngineOptions = requiresNativeEngine(src, tgt)
    ? { ...options, inProcessFallback: false }
    : options;
  const result = await executeWorkerConversion(input, src, tgt, workerOptions, originalFilename);

  const keepOnDisk = !Buffer.isBuffer(input) || Boolean(options.zeroHeap) || Boolean((options as { outputPath?: string }).outputPath);
  return keepOnDisk ? result : materialize(result);
}
