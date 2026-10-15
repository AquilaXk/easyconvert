import { describe, expect } from 'vitest';
import JSZip from 'jszip';
import { convertOffice } from '../src/lib/conversions/office';
import { oracleTest } from './helpers/oracle-test';
import { parseCsvWithPython, shownSheetRowsViaLibreOffice } from './helpers/sheet-rows';

/**
 * Number formats of spreadsheet cells, checked against the office suite that defines how they display: LibreOffice
 * opens the workbook and exports each cell "as shown" (CSV filter token 9), Python's csv module splits that CSV,
 * and the converter's own CSV for the same workbook must show every cell the same way.
 */

const FIRST_CUSTOM_FORMAT_ID = 164;
const LIBREOFFICE_TEST_TIMEOUT_MS = 180_000;

/** Excel number format codes, one per column, as a spreadsheet author writes them. */
const FORMAT_CODES = ['0.0%', '0.00%', '0%', '#,##0', '#,##0.0', '#,##0.00', '$#,##0', '$#,##0.00', '0', '0.0', '0.000'];
const VALUES = [0.342, 1234.5678, -1234.5678, 1250000.5, 0];

async function workbook(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'
  );
  zip.file(
    'xl/workbook.xml',
    '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets><sheet name="Formats" sheetId="1" r:id="rId1"/></sheets></workbook>'
  );
  zip.file(
    'xl/_rels/workbook.xml.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'
  );
  const numFmts = FORMAT_CODES.map((code, i) => `<numFmt numFmtId="${FIRST_CUSTOM_FORMAT_ID + i}" formatCode="${code}"/>`).join('');
  const xfs = FORMAT_CODES.map(
    (_, i) => `<xf numFmtId="${FIRST_CUSTOM_FORMAT_ID + i}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`
  ).join('');
  zip.file(
    'xl/styles.xml',
    '<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      `<numFmts count="${FORMAT_CODES.length}">${numFmts}</numFmts>` +
      '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills>' +
      `<borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="${FORMAT_CODES.length}">${xfs}</cellXfs></styleSheet>`
  );
  const rows = VALUES.map((value, row) => {
    const cells = FORMAT_CODES.map((_, column) => `<c r="${String.fromCharCode(65 + column)}${row + 1}" s="${column}"><v>${value}</v></c>`).join('');
    return `<row r="${row + 1}">${cells}</row>`;
  }).join('');
  zip.file(
    'xl/worksheets/sheet1.xml',
    `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('spreadsheet cell number formats against LibreOffice', () => {
  oracleTest(
    'shows every cell the way LibreOffice shows it, for percent, thousands, currency and fixed-decimal formats',
    ['soffice', 'python3'],
    async () => {
      const xlsx = await workbook();
      const shown = shownSheetRowsViaLibreOffice(xlsx, 'xlsx');
      const converted = parseCsvWithPython((await convertOffice(xlsx, 'xlsx', 'csv')).buffer.toString('utf-8'));

      // LibreOffice shows each value in each format; the converter shows the same text in the same cell.
      expect(shown).toHaveLength(VALUES.length);
      VALUES.forEach((value, row) => {
        FORMAT_CODES.forEach((code, column) => {
          expect(converted[row]?.[column], `${value} formatted as ${code}`).toBe(shown[row][column]);
        });
      });
    },
    LIBREOFFICE_TEST_TIMEOUT_MS
  );
});
