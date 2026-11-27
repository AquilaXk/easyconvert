import type { FormatDefinition } from './types';

/**
 * The Lotus 1-2-3 formats of release 3 and later (docs/policy-decisions.md, entry 462). The office suite reads them (entry 461) and the targets are
 * those of `.wks` and `.wk1`; the content check of each extension is the BOF record of release 3 and later (`isLotusRelease3Bof`).
 */
function lotusWorkbook(id: string, name: string, description: string): FormatDefinition {
  return {
    id,
    name,
    extension: id,
    mimeType: 'application/vnd.lotus-1-2-3',
    category: 'spreadsheet',
    description,
    targetFormats: ['xlsx', 'csv', 'zip'],
  };
}

export const LOTUS_RELEASE3_DEFINITIONS: Record<string, FormatDefinition> = {
  wk3: lotusWorkbook('wk3', 'Lotus 1-2-3 WK3', 'Lotus 1-2-3 Release 3 multi-sheet workbook.'),
  wk4: lotusWorkbook('wk4', 'Lotus 1-2-3 WK4', 'Lotus 1-2-3 Release 4 and 5 multi-sheet workbook.'),
  '123': lotusWorkbook('123', 'Lotus 1-2-3 123', 'Lotus 1-2-3 97, 98 and Millennium Edition workbook.'),
};
