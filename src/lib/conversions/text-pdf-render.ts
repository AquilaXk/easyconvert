import { EngineUnavailableError, FontCoverageError } from '../types';
import { CPU_POOL_MIN_BYTES, runCpuTask } from '../workers/cpu-pool';
import { reportConversionWarning, withConversionWarnings } from './conversion-warnings';
import { renderPdfBlocks, type PdfBlock } from './pdf-blocks';

/**
 * Plain text drawn as a PDF: preformatted blocks, one page run for each form feed. The layout of the lines is one synchronous pass
 * over the whole text (about a second for each megabyte), so a text of `CPU_POOL_MIN_BYTES` or more is drawn on a thread of the
 * CPU pool and leaves the event loop of the worker free for the heartbeat of its job. What the drawing reports on the way
 * (the characters it replaced, the missing font it refuses with) crosses the thread boundary as data and reaches the caller as it
 * would have on its own thread.
 */

const FORM_FEED = '\f';
export const PLAIN_TEXT_PDF_TASK = 'plainTextPdf';

/** What the pool thread needs to draw the PDF: structured data only. */
export interface PlainTextPdfPayload {
  text: string;
  orientation?: 'portrait' | 'landscape';
  title: string;
}

/** What the thread answers: the PDF with the warnings of the drawing, or the refusal the drawing ended with. */
export type PlainTextPdfOutcome =
  | { pdf: Uint8Array; warnings: string[] }
  | { unavailable: { engineName: string; reason: string } }
  | { uncovered: { message: string; codePoint: number } };

/** Plain text as preformatted blocks; a form feed starts a new page. */
export function plainTextToPdfBlocks(text: string): PdfBlock[] {
  const blocks: PdfBlock[] = [];
  text
    .replace(/^﻿/, '')
    .split(FORM_FEED)
    .forEach((page, index) => {
      if (index > 0) blocks.push({ kind: 'pageBreak' });
      blocks.push({ kind: 'preformatted', text: page });
    });
  return blocks;
}

/** The PDF of the text, drawn on the calling thread. */
export function renderPlainTextPdfInline(payload: PlainTextPdfPayload): Promise<Buffer> {
  return renderPdfBlocks(plainTextToPdfBlocks(payload.text), { orientation: payload.orientation, title: payload.title });
}

/** The drawing as a pool thread runs it: the refusals of the fonts become data, the warnings are collected in the thread's own scope. */
export async function drawPlainTextPdfOnThread(payload: PlainTextPdfPayload): Promise<PlainTextPdfOutcome> {
  try {
    const drawn = await withConversionWarnings(async () => ({ pdf: await renderPlainTextPdfInline(payload), metadata: undefined as { warnings?: string[] } | undefined }));
    return { pdf: drawn.pdf, warnings: drawn.metadata?.warnings ?? [] };
  } catch (err) {
    if (err instanceof EngineUnavailableError) return { unavailable: { engineName: err.engineName, reason: err.reason } };
    if (err instanceof FontCoverageError) return { uncovered: { message: err.message, codePoint: err.codePoint } };
    throw err;
  }
}

/** The PDF of the text: drawn on a pool thread when the text is large, else on the calling thread. */
export async function renderPlainTextPdf(payload: PlainTextPdfPayload, signal?: AbortSignal): Promise<Buffer> {
  if (payload.text.length < CPU_POOL_MIN_BYTES) return renderPlainTextPdfInline(payload);
  const outcome = await runCpuTask<PlainTextPdfOutcome>(PLAIN_TEXT_PDF_TASK, payload, { signal });
  if ('unavailable' in outcome) throw new EngineUnavailableError(outcome.unavailable.engineName, outcome.unavailable.reason);
  if ('uncovered' in outcome) throw new FontCoverageError(outcome.uncovered.message, outcome.uncovered.codePoint);
  for (const line of outcome.warnings) reportConversionWarning(line);
  return Buffer.from(outcome.pdf.buffer, outcome.pdf.byteOffset, outcome.pdf.byteLength);
}
