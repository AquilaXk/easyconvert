import {
  executeSandboxedBinary,
  rethrowSandboxUnavailable,
  SandboxedBufferLimitError,
  SandboxedMemoryLimitError,
  SandboxedProcessError,
  SandboxedTimeoutError,
} from '../security/process-sandbox';
import { ConversionFailedError, PayloadLimitError } from '../types';
import { decoderUnavailable, findDecoderTool } from './image-decoder-tools';
import { MAX_SVG_INPUT_CHARS } from './svg-xml';

/**
 * The text of an SVG drawn as outlines, for the metafile writers, which carry geometry and no text records (EMF and WMF). librsvg's
 * `rsvg-convert` (an unmodified separate program, LGPL, the one that writes the PDF of an SVG) draws the drawing to cairo's SVG surface, which
 * writes every glyph as a path of the font that drew it: the same fonts and the same layout as the PDF, PNG and page of the drawing, so the metafile
 * shows the words where the other targets do. A drawing with no text is never sent through it.
 */

/** Environment variable that names the executable; a value is authoritative, so a path that is not an executable file means "not installed". */
export const RSVG_CONVERT_PATH_ENV = 'RSVG_CONVERT_PATH';
const RSVG_EXECUTABLE_NAMES = ['rsvg-convert'] as const;
const TEXT_ELEMENT = /<(?:[A-Za-z_][\w.-]*:)?text[\s/>]/;
const RSVG_TIMEOUT_MS = 60_000;
const RSVG_MEMORY_LIMIT_MB = 2048;
/** The outlines of a text drawing are larger than the text; the drawing the writers read may not pass the SVG limit they apply. */
const RSVG_MAX_OUTPUT_BYTES = MAX_SVG_INPUT_CHARS;

/** The first `rsvg-convert` of the configured path or of the standard directories, or null. */
export function findRsvgConvert(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  return findDecoderTool(RSVG_CONVERT_PATH_ENV, RSVG_EXECUTABLE_NAMES, env);
}

/** Whether the drawing holds a `<text>` element, under any namespace prefix. */
export function hasSvgText(svg: string): boolean {
  return TEXT_ELEMENT.test(svg);
}

function describeFailure(err: unknown): Error {
  rethrowSandboxUnavailable(err);
  if (err instanceof SandboxedTimeoutError) return new ConversionFailedError('The text of the SVG could not be drawn as outlines (the renderer did not finish in time).');
  if (err instanceof SandboxedMemoryLimitError || err instanceof SandboxedBufferLimitError) {
    return new PayloadLimitError('The text of the SVG needs more memory or output than drawing it as outlines allows.');
  }
  if (err instanceof SandboxedProcessError) return new ConversionFailedError('The text of the SVG could not be drawn as outlines (the renderer refused the drawing).');
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * The drawing with its text as outlines, the rest of it drawn as paths by the same program (so the caller offers it a drawing that has text:
 * `hasSvgText`). Without `rsvg-convert` this is an unavailable engine: another worker has it.
 */
export async function outlineSvgText(svg: Buffer, signal?: AbortSignal): Promise<Buffer> {
  const renderer = findRsvgConvert();
  if (renderer === null) throw decoderUnavailable('rsvg-convert', 'librsvg2-bin');
  try {
    const { stdout } = await executeSandboxedBinary(renderer, ['--format', 'svg'], {
      timeoutMs: RSVG_TIMEOUT_MS,
      maxBuffer: RSVG_MAX_OUTPUT_BYTES,
      memoryLimitMb: RSVG_MEMORY_LIMIT_MB,
      networkIsolated: true,
      signal,
      stdin: svg,
      // A filter on standard input and output: it touches no file.
      workDir: null,
    });
    return stdout;
  } catch (err) {
    throw describeFailure(err);
  }
}
