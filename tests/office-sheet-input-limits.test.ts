import { afterAll, describe, expect, it } from 'vitest';
import { convertFile } from '../src/lib/conversions';
import { writeTransientWorkbook } from '../src/lib/conversions/data';
import { DATA_SOURCE_LIMITS } from '../src/lib/conversions/data-limits';
import { DATA_POOL_MIN_BYTES } from '../src/lib/conversions/data-task';
import { DataLimitExceededError, DataParseError, PayloadLimitError } from '../src/lib/types';
import { extractRowsForOffice } from '../src/lib/conversions/office/sheet-extract';
import { generateOdsFromData, officeSheetWorkbook } from '../src/lib/conversions/office';
import { shutdownCpuPool } from '../src/lib/workers/cpu-pool';

/**
 * The office engine reads CSV, TSV and JSON as sheets for the xlsx, ods and xls targets. Like the data converters (entry 337), it
 * refuses an input over the size and the count of values of its source as a typed 413 before the text is parsed, and a text of
 * 128 KiB or more is read and written on a CPU pool thread so that the event loop keeps turning (the loop itself is measured by
 * `office-sheet-loop.perf.test.ts`).
 */
const MIB = 1024 * 1024;

const SHEET_TARGETS = ['xlsx', 'ods'] as const;

async function failureOf(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
  } catch (error) {
    return error;
  }
  return null;
}

function expectInputOverLimit(error: unknown): void {
  expect(error).toBeInstanceOf(PayloadLimitError);
  expect(error).toMatchObject({ status: 413, refusalCode: 'input_over_limit' });
}

const toSheet = (input: Buffer, src: string, tgt: string): Promise<unknown> => convertFile(input, src, tgt, {}, `input.${src}`);
const toXls = (input: Buffer, src: string): Promise<unknown> => writeTransientWorkbook(input, src, {});

const delimitedCells = (cells: number): Buffer => Buffer.from('a,'.repeat(cells));
const nested = (depth: number): Buffer => Buffer.from(`${'['.repeat(depth)}${']'.repeat(depth)}`);

describe('office sheet readers: input limits', () => {
  afterAll(() => shutdownCpuPool());

  describe.each(SHEET_TARGETS)('CSV, TSV and JSON to %s', (tgt) => {
    it('refuses a 20 MB CSV of millions of one-letter cells', async () => {
      const input = delimitedCells(10 * MIB);
      expect(input.length).toBe(20 * MIB);
      expectInputOverLimit(await failureOf(() => toSheet(input, 'csv', tgt)));
    }, 120_000);

    it('refuses a CSV over its size', async () => {
      expectInputOverLimit(await failureOf(() => toSheet(Buffer.from(`a\n${'x'.repeat(DATA_SOURCE_LIMITS.delimited.maxBytes)}`), 'csv', tgt)));
    }, 120_000);

    it('refuses a TSV of line ends over the record count', async () => {
      expectInputOverLimit(await failureOf(() => toSheet(Buffer.from('a\n'.repeat(DATA_SOURCE_LIMITS.delimited.maxItems + 1)), 'tsv', tgt)));
    }, 120_000);

    it('refuses a JSON array over its structural count', async () => {
      const input = Buffer.from(`[${'{},'.repeat(DATA_SOURCE_LIMITS.json.maxItems / 2 + 1)}{}]`);
      expectInputOverLimit(await failureOf(() => toSheet(input, 'json', tgt)));
    }, 120_000);

    it('refuses a JSON text over its size', async () => {
      expectInputOverLimit(await failureOf(() => toSheet(Buffer.from(`["${'x'.repeat(DATA_SOURCE_LIMITS.json.maxBytes)}"]`), 'json', tgt)));
    }, 120_000);

    it('refuses an XML bomb of tags inside the byte limit', async () => {
      const input = Buffer.from(`<r>${'<a/>'.repeat(DATA_SOURCE_LIMITS.xml.maxItems + 1)}</r>`);
      expect(input.length).toBeLessThan(DATA_SOURCE_LIMITS.xml.maxBytes);
      expectInputOverLimit(await failureOf(() => toSheet(input, 'xml', tgt)));
    }, 120_000);

    it('refuses JSON nested over the depth limit with the typed limit error, not a stack overflow', async () => {
      const error = await failureOf(() => toSheet(nested(100_000), 'json', tgt));
      expect(error).toBeInstanceOf(DataLimitExceededError);
      expect(error).toMatchObject({ refusalCode: 'input_over_limit', message: expect.stringContaining('nesting exceeds') });
    }, 120_000);
  });

  describe('CSV, TSV and JSON to xls (the workbook the office suite reads)', () => {
    it.each([
      ['CSV of one-letter cells', delimitedCells(10 * MIB), 'csv'],
      ['TSV of line ends', Buffer.from('a\n'.repeat(DATA_SOURCE_LIMITS.delimited.maxItems + 1)), 'tsv'],
      ['JSON of empty objects', Buffer.from(`[${'{},'.repeat(DATA_SOURCE_LIMITS.json.maxItems / 2 + 1)}{}]`), 'json'],
      ['XML tags', Buffer.from(`<r>${'<a/>'.repeat(DATA_SOURCE_LIMITS.xml.maxItems + 1)}</r>`), 'xml'],
    ] as const)('refuses a %s as an input over the limit', async (_name, input, src) => {
      expectInputOverLimit(await failureOf(() => toXls(input, src)));
    }, 120_000);

    it('refuses JSON nested over the depth limit', async () => {
      const error = await failureOf(() => toXls(nested(100_000), 'json'));
      expect(error).toBeInstanceOf(DataLimitExceededError);
      expect(error).toMatchObject({ refusalCode: 'input_over_limit', message: expect.stringContaining('nesting exceeds') });
    }, 120_000);
  });

  describe('on a pool thread', () => {
    const rows = (count: number): string[] => ['id,name,note', ...Array.from({ length: count }, (_, i) => `${i},item ${i},some note text ${i}`)];

    it.each(SHEET_TARGETS)('keeps the typed parse error of a CSV with an open quote, found on the thread (%s)', async (tgt) => {
      const text = `${rows(8000).join('\n')}\n"never closed`;
      expect(text.length).toBeGreaterThan(DATA_POOL_MIN_BYTES);
      expect(await failureOf(() => toSheet(Buffer.from(text), 'csv', tgt))).toBeInstanceOf(DataParseError);
    });

    it.each(SHEET_TARGETS)('writes the bytes the calling thread writes for a table above the thread threshold (%s)', async (tgt) => {
      const input = Buffer.from(rows(8000).join('\n'));
      expect(input.length).toBeGreaterThan(DATA_POOL_MIN_BYTES);
      const onThread = (await toSheet(input, 'csv', tgt)) as { buffer: Buffer; filename: string };
      const inline =
        tgt === 'xlsx'
          ? await officeSheetWorkbook(input, 'csv', {})
          : await generateOdsFromData(await extractRowsForOffice(input, 'csv', {}), 'input');
      expect(onThread.filename).toBe(`input.${tgt}`);
      expect(onThread.buffer.equals(inline)).toBe(true);
    });
  });
});
