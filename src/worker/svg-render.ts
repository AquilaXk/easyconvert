import { stageTimeoutMs } from '../lib/conversions/job-time';
import { launchSandboxedBinary } from '../lib/security/sandbox-launcher';
import { ConversionFailedError } from '../lib/types';
import { SandboxedBufferLimitError, SandboxedMemoryLimitError, SandboxedProcessError } from './sandbox';
import { createConversionResult, writeOutputSegments } from './worker-output';
import type { WorkerConversionResult, WorkerEngineOptions, WorkerVfsPayload } from './worker-types';

/**
 * An SVG drawing written as a vector PDF by librsvg's `rsvg-convert` (an unmodified separate program, LGPL): paths stay
 * paths and text stays text, instead of a raster picture inside a PDF page.
 *
 * The drawing goes to the renderer on its standard input and the PDF comes back on its standard output, so there is no job
 * directory, input file or copy. The renderer has no file to take a base location from, so nothing the drawing names is
 * looked for beside it. The program is started through the launcher helper when that pays (sandbox-launcher.ts): the
 * start of a program from a worker of a few hundred megabytes costs more than the renderer's own 2.4 ms.
 */

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 300_000;
const MEMORY_LIMIT_MB = 2048;
const MAX_OUTPUT_BYTES = 512 * 1024 * 1024;
const MAX_STDERR_CHARS = 300;
/** What a PDF holds beyond the drawing it was written from: the subsets of the fonts a text drawing embeds. */
const FONT_ALLOWANCE_BYTES = 64 * 1024;

export interface SvgPdfJob {
  /** The drawing, sanitised and normalised for rendering. */
  svg: string;
  /** The configured `rsvg-convert`. */
  renderer: string;
  input: Buffer | WorkerVfsPayload;
  options: WorkerEngineOptions;
  originalFilename: string;
}

/** Writes the drawing as a PDF with the renderer in the sandbox, without network. */
export async function renderSvgAsPdf(job: SvgPdfJob): Promise<WorkerConversionResult> {
  const { svg, renderer, input, options, originalFilename } = job;
  const baseName = originalFilename ? originalFilename.replace(/\.[^/.]+$/, '') : 'converted';
  const startTime = Date.now();
  let rendered: Buffer;
  try {
    ({ stdout: rendered } = await launchSandboxedBinary(renderer, ['--format', 'pdf'], {
      timeoutMs: Math.min(stageTimeoutMs(options, DEFAULT_TIMEOUT_MS), MAX_TIMEOUT_MS),
      maxBuffer: Math.min(options.maxBufferBytes || MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES),
      memoryLimitMb: MEMORY_LIMIT_MB,
      networkIsolated: true,
      signal: options.signal,
      stdin: Buffer.from(svg, 'utf-8'),
      expectedOutputBytes: svg.length + FONT_ALLOWANCE_BYTES,
    }));
  } catch (err) {
    if (err instanceof SandboxedBufferLimitError || err instanceof SandboxedMemoryLimitError) {
      throw new ConversionFailedError('The SVG renderer exceeded its output or memory limit on the drawing.');
    }
    if (err instanceof SandboxedProcessError) {
      const detail = err.stderr.trim().slice(0, MAX_STDERR_CHARS);
      throw new ConversionFailedError(`The SVG renderer rejected the drawing${detail ? `: ${detail}` : ''}`);
    }
    throw err;
  }
  if (rendered.length === 0) {
    throw new ConversionFailedError('The SVG renderer wrote no page from the drawing.');
  }
  const persistedPath = writeOutputSegments([rendered], 'pdf', options, Buffer.isBuffer(input) ? undefined : input);
  return createConversionResult(persistedPath, 'pdf', baseName, 'native-svg', Date.now() - startTime);
}
