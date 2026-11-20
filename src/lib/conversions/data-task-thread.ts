import type { HandlerResult } from '../workers/cpu-tasks';
import { transferableBytes } from '../workers/cpu-tasks';
import { withConversionWarnings } from './conversion-warnings';
import { convertDataInline, writeTransientWorkbookInline } from './data';
import { failureOf, type DataTaskOutcome, type DataTaskPayload } from './data-task';
import { writeSheetInline, type SheetTarget } from './office/sheet-write';

/**
 * The thread side of `convertOnDataThread` (data-task.ts), loaded by the pool thread when its first data task arrives: it runs the
 * conversion on the thread's own heap with a warning scope of its own and answers with the output, the warnings and, for a typed
 * refusal, the failure as data. An error that is no refusal (a broken invariant) is thrown, and the pool answers it as a server fault.
 */
export async function runDataTask(raw: unknown): Promise<HandlerResult> {
  const payload = raw as DataTaskPayload;
  const input = Buffer.from(payload.input.buffer, payload.input.byteOffset, payload.input.byteLength);
  try {
    const converted = await withConversionWarnings(async () => {
      if (payload.task === 'workbook') {
        const { sourceFormat, targetFormat, options } = payload;
        const workbook = targetFormat === 'xls'
          ? await writeTransientWorkbookInline(input, sourceFormat, options)
          : await writeSheetInline(input, sourceFormat, targetFormat as SheetTarget, options, payload.originalFilename);
        return { buffer: workbook, mimeType: 'application/octet-stream', filename: '', metadata: undefined as { warnings?: string[] } | undefined };
      }
      const result = await convertDataInline(input, payload.sourceFormat, payload.targetFormat, payload.options, payload.originalFilename);
      return { buffer: result.buffer, mimeType: result.mimeType, filename: result.filename, metadata: result.metadata as { warnings?: string[] } | undefined };
    });
    const bytes = transferableBytes(converted.buffer);
    const outcome: DataTaskOutcome = {
      ok: { buffer: bytes.result as Uint8Array, mimeType: converted.mimeType, filename: converted.filename, warnings: converted.metadata?.warnings ?? [] },
    };
    return { result: outcome, transfer: bytes.transfer };
  } catch (error) {
    const failure = failureOf(error);
    if (failure === null) throw error;
    const outcome: DataTaskOutcome = { failure };
    return { result: outcome };
  }
}
