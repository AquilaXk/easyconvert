import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import Papa from 'papaparse';
import { convertOffice, parseA1Range, sliceWorksheetToRange, sanitizeSheetName, formatCsvCell } from '../src/lib/conversions/office';
import { convertFile } from '../src/lib/conversions/index';
import { InvalidSheetIndexError, EngineUnavailableError } from '../src/lib/types';
import { executeWorkerConversion } from '../src/worker/engines';

/**
 * Synthesizes a valid multi-sheet OpenXML XLSX buffer purely using JSZip
 * without importing or calling any production serialization functions (prevents circular mocking).
 */
async function synthesizeMultiSheetXlsx(): Promise<Buffer> {
  const zip = new JSZip();

  // 1. [Content_Types].xml
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
</Types>`
  );

  // 2. _rels/.rels
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`
  );

  // 3. xl/_rels/workbook.xml.rels
  zip.file(
    'xl/_rels/workbook.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/>
  <Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>`
  );

  // 4. xl/sharedStrings.xml
  const strings = [
    'HeaderA',              // 0
    'HeaderB',              // 1
    'HeaderC',              // 2
    'HeaderD',              // 3
    'Row2A',                // 4
    'TargetB2',             // 5 (part of print area B2:C3)
    'TargetC2',             // 6 (part of print area B2:C3)
    'Row2D',                // 7
    'Row3A',                // 8
    'TargetB3',             // 9 (part of print area B2:C3)
    'TargetC3',             // 10 (part of print area B2:C3)
    'Row3D',                // 11
    'MultiLine\nText\r\nCell', // 12 (RFC 4180 multiline text)
    'Q1-Alpha',             // 13
    'Q1-Beta',              // 14
    'SpecialDept',          // 15
  ];

  const sstContent = strings.map((s) => `<si><t>${s}</t></si>`).join('');
  zip.file(
    'xl/sharedStrings.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">
  ${sstContent}
</sst>`
  );

  // 5. xl/workbook.xml with definedName _xlnm.Print_Area
  zip.file(
    'xl/workbook.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Summary" sheetId="1" r:id="rId1"/>
    <sheet name="Q1_Report" sheetId="2" r:id="rId2"/>
    <sheet name="Special / Area" sheetId="3" r:id="rId3"/>
  </sheets>
  <definedNames>
    <definedName name="_xlnm.Print_Area" localSheetId="0">Summary!$B$2:$C$3</definedName>
  </definedNames>
</workbook>`
  );

  // 6. Sheet 1: Summary (4x4 matrix with print area B2:C3, multiline cell at D4, formula with cached <v> at A4)
  zip.file(
    'xl/worksheets/sheet1.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" t="s"><v>0</v></c>
      <c r="B1" t="s"><v>1</v></c>
      <c r="C1" t="s"><v>2</v></c>
      <c r="D1" t="s"><v>3</v></c>
    </row>
    <row r="2">
      <c r="A2" t="s"><v>4</v></c>
      <c r="B2" t="s"><v>5</v></c>
      <c r="C2" t="s"><v>6</v></c>
      <c r="D2" t="s"><v>7</v></c>
    </row>
    <row r="3">
      <c r="A3" t="s"><v>8</v></c>
      <c r="B3" t="s"><v>9</v></c>
      <c r="C3" t="s"><v>10</v></c>
      <c r="D3" t="s"><v>11</v></c>
    </row>
    <row r="4">
      <c r="A4"><f>SUM(B2:C3)</f><v>999</v></c>
      <c r="B4"><v>100</v></c>
      <c r="C4"><v>200</v></c>
      <c r="D4" t="s"><v>12</v></c>
    </row>
  </sheetData>
</worksheet>`
  );

  // 7. Sheet 2: Q1_Report
  zip.file(
    'xl/worksheets/sheet2.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" t="s"><v>13</v></c>
      <c r="B1"><v>5000</v></c>
    </row>
    <row r="2">
      <c r="A2" t="s"><v>14</v></c>
      <c r="B2"><v>7500</v></c>
    </row>
  </sheetData>
</worksheet>`
  );

  // 8. Sheet 3: Special / Area
  zip.file(
    'xl/worksheets/sheet3.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" t="s"><v>15</v></c>
      <c r="B1"><v>42</v></c>
    </row>
  </sheetData>
</worksheet>`
  );

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/**
 * Synthesizes a valid ODS buffer with a multiline cell purely via JSZip.
 */
async function synthesizeOdsWithMultiline(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/vnd.oasis.opendocument.spreadsheet');
  zip.file(
    'content.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">
  <office:body>
    <office:spreadsheet>
      <table:table table:name="ODSSheet1">
        <table:table-row>
          <table:table-cell office:value-type="string"><text:p>Column1</text:p></table:table-cell>
          <table:table-cell office:value-type="string"><text:p>Multi\nLine\rODS</text:p></table:table-cell>
        </table:table-row>
        <table:table-row>
          <table:table-cell office:value-type="string"><text:p>Row2Val</text:p></table:table-cell>
          <table:table-cell office:value-type="string"><text:p>NormalVal</text:p></table:table-cell>
        </table:table-row>
      </table:table>
    </office:spreadsheet>
  </office:body>
</office:document-content>`
  );

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

describe('WP-43: Spreadsheet Modes (Merged, Split, Index) & Print Area Parsing', () => {
  describe('1. Unit Helpers: A1 Reference Parsing & Sanitization', () => {
    it('parses absolute and relative A1 range references accurately', () => {
      const parsedSimple = parseA1Range('B2:C3');
      expect(parsedSimple).toEqual({
        sheetName: undefined,
        startRow: 1,
        endRow: 2,
        startCol: 1,
        endCol: 2,
      });

      const parsedWithSheet = parseA1Range("Summary!$B$2:$C$3");
      expect(parsedWithSheet).toEqual({
        sheetName: 'Summary',
        startRow: 1,
        endRow: 2,
        startCol: 1,
        endCol: 2,
      });

      const parsedQuotedSheet = parseA1Range("'Sheet With Spaces'!$A$1:$D$10");
      expect(parsedQuotedSheet).toEqual({
        sheetName: 'Sheet With Spaces',
        startRow: 0,
        endRow: 9,
        startCol: 0,
        endCol: 3,
      });

      const parsedSingleCell = parseA1Range('$E$5');
      expect(parsedSingleCell).toEqual({
        sheetName: undefined,
        startRow: 4,
        endRow: 4,
        startCol: 4,
        endCol: 4,
      });
    });

    it('returns null safely for empty or invalid A1 ranges', () => {
      expect(parseA1Range('')).toBeNull();
      expect(parseA1Range('invalid-range')).toBeNull();
      expect(parseA1Range(undefined as any)).toBeNull();
    });

    it('sanitizes sheet names by replacing forbidden filesystem characters', () => {
      expect(sanitizeSheetName('Sheet:1/Q1*2?')).toBe('Sheet_1_Q1_2_');
      expect(sanitizeSheetName('Special / Area')).toBe('Special _ Area');
      expect(sanitizeSheetName('   ')).toBe('sheet');
    });

    it('enforces RFC 4180 cell quoting on delimiters, quotes, CR, and LF', () => {
      expect(formatCsvCell('normal', ',')).toBe('normal');
      expect(formatCsvCell('has,comma', ',')).toBe('"has,comma"');
      expect(formatCsvCell('has"quote', ',')).toBe('"has""quote"');
      expect(formatCsvCell('has\nnewline', ',')).toBe('"has\nnewline"');
      expect(formatCsvCell('has\rcarriage', ',')).toBe('"has\rcarriage"');
    });
  });

  describe('2. RFC 4180 Multiline Quoting Compliance', () => {
    it('quotes cells containing newlines so PapaParse decodes them as a single field', async () => {
      const xlsxBuffer = await synthesizeMultiSheetXlsx();
      const res = await convertOffice(xlsxBuffer, 'xlsx', 'csv', { sheetMode: 'index', sheetIndex: 0 });

      const csvString = res.buffer.toString('utf-8');
      // Verify with PapaParse differential oracle
      const parsed = Papa.parse<string[]>(csvString, { header: false });

      expect(parsed.errors.length).toBe(0);
      expect(parsed.data.length).toBe(4);

      // Cell D4 contains the multiline string 'MultiLine\nText\r\nCell'
      const multilineCell = parsed.data[3][3];
      expect(multilineCell).toContain('MultiLine\nText');
      expect(multilineCell).toContain('Cell');
    });

    it('enforces RFC 4180 quoting on ODS to CSV conversion', async () => {
      const odsBuffer = await synthesizeOdsWithMultiline();
      const res = await convertOffice(odsBuffer, 'ods', 'csv');

      const csvString = res.buffer.toString('utf-8');
      const parsed = Papa.parse<string[]>(csvString, { header: false });

      expect(parsed.errors.length).toBe(0);
      expect(parsed.data.length).toBe(2);
      expect(parsed.data[0][1]).toContain('Multi\nLine\rODS');
    });
  });

  describe('3. Spreadsheet Modes: Merged, Index, and Split', () => {
    it('defaults to sheetMode: merged, preserving multi-sheet markdown headers', async () => {
      const xlsxBuffer = await synthesizeMultiSheetXlsx();
      const res = await convertOffice(xlsxBuffer, 'xlsx', 'csv');

      const csvString = res.buffer.toString('utf-8');
      expect(res.mimeType).toBe('text/csv');
      expect(res.filename).toBe('document.csv');

      expect(csvString).toContain('### Sheet: Summary');
      expect(csvString).toContain('### Sheet: Q1_Report');
      expect(csvString).toContain('### Sheet: Special / Area');
      expect(csvString).toContain('Q1-Alpha,5000');
    });

    it('extracts a single sheet by zero-based index in sheetMode: index', async () => {
      const xlsxBuffer = await synthesizeMultiSheetXlsx();

      // Extract Sheet 1 (Q1_Report)
      const resQ1 = await convertOffice(xlsxBuffer, 'xlsx', 'csv', {
        sheetMode: 'index',
        sheetIndex: 1,
      });

      const csvString = resQ1.buffer.toString('utf-8');
      expect(csvString).not.toContain('### Sheet:');
      const parsed = Papa.parse<string[]>(csvString, { header: false });
      expect(parsed.data.length).toBe(2);
      expect(parsed.data[0]).toEqual(['Q1-Alpha', '5000']);
      expect(parsed.data[1]).toEqual(['Q1-Beta', '7500']);

      // Extract Sheet 2 (Special / Area)
      const resSpecial = await convertOffice(xlsxBuffer, 'xlsx', 'csv', {
        sheetMode: 'index',
        sheetIndex: 2,
      });
      const parsedSpecial = Papa.parse<string[]>(resSpecial.buffer.toString('utf-8'), { header: false });
      expect(parsedSpecial.data.length).toBe(1);
      expect(parsedSpecial.data[0]).toEqual(['SpecialDept', '42']);
    });

    it('fails closed with InvalidSheetIndexError when sheetIndex is out of range', async () => {
      const xlsxBuffer = await synthesizeMultiSheetXlsx();

      await expect(
        convertOffice(xlsxBuffer, 'xlsx', 'csv', {
          sheetMode: 'index',
          sheetIndex: 99,
        })
      ).rejects.toThrow(InvalidSheetIndexError);

      await expect(
        convertOffice(xlsxBuffer, 'xlsx', 'csv', {
          sheetMode: 'index',
          sheetIndex: -1,
        })
      ).rejects.toThrow(InvalidSheetIndexError);
    });

    it('bundles all sheets into a ZIP of individual RFC 4180 CSVs in sheetMode: split', async () => {
      const xlsxBuffer = await synthesizeMultiSheetXlsx();
      const res = await convertOffice(xlsxBuffer, 'xlsx', 'csv', { sheetMode: 'split' }, 'testbook');

      expect(res.mimeType).toBe('application/zip');
      expect(res.filename).toBe('testbook.zip');

      const outZip = await JSZip.loadAsync(res.buffer);
      const fileNames = Object.keys(outZip.files).sort();

      expect(fileNames).toEqual([
        'testbook-Q1_Report.csv',
        'testbook-Special _ Area.csv',
        'testbook-Summary.csv',
      ]);

      // Verify each CSV inside the ZIP using PapaParse oracle
      const q1Content = await outZip.file('testbook-Q1_Report.csv')!.async('text');
      const q1Parsed = Papa.parse<string[]>(q1Content, { header: false });
      expect(q1Parsed.data).toEqual([
        ['Q1-Alpha', '5000'],
        ['Q1-Beta', '7500'],
      ]);

      const specialContent = await outZip.file('testbook-Special _ Area.csv')!.async('text');
      const specialParsed = Papa.parse<string[]>(specialContent, { header: false });
      expect(specialParsed.data).toEqual([['SpecialDept', '42']]);
    });
  });

  describe('4. Print Area Parsing & Formula Cache Preservation', () => {
    it('restricts extracted CSV to defined Print Area (B2:C3) when range: printArea is requested', async () => {
      const xlsxBuffer = await synthesizeMultiSheetXlsx();
      const res = await convertOffice(xlsxBuffer, 'xlsx', 'csv', {
        sheetMode: 'index',
        sheetIndex: 0,
        range: 'printArea',
      });

      const csvString = res.buffer.toString('utf-8');
      const parsed = Papa.parse<string[]>(csvString, { header: false });

      // Ground truth for B2:C3 in Summary sheet is exactly 2 rows x 2 cols
      expect(parsed.data.length).toBe(2);
      expect(parsed.data[0]).toEqual(['TargetB2', 'TargetC2']);
      expect(parsed.data[1]).toEqual(['TargetB3', 'TargetC3']);
    });

    it('preserves pre-computed formula cache value <v> by default without recalculating', async () => {
      const xlsxBuffer = await synthesizeMultiSheetXlsx();
      const res = await convertOffice(xlsxBuffer, 'xlsx', 'csv', {
        sheetMode: 'index',
        sheetIndex: 0,
      });

      const csvString = res.buffer.toString('utf-8');
      const parsed = Papa.parse<string[]>(csvString, { header: false });

      // Cell A4 has <f>SUM(B2:C3)</f><v>999</v>. Ground truth verification that 999 is retained.
      expect(parsed.data[3][0]).toBe('999');
    });

    it('supports custom line endings: CRLF vs LF', async () => {
      const xlsxBuffer = await synthesizeMultiSheetXlsx();

      const resCrlf = await convertOffice(xlsxBuffer, 'xlsx', 'csv', {
        sheetMode: 'index',
        sheetIndex: 1,
        lineEnding: 'crlf',
      });
      expect(resCrlf.buffer.toString('utf-8')).toBe('Q1-Alpha,5000\r\nQ1-Beta,7500');

      const resLf = await convertOffice(xlsxBuffer, 'xlsx', 'csv', {
        sheetMode: 'index',
        sheetIndex: 1,
        lineEnding: 'lf',
      });
      expect(resLf.buffer.toString('utf-8')).toBe('Q1-Alpha,5000\nQ1-Beta,7500');
    });

    it('fails closed when recalculate: true is requested in worker but native LibreOffice engine is unavailable', async () => {
      const prevSoffice = process.env.SOFFICE_PATH;
      process.env.SOFFICE_PATH = '/nonexistent/soffice';

      try {
        const xlsxBuffer = await synthesizeMultiSheetXlsx();
        await expect(
          executeWorkerConversion(
            xlsxBuffer,
            'xlsx',
            'csv',
            { recalculate: true },
            'workbook.xlsx'
          )
        ).rejects.toThrow(EngineUnavailableError);
      } finally {
        if (prevSoffice === undefined) {
          delete process.env.SOFFICE_PATH;
        } else {
          process.env.SOFFICE_PATH = prevSoffice;
        }
      }
    });
  });
});
