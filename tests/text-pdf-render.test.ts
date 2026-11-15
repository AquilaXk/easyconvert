import { afterAll, describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { withConversionWarnings } from '../src/lib/conversions/conversion-warnings';
import { renderPlainTextPdf, renderPlainTextPdfInline } from '../src/lib/conversions/text-pdf-render';
import { CPU_POOL_MIN_BYTES, shutdownCpuPool } from '../src/lib/workers/cpu-pool';
import { CpuTaskAbortedError } from '../src/lib/types';

/**
 * A plain text of CPU_POOL_MIN_BYTES or more is drawn as a PDF on a thread of the CPU pool (tests/event-loop-budget.test.ts shows
 * the loop stays free). What the drawing reports crosses the thread boundary: the characters it replaced reach the warnings of the
 * conversion that asked, and the pages are those of the same text drawn on the calling thread.
 */

const PRIVATE_USE_CHARACTER = '';
const REPLACEMENT_WARNING = /Replaced U\+E000 with U\+FFFD/;

afterAll(shutdownCpuPool);

const lineOfText = 'a line of plain text that fills the width of the page, with some more words after it\n';
const longText = (extra: string): string => lineOfText.repeat(Math.ceil(CPU_POOL_MIN_BYTES / lineOfText.length) + 1) + extra + '\n';
const pagesOf = async (pdf: Buffer): Promise<number> => (await PDFDocument.load(pdf)).getPageCount();

async function drawn(text: string, inline: boolean): Promise<{ pdf: Buffer; warnings: string[] }> {
  const payload = { text, title: 'sample' };
  const result = await withConversionWarnings(async () => ({
    pdf: inline ? await renderPlainTextPdfInline(payload) : await renderPlainTextPdf(payload),
    metadata: undefined as { warnings?: string[] } | undefined,
  }));
  return { pdf: result.pdf, warnings: result.metadata?.warnings ?? [] };
}

describe('plain text drawn as a PDF on a pool thread', () => {
  it('has the pages and the warnings of the same text drawn on the calling thread', async () => {
    const text = longText(`replaced ${PRIVATE_USE_CHARACTER} here`);
    expect(text.length).toBeGreaterThanOrEqual(CPU_POOL_MIN_BYTES);
    const onThread = await drawn(text, false);
    const inline = await drawn(text, true);
    expect(onThread.pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(await pagesOf(onThread.pdf)).toBe(await pagesOf(inline.pdf));
    expect(inline.warnings.some((line) => REPLACEMENT_WARNING.test(line))).toBe(true);
    expect(onThread.warnings).toEqual(inline.warnings);
  });

  it('draws a short text on the calling thread and starts a new page at a form feed', async () => {
    const short = await drawn(`first page\fsecond page\n`, false);
    expect(await pagesOf(short.pdf)).toBe(2);
  });

  it('stops at an abort signal', async () => {
    const controller = new AbortController();
    const pending = renderPlainTextPdf({ text: longText('end'), title: 'sample' }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: new CpuTaskAbortedError('plainTextPdf').name, message: 'The plainTextPdf task was cancelled' });
  });
});
