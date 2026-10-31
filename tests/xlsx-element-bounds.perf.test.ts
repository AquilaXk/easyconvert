import { describe, expect, it } from 'vitest';
import { parseAllXlsxWorksheets } from '../src/lib/conversions/office';
import { XLSX_MAX_RANGES_PER_WORKBOOK } from '../src/lib/conversions/office/xlsx-sheets';
import { writeXlsx } from '../src/lib/conversions/xlsx-writer';
import { SCALING_TEST_TIMEOUT_MS, cpuClockMs, expectSizeIndependentOnInputs } from './helpers/timing';
import { mergeCells, withSheetTail } from './helpers/xlsx-hostile-sheet';

/**
 * Timing check moved out of xlsx-element-bounds.test.ts. The reader keeps the first XLSX_MAX_RANGES_PER_WORKBOOK merged ranges and
 * does not read the rest, so a sheet that lists three million costs about what one that lists a tenth more than the bound does:
 * the file is decoded and checked for well-formedness whole, and nothing more is done for the elements past the bound. A reader that
 * went on to take every range would cost about two and a half times as much. The comparison runs in the nightly performance workflow
 * (`npx vitest run --no-file-parallelism .perf.test.ts`); the PR gate keeps the count of the kept ranges.
 */

const JUST_PAST_THE_BOUND = Math.ceil(XLSX_MAX_RANGES_PER_WORKBOOK * 1.1);
const MILLIONS = 3_000_000;
const MAX_COST_RATIO = 2;

const workbookWith = async (sheetTail: string): Promise<Buffer> => withSheetTail(await writeXlsx([['a']], 'verbatim'), sheetTail);

describe('merged ranges of a worksheet past the bound', () => {
  it('cost the decoding of the file and nothing more: millions of them take less than twice what a sheet just past the bound takes', async () => {
    const modest = await workbookWith(mergeCells(JUST_PAST_THE_BOUND));
    const huge = await workbookWith(mergeCells(MILLIONS));
    const { largeResult } = await expectSizeIndependentOnInputs(
      'merged ranges past the bound',
      async (workbook: Buffer) => (await parseAllXlsxWorksheets(workbook))[0],
      { modest, huge, maxRatio: MAX_COST_RATIO, clock: cpuClockMs }
    );
    expect(largeResult.mergedRanges).toHaveLength(XLSX_MAX_RANGES_PER_WORKBOOK);
  }, SCALING_TEST_TIMEOUT_MS * 4);
});
