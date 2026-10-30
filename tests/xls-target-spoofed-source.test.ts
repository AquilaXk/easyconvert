import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeWorkerConversion, getLibreOfficePool } from '../src/worker/engines';
import { FileExtensionSpoofError } from '../src/lib/registry';

/**
 * A request for an `.xls` is written through the office suite or the table writers, so the bytes are checked against the declared
 * source before either runs, whichever source the request names.
 */

const NOT_A_ZIP = Buffer.from('plain text under a spreadsheet extension, not a ZIP package');

describe('a source whose bytes are not its declared format, converted to .xls', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(['ods', 'xlsx', 'numbers'])('is refused as a spoofed .%s before the office suite starts', async (src) => {
    const suite = vi.spyOn(getLibreOfficePool(), 'convert');
    const failure = await executeWorkerConversion(NOT_A_ZIP, src, 'xls', {}, `book.${src}`).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(FileExtensionSpoofError);
    expect((failure as Error).message).toContain(`File spoofing rejected for file "book.${src}"`);
    expect(suite).not.toHaveBeenCalled();
  });

  it('is refused for a table source the in-process engine reads, too', async () => {
    const failure = await executeWorkerConversion(Buffer.from([0xff, 0xfe, 0x00, 0x00, 0x50, 0x41, 0x52, 0x31]), 'parquet', 'xls', {}, 'table.parquet').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(FileExtensionSpoofError);
    expect((failure as Error).message).toMatch(/^File spoofing rejected for file "table\.parquet"/);
  });
});
